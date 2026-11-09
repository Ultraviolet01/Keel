// Activity: every decision Keel and the owner made.

import { useState } from "react";
import { companyName } from "../near";
import { type PageProps, PILL, usd, when, ExportButton, Head, payee, Amount } from "./shared";

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
