// Wallets: the vault on NEAR, notifications and the vault's address on other chains.

import { useEffect, useState } from "react";
import { formatNear, formatToken, parseToken } from "../near";
import { EVM_CHAINS, evmWallet, short, type EvmWallet } from "../evm";
import { type PageProps, usd, amt, Head, payee, Amount, VaultCard } from "./shared";

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

  // The server tells strangers only whether email is set up; this browser remembers the account's own status
  // (saved at sign-up and by the confirmation page), and "Check my status" asks the server with a signature.
  const localKey = `keel-notify:${account}`;
  const remembered = (): Partial<Status> => {
    try {
      return JSON.parse(localStorage.getItem(localKey) ?? "{}");
    } catch {
      return {};
    }
  };
  const remember = (v: Partial<Status> | null) => {
    try {
      if (v && v.subscribed) localStorage.setItem(localKey, JSON.stringify(v));
      else localStorage.removeItem(localKey);
    } catch {
      /* private mode: status lasts for this page only */
    }
  };
  const load = async () => {
    try {
      const res = await fetch(`/api/notify?action=status`);
      const { ready } = res.ok ? ((await res.json()) as { ready: boolean }) : { ready: false };
      if (!res.ok) return setStatus("none");
      const mine = remembered();
      setStatus({ ready, subscribed: !!mine.subscribed, confirmed: !!mine.confirmed, email: mine.email ?? null });
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
      const out = (await res.json().catch(() => ({}))) as { error?: string; email?: string; subscribed?: boolean; confirmed?: boolean };
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`);
      if (action === "subscribe") remember({ subscribed: true, confirmed: false, email: out.email ?? null });
      if (action === "status") {
        remember({ subscribed: !!out.subscribed, confirmed: !!out.confirmed, email: out.email ?? null });
        setNote({ ok: true, text: out.subscribed ? (out.confirmed ? `Alerts go to ${out.email}.` : `Waiting for you to confirm ${out.email}.`) : "No email alerts for this account yet." });
        await load();
        return;
      }
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
      {p.signMessage && s?.ready && (
        <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => void call("status", "status", ["Action: status"])} disabled={busy !== null}>
          {busy === "status" ? "Sign in wallet" : "Check my status"}
        </button>
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
          <EvmWalletCard p={p} />
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
function EvmWalletCard({ p }: { p: PageProps }) {
  const vaultId = p.vaultId;
  const d = p.data;
  const [w, setW] = useState<EvmWallet | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [capChain, setCapChain] = useState<number | null>(null);
  const [capText, setCapText] = useState("");
  const [capBusy, setCapBusy] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  useEffect(() => {
    setW(undefined);
    evmWallet(vaultId).then(setW).catch(() => setW(null));
  }, [vaultId]);
  const canSet = p.canAct && d.policy.owner_id === p.accountId;
  const saveCap = async () => {
    const c = w?.chains.find((x) => x.route.chain_id === capChain);
    if (!c) return;
    setCapBusy(true);
    setCapError(null);
    try {
      const parsed = capText.trim() === "" ? "0" : parseToken(capText, d.token.decimals);
      if (parsed === null) throw new Error("Enter an amount like 5 or 12.50.");
      const units = BigInt(parsed) === 0n ? null : BigInt(parsed);
      if (units !== null && units > BigInt(d.policy.per_payment_cap)) throw new Error("The auto cap cannot be above the per-payment cap.");
      await p.send(vaultId, "set_evm_route", { chain_id: c.route.chain_id, route: { ...c.route, decimals: c.route.decimals ?? 6, auto_cap: units === null ? null : units.toString() } }, { deposit: "1" });
      setCapChain(null);
      setW(await evmWallet(vaultId).catch(() => null));
    } catch (e) {
      setCapError(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setCapBusy(false);
    }
  };
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
              <td className="r small">
                {canSet ? (
                  <button className="link-btn" onClick={() => { setCapChain(c.route.chain_id); setCapText(c.route.auto_cap ? formatToken(BigInt(c.route.auto_cap), d.token.decimals) : ""); }}>
                    {c.route.auto_cap ? `Alone up to ${formatToken(BigInt(c.route.auto_cap), d.token.decimals)}` : "Always asks you"}
                  </button>
                ) : (
                  <span className="muted">{c.route.auto_cap ? `Alone up to ${formatToken(BigInt(c.route.auto_cap), d.token.decimals)}` : "Always asks you"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {capChain !== null && (
        <form className="team-form" style={{ padding: 0 }} onSubmit={(e) => { e.preventDefault(); void saveCap(); }}>
          <input value={capText} onChange={(e) => setCapText(e.target.value)} placeholder="0 = always ask" inputMode="decimal" aria-label="Auto cap in USDC" />
          <button className="btn sm" type="submit" disabled={capBusy}>{capBusy ? "Approve in wallet" : `Save for ${EVM_CHAINS[capChain]?.name ?? capChain}`}</button>
        </form>
      )}
      {capChain !== null && <span className="muted tiny">Bills on this chain up to this amount, to a 0x payee on your allowlist and inside your caps, are paid without asking you. Above it, Keel proposes. 0 means always ask.</span>}
      {capError && <p className="error">{capError}</p>}
      <span className="muted small">The same address on every chain. Only this vault can sign for it, through NEAR's MPC network, after you approve or inside the auto cap you set per chain. Keel pays bills on these chains from here when NEAR Intents is unavailable.</span>
      <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy address to fund it"}</button>
    </section>
  );
}

/** What 1Click itself says about a deposit address, shown before the owner signs. */
