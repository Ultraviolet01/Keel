// Payees and Rules, with the optional multisig owner.

import { useState } from "react";
import { NETWORK, accountExists, companyName, formatNear, shortKey } from "../near";
import { Pause, Play } from "../icons";
import {
  SPUTNIK_CREATE_DEPOSIT,
  SPUTNIK_FACTORY,
  createTeamArgs,
  describeCall,
  memberProposal,
  memberRole,
  membersOnlyProposal,
  multisigOf,
  openToAll,
  proposalCall,
  readArgs,
  rightsOf,
  validTeamName,
  type DaoProposal,
  type Multisig,
} from "../multisig";
import { PAYEE_KINDS } from "../bills";
import { type PageProps, ACCOUNT_URL, usd, amt, Head, TGAS } from "./shared";

// -------------------------------------------------------------------- rules

export function Payees(p: PageProps) {
  const d = p.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const named = new Map((d.payees ?? []).map((x) => [x.account_id, x]));
  // Every approved account, named or not, plus blocked ones at the end.
  const rows = [...d.policy.allowlist.map((id) => ({ id, payee: named.get(id), blocked: false })), ...d.policy.blocklist.map((id) => ({ id, payee: undefined, blocked: true }))];
  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      if (d.payees) await p.send(p.vaultId, "remove_payee", { account_id: id }, { deposit: "1", gas: "30000000000000" });
      else await p.send(p.vaultId, "update_policy", { update: { disallow: [id] }, reason: `Removed payee ${id}` }, { deposit: "1", gas: "30000000000000" });
      await p.reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).slice(0, 160));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Head title="Payees" sub="Where Keel may send money on its own, within your caps. Anyone else needs your approval each time.">
        {p.canAct && d.payees !== null && (
          <button className="btn primary" onClick={p.onAddPayee}>
            Approve a payee
          </button>
        )}
      </Head>
      <section className="card card-pad">
        <p className="sub">
          Card subscriptions such as domains, software and cloud charge your company card; approve the card's wallet here with a balance to keep, and Keel tops it up. Bank-only bills go to a bank off-ramp you approve here.
        </p>
        {d.payees === null && <p className="muted small">This vault was created before payees could be named; it shows the allowlist from your rules. Add payees with Set limits.</p>}
        {rows.length === 0 ? (
          <div className="empty">No payees yet. Approve your vendors, your company card wallet and your bank off-ramp, and Keel can pay them without asking you.</div>
        ) : (
          <ul className="bills">
            {rows.map((r) => (
              <li key={r.id}>
                <b>{r.payee?.name ?? (r.blocked ? "Blocked" : "Approved payee")}</b>
                <span className="bill-side">
                  {r.blocked ? <span className="pill bad">Blocked</span> : <span className="pill ok">Approved by you</span>}
                </span>
                <span className="bill-meta">
                  <span className="mono">{r.id}</span>
                  {r.payee ? ` · ${PAYEE_KINDS[r.payee.kind]?.label ?? r.payee.kind}` : ""}
                  {r.payee?.keep_at ? ` · kept at ${amt(r.payee.keep_at, d)}` : ""}
                  {r.payee?.max_move ? ` · idle cash, up to ${amt(r.payee.max_move, d)} per move` : ""}
                  {r.payee?.lending ? " · lending market" : ""}
                </span>
                <span className="bill-side">
                  {p.canAct && !r.blocked && (
                    <button className="link-btn" disabled={busy === r.id} onClick={() => remove(r.id)}>
                      {busy === r.id ? "Approve in wallet" : "Remove"}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </>
  );
}

export function Rules(p: PageProps) {
  const d = p.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = (raw: string) => (raw === "0" ? <span className="brass">Not set</span> : <>{usd(raw, d).replace(/\.00$/, "")} <small>{d.token.symbol}</small></>);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await p.send(p.vaultId, "revoke_agent", {}, { deposit: "1" });
      await p.reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head title="Rules" sub={d.multisig ? "Enforced by the Keel Vault contract. Only your team's multisig can change them." : "Enforced by the Keel Vault contract. Only your key can change them."}>
        <a className="btn" href={ACCOUNT_URL + p.vaultId} target="_blank" rel="noreferrer">View contract</a>
      </Head>
      <div className="rules-grid">
        <section className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Spending limits</h2>
              <p className="sub">Every agent payment</p>
            </div>
            {p.canAct && <button className="btn" onClick={p.onSetLimits}>Edit limits</button>}
          </div>
          <div className="limit-rows">
            <div><span><b>Per payment</b><small>Max single payment without you</small></span><span className="vbox num">{box(d.policy.per_payment_cap)}</span></div>
            <div><span><b>Per day</b><small>Max per day without you</small></span><span className="vbox num">{box(d.policy.daily_cap)}</span></div>
            <div><span><b>Approval needed above</b><small>Larger goes to Approvals</small></span><span className="vbox num">{box(d.policy.per_payment_cap)}</span></div>
            <div><span><b>Spent in 24 hours</b><small>Last 24 hours, counts against the daily cap</small></span><span className="vbox num">{usd(d.policy.spent_today, d)} <small>{d.token.symbol}</small></span></div>
          </div>
        </section>
        <section className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Payees</h2>
              <p className="sub">Paid without asking</p>
            </div>
            {p.canAct && <button className="btn" onClick={p.onSetLimits}>Add payee</button>}
          </div>
          <ul className="payees">
            {d.policy.allowlist.length === 0 && <li className="muted small">No payees yet. Keel proposes every payment until you add some.</li>}
            {d.policy.allowlist.map((a) => (
              <li key={a}>
                <span><b>{companyName(a) === a ? a : companyName(a)}</b><span className="mono block">{a} on NEAR</span></span>
                <span className="payee-right">
                  {d.policy.per_payment_cap !== "0" && <span className="small">cap {usd(d.policy.per_payment_cap, d).replace(/\.00$/, "")}</span>}
                  <span className="pill ok">Allowed</span>
                </span>
              </li>
            ))}
            <li>
              <span><b>{d.policy.blocklist.length} blocked {d.policy.blocklist.length === 1 ? "address" : "addresses"}</b><span className="muted small block">Never paid, even if you approve</span></span>
              <span className="pill bad">Blocked</span>
            </li>
          </ul>
        </section>
      </div>
      <section className="agent-card gap-top">
        <div>
          <h2>What the agent can and cannot do</h2>
          <p>Its key can only call execute_payment and propose_payment. It cannot change rules, add keys or overspend.</p>
          <span className="mono light">
            {d.policy.agent_key
              ? `${shortKey(d.policy.agent_key)}, ${formatNear(d.gas)} NEAR left in the vault for gas`
              : d.policy.agent_id
                ? `Separate agent account ${d.policy.agent_id}`
                : "No agent key on this vault"}
          </span>
        </div>
        {p.canAct && (
          <div className="agent-actions">
            <button className="btn danger-outline" onClick={p.onPauseToggle}>
              {d.policy.paused ? <Play size={14} /> : <Pause size={14} />}
              {d.policy.paused ? "Resume payments" : "Pause all payments"}
            </button>
            {d.policy.agent_key && (
              <button className="btn dark" onClick={revoke} disabled={busy}>
                {busy ? "Approve in wallet" : "Remove agent key"}
              </button>
            )}
          </div>
        )}
      </section>
      <MultisigCard p={p} />
      {error && <p className="error">{error}</p>}
    </>
  );
}


/** Open proposals on a multisig for this vault, with the exact calls and arguments, and vote buttons for members. */
function DaoVotes({ p, ms, list, busy, act }: { p: PageProps; ms: Multisig; list: DaoProposal[]; busy: string | null; act: (key: string, run: () => Promise<unknown>) => void }) {
  const voters = ms.members.filter((m) => rightsOf(ms, m).approve);
  const need = ms.threshold ? Math.min(Math.floor((voters.length * ms.threshold[0]) / ms.threshold[1]) + 1, voters.length) : null;
  const me = rightsOf(ms, p.accountId);
  const connected = !!p.onSignOut;
  if (list.length === 0) return <p className="muted small">No open proposals for this vault.</p>;
  return (
    <>
      {list.map((x) => {
        const yes = Object.values(x.votes).filter((v) => v === "Approve").length;
        const no = Object.values(x.votes).filter((v) => v === "Reject").length;
        const voted = p.accountId in x.votes;
        const actions = x.kind.FunctionCall?.actions ?? [];
        const vote = (action: "VoteApprove" | "VoteReject") =>
          act(`${x.id}:${action}`, () => p.send(ms.dao, "act_proposal", { id: x.id, action, proposal: x.kind }, { gas: TGAS(300) }));
        return (
          <div className="ms-prop" key={x.id}>
            <span>
              <b>
                #{x.id}{" "}
                {x.kind.AddMemberToRole
                  ? `Add ${x.kind.AddMemberToRole.member_id} to the team`
                  : x.kind.RemoveMemberFromRole
                    ? `Remove ${x.kind.RemoveMemberFromRole.member_id} from the team`
                    : x.kind.ChangePolicy
                      ? "Change the multisig's rules: only members can file proposals"
                      : [...new Set(actions.map((a) => describeCall(a.method_name)))].join(", ") || "Proposal"}
              </b>
              {actions.map((a, k) => (
                <span key={k} className="mono tiny wrap-any">
                  {a.method_name}({readArgs(a.args)}){a.deposit !== "1" && a.deposit !== "0" ? `, attaches ${formatNear(a.deposit)} NEAR` : ""}
                </span>
              ))}
              <span className="muted small">
                Filed by <span className="mono">{x.proposer}</span>
                {ms.members.includes(x.proposer) ? "" : <b className="bad-t"> (not a member of this multisig: anyone may file here, so check it carefully)</b>}. {yes} approved, {no} rejected{need ? `, ${need} needed` : ""}.{actions.length ? " Check the arguments above, not the description." : ""}
              </span>
            </span>
            {connected && (me.approve || me.reject) && !voted ? (
              <span className="agent-actions">
                {me.reject && <button className="btn sm" onClick={() => vote("VoteReject")} disabled={busy !== null}>Reject</button>}
                {me.approve && (
                  <button className="btn dark sm" onClick={() => vote("VoteApprove")} disabled={busy !== null}>
                    {busy === `${x.id}:VoteApprove` ? "Approve in wallet" : "Approve"}
                  </button>
                )}
              </span>
            ) : (
              <span className="pill muted">{voted ? `You voted ${x.votes[p.accountId].toLowerCase()}` : me.member ? "Your role cannot vote" : "Members vote"}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Optional multisig ownership: votes for a DAO-owned vault, the open offer, or the hand-over form. */
function MultisigCard({ p }: { p: PageProps }) {
  const d = p.data;
  const ms = d.multisig;
  const pending = d.policy.pending_owner ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState("");
  const [newMember, setNewMember] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamMembers, setTeamMembers] = useState(p.accountId);
  const [created, setCreated] = useState<string | null>(null);
  const isOwner = d.policy.owner_id === p.accountId;

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await p.reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const errorLine = error && <p className="error">{error}</p>;

  if (ms) {
    const role = memberRole(ms);
    const canPropose = !!p.onSignOut && rightsOf(ms, p.accountId).propose;
    const fileMember = (change: "add" | "remove", member: string) =>
      act("member", async () => {
        if (change === "add" && !(await accountExists(member))) throw new Error(`${member} does not exist on NEAR testnet.`);
        if (change === "add" && ms.members.includes(member)) throw new Error(`${member} is already a member.`);
        await p.send(ms.dao, "add_proposal", memberProposal(change, member, role!), { deposit: ms.bond, gas: TGAS(50) });
        setNewMember("");
      });
    const voters = ms.members.filter((m) => rightsOf(ms, m).approve).length;
    const need = ms.threshold ? Math.min(Math.floor((voters * ms.threshold[0]) / ms.threshold[1]) + 1, voters) : null;
    return (
      <section className="card card-pad gap-top">
        <div className="card-head">
          <div>
            <h2>Multisig owner</h2>
            <p className="sub">
              <span className="mono">{ms.dao}</span> owns this vault. Changes run once {need ? `${need} of ${voters}` : "enough"} voting members approve them.
            </p>
          </div>
          <a className="btn" href={ACCOUNT_URL + ms.dao} target="_blank" rel="noreferrer">View multisig</a>
        </div>
        <div className="ms-members">
          {ms.members.map((m) => {
            const r = rightsOf(ms, m);
            const what = r.propose && r.approve ? "proposes and votes" : r.approve ? "votes" : r.propose ? "proposes" : "no rights here";
            return (
              <span key={m} className={`pill ${m === p.accountId ? "ok" : "muted"}`} title={what}>
                {m}
                {m === p.accountId ? " (you)" : ""} · {what}
                {canPropose && role && ms.members.length > 1 && (
                  <button className="pill-x" title={`Propose removing ${m}`} aria-label={`Propose removing ${m}`} onClick={() => fileMember("remove", m)} disabled={busy !== null}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
        {canPropose && role && (
          <form
            className="team-form"
            style={{ padding: 0, marginBottom: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              fileMember("add", newMember.trim().toLowerCase());
            }}
          >
            <input placeholder="new-member.testnet" value={newMember} onChange={(e) => setNewMember(e.target.value)} aria-label="Account to add to the team" />
            <button className="btn sm" type="submit" disabled={!newMember.trim() || busy !== null}>
              {busy === "member" ? "Approve in wallet" : "Propose adding"}
            </button>
          </form>
        )}
        {canPropose && <p className="muted tiny">Adding or removing a member is a proposal too: it happens once enough members approve it below.</p>}
        {openToAll(ms) && (
          <div className="ms-open small">
            <span>
              Anyone on NEAR can file proposals on this multisig for a {formatNear(ms.bond)} NEAR bond, so outsiders can fill your vote list. Keel only
              emails you about proposals filed by members.
            </span>
            {canPropose && !d.multisigProposals.some((x) => x.kind.ChangePolicy) && (
              <button className="btn sm" onClick={() => act("members-only", async () => p.send(ms.dao, "add_proposal", await membersOnlyProposal(ms.dao), { deposit: ms.bond, gas: TGAS(50) }))} disabled={busy !== null}>
                {busy === "members-only" ? "Approve in wallet" : "Only members can propose"}
              </button>
            )}
          </div>
        )}
        {pending && <p className="small brass">This vault is offered to <span className="mono">{pending}</span>; it has not accepted.</p>}
        <DaoVotes p={p} ms={ms} list={d.multisigProposals} busy={busy} act={act} />
        {errorLine}
      </section>
    );
  }

  // An open offer: the owner can withdraw it; the offered account (or its members) accept.
  if (pending) {
    const team = d.offeredTo;
    const member = !!team && rightsOf(team, p.accountId).propose;
    const fileAccept = () =>
      act("accept", () =>
        p.send(team!.dao, "add_proposal", proposalCall(p.vaultId, [{ methodName: "accept_owner", args: {}, gas: TGAS(60), deposit: "1" }], `Keel: accept ownership of ${p.vaultId}`), {
          deposit: team!.bond,
          gas: TGAS(50),
        }).then(() => p.onTeam(team!.dao)),
      );
    return (
      <section className="card card-pad gap-top">
        <div className="card-head">
          <div>
            <h2>Ownership offered</h2>
            <p className="sub">
              {isOwner ? "You offered" : <><span className="mono">{d.policy.owner_id}</span> offered</>} this vault to <span className="mono">{pending}</span>. Nothing
              changes until it accepts. Before accepting, check this vault's payees, bills and limits: the current owner set them, and Keel will
              follow them.
            </p>
          </div>
          {p.canAct && isOwner && (
            <button className="btn" onClick={() => act("cancel", () => p.send(p.vaultId, "cancel_owner_transfer", {}, { deposit: "1" }))} disabled={busy !== null}>
              {busy === "cancel" ? "Approve in wallet" : "Withdraw offer"}
            </button>
          )}
        </div>
        {p.onSignOut && p.accountId === pending && (
          <button className="btn dark" onClick={() => act("accept", () => p.send(p.vaultId, "accept_owner", {}, { deposit: "1", gas: TGAS(60) }))} disabled={busy !== null}>
            {busy === "accept" ? "Approve in wallet" : "Accept ownership"}
          </button>
        )}
        {team && (
          <>
            <p className="muted small">
              <span className="mono">{team.dao}</span> is a multisig: a member files the acceptance, then members vote on it.
            </p>
            {p.onSignOut && member && d.offerProposals.length === 0 && (
              <button className="btn dark" onClick={fileAccept} disabled={busy !== null}>
                {busy === "accept" ? "Approve in wallet" : `File acceptance on ${team.dao}`}
              </button>
            )}
            <DaoVotes p={{ ...p, canAct: !!p.onSignOut }} ms={team} list={d.offerProposals} busy={busy} act={act} />
          </>
        )}
        {errorLine}
      </section>
    );
  }

  if (!p.canAct || !isOwner) return null;
  const supported = "pending_owner" in d.policy;

  const createTeam = () =>
    act("create", async () => {
      const members = [...new Set(teamMembers.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
      if (!members.includes(p.accountId)) throw new Error("Include your own account, or you could not offer the company to the team.");
      for (const m of members) if (!(await accountExists(m))) throw new Error(`${m} does not exist on NEAR testnet.`);
      const dao = `${teamName}.${SPUTNIK_FACTORY[NETWORK]}`;
      if (await accountExists(dao)) throw new Error(`${dao} is already taken: pick another team name.`);
      await p.send(SPUTNIK_FACTORY[NETWORK], "create", createTeamArgs(teamName, members, `Treasury team for ${p.vaultId}`), { deposit: SPUTNIK_CREATE_DEPOSIT, gas: TGAS(150) });
      if (!(await accountExists(dao))) throw new Error("The multisig was not created. Check your NEAR balance (it needs about 6 NEAR) and try again.");
      setCreated(dao);
      setTeam(dao);
      p.onTeam(dao);
    });

  const offer = () =>
    act("hand", async () => {
      const dao = team.trim().toLowerCase();
      const found = await multisigOf(dao);
      if (!found) throw new Error(`${dao} is not a multisig (Sputnik DAO) account on testnet.`);
      if (!found.members.includes(p.accountId)) throw new Error(`You are not a member of ${dao}, so you would lose access to this vault.`);
      await p.send(p.vaultId, "transfer_owner", { new_owner_id: dao }, { deposit: "1" });
      p.onTeam(dao);
    });

  return (
    <section className="card card-pad gap-top">
      <div className="card-head">
        <div>
          <h2>Hand ownership to a multisig</h2>
          <p className="sub">
            Optional. Offer this vault to your team's multisig (a Sputnik DAO, like a Trezu treasury). Once its members accept, every change, from
            limits to approvals, becomes a proposal they vote on. Keel keeps running as before.
          </p>
        </div>
      </div>
      {supported && (
        <details className="create-team">
          <summary>No multisig yet? Create one for your team here</summary>
          <p className="muted small">
            Keel creates a Sputnik DAO multisig with these members (the same contracts Trezu uses). Any change then needs more than half of them to
            approve. It costs {formatNear(SPUTNIK_CREATE_DEPOSIT)} NEAR, which stays in the multisig for its storage. Members can be added or removed
            later by a vote.
          </p>
          <label className="field">
            <span className="label">Team name</span>
            <div className="input-group">
              <input value={teamName} onChange={(e) => setTeamName(e.target.value.toLowerCase())} placeholder="acme-team" />
              <span className="suffix">.{SPUTNIK_FACTORY[NETWORK]}</span>
            </div>
          </label>
          <label className="field">
            <span className="label">Members (one NEAR account per line, including you)</span>
            <textarea className="mono-input" rows={3} value={teamMembers} onChange={(e) => setTeamMembers(e.target.value)} />
          </label>
          <button className="btn" onClick={createTeam} disabled={busy !== null || !validTeamName(teamName)}>
            {busy === "create" ? "Approve in wallet" : "Create multisig"}
          </button>
          {created && <p className="small">Created <span className="mono">{created}</span>. It is filled in below: click Offer to hand this company to it.</p>}
        </details>
      )}
      {supported ? (
        <div className="team-form" style={{ padding: 0 }}>
          <input placeholder="team.sputnikv2.testnet" value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Multisig account" />
          <button className="btn dark" onClick={offer} disabled={!team.trim() || busy !== null}>
            {busy === "hand" ? "Approve in wallet" : "Offer"}
          </button>
        </div>
      ) : (
        <p className="muted small">This vault was created before safe hand-over existed. Create a new company to use a multisig.</p>
      )}
      {errorLine}
    </section>
  );
}
