// App pages, laid out from the Figma frames (Overview, Approvals, Activity,
// Rules, Wallets). Live vault data fills them; where the contract has no data
// yet (bills, minimums, other chains) the page says so plainly.

import { useEffect, useMemo, useState } from "react";
import { companyName, formatNear, formatToken, shortKey, view, type Proposal } from "./near";
import { Check, LoadLine, Pause, Play, Shield } from "./icons";
import type { Send } from "./panels";
import type { Page } from "./Sidebar";
import type { VaultData } from "./vault";
import { EVM_CHAINS, evmWallet, short, type EvmWallet } from "./evm";
import { checkDeposit, type DepositCheck } from "./intents";
import { describeCall, multisigOf, proposalCall, readArgs, rightsOf, type DaoProposal, type Multisig } from "./multisig";
import { BILL_CHAINS, CATEGORIES, PAYEE_KINDS, balanceSamples, billDues } from "./bills";

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
  onAddBill: () => void;
  onAddPayee: () => void;
  onImport: () => void;
  /** The signed-in wallet, or the account being viewed read-only. */
  accountId: string;
  /** Disconnects the wallet; missing in read-only view. */
  onSignOut?: () => void;
  onPauseToggle: () => void;
  /** Lists a multisig's companies in this browser (after handing a vault to it). */
  onTeam: (team: string) => void;
  /** Signs a plain message with the wallet (NEP-413), no transaction; missing in read-only view. */
  signMessage?: (message: string) => Promise<SignedNote>;
}

export interface SignedNote {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  nonce: string;
}

const ACCOUNT_URL = "https://testnet.nearblocks.io/address/";

const PILL: Record<Proposal["status"], { label: string; cls: string }> = {
  pending: { label: "Needs approval", cls: "warn" },
  executing: { label: "Settling", cls: "warn" },
  executed: { label: "Paid", cls: "ok" },
  rejected: { label: "Rejected", cls: "bad" },
  failed: { label: "Failed", cls: "bad" },
  signing: { label: "Signing on NEAR", cls: "warn" },
  signed: { label: "Signed, sent on chain", cls: "ok" },
  superseded: { label: "Replaced by a newer offer", cls: "muted" },
};

/** How a proposal moves money, for the flow diagram and the list pill. */
function routeOf(x: Proposal) {
  if (x.evm) {
    const c = EVM_CHAINS[x.evm.chain_id];
    return { kind: "evm" as const, chain: c?.name ?? `chain ${x.evm.chain_id}`, label: "Signed by NEAR Chain Signatures", detail: `USDC transfer on ${c?.name ?? "EVM"}` };
  }
  // NEAR Intents deposit addresses on NEAR are implicit accounts (64 hex
  // characters). Any payment to one is checked with 1Click, whatever the reason says.
  if (/^[0-9a-f]{64}$/.test(x.receiver_id)) return { kind: "intents" as const, chain: "Other chain", label: "Cross-chain via NEAR Intents", detail: "1Click deposit address" };
  return { kind: "near" as const, chain: "NEAR", label: "Paid by the vault", detail: "ft_transfer on NEAR" };
}

/** Re-renders every second while mounted. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function expiryText(until: number, now: number) {
  const left = Math.floor((until - now) / 1000);
  if (left <= 0) return "Offer expired. Keel will propose a fresh one.";
  const m = Math.floor(left / 60);
  return `Offer expires in ${m}:${String(left % 60).padStart(2, "0")}`;
}

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

/** Downloads the Excel treasury report: Summary, Activity, Payments, Ledger and Wallets. */
function ExportButton({ vaultId, d, label = "Export" }: { vaultId: string; d: VaultData; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const { downloadReport } = await import("./exportReport");
      await downloadReport(vaultId, d);
    } catch (e) {
      console.error(e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn" onClick={run} disabled={busy} title="Excel workbook: summary, activity, payments, ledger and wallets">
      {busy ? "Preparing…" : failed ? "Export failed, retry" : label}
    </button>
  );
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

/** EVM payees are 0x addresses; show them short so they fit. */
const payee = (id: string) => (/^0x[0-9a-f]{40}$/.test(id) ? short(id) : id);

function Amount({ raw, d, size = "big", symbol }: { raw: string | bigint; d: VaultData; size?: "big" | "mid" | "huge"; symbol?: string }) {
  return (
    <div className={`${size} serif num`}>
      {usd(raw, d)}
      <small>{symbol ?? d.token.symbol}</small>
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
  if (x.evm) {
    return [
      { label: "Not on the blocklist", ok: !blocked, bad: blocked, result: blocked ? "Blocked" : "Pass" },
      { label: "Only the vault's USDC on its EVM route", ok: true, result: "Pass" },
      { label: `Gas capped at ${x.evm.gas_limit.toLocaleString()} units`, ok: true, result: "Pass" },
      { label: "Built and hashed by the vault, signed by NEAR's MPC network", ok: true, result: "Pass" },
      { label: "Destination allowlisted", ok: d.policy.allowlist.includes(x.receiver_id), result: d.policy.allowlist.includes(x.receiver_id) ? "Pass" : "Needs you" },
      { label: "Payments running", ok: !d.policy.paused, bad: d.policy.paused, result: d.policy.paused ? "Paused" : "Pass" },
    ];
  }
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
  const now = useNow(pending.some((x) => x.valid_until_ms));
  const expired = !!(selected?.status === "pending" && selected.valid_until_ms && selected.valid_until_ms <= now);
  const route = selected ? routeOf(selected) : null;
  // On the NEAR Intents route, ask 1Click itself where the deposit address pays.
  const [deposit, setDeposit] = useState<DepositCheck | null>(null);
  useEffect(() => {
    setDeposit(null);
    if (!selected || selected.status !== "pending" || routeOf(selected).kind !== "intents") return;
    let live = true;
    setDeposit({ kind: "loading" });
    checkDeposit(selected.receiver_id, selected, p.vaultId).then((d) => live && setDeposit(d));
    return () => {
      live = false;
    };
  }, [selected, p.vaultId]);
  const depositBlocks = deposit?.kind === "loading" || deposit?.kind === "unknown" || (deposit?.kind === "known" && deposit.problems.length > 0);

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
      // An EVM approval waits for NEAR's MPC network to sign, which needs more gas.
      const gas = method === "reject" ? "30000000000000" : selected.evm ? "300000000000000" : "100000000000000";
      await p.send(p.vaultId, method, { proposal_id: selected.id }, { deposit: "1", gas });
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
                  <span className={`pill ${PILL[x.status].cls}`}>{x.status === "pending" ? (routeOf(x).kind === "near" ? "Payment" : "Cross-chain move") : PILL[x.status].label}</span>
                  <span className="muted tiny">{ago(x.created_at_ms)}</span>
                </span>
                <span className="q-row">
                  <b>Pay {payee(x.receiver_id)}</b>
                  <span className="num">{x.evm ? `${usd(x.amount, d)} USDC` : amt(x.amount, d)}</span>
                </span>
                <span className="muted small">{x.reason}</span>
                {x.status === "pending" && x.valid_until_ms ? <span className={`tiny ${x.valid_until_ms <= now ? "bad-t" : "brass"}`}>{expiryText(x.valid_until_ms, now)}</span> : null}
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
            {/* The full address, never shortened here: a look-alike with the same first and last characters must be visible before signing. */}
            <h2 className="ad-title wrap-any">Pay <span className={/^0x/.test(selected.receiver_id) ? "mono" : ""}>{selected.receiver_id}</span></h2>
            <Amount raw={selected.amount} d={d} symbol={selected.evm ? `USDC on ${route?.chain}` : undefined} />
            {selected.status === "pending" && selected.valid_until_ms ? (
              <p className={`small ${expired ? "bad-t" : "brass"}`}>{expiryText(selected.valid_until_ms, now)}</p>
            ) : null}
            {selected.evm_signed ? (
              <p className="small">
                Signed transfer:{" "}
                <a href={`${EVM_CHAINS[selected.evm!.chain_id]?.explorer}/tx/${selected.evm_signed.tx_hash}`} target="_blank" rel="noreferrer" className="mono">
                  {short(selected.evm_signed.tx_hash)}
                </a>
              </p>
            ) : null}

            <div className="flow">
              <div className="flow-box">
                <span className="muted small">{route?.kind === "evm" ? route.chain : "NEAR"}</span>
                <b>{companyName(p.vaultId)} vault</b>
                {route?.kind === "evm" ? (
                  <span className="small">Its own {route.chain} address</span>
                ) : (
                  <span className="small num">
                    {usd(d.balance, d)} → {after < 0n ? `short ${usd(-after, d)}` : usd(after, d)}
                  </span>
                )}
              </div>
              <div className="flow-arrow">
                <svg viewBox="0 0 130 12" aria-hidden="true">
                  <path d="M0 6 H124 M118 1 L126 6 L118 11" stroke="#0b5c55" strokeWidth="1.8" fill="none" />
                </svg>
                <span className="teal small">{route?.label}</span>
                <span className="muted tiny">{route?.detail}</span>
              </div>
              <div className="flow-box">
                <span className="muted small">{route?.chain}</span>
                <b className={`wrap-any ${route?.kind === "near" ? "" : "mono"}`}>{selected.receiver_id}</b>
                <span className="small">{d.policy.allowlist.includes(selected.receiver_id) ? "Allowlisted payee" : "Not on your payee list"}</span>
              </div>
            </div>

            {deposit ? <DepositBox d={deposit} /> : null}

            <h3 className="sec">
              <Shield size={18} />
              Why Keel proposed this
            </h3>
            <ol className="why-list">
              <li>{selected.reason}</li>
              {selected.memo ? (
                <li className="muted">Invoice text, from the payee and not checked by Keel: “{selected.memo}”</li>
              ) : null}
              {route?.kind === "intents" ? (
                <li className="brass">This pays a NEAR Intents deposit address, not the payee directly. Check the payee and amount in Keel's reason before approving.</li>
              ) : null}
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
                    <button className="btn primary" disabled={busy || d.policy.paused || expired || depositBlocks} onClick={() => act("approve")}>
                      {busy ? "Approve in wallet" : expired ? "Offer expired" : depositBlocks ? "Not verified by 1Click" : "Approve and sign"}
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
        <ExportButton vaultId={p.vaultId} d={d} label="Export to Excel" />
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
                  <td>Pay {payee(x.receiver_id)}</td>
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
      <MultisigCard p={p} />
      {error && <p className="error">{error}</p>}
    </>
  );
}

const TGAS = (n: number) => `${n}000000000000`;

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
              <b>#{x.id} {[...new Set(actions.map((a) => describeCall(a.method_name)))].join(", ") || "Proposal"}</b>
              {actions.map((a, k) => (
                <span key={k} className="mono tiny wrap-any">
                  {a.method_name}({readArgs(a.args)}){a.deposit !== "1" && a.deposit !== "0" ? `, attaches ${formatNear(a.deposit)} NEAR` : ""}
                </span>
              ))}
              <span className="muted small">
                Filed by <span className="mono">{x.proposer}</span>
                {ms.members.includes(x.proposer) ? "" : <b className="bad-t"> (not a member of this multisig: anyone may file here, so check it carefully)</b>}. {yes} approved, {no} rejected{need ? `, ${need} needed` : ""}. Check the
                arguments above, not the description.
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
            return <span key={m} className={`pill ${m === p.accountId ? "ok" : "muted"}`} title={what}>{m}{m === p.accountId ? " (you)" : ""} · {what}</span>;
          })}
        </div>
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

// ------------------------------------------------------------------ wallets

function ConnectedWallet({ p }: { p: PageProps }) {
  const owner = p.data.policy.owner_id;
  return (
    <section className="card card-pad connected">
      <div className="w-top">
        <b>{p.onSignOut ? "Connected wallet" : "Viewing read-only"}</b>
        <span className={`pill ${p.onSignOut ? "ok" : "muted"}`}>{p.onSignOut ? "Connected" : "No wallet"}</span>
      </div>
      <span className="mono">{p.accountId}</span>
      <span className="muted small">
        {p.onSignOut
          ? p.accountId === owner
            ? "You own this vault: your wallet signs limits, payees, bills and approvals."
            : `This vault's owner is ${owner}; your wallet cannot change it.`
          : "Nothing on these pages can sign."}
      </span>
      {p.onSignOut ? (
        <button className="btn danger sm" style={{ alignSelf: "flex-start" }} onClick={p.onSignOut}>
          Disconnect wallet
        </button>
      ) : (
        <a className="btn sm" style={{ alignSelf: "flex-start" }} href="/app">
          Connect your own wallet
        </a>
      )}
    </section>
  );
}

/** Email notifications for the connected account: sign up with a signed message, confirm by email, send a test. */
function NotificationsCard({ p }: { p: PageProps }) {
  type Status = { ready: boolean; subscribed: boolean; confirmed: boolean; email: string | null };
  const [status, setStatus] = useState<Status | null | "none">(null);
  const [email, setEmail] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const account = p.accountId;

  const load = async () => {
    try {
      const res = await fetch(`/api/notify?action=status&account=${encodeURIComponent(account)}`);
      setStatus(res.ok ? ((await res.json()) as Status) : "none");
    } catch {
      setStatus("none");
    }
  };
  useEffect(() => {
    void load();
  }, [account]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = async (key: string, action: string, lines: string[]) => {
    if (!p.signMessage) return;
    setBusy(key);
    setNote(null);
    try {
      const signed = await p.signMessage(["Keel notifications", `Account: ${account}`, ...lines, `Time: ${new Date().toISOString()}`].join("\n"));
      const res = await fetch(`/api/notify?action=${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed) });
      const out = (await res.json().catch(() => ({}))) as { error?: string; email?: string };
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`);
      setNote({ ok: true, text: action === "subscribe" ? `Check ${out.email} for the confirmation link, and look in Spam if it is not in your inbox: mark it Not spam so later alerts arrive. Nothing is sent until you click it.` : "Test email sent. Check your inbox, and Spam if it is not there." });
      setEditing(false);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/reject|cancel|closed/i.test(msg)) setNote({ ok: false, text: msg.slice(0, 200) });
    } finally {
      setBusy(null);
    }
  };

  const s = status && status !== "none" ? status : null;
  const form = (
    <form
      className="team-form"
      style={{ padding: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        void call("sub", "subscribe", ["Action: subscribe", `Email: ${email.trim().toLowerCase()}`]);
      }}
    >
      <input type="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
      <button className="btn dark" type="submit" disabled={busy !== null || !email.trim()}>{busy === "sub" ? "Sign in wallet" : "Turn on"}</button>
    </form>
  );

  return (
    <section className="card card-pad connected">
      <div className="w-top">
        <b>Email notifications</b>
        <span className={`pill ${s?.confirmed ? "ok" : "muted"}`}>{s?.confirmed ? "On" : s?.subscribed ? "Confirm your email" : "Off"}</span>
      </div>
      <span className="muted small">
        An email when a payment or a multisig vote waits for you, when Keel refuses a bill or cash runs low, and a daily digest when money moved.
        For every company this account owns or votes on.
      </span>
      {status === null ? (
        <span className="muted small">Checking…</span>
      ) : status === "none" ? (
        <span className="muted small">Notifications run on the hosted app only.</span>
      ) : !p.signMessage ? (
        <span className="muted small">Connect your own wallet to turn them on.</span>
      ) : !status.ready ? (
        <span className="muted small">Email is not set up on this deployment yet.</span>
      ) : s?.confirmed && !editing ? (
        <>
          <span className="small">Emails go to <span className="mono">{s.email}</span>.</span>
          <span className="agent-actions">
            <button className="btn sm" onClick={() => void call("test", "test", ["Action: test"])} disabled={busy !== null}>{busy === "test" ? "Sign in wallet" : "Send a test email"}</button>
            <button className="link-btn" onClick={() => setEditing(true)}>Change address</button>
          </span>
        </>
      ) : (
        <>
          {s?.subscribed && !editing && <span className="small">Waiting for you to click the link sent to <span className="mono">{s.email}</span>. Look in Spam if it is not in your inbox; sign up again to resend it.</span>}
          {form}
          <span className="muted tiny">Your wallet signs a message to prove the account is yours: no transaction, no fee. The address is kept private, never on chain; every email has a link to stop them and delete it.</span>
        </>
      )}
      {note && <span className={`small ${note.ok ? "" : "bad-t"}`}>{note.text}</span>}
    </section>
  );
}

export function Wallets(p: PageProps) {
  const d = p.data;
  // Bills paid from the vault's Base address do not draw on the NEAR balance.
  const pending = d.proposals.filter((x) => x.status === "pending" && !x.evm);
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
        <div>
          <span className="muted">Above the cash buffer</span>
          <Amount raw={(() => { const x = BigInt(d.balance) - BigInt(d.policy.min_balance ?? "0"); return (x > 0n ? x : 0n).toString(); })()} d={d} size="mid" />
          <span className="muted small">{d.policy.min_balance && d.policy.min_balance !== "0" ? `Buffer ${amt(d.policy.min_balance, d)}` : "No cash buffer set"}</span>
        </div>
        <div><span className="muted">Shortfalls ahead</span><div className="mid serif num">{firstShort ? 1 : 0}</div><span className={`small ${firstShort ? "brass" : "muted"}`}>{firstShort ? `Proposal #${firstShort.x.id}` : "None in pending payments"}</span></div>
        <div><span className="muted">Gas left for Keel</span><div className="mid serif num">{formatNear(d.gas)}<small>NEAR</small></div><span className="muted small">Paid from this vault</span></div>
      </section>
      <div className="wallets-grid">
        <div className="stack">
          <ConnectedWallet p={p} />
          <NotificationsCard p={p} />
          <VaultCard p={p} selected />
          <EvmWalletCard vaultId={p.vaultId} />
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
                  <td>Pay {payee(x.receiver_id)}, proposal #{x.id} <span className="pill warn">Waiting</span></td>
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


/** The vault's own EVM address, controlled through NEAR Chain Signatures, with its balance on each chain. */
function EvmWalletCard({ vaultId }: { vaultId: string }) {
  const [w, setW] = useState<EvmWallet | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setW(undefined);
    evmWallet(vaultId).then(setW).catch(() => setW(null));
  }, [vaultId]);
  if (w === undefined) return <section className="card card-pad add-wallet"><span className="muted small">Reading the vault's addresses on other chains…</span></section>;
  if (w === null)
    return (
      <section className="card card-pad add-wallet">
        <b>No wallet on another chain</b>
        <span className="muted small">Vaults created before Chain Signatures pay only on NEAR. Create a new vault to get an address on other chains.</span>
      </section>
    );
  const copy = () => navigator.clipboard?.writeText(w.address).then(() => setCopied(true)).catch(() => {});
  return (
    <section className="card card-pad evm-wallet">
      <div className="q-row">
        <b>Vault on other chains</b>
        <span className="tag">Chain Signatures</span>
      </div>
      <span className="mono small">{short(w.address)}</span>
      <table className="table plain-t evm-chains">
        <tbody>
          {w.chains.map((c) => (
            <tr key={c.route.chain_id}>
              <td><a href={`${c.chain.explorer}/address/${w.address}`} target="_blank" rel="noreferrer">{c.chain.name}</a></td>
              <td className="r num">{formatToken(c.usdc, c.route.decimals ?? 6)} USDC</td>
              <td className="r muted small">{formatToken(c.gas, 18)} {c.chain.gas}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="muted small">The same address on every chain. Only this vault can sign for it, through NEAR's MPC network, after you approve. Keel pays bills on these chains from here when NEAR Intents is unavailable.</span>
      <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy address to fund it"}</button>
    </section>
  );
}

/** What 1Click itself says about a deposit address, shown before the owner signs. */
function DepositBox({ d }: { d: DepositCheck }) {
  if (d.kind === "loading") return <p className="small muted">Asking NEAR Intents where this deposit address pays…</p>;
  if (d.kind === "unreachable")
    return <p className="small brass">Could not reach 1Click to check this deposit address ({d.detail}). Check the payee and amount yourself before approving.</p>;
  if (d.kind === "unknown")
    return (
      <p className="small bad-t">
        1Click does not recognise this deposit address. Do not approve: the money would go to an account that NEAR Intents never issued.
      </p>
    );
  return (
    <div className={`deposit-box ${d.problems.length ? "bad" : "ok"}`}>
      <b className="small">{d.problems.length ? "1Click's record does not match this proposal" : "Checked with 1Click"}</b>
      <span className="small">
        Pays <b>{d.amountOut}</b> to <span className="mono wrap-any">{d.recipient}</span> on <b>{d.chain}</b> ({d.token}). Refunds go to <span className="mono">{d.refundTo}</span>. Status {d.status}.
      </span>
      {d.problems.map((x) => (
        <span key={x} className="small bad-t">{x}</span>
      ))}
      <span className="tiny muted">Compare the recipient with the invoice before approving.</span>
    </div>
  );
}
