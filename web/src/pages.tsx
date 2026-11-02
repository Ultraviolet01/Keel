import { useState } from "react";
import { companyName, EXPLORER_TX, formatNear, formatToken, shortKey, type Proposal } from "./near";
import { Check, Copy, LoadLine } from "./icons";
import type { Send } from "./panels";
import type { VaultData } from "./vault";

export interface PageProps {
  vaultId: string;
  data: VaultData;
  canAct: boolean;
  send: Send;
  reload: () => Promise<void>;
  onSetLimits: () => void;
  onDeposit: () => void;
}

const STATUS_PILL: Record<Proposal["status"], { label: string; cls: string }> = {
  pending: { label: "Needs you", cls: "warn" },
  executing: { label: "Settling", cls: "warn" },
  executed: { label: "Paid", cls: "ok" },
  rejected: { label: "Rejected", cls: "bad" },
  failed: { label: "Failed", cls: "bad" },
};

function amt(raw: string, d: VaultData) {
  return `${formatToken(raw, d.token.decimals)} ${d.token.symbol}`;
}

function when(ms: number) {
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Head({ title, sub, children }: { title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="head">
      <div>
        <h1 className="serif">{title}</h1>
        <p className="sub">{sub}</p>
      </div>
      <div className="tools">{children}</div>
    </div>
  );
}

function hasLimits(d: VaultData) {
  return d.policy.per_payment_cap !== "0" && d.policy.daily_cap !== "0";
}

// ----------------------------------------------------------------- overview

export function Overview(p: PageProps) {
  const { data: d } = p;
  const limits = hasLimits(d);
  const funded = d.balance !== "0";
  const payees = d.policy.allowlist.length > 0;
  const agentOn = Boolean(d.policy.agent_key || d.policy.agent_id);
  const setupDone = limits && payees && funded;
  const recent = [...d.proposals].reverse().slice(0, 5);

  return (
    <>
      <Head title="Overview" sub={`${companyName(p.vaultId)} · ${p.vaultId}`}>
        <button className="btn" onClick={p.onDeposit}>
          Deposit
        </button>
        {p.canAct && (
          <button className="btn primary" onClick={p.onSetLimits}>
            {limits ? "Edit limits" : "Set limits"}
          </button>
        )}
      </Head>

      {!setupDone && (
        <section className="setup">
          <div>
            <h2 className="serif">Finish setting up {companyName(p.vaultId)}</h2>
            <p className="why">
              {limits
                ? "A few steps left before Keel can look after this company's money."
                : "Until you set limits, Keel can't pay anything on its own. It can still propose payments for you to approve."}
            </p>
          </div>
          <div className="checklist">
            <Step done title="Vault created" note={`${p.vaultId} · owned by ${d.policy.owner_id}`} mono />
            <Step
              done={agentOn}
              title={agentOn ? "Keel's agent connected" : "Keel's agent is off"}
              note={agentOn ? "Can call execute_payment and propose_payment only" : "Add its key back from Rules"}
            />
            <Step done={limits} title="Set your limits" note="Per payment, per day, and when Keel must ask you">
              {p.canAct && (
                <button className="btn primary sm" onClick={p.onSetLimits}>
                  Set limits
                </button>
              )}
            </Step>
            <Step done={payees} title="Add the payees Keel may pay" note="Suppliers, payroll and your other wallets">
              {p.canAct && (
                <button className="btn sm" onClick={p.onSetLimits}>
                  Add payees
                </button>
              )}
            </Step>
            <Step done={funded} title={`Deposit ${d.token.symbol}`} note={`Send ${d.token.symbol} on NEAR to ${p.vaultId}`}>
              <button className="btn sm" onClick={p.onDeposit}>
                Deposit
              </button>
            </Step>
          </div>
        </section>
      )}

      <div className="grid2">
        <div className="stack">
          <section className="card card-pad">
            <span className="muted">Total treasury</span>
            <div className="big serif num">
              {formatToken(d.balance, d.token.decimals)}
              <small>{d.token.symbol}</small>
            </div>
            <span className="muted small">1 wallet on NEAR</span>
            <div className="empty-chart">
              {funded
                ? "The 14-day forecast appears once Keel has bills to watch"
                : `Keel starts forecasting once the vault holds ${d.token.symbol} and has bills to watch`}
            </div>
          </section>
          <section className="card card-pad">
            <h2>Keel's decisions</h2>
            <p className="sub">Every move, with the rule it checked</p>
            {recent.length === 0 ? (
              <div className="empty">No moves yet. Each payment Keel makes or proposes will show here with the rule it checked.</div>
            ) : (
              <ul className="decisions">
                {recent.map((x) => (
                  <li key={x.id}>
                    <span className={`pill ${STATUS_PILL[x.status].cls}`}>{STATUS_PILL[x.status].label}</span>
                    <span className="d-main">
                      <b>Pay {x.receiver_id}</b>
                      <span className="muted small">{x.reason}</span>
                    </span>
                    <span className="num d-amt">{amt(x.amount, d)}</span>
                    <span className="muted small d-when">{when(x.created_at_ms)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <div className="stack">
          <RulesCard d={d} />
          <section className="card card-pad">
            <h2>Deposit address</h2>
            <p className="sub">{d.token.symbol} on NEAR. Other chains come through NEAR Intents once limits are set.</p>
            <CopyAddress value={p.vaultId} />
          </section>
        </div>
      </div>
    </>
  );
}

function Step(props: { done: boolean; title: string; note: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className={`ck ${props.done ? "done" : ""}`}>
      <span className="box">{props.done && <Check size={13} />}</span>
      <span className="t">
        <b>{props.title}</b>
        <span className={props.mono ? "mono" : ""}>{props.note}</span>
      </span>
      {!props.done && props.children}
    </div>
  );
}

function RulesCard({ d }: { d: VaultData }) {
  const cap = (raw: string) => (raw === "0" ? <span className="brass">Not set</span> : amt(raw, d));
  return (
    <section className="card card-pad">
      <div className="rules-head">
        <h2>
          <LoadLine className="brass" />
          Active rules
        </h2>
        <span className="muted small">Enforced on chain</span>
      </div>
      <div className="rl">
        <div>
          <span>Per payment</span>
          <span className="num">{cap(d.policy.per_payment_cap)}</span>
        </div>
        <div>
          <span>Per day</span>
          <span className="num">
            {d.policy.daily_cap === "0" ? cap("0") : `${formatToken(d.policy.spent_today, d.token.decimals)} of ${amt(d.policy.daily_cap, d)} used`}
          </span>
        </div>
        <div>
          <span>Approval needed</span>
          <span>{hasLimits(d) ? `Above ${amt(d.policy.per_payment_cap, d)}, new payees, swaps` : "Every payment"}</span>
        </div>
        <div>
          <span>Allowed payees</span>
          <span>{d.policy.allowlist.length || "None"}</span>
        </div>
        <div>
          <span>Blocked addresses</span>
          <span>{d.policy.blocklist.length || "None"}</span>
        </div>
      </div>
    </section>
  );
}

function CopyAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="addr">
      <span className="mono ink">{value}</span>
      <button
        className="icon-btn"
        aria-label="Copy address"
        onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {})}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- approvals

export function Approvals(p: PageProps) {
  const d = p.data;
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const pending = d.proposals.filter((x) => x.status === "pending");
  const decided = d.proposals.filter((x) => x.status !== "pending").reverse();

  const act = async (id: number, method: "approve" | "reject") => {
    setBusy(id);
    setError(null);
    try {
      const out = await p.send(p.vaultId, method, { proposal_id: id }, { deposit: "1", gas: method === "approve" ? "100000000000000" : "30000000000000" });
      setTx(out.transaction.hash);
      await p.reload();
    } catch (e) {
      const msg = String(e);
      setError(/reject|cancel/i.test(msg) ? "You cancelled the transaction in your wallet." : msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Head title="Approvals" sub={pending.length ? `${pending.length} waiting for you` : "Nothing waiting for you"} />
      {error && <p className="error">{error}</p>}
      {tx && (
        <p className="muted small">
          Signed:{" "}
          <a className="mono" href={EXPLORER_TX + tx} target="_blank" rel="noreferrer">
            {tx.slice(0, 10)}…
          </a>
        </p>
      )}
      <section className="card card-pad">
        <h2>Waiting</h2>
        {pending.length === 0 ? (
          <div className="empty">When Keel proposes a payment above your limits, to a new payee or across chains, it waits here for you.</div>
        ) : (
          <ul className="queue">
            {pending.map((x) => (
              <li key={x.id}>
                <div className="q-main">
                  <span className="muted small">Proposal #{x.id} · {when(x.created_at_ms)}</span>
                  <b>Pay {x.receiver_id}</b>
                  <span className="small">{x.reason}</span>
                </div>
                <span className="q-amt serif num">{amt(x.amount, d)}</span>
                {p.canAct && (
                  <span className="q-act">
                    <button className="btn danger" disabled={busy !== null} onClick={() => act(x.id, "reject")}>
                      Reject
                    </button>
                    <button className="btn primary" disabled={busy !== null} onClick={() => act(x.id, "approve")}>
                      {busy === x.id ? "Approve in wallet" : "Approve and sign"}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {decided.length > 0 && (
        <section className="card card-pad gap-top">
          <h2>Recently decided</h2>
          <ProposalTable rows={decided} d={d} />
        </section>
      )}
    </>
  );
}

function ProposalTable({ rows, d }: { rows: Proposal[]; d: VaultData }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>What happened</th>
          <th className="r">Amount</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <tr key={x.id}>
            <td className="muted">{when(x.created_at_ms)}</td>
            <td>
              Pay {x.receiver_id}
              <span className="muted small block">{x.reason}</span>
            </td>
            <td className="r num">{amt(x.amount, d)}</td>
            <td>
              <span className={`pill ${STATUS_PILL[x.status].cls}`}>{STATUS_PILL[x.status].label}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ----------------------------------------------------------------- activity

export function Activity(p: PageProps) {
  const rows = [...p.data.proposals].reverse();
  return (
    <>
      <Head title="Activity" sub="Every proposal on this vault and how it ended" />
      <section className="card card-pad">
        {rows.length === 0 ? (
          <div className="empty">No activity yet. Payments Keel makes alone will appear here once the ledger page reads the vault's events.</div>
        ) : (
          <ProposalTable rows={rows} d={p.data} />
        )}
      </section>
    </>
  );
}

// -------------------------------------------------------------------- rules

export function Rules(p: PageProps) {
  const d = p.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <Head title="Rules" sub="Enforced by your vault contract. Only your wallet can change them.">
        {p.canAct && (
          <button className="btn primary" onClick={p.onSetLimits}>
            {hasLimits(d) ? "Edit limits" : "Set limits"}
          </button>
        )}
      </Head>
      <div className="grid2">
        <section className="card card-pad">
          <h2>Payees</h2>
          <p className="sub">Paid without asking, within your limits</p>
          {d.policy.allowlist.length === 0 ? (
            <div className="empty">No payees yet. Keel proposes every payment until you add some.</div>
          ) : (
            <ul className="plain">
              {d.policy.allowlist.map((a) => (
                <li key={a}>
                  <span className="mono ink">{a}</span>
                  <span className="pill ok">Allowed</span>
                </li>
              ))}
              {d.policy.blocklist.map((a) => (
                <li key={a}>
                  <span className="mono ink">{a}</span>
                  <span className="pill bad">Blocked</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <RulesCard d={d} />
      </div>
      <section className="agent-card gap-top">
        <div>
          <h2>What Keel's agent can and cannot do</h2>
          <p>
            Its key lives on this vault and can only call execute_payment and propose_payment. It cannot change rules, add keys or
            pay past your limits.
          </p>
          <span className="mono light">
            {d.policy.agent_key
              ? `${shortKey(d.policy.agent_key)} · gas left ${formatNear(d.gas)} NEAR`
              : d.policy.agent_id
                ? `Separate agent account ${d.policy.agent_id}`
                : "No agent key on this vault"}
          </span>
        </div>
        {p.canAct && d.policy.agent_key && (
          <button className="btn danger-outline" onClick={revoke} disabled={busy}>
            {busy ? "Approve in wallet" : "Remove Keel's agent"}
          </button>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </>
  );
}

// ------------------------------------------------------------------ wallets

export function Wallets(p: PageProps) {
  const d = p.data;
  return (
    <>
      <Head title="Wallets" sub="Keel keeps each wallet above its minimum">
        <button className="btn" onClick={p.onDeposit}>
          Deposit
        </button>
      </Head>
      <div className="grid2">
        <section className="card card-pad">
          <div className="w-top">
            <b>{companyName(p.vaultId)} vault</b>
            <span className="tag">NEAR</span>
          </div>
          <span className="mono">{p.vaultId}</span>
          <div className="big serif num">
            {formatToken(d.balance, d.token.decimals)}
            <small>{d.token.symbol}</small>
          </div>
          <span className="muted small">{formatNear(d.gas)} NEAR left for Keel's gas</span>
        </section>
        <section className="card card-pad">
          <h2>Wallets on other chains</h2>
          <p className="sub">Payroll on Base, vendors on Arbitrum and others</p>
          <div className="empty">Linking wallets on other chains comes with NEAR Intents. For now this company has one vault on NEAR.</div>
        </section>
      </div>
    </>
  );
}
