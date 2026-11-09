import { useCallback, useEffect, useState } from "react";
import { FACTORY_ID, keyMethods, spendableNear, view, type Policy, type Proposal, type TokenMetadata } from "./near";
import { billDues, type VaultBill, type VaultPayee } from "./bills";
import { multisigOf, openProposalsFor, type DaoProposal, type Multisig } from "./multisig";

export interface VaultData {
  policy: Policy;
  token: TokenMetadata;
  balance: string;
  gas: bigint;
  proposals: Proposal[];
  /** Bills the owner listed; null for vaults created before bills could be listed. */
  bills: VaultBill[] | null;
  /** When the vault paid each bill_ref of the listed bills (ms), if it did. */
  paid: Record<string, number>;
  /** Payees the owner named; null for vaults created before payees had names. */
  payees: VaultPayee[] | null;
  /** Savings at an approved lending market (Burrow), if there is one. */
  savings: { market: string; name: string; units: string; apr: number } | null;
  /** What Keel's key may call on this vault (newer vaults add recall_from_yield). */
  agentMethods: string[];
  /** The vault's token transfers, newest first (ms, signed amount), or null if the indexer is unreachable. */
  history: { at: number; delta: bigint }[] | null;
  /** Set when the owner is a multisig (a Sputnik DAO such as a Trezu treasury). */
  multisig: Multisig | null;
  /** That multisig's open proposals for this vault. */
  multisigProposals: DaoProposal[];
}

/**
 * Every transfer of the vault's token in and out of the vault, from
 * nearblocks' public index (newest first, up to 200). The chart walks back
 * from today's balance with these, so it shows the balance the vault really had.
 */
async function loadHistory(vaultId: string, tokenId: string): Promise<VaultData["history"]> {
  const base = FACTORY_ID.endsWith(".near") ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";
  const out: { at: number; delta: bigint }[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 2; page++) {
      const url = `${base}/v3/accounts/${vaultId}/ft-txns?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return out.length ? out : null;
      const body = (await res.json()) as { data?: { contract_account_id: string; delta_amount: string; block_timestamp: string }[]; meta?: { cursor?: string | null } };
      for (const t of body.data ?? []) {
        if (t.contract_account_id === tokenId) out.push({ at: Number(BigInt(t.block_timestamp) / 1_000_000n), delta: BigInt(t.delta_amount) });
      }
      cursor = body.meta?.cursor ?? undefined;
      if (!cursor || (body.data ?? []).length < 100) break;
    }
    return out.sort((a, b) => b.at - a.at);
  } catch {
    return out.length ? out : null;
  }
}

/** The vault's supply at its lending market, in the vault token's units. */
async function loadSavings(vaultId: string, tokenId: string, payees: VaultPayee[] | null): Promise<VaultData["savings"]> {
  const market = payees?.find((p) => p.kind === "yield" && p.lending);
  if (!market) return null;
  try {
    const [acct, asset] = await Promise.all([
      view<{ supplied: { token_id: string; balance: string }[] } | null>(market.account_id, "get_account", { account_id: vaultId }),
      view<{ config: { extra_decimals: number }; supply_apr: string }>(market.account_id, "get_asset", { token_id: tokenId }),
    ]);
    const inner = BigInt(acct?.supplied.find((s) => s.token_id === tokenId)?.balance ?? "0");
    return { market: market.account_id, name: market.name, units: (inner / 10n ** BigInt(asset.config.extra_decimals)).toString(), apr: Number(asset.supply_apr) };
  } catch {
    return { market: market.account_id, name: market.name, units: "0", apr: 0 };
  }
}

async function loadBills(vaultId: string): Promise<{ bills: VaultBill[] | null; paid: Record<string, number> }> {
  let bills: VaultBill[];
  try {
    bills = await view<VaultBill[]>(vaultId, "get_bills");
  } catch {
    return { bills: null, paid: {} };
  }
  const refs = billDues(bills, new Date().toISOString().slice(0, 10)).map((x) => x.ref);
  const at = await Promise.all(refs.map((r) => view<number | null>(vaultId, "bill_paid_at", { bill_ref: r }).catch(() => null)));
  const paid: Record<string, number> = {};
  refs.forEach((r, i) => at[i] && (paid[r] = at[i]!));
  return { bills, paid };
}

/** Everything the screens show about one vault, read live from the chain. */
export function useVault(vaultId: string | null) {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!vaultId) return;
    try {
      const policy = await view<Policy>(vaultId, "get_policy");
      const [token, balance, gas, proposals, listed, payees] = await Promise.all([
        view<TokenMetadata>(policy.token_id, "ft_metadata"),
        view<string>(policy.token_id, "ft_balance_of", { account_id: vaultId }),
        spendableNear(vaultId),
        view<Proposal[]>(vaultId, "get_proposals", { from_index: 0, limit: 100 }),
        loadBills(vaultId),
        view<VaultPayee[]>(vaultId, "get_payees").catch(() => null),
      ]);
      const [savings, agentMethods, history, multisig] = await Promise.all([
        loadSavings(vaultId, policy.token_id, payees),
        policy.agent_key ? keyMethods(vaultId, policy.agent_key) : Promise.resolve([]),
        loadHistory(vaultId, policy.token_id),
        multisigOf(policy.owner_id),
      ]);
      const multisigProposals = multisig ? await openProposalsFor(multisig.dao, vaultId).catch(() => []) : [];
      setData({ policy, token, balance, gas, proposals, ...listed, payees, savings, agentMethods, history, multisig, multisigProposals });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [vaultId]);

  useEffect(() => {
    setData(null);
    setError(null);
    load();
  }, [load]);

  return { data, error, reload: load };
}

export type KeelState = "running" | "waiting" | "paused" | "off" | "legacy";

/** What the sidebar status box says about Keel's agent for this vault. */
export function keelState(policy: Policy): KeelState {
  if (policy.paused) return "paused";
  if (policy.agent_id) return "legacy";
  if (!policy.agent_key) return "off";
  if (policy.per_payment_cap === "0" || policy.daily_cap === "0" || policy.allowlist.length === 0) return "waiting";
  return "running";
}
