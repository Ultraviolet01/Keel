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

/** Gas all of a proposal's actions may use together; Sputnik runs them inside the final vote (sent with 300 Tgas). */
const MAX_PROPOSAL_GAS = 200_000_000_000_000n;

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
          actions: calls.map((c) => {
            // The final vote's transaction carries the whole batch, so the actions share one budget.
            const share = MAX_PROPOSAL_GAS / BigInt(calls.length);
            const want = BigInt(c.gas);
            return { method_name: c.methodName, args: toBase64(c.args), deposit: c.deposit, gas: (want > share ? share : want).toString() };
          }),
        },
      },
    },
  };
}

export const toBase64 =(o: object) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));

/** A proposal action's arguments as readable JSON, so members see exactly what they vote for. */
export function readArgs(b64: string): string {
  try {
    return JSON.stringify(JSON.parse(decodeURIComponent(escape(atob(b64)))));
  } catch {
    return "(arguments could not be read; do not approve)";
  }
}

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
    transfer_owner: "Offer the vault to a new owner",
    cancel_owner_transfer: "Withdraw the ownership offer",
    accept_owner: "Accept ownership of the vault",
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

/**
 * The multisigs that own a Keel vault and list `accountId` as a member, so a
 * member's team companies show up without typing the team's account. Reads
 * every vault's owner from the factory (fine at testnet scale).
 */
export async function teamsOf(accountId: string, factoryId: string): Promise<string[]> {
  const vaults: string[] = [];
  for (let from = 0; from < 2000; from += 100) {
    const page = await view<string[]>(factoryId, "get_vaults", { from_index: from, limit: 100 });
    vaults.push(...page);
    if (page.length < 100) break;
  }
  const owners = await Promise.all(vaults.map((v) => view<string | null>(factoryId, "get_owner", { vault_id: v }).catch(() => null)));
  const candidates = [...new Set(owners.filter((o): o is string => !!o && o !== accountId))];
  const found = await Promise.all(candidates.map((o) => multisigOf(o).catch(() => null)));
  return found.filter((m): m is Multisig => !!m && m.members.includes(accountId)).map((m) => m.dao);
}
