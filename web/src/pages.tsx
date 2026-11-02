// App pages, laid out from the Figma frames (Overview, Approvals, Activity,
// Rules, Wallets). Live vault data fills them; where the contract has no data
// yet (bills, minimums, other chains) the page says so plainly.

import { useEffect, useMemo, useState } from "react";
import { companyName, formatNear, formatToken, shortKey, view, type Proposal } from "./near";
import { Check, LoadLine, Pause, Play, Shield } from "./icons";
import type { Send } from "./panels";
import type { Page } from "./Sidebar";
import type { VaultData } from "./vault";

export interface PageProps {
  vaultId: string;
  data: VaultData;
  canAct: boolean;
  send: Send;
  reload: () => Promise<void>;
  go: (page: Page) => void;
  onSetLimits: () => void;
  onDeposit: () => void;
  onNewPayment: () => void;
  onPauseToggle: () => void;
}

const ACCOUNT_URL = "https://testnet.nearblocks.io/address/";

const PILL: Record<Proposal["status"], { label: string; cls: string }> = {
  pending: { label: "Needs approval", cls: "warn" },
  executing: { label: "Settling", cls: "warn" },
  executed: { label: "Paid", cls: "ok" },
  rejected: { label: "Rejected", cls: "bad" },
  failed: { label: "Failed", cls: "bad" },
};

const usd = (raw: string | bigint, d: VaultData) => formatToken(raw, d.token.decimals);
const amt = (raw: string | bigint, d: VaultData) => `${usd(raw, d)} ${d.token.symbol}`;
const hasLimits = (d: VaultData) => d.policy.per_payment_cap !== "0" && d.policy.daily_cap !== "0";

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function when(ms: number) {
  return new Date(ms).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function exportCsv(vaultId: string, d: VaultData) {
  const rows = [["proposal_id", "created_utc", "receiver", "amount", "token", "status", "reason"]];
  for (const x of d.proposals) {
    rows.push([String(x.id), new Date(x.created_at_ms).toISOString(), x.receiver_id, usd(x.amount, d).replace(/,/g, ""), d.token.symbol, x.status, x.reason]);
  }
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${vaultId}-ledger.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Head({ title, sub, children }: { title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="head">
      <div>
        <h1 className="serif">{title}</h1>
        <p className="sub">{sub}</p>
      </div>
      {children && <div className="tools">{children}</div>}
    </div>
  );
}

function Amount({ raw, d, size = "big" }: { raw: string | bigint; d: VaultData; size?: "big" | "mid" | "huge" }) {
  return (
    <div className={`${size} serif num`}>
      {usd(raw, d)}
      <small>{d.token.symbol}</small>
    </div>
  );
}

// ----------------------------------------------------------------- overview

export function Overview(p: PageProps) {
  const d = p.data;
  const pending = d.proposals.filter((x) => x.status === "pending");
  const limits = hasLimits(d);
  const funded = d.balance !== "0";
  const payees = d.policy.allowlist.length > 0;
  const agentOn = Boolean(d.policy.agent_key || d.policy.agent_id);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const sub = `${today}, ${pending.length ? `${pending.length} ${pending.length === 1 ? "item needs" : "items need"} you` : "nothing needs you"}`;

  return (
    <>
      <Head title="Overview" sub={sub}>
        <button className="btn" onClick={() => exportCsv(p.vaultId, d)}>
          Export
        </button>
        <button className="btn" onClick={p.onDeposit}>
          Deposit
        </button>
        {p.canAct && (
          <button className="btn primary" onClick={p.onNewPayment}>
            New payment
          </button>
        )}
      </Head>

      {!(limits && payees && funded) && (
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
            <Step done={agentOn} title={agentOn ? "Keel's agent connected" : "Keel's agent is off"} note={agentOn ? "Can call execute_payment and propose_payment only" : "Add its key back from Rules"} />
            <Step done={limits} title="Set your limits" note="Per payment, per day, and when Keel must ask you">
              {p.canAct && <button className="btn primary sm" onClick={p.onSetLimits}>Set limits</button>}
            </Step>
            <Step done={payees} title="Add the payees Keel may pay" note="Suppliers, payroll and your other wallets">
              {p.canAct && <button className="btn sm" onClick={p.onSetLimits}>Add payees</button>}
            </Step>
            <Step done={funded} title={`Deposit ${d.token.symbol}`} note={`Send ${d.token.symbol} on NEAR to ${p.vaultId}`}>
              <button className="btn sm" onClick={p.onDeposit}>Deposit</button>
            </Step>
          </div>
        </section>
      )}

      <div className="ov-top">
        <section className="card card-pad">
          <span className="muted">Total treasury</span>
          <Amount raw={d.balance} d={d} />
          <div className="legend-row">
            <span className="muted small">1 wallet on NEAR</span>
            <span className="legend">
              <i className="lg-line" />
              With Keel
            </span>
          </div>
          <Forecast d={d} />
        </section>
        <section className="needs">
          <div className="needs-top">
            Needs you<span>{pending.length} open</span>
          </div>
          {pending.length === 0 ? (
            <p className="needs-empty">Nothing waiting. When Keel proposes a payment above your limits, it lands here.</p>
          ) : (
            pending.slice(0, 2).map((x) => (
              <div key={x.id} className="needs-item">
                <b>
                  Pay {x.receiver_id}
                  <span className="num">{amt(x.amount, d)}</span>
                </b>
                <span>{x.reason}</span>
              </div>
            ))
          )}
          {pending.length > 0 && (
            <button className="btn primary block" onClick={() => p.go("approvals")}>
              Review {pending.length} {pending.length === 1 ? "item" : "items"}
            </button>
          )}
        </section>
      </div>

      <div className="wallet-row">
        <VaultCard p={p} />
        <section className="card card-pad add-wallet">
          <b>Wallets on other chains</b>
          <span className="muted small">Payroll on Base, vendors on Arbitrum. Linked through NEAR Intents.</span>
          <span className="tag">Coming with Intents</span>
        </section>
      </div>

      <div className="ov-bottom">
        <section className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Keel's decisions</h2>
              <p className="sub">Every move, with the rule it checked</p>
            </div>
            {d.proposals.length > 0 && (
              <button className="link-btn lg" onClick={() => p.go("activity")}>
                View all
              </button>
            )}
          </div>
          <Decisions rows={[...d.proposals].reverse().slice(0, 4)} d={d} />
        </section>
        <div className="stack">
          <section className="card card-pad">
            <h2>Upcoming payments</h2>
            <p className="sub">Next 14 days</p>
            <div className="empty">No bills yet. Bills Keel watches, like payroll and suppliers, will show here with their status.</div>
          </section>
          <RulesCard d={d} />
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

/** The 14-day chart. With no bills on file the balance runs flat, labelled honestly. */
function Forecast({ d }: { d: VaultData }) {
  const days = Array.from({ length: 5 }, (_, i) => {
    const t = new Date();
    t.setDate(t.getDate() + Math.round((i * 13) / 4));
    return t.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  });
  const top = d.balance === "0" ? "" : usd(d.balance, d).split(".")[0];
  return (
    <div className="forecast">
      <span className="muted small">Vault balance, next 14 days</span>
      <svg viewBox="0 0 860 220" preserveAspectRatio="none" aria-hidden="true">
        <g stroke="#e8eded">
          <line x1="40" x2="860" y1="30" y2="30" />
          <line x1="40" x2="860" y1="105" y2="105" />
          <line x1="40" x2="860" y1="180" y2="180" />
        </g>
        <path d={d.balance === "0" ? "M40 180 H860" : "M40 60 H860"} stroke="#0b5c55" strokeWidth="2.5" fill="none" />
        {d.balance !== "0" && <path d="M40 60 H860 V180 H40 Z" fill="#eef3f3" opacity="0.7" />}
      </svg>
      <div className="axis-y">
        <span className="mono">{top}</span>
        <span className="mono">0</span>
      </div>
      <div className="axis-x">
        {days.map((x) => (
          <span key={x}>{x}</span>
        ))}
      </div>
      <p className="muted tiny">No bills on file yet, so Keel forecasts a flat balance.</p>
    </div>
  );
}

function VaultCard({ p, selected, onClick }: { p: PageProps; selected?: boolean; onClick?: () => void }) {
  const d = p.data;
  const empty = d.balance === "0";
  return (
    <section className={`card card-pad wallet ${selected ? "selected" : ""}`} onClick={onClick}>
      <div className="w-top">
        <div>
          <b>Treasury vault</b>
          <span className="mono block">{p.vaultId}</span>
        </div>
        <span className="tag">NEAR</span>
      </div>
      <Amount raw={d.balance} d={d} size="mid" />
      <div className="w-foot">
        <span className="small">{empty ? "Empty, waiting for a deposit" : "No minimum set"}</span>
        <span className={`pill ${empty ? "warn" : "ok"}`}>{empty ? "Empty" : "Healthy"}</span>
      </div>
    </section>
  );
}

function Decisions({ rows, d }: { rows: Proposal[]; d: VaultData }) {
  if (rows.length === 0) return <div className="empty">No moves yet. Each payment Keel makes or proposes will show here with the rule it checked.</div>;
  return (
    <ul className="decisions">
      {rows.map((x) => (
        <li key={x.id}>
          <div className="dec-line">
            <span className={`pill ${PILL[x.status].cls}`}>{PILL[x.status].label}</span>
            <b>Pay {x.receiver_id}</b>
            <span className="dec-amt num">{amt(x.amount, d)}</span>
            <span className="muted small">{ago(x.created_at_ms)}</span>
          </div>
          <span className="dec-reason">{x.reason}</span>
        </li>
      ))}
    </ul>
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
        <div><span>Per payment</span><span className="num">{cap(d.policy.per_payment_cap)}</span></div>
        <div>
          <span>Per day</span>
          <span className="num">{d.policy.daily_cap === "0" ? cap("0") : `${usd(d.policy.spent_today, d)} of ${amt(d.policy.daily_cap, d)} used`}</span>
        </div>
        <div><span>Approval needed above</span><span className="num">{d.policy.per_payment_cap === "0" ? "Every payment" : amt(d.policy.per_payment_cap, d)}</span></div>
        <div><span>Allowed payees</span><span>{d.policy.allowlist.length ? `${d.policy.allowlist.length} addresses` : "None"}</span></div>
        <div><span>Blocked addresses</span><span>{d.policy.blocklist.length ? `${d.policy.blocklist.length} addresses` : "None"}</span></div>
        <div><span>New payees</span><span>Always need approval</span></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- approvals

interface Check {
  label: string;
  ok: boolean;
  bad?: boolean;
  result: string;
}

function checksFor(x: Proposal, d: VaultData): Check[] {
  const amount = BigInt(x.amount);
  const per = BigInt(d.policy.per_payment_cap);
  const daily = BigInt(d.policy.daily_cap);
  const spent = BigInt(d.policy.spent_today);
  const blocked = d.policy.blocklist.includes(x.receiver_id);
  const enough = BigInt(d.balance) >= amount;
  return [
    { label: "Not on the blocklist", ok: !blocked, bad: blocked, result: blocked ? "Blocked" : "Pass" },
    { label: "Destination allowlisted", ok: d.policy.allowlist.includes(x.receiver_id), result: d.policy.allowlist.includes(x.receiver_id) ? "Pass" : "Needs you" },
    { label: per === 0n ? "Per-payment cap" : `Under the ${usd(per, d)} per-payment cap`, ok: per > 0n && amount <= per, result: per > 0n && amount <= per ? "Pass" : "Needs you" },
    { label: "Within today's cap", ok: daily > 0n && spent + amount <= daily, result: daily > 0n && spent + amount <= daily ? "Pass" : "Needs you" },
    { label: "Vault holds enough", ok: enough, bad: !enough, result: enough ? "Pass" : "Short" },
    { label: "Payments running", ok: !d.policy.paused, bad: d.policy.paused, result: d.policy.paused ? "Paused" : "Pass" },
  ];
}

export function Approvals(p: PageProps) {
  const d = p.data;
  const [tab, setTab] = useState<"waiting" | "decided">("waiting");
  const pending = useMemo(() => d.proposals.filter((x) => x.status === "pending"), [d]);
  const decided = useMemo(() => d.proposals.filter((x) => x.status !== "pending").reverse(), [d]);
  const list = tab === "waiting" ? pending : decided;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = list.find((x) => x.id === selectedId) ?? list[0] ?? null;
  const [verdict, setVerdict] = useState<{ band: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVerdict(null);
    if (!selected) return;
    view<{ band: string; reason: string }>(p.vaultId, "check_payment", { receiver_id: selected.receiver_id, amount: selected.amount })
      .then(setVerdict)
      .catch(() => {});
  }, [selected, p.vaultId]);

  const act = async (method: "approve" | "reject") => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await p.send(p.vaultId, method, { proposal_id: selected.id }, { deposit: "1", gas: method === "approve" ? "100000000000000" : "30000000000000" });
      await p.reload();
    } catch (e) {
      setError(/reject|cancel/i.test(String(e)) ? "You cancelled the transaction in your wallet." : String(e));
    } finally {
      setBusy(false);
    }
  };

  const after = selected ? BigInt(d.balance) - BigInt(selected.amount) : 0n;

  return (
    <>
      <Head title="Approvals" sub={pending.length ? `${pending.length} waiting for you` : "Nothing waiting for you"} />
      <div className="appr">
        <section className="card appr-list">
          <div className="seg">
            <button className={tab === "waiting" ? "on" : ""} onClick={() => setTab("waiting")}>
              Waiting ({pending.length})
            </button>
            <button className={tab === "decided" ? "on" : ""} onClick={() => setTab("decided")}>
              Decided
            </button>
          </div>
          {list.length === 0 ? (
            <div className="empty">{tab === "waiting" ? "Nothing waiting. Keel proposes here when a payment is above your limits, to a new payee or across chains." : "Nothing decided yet."}</div>
          ) : (
            list.map((x) => (
              <button key={x.id} className={`q-item ${selected?.id === x.id ? "on" : ""}`} onClick={() => setSelectedId(x.id)}>
                <span className="q-row">
                  <span className={`pill ${PILL[x.status].cls}`}>{x.status === "pending" ? "Payment" : PILL[x.status].label}</span>
                  <span className="muted tiny">{ago(x.created_at_ms)}</span>
                </span>
                <span className="q-row">
                  <b>Pay {x.receiver_id}</b>
                  <span className="num">{amt(x.amount, d)}</span>
                </span>
                <span className="muted small">{x.reason}</span>
              </button>
            ))
          )}
        </section>

        {selected ? (
          <section className="card card-pad appr-detail">
            <div className="ad-top">
              <span className={`pill ${PILL[selected.status].cls}`}>{selected.status === "pending" ? "Needs your approval" : PILL[selected.status].label}</span>
              <span className="muted small">Proposal #{selected.id}, created by Keel {ago(selected.created_at_ms)}</span>
            </div>
            <h2 className="ad-title">Pay {selected.receiver_id}</h2>
            <Amount raw={selected.amount} d={d} />

            <div className="flow">
              <div className="flow-box">
                <span className="muted small">NEAR</span>
                <b>{companyName(p.vaultId)} vault</b>
                <span className="small num">
                  {usd(d.balance, d)} → {after < 0n ? `short ${usd(-after, d)}` : usd(after, d)}
                </span>
              </div>
              <div className="flow-arrow">
                <svg viewBox="0 0 130 12" aria-hidden="true">
                  <path d="M0 6 H124 M118 1 L126 6 L118 11" stroke="#0b5c55" strokeWidth="1.8" fill="none" />
                </svg>
                <span className="teal small">Paid by the vault</span>
                <span className="muted tiny">ft_transfer on NEAR</span>
              </div>
              <div className="flow-box">
                <span className="muted small">NEAR</span>
                <b>{selected.receiver_id}</b>
                <span className="small">{d.policy.allowlist.includes(selected.receiver_id) ? "Allowlisted payee" : "Not on your payee list"}</span>
              </div>
            </div>

            <h3 className="sec">
              <Shield size={18} />
              Why Keel proposed this
            </h3>
            <ol className="why-list">
              <li>{selected.reason}</li>
              {verdict && <li>The vault says: {verdict.reason}</li>}
            </ol>

            <div className="sec-row">
              <h3 className="sec">
                <Shield size={18} />
                Policy checks
              </h3>
              <span className="muted small">enforced by the vault</span>
            </div>
            <ul className="checks">
              {checksFor(selected, d).map((c) => (
                <li key={c.label}>
                  <span className={`ck-ic ${c.ok ? "ok" : c.bad ? "bad" : "warn"}`}>{c.ok ? <Check size={14} /> : "!"}</span>
                  <span>{c.label}</span>
                  <span className={c.ok ? "good" : c.bad ? "bad-t" : "brass"}>{c.result}</span>
                </li>
              ))}
            </ul>

            {error && <p className="error">{error}</p>}
            {selected.status === "pending" && (
              <div className="ad-foot">
                <span>
                  <span className="small block">Signs vault.approve({selected.id})</span>
                  <span className="mono">{d.policy.owner_id}, full-access key</span>
                </span>
                {p.canAct && (
                  <span className="q-act">
                    <button className="btn danger" disabled={busy} onClick={() => act("reject")}>Reject</button>
                    <button className="btn primary" disabled={busy || d.policy.paused} onClick={() => act("approve")}>
                      {busy ? "Approve in wallet" : "Approve and sign"}
                    </button>
                  </span>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="card card-pad appr-detail">
            <div className="empty">Pick a proposal to see why Keel made it and what the vault will check.</div>
          </section>
        )}
      </div>
    </>
  );
}

// ----------------------------------------------------------------- activity

type Filter = "all" | "pending" | "executed" | "rejected";

export function Activity(p: PageProps) {
  const d = p.data;
  const [filter, setFilter] = useState<Filter>("all");
  const all = [...d.proposals].reverse();
  const rows = all.filter((x) => filter === "all" || x.status === filter || (filter === "rejected" && x.status === "failed"));
  const paid = d.proposals.filter((x) => x.status === "executed");
  const moved = paid.reduce((s, x) => s + BigInt(x.amount), 0n);
  const waiting = d.proposals.filter((x) => x.status === "pending").length;
  const refused = d.proposals.filter((x) => x.status === "rejected" || x.status === "failed").length;

  return (
    <>
      <Head title="Activity" sub="Every move, the rule it checked, and its proof">
        <button className="btn" onClick={() => exportCsv(p.vaultId, d)}>Export CSV</button>
      </Head>
      <div className="stat4">
        <section className="card card-pad"><span className="muted">Moved through approvals</span><Amount raw={moved} d={d} size="mid" /></section>
        <section className="card card-pad"><span className="muted">Proposed by Keel</span><div className="mid serif num">{d.proposals.length}</div></section>
        <section className="card card-pad"><span className="muted">Waited for you</span><div className="mid serif num">{waiting}<small className="brass-s">{waiting ? "still open" : "none open"}</small></div></section>
        <section className="card card-pad"><span className="muted">Refused</span><div className="mid serif num">{refused}<small className="bad-s">rejected or failed</small></div></section>
      </div>
      <section className="card table-card">
        <div className="tc-head">
          <div className="seg">
            {(["all", "pending", "executed", "rejected"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {{ all: "All", pending: "Waiting", executed: "Paid", rejected: "Rejected" }[f]}
              </button>
            ))}
          </div>
          <span className="muted small">{companyName(p.vaultId)} vault</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty pad">Nothing here yet. Payments Keel makes alone appear once the agent service reads the vault's events.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>What happened</th>
                <th>Wallet</th>
                <th className="r">Amount</th>
                <th>Outcome</th>
                <th>Rule checked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <td className="muted">{when(x.created_at_ms)}</td>
                  <td>Pay {x.receiver_id}</td>
                  <td>Treasury vault</td>
                  <td className="r num">{usd(x.amount, d)}</td>
                  <td><span className={`pill ${PILL[x.status].cls}`}>{PILL[x.status].label}</span></td>
                  <td className="muted">{x.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="tc-foot muted small">Showing {rows.length} of {all.length}</div>
      </section>
    </>
  );
}

// -------------------------------------------------------------------- rules

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
      <Head title="Rules" sub="Enforced by the Keel Vault contract. Only your key can change them.">
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
            <div><span><b>Spent today</b><small>Counts against the daily cap</small></span><span className="vbox num">{usd(d.policy.spent_today, d)} <small>{d.token.symbol}</small></span></div>
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
      {error && <p className="error">{error}</p>}
    </>
  );
}

// ------------------------------------------------------------------ wallets

export function Wallets(p: PageProps) {
  const d = p.data;
  const pending = d.proposals.filter((x) => x.status === "pending");
  let running = BigInt(d.balance);
  const plan = pending.map((x) => {
    running -= BigInt(x.amount);
    return { x, after: running };
  });
  const firstShort = plan.find((r) => r.after < 0n);

  return (
    <>
      <Head title="Wallets" sub="Keel keeps each wallet above its minimum" />
      <section className="card stat-strip">
        <div><span className="muted">Total across wallets</span><Amount raw={d.balance} d={d} size="mid" /><span className="muted small">1 vault on NEAR</span></div>
        <div><span className="muted">Above minimums</span><Amount raw={d.balance} d={d} size="mid" /><span className="muted small">No minimum set yet</span></div>
        <div><span className="muted">Shortfalls ahead</span><div className="mid serif num">{firstShort ? 1 : 0}</div><span className={`small ${firstShort ? "brass" : "muted"}`}>{firstShort ? `Proposal #${firstShort.x.id}` : "None in pending payments"}</span></div>
        <div><span className="muted">Gas left for Keel</span><div className="mid serif num">{formatNear(d.gas)}<small>NEAR</small></div><span className="muted small">Paid from this vault</span></div>
      </section>
      <div className="wallets-grid">
        <div className="stack">
          <VaultCard p={p} selected />
          <section className="card card-pad add-wallet">
            <b>Add a wallet on another chain</b>
            <span className="muted small">Comes with NEAR Intents</span>
          </section>
        </div>
        <section className="card card-pad w-detail">
          <div className="card-head">
            <div>
              <h2 className="w-name">Treasury vault <span className="tag">NEAR</span></h2>
              <span className="mono">{p.vaultId}</span>
            </div>
            <button className="btn" onClick={p.onDeposit}>Deposit address</button>
          </div>
          <Amount raw={d.balance} d={d} size="huge" />
          <div className="sec-row"><h3 className="sec">Next 14 days</h3><span className="muted small">Balance after</span></div>
          <table className="table plain-t">
            <tbody>
              <tr><td className="muted">Today</td><td>Current balance</td><td /><td className="r num">{usd(d.balance, d)}</td></tr>
              {plan.map(({ x, after }) => (
                <tr key={x.id}>
                  <td className="muted">Pending</td>
                  <td>Pay {x.receiver_id}, proposal #{x.id} <span className="pill warn">Waiting</span></td>
                  <td className="r num">-{usd(x.amount, d)}</td>
                  <td className={`r num ${after < 0n ? "bad-t" : ""}`}>{after < 0n ? `-${usd(-after, d)}` : usd(after, d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {firstShort && (
            <div className="w-callout">
              <span>
                <b>Without a deposit, proposal #{firstShort.x.id} can't be paid</b>
                <span className="small block">The vault holds {amt(d.balance, d)}; waiting payments total more.</span>
              </span>
              <button className="btn primary" onClick={p.onDeposit}>Deposit</button>
            </div>
          )}
          <div className="sec-row"><h3 className="sec">Rules for this wallet</h3>{p.canAct && <button className="link-btn lg" onClick={p.onSetLimits}>Edit in Rules</button>}</div>
          <div className="rl">
            <div><span>Minimum</span><span>Not set</span></div>
            <div><span>Approval needed above</span><span>{d.policy.per_payment_cap === "0" ? "Every payment" : amt(d.policy.per_payment_cap, d)}</span></div>
            <div><span>Pays out to</span><span>{d.policy.allowlist.length ? d.policy.allowlist.join(", ") : "No payees yet"}</span></div>
          </div>
        </section>
      </div>
    </>
  );
}

