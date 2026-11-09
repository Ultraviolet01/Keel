// Helpers and cards shared by the app pages.

import { useEffect, useRef, useState } from "react";
import { formatToken, type Proposal } from "../near";
import type { Send } from "../panels";
import type { Page } from "../Sidebar";
import type { VaultData } from "../vault";
import { EVM_CHAINS, short } from "../evm";

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

export const ACCOUNT_URL = "https://testnet.nearblocks.io/address/";

export const PILL: Record<Proposal["status"], { label: string; cls: string }> = {
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
export function routeOf(x: Proposal) {
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
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function expiryText(until: number, now: number) {
  const left = Math.floor((until - now) / 1000);
  if (left <= 0) return "Offer expired. Keel will propose a fresh one.";
  const m = Math.floor(left / 60);
  return `Offer expires in ${m}:${String(left % 60).padStart(2, "0")}`;
}

export const usd = (raw: string | bigint, d: VaultData) => formatToken(raw, d.token.decimals);
export const amt = (raw: string | bigint, d: VaultData) => `${usd(raw, d)} ${d.token.symbol}`;
export const hasLimits = (d: VaultData) => d.policy.per_payment_cap !== "0" && d.policy.daily_cap !== "0";

export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function when(ms: number) {
  return new Date(ms).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type Preset = "month" | "lastmonth" | "30d" | "all" | "custom";
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The From and To dates (YYYY-MM-DD, "" = open) for a preset. */
export function presetDates(p: Preset, now = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (p === "month") return { from: isoDay(new Date(Date.UTC(y, m, 1))), to: "" };
  if (p === "lastmonth") return { from: isoDay(new Date(Date.UTC(y, m - 1, 1))), to: isoDay(new Date(Date.UTC(y, m, 0))) };
  if (p === "30d") return { from: isoDay(new Date(now.getTime() - 29 * 86_400_000)), to: "" };
  return { from: "", to: "" };
}

/** Downloads the Excel treasury report for a period the founder picks: Summary, Activity, Payments, Ledger and Wallets. */
export function ExportButton({ vaultId, d, label = "Export" }: { vaultId: string; d: VaultData; label?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("month");
  const [{ from, to }, setDates] = useState(() => presetDates("month"));
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") setDates(presetDates(p));
  };
  const badRange = Boolean(from && to && from > to);

  const run = async () => {
    setBusy(true);
    setFailed(null);
    let mod: typeof import("../exportReport");
    try {
      mod = await import("../exportReport");
    } catch {
      // Keel was redeployed while this page was open, so the old export code is gone: load the new version.
      window.location.reload();
      return;
    }
    try {
      await mod.downloadReport(vaultId, d, { from: from ? Date.parse(`${from}T00:00:00Z`) : null, to: to ? Date.parse(`${to}T23:59:59.999Z`) : null });
      setOpen(false);
    } catch (e) {
      console.error(e);
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const PRESETS: [Preset, string][] = [
    ["month", "This month"],
    ["lastmonth", "Last month"],
    ["30d", "Last 30 days"],
    ["all", "All time"],
  ];
  return (
    <span ref={box} style={{ position: "relative", display: "inline-flex" }}>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Excel workbook: summary, activity, payments, ledger and wallets">
        {label}
      </button>
      {open && (
        <div className="export-pop" role="dialog" aria-label="Export to Excel">
          <b>Export to Excel</b>
          <span className="muted small">Pick the period. Balances are as of now.</span>
          <div className="export-presets">
            {PRESETS.map(([k, t]) => (
              <button key={k} className={`chip-btn ${preset === k ? "on" : ""}`} onClick={() => pick(k)}>
                {t}
              </button>
            ))}
          </div>
          <div className="export-dates">
            <label className="field">
              <span className="label">From</span>
              <input type="date" value={from} max={to || undefined} onChange={(e) => (setPreset("custom"), setDates({ from: e.target.value, to }))} />
            </label>
            <label className="field">
              <span className="label">To</span>
              <input type="date" value={to} min={from || undefined} onChange={(e) => (setPreset("custom"), setDates({ from, to: e.target.value }))} />
              <span className="hint">{to ? "" : "Empty: up to the present"}</span>
            </label>
          </div>
          {badRange && <span className="small bad-t">From is after To.</span>}
          {failed && <span className="small bad-t">Export failed: {failed.slice(0, 140)}</span>}
          <button className="btn primary" onClick={run} disabled={busy || badRange}>
            {busy ? "Preparing…" : "Download .xlsx"}
          </button>
        </div>
      )}
    </span>
  );
}

export function Head({ title, sub, children }: { title: string; sub: string; children?: React.ReactNode }) {
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
export const payee = (id: string) => (/^0x[0-9a-f]{40}$/.test(id) ? short(id) : id);

export function Amount({ raw, d, size = "big", symbol }: { raw: string | bigint; d: VaultData; size?: "big" | "mid" | "huge"; symbol?: string }) {
  return (
    <div className={`${size} serif num`}>
      {usd(raw, d)}
      <small>{symbol ?? d.token.symbol}</small>
    </div>
  );
}


export function VaultCard({ p, selected, onClick }: { p: PageProps; selected?: boolean; onClick?: () => void }) {
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


export const TGAS = (n: number) => `${n}000000000000`;

