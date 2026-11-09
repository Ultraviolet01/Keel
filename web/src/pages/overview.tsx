// Overview: balance, forecast, upcoming bills, Keel's recent decisions.

import { useMemo, useState } from "react";
import { companyName, type Proposal } from "../near";
import { Check, LoadLine } from "../icons";
import type { VaultData } from "../vault";
import { short } from "../evm";
import { BILL_CHAINS, CATEGORIES, balanceSamples, billDues } from "../bills";
import { type PageProps, PILL, usd, amt, hasLimits, ago, ExportButton, Head, payee, Amount, VaultCard } from "./shared";

// ----------------------------------------------------------------- overview

export function Overview(p: PageProps) {
  const d = p.data;
  const pending = d.proposals.filter((x) => x.status === "pending");
  const limits = hasLimits(d);
  const funded = d.balance !== "0";
  const payees = d.policy.allowlist.length > 0;
  const agentOn = Boolean(d.policy.agent_key || d.policy.agent_id);
  // Vaults from before bills could be listed have bills === null and skip this step.
  const hasBills = d.bills === null || d.bills.length > 0;
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const sub = `${today}, ${pending.length ? `${pending.length} ${pending.length === 1 ? "item needs" : "items need"} you` : "nothing needs you"}`;

  return (
    <>
      <Head title="Overview" sub={sub}>
        <ExportButton vaultId={p.vaultId} d={d} />
        <button className="btn" onClick={p.onDeposit}>
          Deposit
        </button>
        {p.canAct && (
          <button className="btn primary" onClick={p.onNewPayment}>
            New payment
          </button>
        )}
      </Head>

      {!(limits && payees && funded && hasBills) && (
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
            <Step done={agentOn} title={agentOn ? "Keel's agent connected" : "Keel's agent is off"} note={agentOn ? `Can call ${(d.agentMethods.length ? d.agentMethods : ["execute_payment", "propose_payment"]).join(", ")} only` : "Add its key back from Rules"} />
            <Step done={limits} title="Set your limits" note="Per payment, per day, and when Keel must ask you">
              {p.canAct && <button className="btn primary sm" onClick={p.onSetLimits}>Set limits</button>}
            </Step>
            <Step done={payees} title="Add the payees Keel may pay" note="Suppliers, payroll and your other wallets">
              {p.canAct && <button className="btn sm" onClick={p.onSetLimits}>Add payees</button>}
            </Step>
            <Step done={funded} title={`Deposit ${d.token.symbol}`} note={`Send ${d.token.symbol} on NEAR to ${p.vaultId}`}>
              <button className="btn sm" onClick={p.onDeposit}>Deposit</button>
            </Step>
            {d.bills !== null && (
              <Step done={hasBills} title="Add the bills Keel should pay" note="Hosting, payroll, suppliers: what, to whom, how much and when">
                {p.canAct && (
                  <span className="tools">
                    <button className="btn sm" onClick={p.onImport}>Import invoices</button>
                    <button className="btn sm" onClick={p.onAddBill}>Add bill</button>
                  </span>
                )}
              </Step>
            )}
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
                  Pay {payee(x.receiver_id)}
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
        {d.savings ? <SavingsCard p={p} /> : (
        <section className="card card-pad add-wallet">
          <b>Wallets on other chains</b>
          <span className="muted small">The vault's own address on Base, Ethereum, Arbitrum and Optimism, signed through NEAR Chain Signatures.</span>
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => p.go("wallets")}>
            See addresses
          </button>
        </section>
        )}
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
          <UpcomingBills p={p} />
          <RulesCard d={d} />
        </div>
      </div>
    </>
  );
}

function UpcomingBills({ p }: { p: PageProps }) {
  const d = p.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dues = d.bills ? billDues(d.bills, new Date().toISOString().slice(0, 10)) : [];
  const status = (ref: string) => {
    if (d.paid[ref]) return { label: "Paid", cls: "ok" };
    const prop = d.proposals.find((x) => x.bill_ref === ref && ["pending", "executing", "signing", "signed"].includes(x.status));
    if (prop) return prop.status === "pending" ? { label: "Needs approval", cls: "warn" } : { label: "Paying", cls: "warn" };
    return { label: "Scheduled", cls: "muted" };
  };
  // Same rule as the agent: a non-critical NEAR bill due within three days
  // waits while paying it would take the vault below the cash buffer.
  const buffer = BigInt(d.policy.min_balance ?? "0");
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const deferred = (x: { bill: { amount: string; chain?: string | null; critical?: boolean }; due: string }) =>
    buffer > 0n && !x.bill.chain && !x.bill.critical && x.due <= soon && x.due > today && BigInt(d.balance) - BigInt(x.bill.amount) < buffer;
  const cancel = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await p.send(p.vaultId, "cancel_bill", { id }, { deposit: "1", gas: "30000000000000" });
      await p.reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).slice(0, 160));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card card-pad">
      <div className="card-head">
        <div>
          <h2>Upcoming payments</h2>
          <p className="sub">Bills Keel pays inside your limits</p>
        </div>
        {p.canAct && d.bills !== null && (
<span className="tools">
            <button className="link-btn lg" onClick={p.onImport}>
              Import invoices
            </button>
            <button className="link-btn lg" onClick={p.onAddBill}>
              Add bill
            </button>
          </span>
        )}
      </div>
      {d.bills === null ? (
        <div className="empty">This vault's contract cannot hold bills, so Keel has nothing to pay from it. Create a new company to list bills for Keel.</div>
      ) : dues.length === 0 ? (
        <div className="empty">No bills yet. Add one, like hosting or payroll, and Keel pays it when it is due.</div>
      ) : (
        <ul className="bills">
          {dues.map((x) => {
            const base = status(x.ref);
            const st = base.label === "Scheduled" && deferred(x) ? { label: "Deferred: cash buffer", cls: "warn" } : base;
            return (
              <li key={x.ref}>
                <b>{x.bill.label}</b>
                <span className="bill-amt">{amt(x.bill.amount, d)}</span>
                <span className="bill-meta">
                  {x.bill.chain ? `${short(x.bill.payee)} on ${BILL_CHAINS[x.bill.chain] ?? x.bill.chain}` : payee(x.bill.payee)} · due{" "}
                  {new Date(`${x.due}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}
                  {x.bill.monthly ? " · monthly" : x.bill.yearly ? " · yearly" : ""}
                  {x.bill.category && CATEGORIES[x.bill.category] ? ` · ${CATEGORIES[x.bill.category]}` : ""}
                  {x.bill.critical ? " · critical" : ""}
                </span>
                <span className="bill-side">
                  {st.label && <span className={`pill ${st.cls}`}>{st.label}</span>}
                  {p.canAct && (
                    <button className="link-btn" disabled={busy === x.bill.id} onClick={() => cancel(x.bill.id)}>
                      {busy === x.bill.id ? "Approve in wallet" : "Remove"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function SavingsCard({ p }: { p: PageProps }) {
  const d = p.data;
  const s = d.savings!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = async () => {
    setBusy(true);
    setError(null);
    try {
      // Everything comes back to the vault; nowhere else is possible.
      await p.send(p.vaultId, "recall_from_yield", { market: s.market, max_amount: null }, { deposit: "1", gas: "150000000000000" });
      await p.reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad add-wallet">
      <b>Yield investment · {s.name}</b>
      <span className="num">
        {amt(s.units, d)}
        {s.apr > 0 ? ` · earning about ${(s.apr * 100).toFixed(1)}% a year` : ""}
      </span>
      <span className="muted small">
        Keel invests cash above your buffer and the next 14 days of bills here for yield, and withdraws it when bills need it. It can only come back to this vault.
      </span>
      {p.canAct && s.units !== "0" && (
        <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={home}>
          {busy ? "Approve in your wallet" : "Withdraw it all to the vault"}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
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
/** Smooth path through points, without overshooting between them (monotone cubic). */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  const n = pts.length;
  const dx = pts.slice(1).map((p, i) => p.x - pts[i].x);
  const m = pts.slice(1).map((p, i) => (p.y - pts[i].y) / (dx[i] || 1));
  const t = pts.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i].x + h).toFixed(1)} ${(pts[i].y + t[i] * h).toFixed(1)} ${(pts[i + 1].x - h).toFixed(1)} ${(pts[i + 1].y - t[i + 1] * h).toFixed(1)} ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

const RANGES = [
  { key: "24H", ms: 86_400_000 },
  { key: "7D", ms: 7 * 86_400_000 },
  { key: "14D", ms: 14 * 86_400_000 },
  { key: "30D", ms: 30 * 86_400_000 },
] as const;

/** Portfolio-style balance chart: the vault's real balance over the chosen range, with a hover readout. */
function Forecast({ d }: { d: VaultData }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("7D");
  const [hover, setHover] = useState<number | null>(null);
  const now = useMemo(() => Date.now(), [d]);
  const ms = RANGES.find((r) => r.key === range)!.ms;
  const pts = useMemo(() => balanceSamples(BigInt(d.balance), d.history, ms, now, 60), [d, ms, now]);
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const change = last - first;
  const pct = first > 0n ? Number((change * 10_000n) / first) / 100 : null;
  const up = change >= 0n;
  const color = change === 0n ? "#0b5c55" : up ? "#1f8a5b" : "#c2563a";
  const max = pts.reduce((m, p) => (p.v > m ? p.v : m), 0n);
  const min = pts.reduce((m, p) => (p.v < m ? p.v : m), max);
  const W = 860, H = 200, padT = 16, padB = 12;
  const lo = max === min ? (min > 0n ? min - min / 10n : 0n) : min;
  const hi = max === min ? max + (max / 10n || 1n) : max;
  const xy = pts.map((p, i) => ({ x: (i / (pts.length - 1)) * W, y: padT + (H - padT - padB) * (1 - Number(((p.v - lo) * 10_000n) / (hi - lo || 1n)) / 10_000) }));
  const line = smoothPath(xy);
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const h = hover !== null ? Math.max(0, Math.min(pts.length - 1, hover)) : null;
  const fmtWhen = (t: number) =>
    new Date(t).toLocaleString("en-GB", ms <= 86_400_000 ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)));
  };
  // Upcoming bills, in words: the chart shows only what really happened.
  const today = new Date(now).toISOString().slice(0, 10);
  const end = new Date(now + 14 * 86_400_000).toISOString().slice(0, 10);
  const dues = (d.bills ? billDues(d.bills, today) : []).filter((x) => !x.bill.chain && !d.paid[x.ref] && x.due <= end);
  const owed = dues.reduce((t, x) => t + BigInt(x.bill.amount), 0n);
  return (
    <div className="pchart">
      <div className="pchart-head">
        <span className={`pchart-change ${change === 0n ? "flat" : up ? "up" : "down"}`}>
          {change === 0n ? "No change" : `${up ? "+" : "−"}${usd(up ? change : -change, d)} ${d.token.symbol}`}
          {pct !== null && change !== 0n && ` (${up ? "+" : "−"}${Math.abs(pct).toFixed(2)}%)`}
          <span className="muted"> · {range}</span>
        </span>
        <div className="pchart-tabs" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.key} role="tab" aria-selected={range === r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>
              {r.key}
            </button>
          ))}
        </div>
      </div>
      <div className="pchart-box">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} aria-label="Vault balance over time">
          <defs>
            <linearGradient id="pchart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path key={`a${range}`} className="pchart-area" d={area} fill="url(#pchart-fill)" />
          <path key={`l${range}`} className="pchart-line" d={line} stroke={color} strokeWidth="2.25" fill="none" vectorEffect="non-scaling-stroke" />
          {h !== null && (
            <g>
              <line x1={xy[h].x} x2={xy[h].x} y1="0" y2={H} stroke="#9fb0b4" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              <circle cx={xy[h].x} cy={xy[h].y} r="4" fill="#fff" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </svg>
        {h !== null && (
          <div className="pchart-tip" style={{ left: `${(xy[h].x / W) * 100}%` }}>
            <b className="num">
              {usd(pts[h].v, d)} {d.token.symbol}
            </b>
            <span>{fmtWhen(pts[h].t)}</span>
          </div>
        )}
      </div>
      <div className="pchart-foot muted tiny">
        <span>{fmtWhen(pts[0].t)}</span>
        <span>
          {d.history === null
            ? "Past balance unavailable right now"
            : dues.length
              ? `${dues.length} unpaid ${dues.length === 1 ? "bill" : "bills"} in the next 14 days: ${amt(owed.toString(), d)}${owed > BigInt(d.balance) ? `, ${usd(owed - BigInt(d.balance), d)} more than the vault holds` : ""}`
              : "No unpaid bills in the next 14 days"}
        </span>
        <span>Now</span>
      </div>
    </div>
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
            <b>Pay {payee(x.receiver_id)}</b>
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
        {d.policy.min_balance !== undefined && (
          <div><span>Cash buffer</span><span className="num">{d.policy.min_balance === "0" ? <span className="brass">Not set</span> : amt(d.policy.min_balance, d)}</span></div>
        )}
        <div><span>Allowed payees</span><span>{d.policy.allowlist.length ? `${d.policy.allowlist.length} addresses` : "None"}</span></div>
        <div><span>Blocked addresses</span><span>{d.policy.blocklist.length ? `${d.policy.blocklist.length} addresses` : "None"}</span></div>
        <div><span>New payees</span><span>Always need approval</span></div>
      </div>
    </section>
  );
}
