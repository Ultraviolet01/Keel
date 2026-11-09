// Optional multisig ownership: a vault whose owner is a Sputnik DAO (the
// contracts behind Trezu treasuries). Owner actions then become DAO
// proposals that the members vote on.

import { view } from "./near";

export interface Multisig {
  dao: string;
  /** NEAR (yocto) a member attaches to file a proposal; returned once it is decided. */
  bond: string;
  members: string[];
  /** Share of members' votes a proposal needs, e.g. [1, 2] = more than half. */
  threshold: [number, number] | null;
}

export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  status: string;
  votes: Record<string, string>;
  kind: { FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] } };
}

type DaoPolicy = {
  proposal_bond?: string;
  roles?: { name: string; kind: string | { Group?: string[] } }[];
  default_vote_policy?: { threshold?: [number, number] | string };
};

/** The DAO's members and bond if `owner` is a Sputnik DAO, else null. */
export async function multisigOf(owner: string): Promise<Multisig | null> {
  let p: DaoPolicy;
  try {
    p = await view<DaoPolicy>(owner, "get_policy");
  } catch {
    return null;
  }
  if (!p || typeof p.proposal_bond !== "string" || !Array.isArray(p.roles)) return null;
  const members = [...new Set(p.roles.flatMap((r) => (typeof r.kind === "object" && r.kind.Group ? r.kind.Group : [])))];
  const t = p.default_vote_policy?.threshold;
  return { dao: owner, bond: p.proposal_bond, members, threshold: Array.isArray(t) ? t : null };
}

/** Open proposals in the DAO that call this vault. */
export async function openProposalsFor(dao: string, vaultId: string): Promise<DaoProposal[]> {
  const last = await view<number>(dao, "get_last_proposal_id");
  const from = Math.max(0, last - 60);
  const list = await view<DaoProposal[]>(dao, "get_proposals", { from_index: from, limit: 60 });
  return list.filter((p) => p.status === "InProgress" && p.kind.FunctionCall?.receiver_id === vaultId).reverse();
}

/** A DAO proposal action may carry at most this much gas; Sputnik runs it when the last vote lands. */
const MAX_ACTION_GAS = 150_000_000_000_000n;

/**
 * The add_proposal call that asks the DAO to make these vault calls. The DAO
 * attaches each call's deposit from its own balance when it executes.
 */
export function proposalCall(vaultId: string, calls: { methodName: string; args: object; gas: string; deposit: string }[], description: string) {
  return {
    proposal: {
      description,
      kind: {
        FunctionCall: {
          receiver_id: vaultId,
          actions: calls.map((c) => ({
            method_name: c.methodName,
            args: toBase64(c.args),
            deposit: c.deposit,
            gas: (BigInt(c.gas) > MAX_ACTION_GAS ? MAX_ACTION_GAS : BigInt(c.gas)).toString(),
          })),
        },
      },
    },
  };
}

export const toBase64 =(o: object) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));

export function describeCall(method: string): string {
  const names: Record<string, string> = {
    approve: "Approve a payment",
    reject: "Reject a payment",
    update_policy: "Change limits",
    add_bill: "Add a bill",
    cancel_bill: "Remove a bill",
    add_payee: "Approve a payee",
    remove_payee: "Remove a payee",
    pause: "Pause payments",
    resume: "Resume payments",
    withdraw: "Pay out from the vault",
    recall_from_yield: "Withdraw the yield investment",
    revoke_agent: "Remove Keel's key",
    set_agent_key: "Set Keel's key",
    transfer_owner: "Hand the vault to a new owner",
  };
  return names[method] ?? method;
}

/** Teams (multisig accounts) this browser follows, so their vaults show in the company list. */
const TEAMS_KEY = "keel-teams";
export function savedTeams(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TEAMS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function saveTeams(teams: string[]) {
  try {
    localStorage.setItem(TEAMS_KEY, JSON.stringify([...new Set(teams)]));
  } catch {
    /* private mode: the list lasts for this page only */
  }
}
