import { useCallback, useEffect, useState } from "react";
import { spendableNear, view, type Policy, type Proposal, type TokenMetadata } from "./near";

export interface VaultData {
  policy: Policy;
  token: TokenMetadata;
  balance: string;
  gas: bigint;
  proposals: Proposal[];
}

/** Everything the screens show about one vault, read live from the chain. */
export function useVault(vaultId: string | null) {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!vaultId) return;
    try {
      const policy = await view<Policy>(vaultId, "get_policy");
      const [token, balance, gas, proposals] = await Promise.all([
        view<TokenMetadata>(policy.token_id, "ft_metadata"),
        view<string>(policy.token_id, "ft_balance_of", { account_id: vaultId }),
        spendableNear(vaultId),
        view<Proposal[]>(vaultId, "get_proposals", { from_index: 0, limit: 100 }),
      ]);
      setData({ policy, token, balance, gas, proposals });
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
