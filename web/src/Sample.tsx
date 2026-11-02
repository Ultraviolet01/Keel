// A sample treasury shown blurred behind the sign-in and first-company panels.
// It is decoration only: no real account's data appears before a wallet connects.

import { Grid, Inbox, List, Pause, Sliders, Wallet } from "./icons";

export function SampleApp() {
  return (
    <div className="app behind" aria-hidden="true">
      <aside className="sidebar">
        <span className="wordmark">KEEL</span>
        <div className="switch">
          <div className="company-card">
            <span className="who">
              <span className="name-row"><span className="name">Kora Supply Group</span><span className="tag">Mainnet</span></span>
              <span className="mono">kora.keel.near</span>
            </span>
          </div>
        </div>
        <nav className="nav">
          <button className="active"><Grid />Overview</button>
          <button><Inbox />Approvals<span className="count">2</span></button>
          <button><List />Activity</button>
          <button><Sliders />Rules</button>
          <button><Wallet />Wallets</button>
        </nav>
        <div className="status-box">
          <div className="row"><span className="dot live" />Keel is running</div>
          <p>Checked 12s ago</p>
          <button className="btn"><Pause size={14} />Pause all payments</button>
        </div>
      </aside>
      <main className="main">
        <div className="head">
          <div>
            <h1 className="serif">Overview</h1>
            <p className="sub">Sunday, 1 November, 1 shortfall ahead, 2 items need you</p>
          </div>
        </div>
        <div className="grid2">
          <section className="card card-pad">
            <span className="muted">Total treasury</span>
            <div className="big serif num">48,215.40<small>USDC</small></div>
            <svg className="chart" viewBox="0 0 640 150" width="100%" preserveAspectRatio="none">
              <line x1="0" y1="110" x2="640" y2="110" stroke="#e3e8e8" />
              <path d="M0 70 H200 V12 H300 V84 H640" fill="none" stroke="#0b5c55" strokeWidth="2" />
            </svg>
          </section>
          <section className="needs">
            <div className="needs-top">Needs you<span>2 open</span></div>
            <div className="needs-item"><b>Fund Payroll on Base</b><span>Short 6,920 for Nov 7</span></div>
            <div className="needs-item"><b>Rule update: Atlas Freight</b><span>3 approvals in a row</span></div>
          </section>
        </div>
        <div className="wallets3">
          {["Treasury vault", "Payroll", "Vendors"].map((w, i) => (
            <section key={w} className="card card-pad">
              <b>{w}</b>
              <div className="mid serif num">{["31,240.00", "4,180.00", "12,795.40"][i]}</div>
              <div className="bar"><i style={{ width: ["92%", "26%", "94%"][i] }} /></div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
