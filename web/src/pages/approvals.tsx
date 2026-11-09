// Approvals: proposals waiting for the owner, with the vault's own checks.

import { useEffect, useMemo, useState } from "react";
import { companyName, formatToken, view, type Proposal } from "../near";
import { Check, Shield } from "../icons";
import type { VaultData } from "../vault";
import { EVM_CHAINS, short } from "../evm";
import { checkDeposit, type DepositCheck } from "../intents";
import { type PageProps, PILL, routeOf, useNow, expiryText, usd, amt, ago, Head, payee, Amount } from "./shared";

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
    { label: "Within the 24-hour cap", ok: daily > 0n && spent + amount <= daily, result: daily > 0n && spent + amount <= daily ? "Pass" : "Needs you" },
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
              {verdict && <li>The vault says: {verdict.reason.replace(/\b\d{4,}\b/g, (n) => `${formatToken(BigInt(n), d.token.decimals)} ${d.token.symbol}`)}</li>}
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
