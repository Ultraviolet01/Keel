import { useCallback, useEffect, useState } from "react";
import { spendableNear, view, type Policy, type Proposal, type TokenMetadata } from "./near";
import { billDues, type VaultBill, type VaultPayee } from "./bills";

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
      setData({ policy, token, balance, gas, proposals, ...listed, payees });
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
