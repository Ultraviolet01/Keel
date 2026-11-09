// Landing page, built from the Figma "Landing" frame and its prototype video.
// The ship rides light while Keel pays under the line, then loads past its
// load line when a payment needs the owner's signature.

import { useEffect, useState } from "react";
import { APP, REPO, SiteNav, useReveal } from "./guide";

const CONTAINER_COLORS = ["#0f5d5a", "#5b6870", "#c4922e", "#0f5d5a", "#d9e2e5", "#174a54", "#a9c6d0"];

/** Container stacks on deck: x position and how many boxes high. */
const STACKS = [
  [440, 2], [486, 3], [532, 3], [578, 4], [624, 3], [670, 4], [716, 3],
  [762, 4], [808, 3], [854, 4], [900, 3], [946, 3], [992, 2], [1038, 2],
];

function deckY(x: number) {
  // The deck slopes up toward the bow.
  return 352 - ((x - 250) * 30) / 940;
}

function Ship() {
  return (
    <g className="ship">
      <g className="ship-bob">
      {/* reflection under the hull */}
      <path d="M268 506 H1150 Q1170 506 1166 530 L1160 560 Q1155 572 1135 572 H300 Q275 572 270 548 Z" fill="#9cb8c0" />
      {/* bridge and funnel */}
      <rect x="282" y="208" width="96" height="146" fill="#e7eded" />
      <rect x="270" y="196" width="122" height="12" fill="#d5dfe0" />
      <rect x="322" y="150" width="30" height="46" fill="#0f5d5a" />
      <rect x="322" y="160" width="30" height="7" fill="#c4922e" />
      <path d="M398 118 V200 M386 132 H410" stroke="#12313b" strokeWidth="3" />
      {[0, 1, 2, 3].map((r) =>
        [0, 1, 2, 3, 4, 5].map((c) => (
          <rect key={`${r}-${c}`} x={294 + c * 13} y={226 + r * 26} width="8" height="7" fill={r === 0 ? "#12313b" : "#5b6870"} />
        )),
      )}
      {/* containers */}
      {STACKS.map(([x, h], i) =>
        Array.from({ length: h }, (_, j) => {
          const color = CONTAINER_COLORS[(i * 3 + j * 5) % CONTAINER_COLORS.length];
          const y = deckY(x + 22) - 24 * (j + 1);
          const light = color === "#d9e2e5" || color === "#a9c6d0";
          return (
            <g key={`${i}-${j}`}>
              <rect x={x} y={y} width="44" height="22" fill={color} />
              {light &&
                [8, 16, 24, 32].map((dx) => <line key={dx} x1={x + dx} x2={x + dx} y1={y + 4} y2={y + 18} stroke="#8fa7ad" strokeWidth="1" />)}
            </g>
          );
        }),
      )}
      {/* hull */}
      <path d="M250 356 L1192 324 L1150 504 L264 506 Z" fill="#12313b" />
      <path d="M262 380 L1180 352" stroke="#25454f" strokeWidth="1.5" />
      <rect x="264" y="492" width="886" height="12" fill="#0b5c55" />
      <text x="1070" y="398" fill="#ffffff" fontFamily="Fraunces, serif" fontWeight="600" fontSize="24" letterSpacing="3">
        KEEL
      </text>
      <circle cx="1166" cy="392" r="5" fill="none" stroke="#8fa7ad" strokeWidth="1.5" />
      {/* the load line */}
      <g className="mark">
        <path d="M700 470 H760" stroke="#c4922e" strokeWidth="2" />
        <circle cx="730" cy="470" r="11" fill="none" stroke="#c4922e" strokeWidth="2" />
        <text x="776" y="475" fill="#ffffff" fontFamily="Fraunces, serif" fontWeight="600" fontSize="15">
          Your line
        </text>
        <text x="852" y="475" fill="#c9d6d9" fontFamily="Hanken Grotesk, sans-serif" fontSize="12">
          the limit you set
        </text>
      </g>
      </g>
    </g>
  );
}

function Compass() {
  return (
    <g transform="translate(1290 120)" stroke="#a7b4b7" fill="none">
      <text x="0" y="-52" textAnchor="middle" fill="#5f7378" stroke="none" fontFamily="Fraunces, serif" fontWeight="600" fontSize="14">
        N
      </text>
      <circle r="40" />
      <circle r="32" />
      {Array.from({ length: 24 }, (_, i) => {
        const a = (i * Math.PI) / 12;
        return <line key={i} x1={Math.sin(a) * 32} y1={-Math.cos(a) * 32} x2={Math.sin(a) * 40} y2={-Math.cos(a) * 40} />;
      })}
      <path d="M-46 0 H46 M0 -46 V46" />
      <path d="M0 -34 L6 0 L0 6 L-6 0 Z" fill="#c4922e" stroke="none" />
      <path d="M0 34 L6 0 L0 -6 L-6 0 Z" fill="#8fa7ad" stroke="none" />
    </g>
  );
}

/** A row of wave crests. Each row drifts sideways in a seamless loop (one
 * crest spacing per cycle), at its own speed and direction. */
function Waves({ y, offset = 0, speed = "slow" }: { y: number; offset?: number; speed?: "slow" | "mid" | "fast" | "back" }) {
  return (
    <g className={`waves ${speed}`} stroke="#ffffff" strokeWidth="1.5" opacity="0.8" fill="none">
      {Array.from({ length: 24 }, (_, i) => {
        const x = offset - 70 + i * 70;
        return <path key={i} d={`M${x} ${y} q16 -5 32 0`} />;
      })}
    </g>
  );
}

/** True on phone and small tablet widths, where the scene frames the whole ship. */
function useNarrow() {
  const query = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Scene() {
  // Desktop fills the width and crops top and bottom; narrow screens show
  // the whole ship, from the mast to the water under the hull.
  const narrow = useNarrow();
  return (
    <div className="scene" role="img" aria-label="A container ship marked with its load line. Light loads stay under the line; a heavy one sinks past it and waits for the owner.">
      <div className="scene-caption">
        <div className="cap light">
          <b className="serif">A payment inside your limit</b>
          <span>Under the line, so Keel pays it alone</span>
        </div>
        <div className="cap heavy">
          <b className="serif">A payment over your limit</b>
          <span>Over the line, so it waits for your signature</span>
        </div>
      </div>
      <svg viewBox={narrow ? "200 96 1060 544" : "0 0 1440 640"} preserveAspectRatio={narrow ? "xMidYMid meet" : "xMidYMax slice"} aria-hidden="true">
        <g stroke="#e3e9e9" strokeWidth="1">
          {[120, 330, 540, 750, 960, 1170, 1380].map((x) => (
            <line key={x} x1={x} x2={x} y1="0" y2="430" />
          ))}
          <line x1="0" x2="1440" y1="150" y2="150" />
          <line x1="0" x2="1440" y1="300" y2="300" />
        </g>
        <Compass />
        <rect x="0" y="430" width="1440" height="210" fill="#b3cfd6" />
        <line x1="0" x2="1440" y1="430" y2="430" stroke="#93b3bc" strokeWidth="2" />
        <Waves y={452} offset={20} speed="fast" />
        <Ship />
        {/* water in front of the hull, so the ship sinks into it */}
        <rect className="front-water" x="0" y="500" width="1440" height="154" fill="#b3cfd6" opacity="0.92" />
        <Waves y={506} speed="mid" />
        <Waves y={560} offset={35} speed="back" />
        <Waves y={620} speed="slow" />
      </svg>
    </div>
  );
}

export default function Landing() {
  useReveal(".l-how h2, .l-how li, .l-how .l-more, .l-dark > div, .l-cta > *");
  return (
    <div className="landing">
      <SiteNav />

      <section className="l-hero">
        <h1 className="serif">
          Runs your treasury.
          <br />
          Never past the line
        </h1>
        <div className="l-hero-row">
          <p>
            Keel is an AI agent that runs your company's money: it pays bills, protects your cash, tops up wallets and puts idle cash to work,
            always inside limits you set on NEAR.
          </p>
          <div className="l-actions">
            <a className="btn primary" href={APP}>
              Open app
            </a>
            <a className="btn" href={`${REPO}#try-it`}>
              Watch the demo
            </a>
          </div>
        </div>
      </section>

      <Scene />

      <section className="l-how" id="how">
        <h2 className="serif">How it works</h2>
        <ol>
          <li>
            <span className="serif n">1</span>
            <h3>Paint the line</h3>
            <p>Set caps, payees and bills in your own Keel Vault contract. Only your key can change them.</p>
          </li>
          <li>
            <span className="serif n">2</span>
            <h3>Keel keeps watch</h3>
            <p>Every 15 minutes it forecasts your cash, pays what is due inside your limits and keeps your card wallet topped up.</p>
          </li>
          <li>
            <span className="serif n">3</span>
            <h3>You sign the big ones</h3>
            <p>Anything over your line waits for your approval, with Keel's reasons attached.</p>
          </li>
        </ol>
        <a className="l-more" href="/how-it-works">
          How Keel works in detail
        </a>
      </section>

      <section className="l-dark" id="security">
        <div>
          <h2 className="serif">
            It can't spend
            <br />
            past the line
          </h2>
          <p>
            Not "won't". Can't. Keel signs with a NEAR function-call key that can only reach three methods on your vault: pay, propose, and withdraw its yield investment back to the vault. The vault
            checks every payment against your line before any money moves.
          </p>
          <a className="l-more light" href="/security">
            Read the security page
          </a>
        </div>
        <div className="keys">
          <span className="keys-label">What Keel's key can call on your vault</span>
          <ul>
            <li>
              <span className="mono">execute_payment</span>
              <span className="allowed">Allowed</span>
            </li>
            <li>
              <span className="mono">propose_payment</span>
              <span className="allowed">Allowed</span>
            </li>
            <li>
              <span className="mono">recall_from_yield</span>
              <span className="allowed">Back to vault only</span>
            </li>
            <li>
              <span className="mono">update_policy</span>
              <span className="owner">Owner only</span>
            </li>
            <li>
              <span className="mono">add_payee</span>
              <span className="owner">Owner only</span>
            </li>
            <li>
              <span className="mono">transfer</span>
              <span className="never">Never</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="l-cta">
        <h2 className="serif">Give your treasury a keel</h2>
        <div className="l-actions">
          <a className="btn primary" href={APP}>
            Open app
          </a>
          <a className="btn" href="/docs">
            Read the docs
          </a>
        </div>
      </section>

      <footer className="l-foot">
        <a href={REPO}>Source on GitHub</a>
      </footer>
    </div>
  );
}
