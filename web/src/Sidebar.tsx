import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { companyName } from "./near";
import { Check, ChevronsUpDown, Grid, Inbox, List, Pause, Play, Plus, Sliders, Users, Wallet } from "./icons";
import type { KeelState } from "./vault";

export type Page = "overview" | "approvals" | "activity" | "payees" | "rules" | "wallets";

const NAV: { page: Page; label: string; Icon: typeof Grid }[] = [
  { page: "overview", label: "Overview", Icon: Grid },
  { page: "approvals", label: "Approvals", Icon: Inbox },
  { page: "activity", label: "Activity", Icon: List },
  { page: "payees", label: "Payees", Icon: Users },
  { page: "rules", label: "Rules", Icon: Sliders },
  { page: "wallets", label: "Wallets", Icon: Wallet },
];

const STATUS: Record<KeelState, { title: string; note: string; dot: string }> = {
  running: { title: "Keel is running", note: "Paying inside your limits", dot: "live" },
  waiting: { title: "Keel is waiting for limits", note: "Connected, but can only propose until you set them", dot: "wait" },
  paused: { title: "Payments are paused", note: "Nothing moves until you resume", dot: "stop" },
  off: { title: "Keel's agent is off", note: "You removed its key from this vault", dot: "stop" },
  legacy: { title: "Earlier vault version", note: "Uses a separate agent account", dot: "wait" },
};

export function Sidebar(props: {
  companies: { vaultId: string; pending?: number; noLimits?: boolean }[];
  selected: string | null;
  page: Page;
  pendingCount: number;
  status: KeelState | null;
  canAct: boolean;
  busy: boolean;
  onSelect: (vaultId: string) => void;
  onAdd: () => void;
  onPage: (page: Page) => void;
  onPauseToggle: () => void;
  accountId: string;
  onSignOut?: () => void;
  /** The selected vault's owner, as the vault itself records it. */
  owner?: string | null;
}) {
  // The highlight behind the active tab slides to the tab you pick (and
  // follows it along the tab row on phones) instead of jumping.
  const navRef = useRef<HTMLElement>(null);
  const [ind, setInd] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const nav = navRef.current;
      const el = nav?.querySelector<HTMLButtonElement>("button.active");
      if (!nav || !el) return setInd(null);
      setInd({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
      if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: el.offsetLeft - nav.clientWidth / 2 + el.offsetWidth / 2, behavior: "smooth" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [props.page, props.selected, props.pendingCount]);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const current = props.selected;
  const status = props.status ? STATUS[props.status] : null;

  return (
    <aside className="sidebar">
      <span className="wordmark">KEEL</span>

      <div className="switch" ref={ref}>
        <button
          className={`company-card ${open ? "open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="who">
            <span className="name-row">
              <span className="name">{current ? companyName(current) : "No company yet"}</span>
              <span className="tag">Testnet</span>
            </span>
            <span className="mono">{current ?? "Create one to start"}</span>
            {current && props.owner ? <span className="tiny muted">Owner: <span className="mono">{props.owner}</span></span> : null}
          </span>
          <ChevronsUpDown className="faint" size={16} />
        </button>

        {open && (
          <div className="switcher" role="listbox">
            <div className="switcher-label">Your companies</div>
            {props.companies.map((c) => (
              <button
                key={c.vaultId}
                role="option"
                aria-selected={c.vaultId === current}
                className={`opt ${c.vaultId === current ? "on" : ""}`}
                onClick={() => {
                  props.onSelect(c.vaultId);
                  setOpen(false);
                }}
              >
                <span className="mark">{companyName(c.vaultId).charAt(0).toUpperCase()}</span>
                <span className="txt">
                  <b>{companyName(c.vaultId)}</b>
                  <span className="mono">{c.vaultId}</span>
                </span>
                {c.vaultId === current && <Check className="teal" />}
              </button>
            ))}
            {props.canAct && (
              <>
                <div className="divider" />
                <button
                  className="opt add"
                  onClick={() => {
                    setOpen(false);
                    props.onAdd();
                  }}
                >
                  <span className="mark">
                    <Plus size={16} />
                  </span>
                  Add company
                </button>
              </>
            )}
            <div className="divider" />
            <div className="account-row">
              <span className="muted tiny">
                {props.onSignOut ? "Signed in as" : "Viewing"} <span className="mono ink">{props.accountId}</span>
              </span>
              {props.onSignOut && (
                <button className="link-btn" onClick={props.onSignOut}>
                  Sign out
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <nav className="nav" ref={navRef}>
        {ind && <span className="nav-ind" aria-hidden="true" style={{ transform: `translate(${ind.x}px, ${ind.y}px)`, width: ind.w, height: ind.h }} />}
        {NAV.map(({ page, label, Icon }) => (
          <button
            key={page}
            className={props.page === page ? "active" : ""}
            onClick={() => props.onPage(page)}
            disabled={!current}
          >
            <Icon />
            {label}
            {page === "approvals" && props.pendingCount > 0 && <span className="count">{props.pendingCount}</span>}
          </button>
        ))}
      </nav>

      {status && (
        <div className="status-box">
          <div className="row">
            <span className={`dot ${status.dot}`} />
            {status.title}
          </div>
          <p>{status.note}</p>
          {props.canAct && props.status !== "off" && (
            <button className="btn" onClick={props.onPauseToggle} disabled={props.busy}>
              {props.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
              {props.status === "paused" ? "Resume payments" : "Pause all payments"}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
