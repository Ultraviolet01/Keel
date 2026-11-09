import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, Center, Chip, Counter, Kicker, Shot, Words, Wordmark, clamp, ease, useIn } from "./parts";
import { C, mono, sans, serif } from "./theme";

// ------------------------------------------------------------- 1. the problem

const CHAINS = [
  { name: "NEAR", amt: 48210 },
  { name: "Base", amt: 12900 },
  { name: "Ethereum", amt: 31450 },
  { name: "Arbitrum", amt: 8300 },
  { name: "Optimism", amt: 5120 },
];

export const Chains: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Backdrop>
      <Center gap={70}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 26 }}>
          <Kicker>The problem</Kicker>
          <Words text="Your company's money sits on five chains." size={92} delay={6} highlight={{ five: C.brass, chains: C.brass }} />
        </div>
        <div style={{ position: "relative", display: "flex", gap: 46 }}>
          <svg width={1480} height={4} style={{ position: "absolute", top: 70, left: 0 }}>
            <line x1={0} y1={2} x2={1480 * interpolate(frame, [40, 100], [0, 1], { ...clamp, easing: ease })} y2={2} stroke={C.line2} strokeWidth={2} strokeDasharray="8 10" />
          </svg>
          {CHAINS.map((c, i) => {
            const p = spring({ frame: frame - 34 - i * 6, fps: 30, config: { damping: 13 } });
            const bob = Math.sin((frame + i * 20) / 18) * 5;
            return (
              <div key={c.name} style={{ width: 260, display: "flex", flexDirection: "column", alignItems: "center", gap: 18, opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 60 + bob}px) scale(${0.7 + 0.3 * p})` }}>
                <div style={{ width: 140, height: 140, borderRadius: 99, border: `2px solid ${C.teal}88`, background: C.surface, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: sans, fontWeight: 600, fontSize: 26, color: C.ink, boxShadow: `0 0 50px ${C.teal}22` }}>
                  {c.name}
                </div>
                <Counter from={0} to={c.amt} start={50 + i * 6} end={110 + i * 6} decimals={0} suffix=" USDC" style={{ fontFamily: mono, fontSize: 28, color: C.muted }} />
              </div>
            );
          })}
        </div>
      </Center>
    </Backdrop>
  );
};

const TASKS = ["pay every bill.", "watch every balance.", "move every idle dollar.", "do it every week."];

export const Someone: React.FC = () => {
  const frame = useCurrentFrame();
  const slot = 32;
  const i = Math.min(TASKS.length - 1, Math.floor(Math.max(0, frame - 20) / slot));
  const local = Math.max(0, frame - 20) - i * slot;
  const inP = interpolate(local, [0, 10], [0, 1], { ...clamp, easing: ease });
  const outP = i < TASKS.length - 1 ? interpolate(local, [slot - 8, slot], [0, 1], clamp) : 0;
  const stamps = [
    { t: "Bills paid late", c: C.brass, d: 128 },
    { t: "Idle cash earns 0%", c: C.brass, d: 136 },
    { t: "Nobody watching", c: C.bad, d: 144 },
  ];
  return (
    <Backdrop glow={C.brass}>
      <Center gap={50}>
        <Words text="Someone has to" size={100} />
        <div style={{ height: 130, overflow: "hidden", display: "flex", alignItems: "center" }}>
          <div style={{ fontFamily: serif, fontWeight: 600, fontSize: 110, color: C.brass, letterSpacing: "-0.02em", transform: `translateY(${(1 - inP) * 90 - outP * 90}px)`, opacity: inP * (1 - outP) }}>
            {TASKS[i]}
          </div>
        </div>
        <div style={{ display: "flex", gap: 28, marginTop: 20 }}>
          {stamps.map((s) => (
            <Chip key={s.t} delay={s.d} color={s.c} tint={s.c === C.bad ? C.badTint : C.brassTint} size={30}>
              {s.t}
            </Chip>
          ))}
        </div>
      </Center>
    </Backdrop>
  );
};

export const Key: React.FC = () => {
  const frame = useCurrentFrame();
  const keyIn = useIn(30, 12);
  const swing = Math.sin(frame / 10) * 6 * (1 - interpolate(frame, [30, 90], [0, 1], clamp));
  const drain = interpolate(frame, [92, 140], [1, 0], { ...clamp, easing: ease });
  return (
    <Backdrop glow={C.bad}>
      <Center gap={44}>
        <Words text="Hand an AI agent the wallet key?" size={92} highlight={{ key: C.brass }} />
        <div style={{ display: "flex", alignItems: "center", gap: 80, marginTop: 10 }}>
          <svg width={220} height={110} viewBox="0 0 220 110" style={{ opacity: keyIn, transform: `rotate(${swing}deg) scale(${0.6 + 0.4 * keyIn})` }}>
            <circle cx={55} cy={55} r={38} fill="none" stroke={C.brass} strokeWidth={12} />
            <rect x={90} y={49} width={120} height={12} rx={6} fill={C.brass} />
            <rect x={170} y={55} width={12} height={30} rx={4} fill={C.brass} />
            <rect x={194} y={55} width={12} height={22} rx={4} fill={C.brass} />
          </svg>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14, opacity: useIn(70) }}>
            <Counter from={105980} to={0} start={92} end={140} prefix="" suffix=" USDC" style={{ fontFamily: serif, fontWeight: 600, fontSize: 96, color: frame > 100 ? C.bad : C.ink }} />
            <div style={{ width: 560, height: 14, borderRadius: 99, background: C.surface, overflow: "hidden" }}>
              <div style={{ width: `${drain * 100}%`, height: "100%", background: frame > 100 ? C.bad : C.teal }} />
            </div>
          </div>
        </div>
        <Words text="It can spend everything." size={64} font="sans" color={C.bad} delay={118} weight={600} />
      </Center>
    </Backdrop>
  );
};

// ---------------------------------------------------------------- 2. the turn

export const Turn: React.FC = () => (
  <Backdrop>
    <Center gap={40}>
      <Words text="Give it rules, not keys." size={110} highlight={{ rules: C.teal2 }} />
      <div style={{ marginTop: 30 }}>
        <Wordmark size={150} delay={40} />
      </div>
      <Words text="An AI treasury agent on NEAR" size={40} font="sans" color={C.muted} delay={62} weight={500} />
    </Center>
  </Backdrop>
);

// ------------------------------------------------------------- 3. the line

/** Three payments leave Keel: one passes the vault's line, one waits for the owner, one is refused. */
export const Line: React.FC = () => {
  const frame = useCurrentFrame();
  const draw = interpolate(frame, [10, 50], [0, 1], { ...clamp, easing: ease });
  const box = { x: 250, y: 330, w: 820, h: 460 };
  const wall = box.x + box.w;
  const agent = { x: box.x + 130, y: box.y + box.h / 2 };
  const you = { x: wall + 190, y: box.y + 30 };
  const pulse = 1 + Math.sin(frame / 8) * 0.06;
  const youIn = interpolate(frame, [110, 130], [0, 1], clamp);

  // Pills are placed by their right edge, so they stop right at the wall.
  const token = (start: number, kind: "pass" | "ask" | "block") => {
    const t = frame - start;
    const startX = agent.x + 470;
    let x = interpolate(t, [0, 30], [startX, wall - 14], { ...clamp, easing: ease });
    let y = agent.y;
    let color = C.teal2;
    let shake = 0;
    let opacity = interpolate(t, [0, 8], [0, 1], clamp);
    if (kind === "pass") {
      x = interpolate(t, [0, 30, 62], [startX, wall - 14, wall + 520], { ...clamp, easing: ease });
      opacity *= interpolate(t, [50, 64], [1, 0], clamp);
    } else if (kind === "ask") {
      const up = interpolate(t, [34, 60], [0, 1], { ...clamp, easing: ease });
      if (up > 0) {
        color = C.brass;
        x = interpolate(up, [0, 1], [wall - 14, you.x - 56]);
        y = interpolate(up, [0, 1], [agent.y, you.y]);
      }
      opacity *= interpolate(t, [58, 66], [1, 0], clamp);
    } else {
      const hit = interpolate(t, [30, 48], [0, 1], clamp);
      if (hit > 0) color = C.bad;
      shake = hit > 0 && hit < 1 ? Math.sin(t * 2.4) * 10 : 0;
    }
    return { x: x + shake, y, color, opacity, visible: t >= 0 };
  };

  const pays = [
    { start: 60, kind: "pass" as const, label: "Northwind · 80 USDC", note: "Approved payee, under the caps → paid alone", noteAt: 90, pos: { left: wall + 70, top: agent.y - 110 } },
    { start: 120, kind: "ask" as const, label: "Atlas · 132 USDC", note: "New payee → waits for your signature", noteAt: 178, pos: { left: you.x + 70, top: you.y - 22 } },
    { start: 190, kind: "block" as const, label: "“Changed bank details” · 4,000 USDC", note: "Blocklisted → refused, nothing signed", noteAt: 222, pos: { left: wall + 70, top: agent.y + 56 } },
  ];

  return (
    <Backdrop>
      <AbsoluteFill>
        <div style={{ position: "absolute", top: 90, width: "100%", display: "flex", justifyContent: "center" }}>
          <Words text="You set the line. The vault holds it." size={64} highlight={{ line: C.teal2, vault: C.teal2 }} />
        </div>
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={36} fill={`${C.teal}0d`} stroke={C.teal} strokeWidth={3} strokeDasharray={2600} strokeDashoffset={2600 * (1 - draw)} />
          <line x1={wall} y1={box.y + 30} x2={wall} y2={box.y + box.h - 30} stroke={C.teal2} strokeWidth={8} strokeLinecap="round" opacity={draw} />
          <circle cx={agent.x} cy={agent.y} r={46 * pulse} fill={C.tealTint} stroke={C.teal2} strokeWidth={3} opacity={draw} />
          <circle cx={you.x} cy={you.y} r={40} fill={C.brassTint} stroke={C.brass} strokeWidth={3} opacity={youIn} />
        </svg>
        <div style={{ position: "absolute", left: box.x + 30, top: box.y + 24, fontFamily: mono, fontSize: 22, color: C.teal2, opacity: draw }}>KEEL VAULT · NEAR CONTRACT</div>
        <div style={{ position: "absolute", left: agent.x - 60, top: agent.y + 60, width: 120, textAlign: "center", fontFamily: sans, fontWeight: 600, fontSize: 26, color: C.ink, opacity: draw }}>Keel</div>
        <div style={{ position: "absolute", left: you.x - 60, top: you.y + 48, width: 120, textAlign: "center", fontFamily: sans, fontWeight: 600, fontSize: 26, color: C.brass, opacity: youIn }}>You</div>
        <div style={{ position: "absolute", left: box.x, top: box.y + box.h + 20, width: box.w, textAlign: "right", fontFamily: mono, fontSize: 20, color: C.muted, opacity: draw }}>the line: your caps · cash buffer · payees · blocklist</div>
        {pays.map((p) => {
          const t = token(p.start, p.kind);
          if (!t.visible) return null;
          const noteP = spring({ frame: frame - p.noteAt, fps: 30, config: { damping: 200 } });
          return (
            <React.Fragment key={p.label}>
              <div
                style={{
                  position: "absolute",
                  left: t.x,
                  top: t.y - 26,
                  transform: "translateX(-100%)",
                  padding: "10px 20px",
                  borderRadius: 999,
                  background: C.surface,
                  border: `2px solid ${t.color}`,
                  color: t.color,
                  fontFamily: sans,
                  fontWeight: 600,
                  fontSize: 24,
                  whiteSpace: "nowrap",
                  boxShadow: `0 0 30px ${t.color}44`,
                  opacity: t.opacity,
                }}
              >
                {p.label}
              </div>
              <div
                style={{
                  position: "absolute",
                  ...p.pos,
                  width: 560,
                  fontFamily: sans,
                  fontSize: 30,
                  fontWeight: 600,
                  lineHeight: 1.25,
                  color: p.kind === "pass" ? C.teal2 : p.kind === "ask" ? C.brass : C.bad,
                  opacity: noteP,
                  transform: `translateX(${(1 - noteP) * 40}px)`,
                }}
              >
                {p.note}
              </div>
            </React.Fragment>
          );
        })}
        <div style={{ position: "absolute", bottom: 70, width: "100%", display: "flex", justifyContent: "center" }}>
          <Words text="Whatever Keel decides, nothing gets past the line." size={46} font="sans" color={C.ink2} weight={500} delay={232} stagger={2} />
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---------------------------------------------------------------- 4. proof

const LOG: { step: string; text: string; color: string }[] = [
  { step: "observe", text: "compass.keel.testnet · 7 open bills", color: C.muted },
  { step: "forecast", text: "short 8.00 USDC on 9 Nov", color: C.brass },
  { step: "check", text: "Payroll · already paid by the vault", color: C.muted },
  { step: "decide", text: "refuse: payee is on the blocklist", color: C.bad },
  { step: "check", text: "Atlas · proposed #4, waits for you", color: C.brass },
  { step: "check", text: "Arbitrum bill → NEAR Chain Signatures", color: C.teal2 },
];

export const Proof: React.FC = () => {
  const frame = useCurrentFrame();
  const card = useIn(8);
  return (
    <Backdrop>
      <AbsoluteFill style={{ padding: "110px 110px", flexDirection: "row", alignItems: "center", gap: 70 }}>
        <div style={{ width: 760, display: "flex", flexDirection: "column", gap: 30 }}>
          <Kicker>Live on NEAR testnet</Kicker>
          <Words text="Every decision, with the rule it checked." size={66} style={{ justifyContent: "flex-start" }} />
          <div style={{ marginTop: 16, borderRadius: 18, background: "#050b0d", border: `1px solid ${C.line2}`, padding: "28px 32px", opacity: card, transform: `translateY(${(1 - card) * 40}px)`, boxShadow: "0 30px 90px #0008" }}>
            <div style={{ fontFamily: mono, fontSize: 22, color: C.teal2, marginBottom: 18 }}>$ npm run demo -- --dry-run</div>
            {LOG.map((l, i) => {
              const start = 30 + i * 22;
              const chars = Math.floor(interpolate(frame, [start, start + 18], [0, l.text.length], clamp));
              if (frame < start) return null;
              return (
                <div key={i} style={{ display: "flex", gap: 20, fontFamily: mono, fontSize: 22, lineHeight: 1.75 }}>
                  <span style={{ width: 120, color: C.muted }}>{l.step}</span>
                  <span style={{ color: l.color }}>
                    {l.text.slice(0, chars)}
                    {chars < l.text.length && frame % 10 < 6 ? "▍" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <Shot src="approvals" delay={60} width={880} crop={{ x: 0.465, y: 0, w: 0.535, h: 0.95 }} tilt={-6} />
      </AbsoluteFill>
    </Backdrop>
  );
};

// ------------------------------------------------------------- 5. treasury

const Tile: React.FC<{ title: string; sub: string; delay: number; children: React.ReactNode }> = ({ title, sub, delay, children }) => {
  const p = useIn(delay);
  return (
    <div style={{ width: 760, height: 300, borderRadius: 26, background: C.surface, border: `1px solid ${C.line2}`, padding: "34px 40px", display: "flex", gap: 34, alignItems: "center", opacity: p, transform: `translateY(${(1 - p) * 50}px)` }}>
      <div style={{ width: 210, height: 210, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: serif, fontWeight: 600, fontSize: 44, color: C.ink, lineHeight: 1.1 }}>{title}</div>
        <div style={{ fontFamily: sans, fontSize: 26, color: C.muted, lineHeight: 1.35 }}>{sub}</div>
      </div>
    </div>
  );
};

export const Treasury: React.FC = () => {
  const frame = useCurrentFrame();
  const lit = (i: number) => frame > 50 + i * 12;
  const level = interpolate(frame, [70, 150], [0.95, 0.36], { ...clamp, easing: ease });
  const card = interpolate(frame, [110, 170], [0.25, 0.85], { ...clamp, easing: ease });
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 90, gap: 50 }}>
        <Words text="It runs the whole treasury." size={78} highlight={{ whole: C.teal2 }} />
        <div style={{ display: "grid", gridTemplateColumns: "760px 760px", gap: 34 }}>
          <Tile title="Pays bills on five chains" sub="NEAR, plus Base, Ethereum, Arbitrum and Optimism through Chain Signatures" delay={20}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, width: 190, justifyContent: "center" }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} style={{ width: 52, height: 52, borderRadius: 99, border: `3px solid ${C.teal2}`, background: lit(i) ? C.teal2 : "transparent", boxShadow: lit(i) ? `0 0 24px ${C.teal2}` : "none" }} />
              ))}
            </div>
          </Tile>
          <Tile title="Keeps a cash buffer" sub="Payroll first; other bills wait instead of draining the vault" delay={32}>
            <div style={{ position: "relative", width: 110, height: 190, borderRadius: 16, border: `3px solid ${C.line2}`, overflow: "hidden" }}>
              <div style={{ position: "absolute", bottom: 0, width: "100%", height: `${level * 100}%`, background: `${C.teal}cc` }} />
              <div style={{ position: "absolute", bottom: "35%", width: "100%", borderTop: `4px dashed ${C.brass}` }} />
            </div>
          </Tile>
          <Tile title="Puts idle cash to work" sub="Rhea lending, withdrawn to the vault when bills need it" delay={44}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <Counter from={0} to={10.4} start={70} end={140} decimals={1} suffix="%" style={{ fontFamily: serif, fontWeight: 600, fontSize: 58, color: C.teal2 }} />
              <span style={{ fontFamily: mono, fontSize: 20, color: C.muted }}>a year, testnet</span>
            </div>
          </Tile>
          <Tile title="Tops up card wallets" sub="Back to the balance you set, at most once a day" delay={56}>
            <svg width={190} height={190} viewBox="0 0 190 190">
              <circle cx={95} cy={95} r={76} fill="none" stroke={C.line2} strokeWidth={16} />
              <circle cx={95} cy={95} r={76} fill="none" stroke={C.brass} strokeWidth={16} strokeLinecap="round" strokeDasharray={477} strokeDashoffset={477 * (1 - card)} transform="rotate(-90 95 95)" />
            </svg>
          </Tile>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// -------------------------------------------------------------- 6. teams

export const Team: React.FC = () => {
  const frame = useCurrentFrame();
  const members = ["Founder", "Finance", "Co-founder"];
  return (
    <Backdrop>
      <AbsoluteFill style={{ padding: "120px 110px", flexDirection: "row", alignItems: "center", gap: 80 }}>
        <div style={{ width: 720, display: "flex", flexDirection: "column", gap: 34 }}>
          <Kicker>One founder or a whole team</Kicker>
          <Words text="Hand the vault to your multisig." size={70} style={{ justifyContent: "flex-start" }} highlight={{ multisig: C.teal2 }} />
          <Words text="Every change becomes a vote. Keel keeps working." size={34} font="sans" color={C.muted} weight={500} delay={24} stagger={2} style={{ justifyContent: "flex-start" }} />
          <div style={{ display: "flex", gap: 36, marginTop: 20 }}>
            {members.map((m, i) => {
              const p = useIn(40 + i * 8, 14);
              const voted = i < 2 && frame > 80 + i * 20;
              return (
                <div key={m} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: p, transform: `scale(${0.7 + 0.3 * p})` }}>
                  <div style={{ width: 110, height: 110, borderRadius: 99, background: voted ? C.tealTint : C.surface, border: `3px solid ${voted ? C.teal2 : C.line2}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 54, color: C.teal2, fontFamily: sans, fontWeight: 600 }}>
                    {voted ? "✓" : ""}
                  </div>
                  <span style={{ fontFamily: sans, fontSize: 24, color: C.ink2 }}>{m}</span>
                </div>
              );
            })}
          </div>
          <div style={{ fontFamily: mono, fontSize: 26, color: C.teal2, opacity: interpolate(frame, [125, 140], [0, 1], clamp) }}>2 of 3 approved → the vault runs it</div>
        </div>
        <Shot src="multisig" delay={30} width={860} crop={{ x: 0.115, y: 0.585, w: 0.5, h: 0.4 }} tilt={-6} />
      </AbsoluteFill>
    </Backdrop>
  );
};

// ------------------------------------------------------------- 7. alerts

export const Alerts: React.FC = () => {
  const frame = useCurrentFrame();
  const ping = interpolate(frame, [20, 50], [0, 1], clamp);
  const sheets = ["Summary", "Activity", "Payments", "Ledger", "Wallets"];
  return (
    <Backdrop>
      <AbsoluteFill style={{ padding: "100px 110px", flexDirection: "row", alignItems: "center", gap: 90 }}>
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", left: -26, top: -26, width: 52, height: 52, borderRadius: 99, border: `3px solid ${C.teal2}`, transform: `scale(${1 + ping * 1.6})`, opacity: 1 - ping }} />
          <div style={{ position: "absolute", left: -14, top: -14, width: 28, height: 28, borderRadius: 99, background: C.teal2, zIndex: 2, opacity: useIn(16) }} />
          <Shot src="email" delay={10} width={820} bar={false} natural={{ w: 1360, h: 1120 }} crop={{ x: 0, y: 0, w: 1, h: 0.62 }} from="bottom" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 34, width: 820 }}>
          <Kicker>It tells you, and it reports</Kicker>
          <Words text="An email when something needs you." size={64} style={{ justifyContent: "flex-start" }} />
          <Words text="Approvals, votes, refused bills, cash running short. A daily digest when money moved." size={30} font="sans" color={C.muted} weight={500} delay={20} stagger={1} style={{ justifyContent: "flex-start" }} />
          <div style={{ marginTop: 26, fontFamily: sans, fontWeight: 600, fontSize: 34, color: C.ink, opacity: useIn(90) }}>An Excel report for your accountant:</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {sheets.map((s, i) => (
              <Chip key={s} delay={100 + i * 7} size={26}>
                {s}
              </Chip>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---------------------------------------------------------------- 8. NEAR

export const Near: React.FC = () => {
  const parts = ["Keel Vault contract", "Function-call access key", "Chain Signatures", "Rhea lending", "Sputnik DAO multisig", "NEAR AI Cloud", "NEAR Intents"];
  return (
    <Backdrop>
      <Center gap={50}>
        <Kicker>Built on NEAR</Kicker>
        <Words text="The contract holds the line. The agent does the work." size={72} highlight={{ contract: C.teal2, agent: C.brass }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, justifyContent: "center", maxWidth: 1500, marginTop: 10 }}>
          {parts.map((p, i) => (
            <Chip key={p} delay={36 + i * 6} size={30}>
              {p}
            </Chip>
          ))}
        </div>
      </Center>
    </Backdrop>
  );
};

// ----------------------------------------------------------------- 9. close

export const Cta: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const fadeOut = interpolate(frame, [durationInFrames - 20, durationInFrames], [1, 0], clamp);
  return (
    <Backdrop>
      <Center gap={36} style={{ opacity: fadeOut }}>
        <Wordmark size={170} />
        <Words text="Runs your treasury. Never past the line." size={64} delay={30} highlight={{ line: C.teal2 }} />
        <div style={{ marginTop: 26 }}>
          <Chip delay={60} size={38}>
            keel-treasury.vercel.app
          </Chip>
        </div>
        <Words text="Live on NEAR testnet · Open source" size={30} font="sans" color={C.muted} weight={500} delay={76} stagger={2} />
      </Center>
    </Backdrop>
  );
};
