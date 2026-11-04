import { NearConnector } from "@hot-labs/near-connect";

export const NETWORK = "testnet" as const;
export const RPC_URL = "https://test.rpc.fastnear.com";
export const FACTORY_ID = "keel.testnet";
export const EXPLORER_TX = "https://explorer.testnet.near.org/transactions/";

export const connector = new NearConnector({
  network: NETWORK,
  features: { signAndSendTransaction: true },
});

// ---------------------------------------------------------------- read calls

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "keel", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? "RPC error");
  return body.result as T;
}

/** Calls a contract's view method and parses its JSON result. */
export async function view<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
  const result = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: methodName,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

/** The methods a function-call key may call on an account, or [] if the key is missing. */
export async function keyMethods(accountId: string, publicKey: string): Promise<string[]> {
  try {
    const r = await rpc<{ permission?: { FunctionCall?: { method_names: string[] } } }>("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: accountId,
      public_key: publicKey,
    });
    return r.permission?.FunctionCall?.method_names ?? [];
  } catch {
    return [];
  }
}

/** True if a NEAR account with this id exists. */
export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
    return true;
  } catch (e) {
    if (String(e).includes("does not exist")) return false;
    throw e;
  }
}

/** NEAR the account can spend, after what is locked to pay for its storage. */
export async function spendableNear(accountId: string): Promise<bigint> {
  const acc = await rpc<{ amount: string; storage_usage: number }>("query", {
    request_type: "view_account",
    finality: "optimistic",
    account_id: accountId,
  });
  const locked = BigInt(acc.storage_usage) * STORAGE_PRICE_PER_BYTE;
  const amount = BigInt(acc.amount);
  return amount > locked ? amount - locked : 0n;
}

/** NEAR's storage price: 0.01 NEAR per kilobyte. */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

// --------------------------------------------------------------- contract types

export interface FactoryConfig {
  admin_id: string;
  agent_key: string;
  token_id: string;
  vault_code_hash: string | null;
  vault_code_bytes: number;
  min_vault_deposit: string;
}

export interface Policy {
  owner_id: string;
  /** Current vaults. Vaults from before the agent key moved onto the vault have agent_id instead. */
  agent_key?: string | null;
  agent_id?: string;
  token_id: string;
  per_payment_cap: string;
  daily_cap: string;
  spent_today: string;
  /** Cash buffer Keel's payments must leave in the vault; missing on vaults created before it existed. */
  min_balance?: string;
  paused: boolean;
  allowlist: string[];
  blocklist: string[];
}

export type ProposalStatus = "pending" | "executing" | "executed" | "rejected" | "failed" | "signing" | "signed" | "superseded";

export interface Proposal {
  id: number;
  receiver_id: string;
  amount: string;
  memo: string | null;
  reason: string;
  status: ProposalStatus;
  created_at_ms: number;
  /** Offers that expire, such as a NEAR Intents quote. The vault refuses approval after this. */
  valid_until_ms?: number | null;
  /** Paid from the vault's own EVM address through NEAR Chain Signatures. */
  evm?: { chain_id: number; token: string; to: string; nonce: number; gas_limit: number; max_fee_per_gas: string } | null;
  evm_signed?: { raw_tx: string; tx_hash: string } | null;
  /** The bill this pays. The vault pays each bill at most once. */
  bill_ref?: string | null;
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

// ------------------------------------------------------------------- formats

export function formatNear(yocto: bigint | string, digits = 2): string {
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, digits);
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

/** Rounds a yocto amount up to two decimals, so a deposit is never short. */
export function roundUpNear(yocto: bigint | string): bigint {
  const step = 10n ** 22n;
  const v = BigInt(yocto);
  return ((v + step - 1n) / step) * step;
}

export function formatToken(raw: string | bigint, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const cents = ((v % base) * 100n) / base;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/** "Kora Supply Group" -> "kora-supply-group", within the factory's rules. */
export function vaultNameFrom(company: string): string {
  return company
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export function validVaultName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])$/.test(name);
}

/** "kora-supply.keel.testnet" -> "Kora supply" */
export function companyLabel(vaultId: string): string {
  const name = vaultId.split(".")[0].replace(/[-_]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function shortKey(key: string): string {
  const [, body = key] = key.split(":");
  return `${body.slice(0, 6)}…${body.slice(-4)}`;
}

/** "100.5" with 6 decimals -> "100500000". Returns null if the text is not a number. */
export function parseToken(text: string, decimals: number): string | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

// ------------------------------------------------- company names (this browser)

const NAMES_KEY = "keel.companyNames";

/** The name a founder typed for each vault, remembered in this browser only. */
export function companyName(vaultId: string): string {
  try {
    const names = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}") as Record<string, string>;
    if (names[vaultId]) return names[vaultId];
  } catch {
    /* storage unavailable */
  }
  return companyLabel(vaultId);
}

export function rememberCompanyName(vaultId: string, name: string) {
  try {
    const names = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}") as Record<string, string>;
    names[vaultId] = name;
    localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  } catch {
    /* storage unavailable */
  }
}
