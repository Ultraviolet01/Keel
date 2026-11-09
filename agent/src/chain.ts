// Talking to NEAR: read calls over JSON-RPC, and signing as a vault with
// Keel's agent key (a function-call key that only reaches execute_payment and
// propose_payment on that vault).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import type { Policy, Proposal, VaultBill, VaultPayee } from "./brain";

export interface Config {
  network: string;
  rpcUrl: string;
  factoryId: string;
  agentKeyFile: string;
  /** The agent key itself, for hosts that keep it in a secret instead of a file (GitHub Actions). */
  agentPrivateKey?: string;
  explorerTx: string;
  nearAiKey?: string;
  nearAiUrl: string;
  nearAiModel: string;
  anthropicKey?: string;
  anthropicModel: string;
}

/** Reads ../.env (if present) and the environment. */
export function loadConfig(): Config {
  const envFile = resolve(import.meta.dirname, "../../.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
  const e = process.env;
  const network = e.NEAR_NETWORK || "testnet";
  return {
    network,
    rpcUrl: e.NEAR_RPC_URL || (network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"),
    factoryId: e.FACTORY_ACCOUNT_ID || "keel.testnet",
    agentKeyFile: (e.AGENT_KEY_FILE || "~/.near-credentials/keel-agent-key.json").replace(/^~/, homedir()),
    explorerTx: network === "mainnet" ? "https://nearblocks.io/txns/" : "https://testnet.nearblocks.io/txns/",
    nearAiKey: e.NEARAI_API_KEY || undefined,
    nearAiUrl: e.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1",
    nearAiModel: e.NEARAI_MODEL || "deepseek/deepseek-v3.2",
    anthropicKey: e.ANTHROPIC_API_KEY || undefined,
    anthropicModel: e.ANTHROPIC_MODEL || "claude-haiku-5-5",
    agentPrivateKey: e.KEEL_AGENT_PRIVATE_KEY || undefined,
  };
}

export class Chain {
  private provider: JsonRpcProvider;
  private agentKey: { public_key: string; private_key: string } | null = null;

  constructor(private cfg: Config) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.cfg.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "keel-agent", method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { data?: string; message?: string } };
    if (body.error) throw new Error(String(body.error.data ?? body.error.message));
    return body.result as T;
  }

  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const r = await this.rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    // A failed view (for example a method the vault's code does not have) comes back as result.error.
    const failed = (r as { error?: string }).error;
    if (failed || !r.result) throw new Error(`${contractId}.${method}: ${failed ?? "no result"}`);
    return JSON.parse(Buffer.from(r.result).toString()) as T;
  }

  /** null if the account does not exist. */
  async account(accountId: string): Promise<{ codeHash: string; amount: bigint } | null> {
    try {
      const a = await this.rpc<{ code_hash: string; amount: string }>("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      });
      return { codeHash: a.code_hash, amount: BigInt(a.amount) };
    } catch (e) {
      if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(e))) return null;
      throw e;
    }
  }

  async vaults(): Promise<string[]> {
    const all: string[] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.view<string[]>(this.cfg.factoryId, "get_vaults", { from_index: from, limit: 100 });
      all.push(...page);
      if (page.length < 100) return all;
    }
  }

  policy(vaultId: string) {
    return this.view<Policy>(vaultId, "get_policy");
  }

  proposals(vaultId: string) {
    return this.view<Proposal[]>(vaultId, "get_proposals", { from_index: 0, limit: 100 });
  }

  async balance(tokenId: string, accountId: string): Promise<bigint> {
    return BigInt(await this.view<string>(tokenId, "ft_balance_of", { account_id: accountId }));
  }

  /** The bills the owner listed on the vault; none for vaults created before `add_bill`. */
  async bills(vaultId: string): Promise<VaultBill[]> {
    try {
      return await this.view<VaultBill[]>(vaultId, "get_bills");
    } catch (e) {
      if (/MethodNotFound|MethodResolveError|CodeDoesNotExist/.test(String(e))) return [];
      throw e;
    }
  }

  /** The payees the owner named on the vault; none for older vaults. */
  async payees(vaultId: string): Promise<VaultPayee[]> {
    try {
      return await this.view<VaultPayee[]>(vaultId, "get_payees");
    } catch (e) {
      if (/MethodNotFound|MethodResolveError|CodeDoesNotExist/.test(String(e))) return [];
      throw e;
    }
  }

  checkPayment(vaultId: string, receiverId: string, amount: bigint) {
    return this.view<{ band: "runs_alone" | "needs_approval" | "blocked"; reason: string }>(vaultId, "check_payment", {
      receiver_id: receiverId,
      amount: amount.toString(),
    });
  }

  /** True when Keel's private agent key is here (KEEL_AGENT_PRIVATE_KEY or the key file), so it can sign. */
  canSign(): boolean {
    return Boolean(this.cfg.agentPrivateKey) || existsSync(this.cfg.agentKeyFile);
  }

  /**
   * Keel's agent public key: from the local key file, or, without it, the one
   * the factory adds to every vault. Dry runs need only this.
   */
  async agentPublicKey(): Promise<string> {
    if (this.canSign()) return this.key().public_key;
    return (await this.view<{ agent_key: string }>(this.cfg.factoryId, "get_config")).agent_key;
  }

  private key() {
    if (!this.agentKey) {
      if (!this.canSign()) {
        throw new Error(`signing needs Keel's agent key (KEEL_AGENT_PRIVATE_KEY or ${this.cfg.agentKeyFile}); without it, run with --dry-run`);
      }
      if (this.cfg.agentPrivateKey) {
        const pk = this.cfg.agentPrivateKey.trim();
        const public_key = KeyPair.fromString(pk as `ed25519:${string}`).getPublicKey().toString();
        this.agentKey = { public_key, private_key: pk };
      } else {
        this.agentKey = JSON.parse(readFileSync(this.cfg.agentKeyFile, "utf8"));
      }
    }
    return this.agentKey!;
  }

  /** Signs a call as the vault with the agent key. Returns the transaction hash and the decoded return value. */
  /**
   * The vault's supply at a lending market (Burrow), in the vault token's
   * units, and the market's supply APR. Burrow counts with extra decimals.
   */
  async lendingPosition(market: string, vaultId: string, tokenId: string): Promise<{ units: bigint; extra: number; apr: number }> {
    const [acct, asset] = await Promise.all([
      this.view<{ supplied: { token_id: string; balance: string }[] } | null>(market, "get_account", { account_id: vaultId }),
      this.view<{ config: { extra_decimals: number }; supply_apr: string }>(market, "get_asset", { token_id: tokenId }),
    ]);
    const extra = asset.config.extra_decimals;
    const inner = BigInt(acct?.supplied.find((s) => s.token_id === tokenId)?.balance ?? "0");
    return { units: inner / 10n ** BigInt(extra), extra, apr: Number(asset.supply_apr) };
  }

  /**
   * Signs as the vault with the agent key. Gas is kept low enough to pass the
   * key's allowance check (0.25 NEAR at the pessimistic price): 100 Tgas for
   * ordinary calls, 200 for a lending-market deposit, 150 for a recall.
   */
  async callAsAgent(vaultId: string, methodName: "execute_payment" | "propose_payment" | "recall_from_yield", args: object, tgas = 100) {
    const account = new Account(vaultId, this.provider, this.key().private_key as `ed25519:${string}`);
    const res = await account.callFunctionRaw({
      contractId: vaultId,
      methodName,
      args,
      gas: BigInt(tgas) * 1_000_000_000_000n,
      deposit: 0n,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    const status = (res as { status?: { SuccessValue?: string; Failure?: unknown } }).status;
    const hash = (res as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } }).transaction?.hash ?? "";
    if (status?.Failure) throw Object.assign(new Error(JSON.stringify(status.Failure)), { hash });
    const value = status?.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, "base64").toString() || "null") : null;
    return { hash, value };
  }
}
