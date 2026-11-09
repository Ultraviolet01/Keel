import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, mono, sans, serif } from "./theme";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const ease = Easing.bezier(0.22, 1, 0.36, 1);

/** Progress 0..1 of a smooth spring that starts `delay` frames into the scene. */
export function useIn(delay = 0, damping = 200, durationInFrames?: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping }, durationInFrames });
}

/** Deep teal backdrop: a slow-drifting grid and a soft moving glow, so no scene is ever still. */
export const Backdrop: React.FC<{ glow?: string; children?: React.ReactNode }> = ({ glow = C.teal, children }) => {
  const frame = useCurrentFrame();
  const drift = frame * 0.35;
  return (
    <AbsoluteFill style={{ background: C.deep, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.line} 1px, transparent 1px), linear-gradient(90deg, ${C.line} 1px, transparent 1px)`,
          backgroundSize: "96px 96px",
          backgroundPosition: `${drift}px ${drift * 0.6}px`,
          opacity: 0.35,
          maskImage: "radial-gradient(ellipse at 50% 45%, black 20%, transparent 75%)",
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(900px 600px at ${50 + Math.sin(frame / 90) * 8}% ${40 + Math.cos(frame / 110) * 6}%, ${glow}33, transparent 70%)`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

/** A line of words that rise into place one after another. */
export const Words: React.FC<{
  text: string;
  delay?: number;
  stagger?: number;
  size?: number;
  font?: "serif" | "sans";
  color?: string;
  weight?: number;
  highlight?: Record<string, string>;
  style?: React.CSSProperties;
}> = ({ text, delay = 0, stagger = 4, size = 96, font = "serif", color = C.ink, weight = 600, highlight = {}, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `0 ${size * 0.26}px`, ...style }}>
      {text.split(" ").map((w, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 200 } });
        return (
          <span
            key={i}
            style={{
              fontFamily: font === "serif" ? serif : sans,
              fontSize: size,
              fontWeight: weight,
              letterSpacing: font === "serif" ? "-0.02em" : "-0.01em",
              lineHeight: 1.08,
              color: highlight[w.replace(/[.,?!]/g, "")] ?? color,
              opacity: p,
              transform: `translateY(${(1 - p) * size * 0.45}px)`,
              filter: `blur(${(1 - p) * 8}px)`,
              display: "inline-block",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** Small uppercase label naming what a scene shows. */
export const Kicker: React.FC<{ children: React.ReactNode; delay?: number; color?: string }> = ({ children, delay = 0, color = C.teal2 }) => {
  const p = useIn(delay);
  return (
    <div style={{ fontFamily: mono, fontSize: 24, letterSpacing: "0.18em", textTransform: "uppercase", color, opacity: p, transform: `translateY(${(1 - p) * 14}px)` }}>
      {children}
    </div>
  );
};

/** A number that counts from `from` to `to` between two frames. */
export const Counter: React.FC<{ from: number; to: number; start: number; end: number; decimals?: number; prefix?: string; suffix?: string; style?: React.CSSProperties }> = ({
  from,
  to,
  start,
  end,
  decimals = 2,
  prefix = "",
  suffix = "",
  style,
}) => {
  const frame = useCurrentFrame();
  const v = interpolate(frame, [start, end], [from, to], { ...clamp, easing: ease });
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>
      {prefix}
      {v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
};

/** A rounded tag that pops in. */
export const Chip: React.FC<{ children: React.ReactNode; delay?: number; color?: string; tint?: string; size?: number }> = ({ children, delay = 0, color = C.teal2, tint = C.tealTint, size = 30 }) => {
  const p = useIn(delay, 14);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        padding: `${size * 0.42}px ${size * 0.8}px`,
        borderRadius: 999,
        border: `1.5px solid ${color}66`,
        background: tint,
        color,
        fontFamily: sans,
        fontWeight: 600,
        fontSize: size,
        opacity: Math.min(1, p * 1.4),
        transform: `scale(${0.6 + 0.4 * p})`,
      }}
    >
      {children}
    </div>
  );
};

/** A screen from the live app in a window frame, gliding in and slowly pushing in. Crops are fractions of the 2880x1800 capture. */
export const Shot: React.FC<{
  src: string;
  delay?: number;
  width?: number;
  from?: "right" | "left" | "bottom";
  crop?: { x: number; y: number; w: number; h: number };
  tilt?: number;
  bar?: boolean;
  natural?: { w: number; h: number };
  style?: React.CSSProperties;
}> = ({ src, delay = 0, width = 1100, from = "right", crop, tilt = 0, bar = true, natural = { w: 2880, h: 1800 }, style }) => {
  const frame = useCurrentFrame();
  const p = useIn(delay);
  const push = interpolate(frame - delay, [0, 240], [1, 1.05], clamp);
  const dx = from === "right" ? 160 : from === "left" ? -160 : 0;
  const dy = from === "bottom" ? 160 : 0;
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const scale = width / (c.w * natural.w);
  const height = c.h * natural.h * scale;
  return (
    <div
      style={{
        width,
        borderRadius: 18,
        overflow: "hidden",
        border: `1px solid ${C.line2}`,
        boxShadow: `0 40px 120px #000a, 0 0 0 1px #ffffff08`,
        background: C.surface,
        opacity: p,
        transform: `perspective(1800px) translate(${(1 - p) * dx}px, ${(1 - p) * dy}px) rotateY(${tilt * (1 - p * 0.4)}deg) scale(${0.94 + 0.06 * p})`,
        ...style,
      }}
    >
      {bar && (
        <div style={{ height: 34, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: C.page, borderBottom: `1px solid ${C.line}` }}>
          {[C.bad, C.brass, C.teal].map((col) => (
            <span key={col} style={{ width: 11, height: 11, borderRadius: 99, background: col, opacity: 0.7 }} />
          ))}
          <span style={{ marginLeft: 14, fontFamily: mono, fontSize: 15, color: C.muted }}>keel-treasury.vercel.app</span>
        </div>
      )}
      <div style={{ width, height, overflow: "hidden", position: "relative" }}>
        <Img
          src={staticFile(`shots/${src}.png`)}
          style={{
            position: "absolute",
            width: natural.w * scale,
            left: -c.x * natural.w * scale,
            top: -c.y * natural.h * scale,
            transform: `scale(${push})`,
            transformOrigin: "50% 30%",
          }}
        />
      </div>
    </div>
  );
};

/** Keel's wordmark with a keel line drawn underneath. */
export const Wordmark: React.FC<{ size?: number; delay?: number }> = ({ size = 200, delay = 0 }) => {
  const frame = useCurrentFrame();
  const p = useIn(delay, 200, 40);
  const draw = interpolate(frame - delay, [10, 50], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size * 0.1 }}>
      <div style={{ fontFamily: serif, fontWeight: 600, fontSize: size, letterSpacing: "0.12em", color: C.ink, opacity: p, transform: `translateY(${(1 - p) * 30}px)`, paddingLeft: "0.12em" }}>
        KEEL
      </div>
      <svg width={size * 3} height={size * 0.2} viewBox="0 0 600 40">
        <path d="M10 8 Q300 52 590 8" fill="none" stroke={C.teal2} strokeWidth={4} strokeLinecap="round" strokeDasharray={620} strokeDashoffset={620 * (1 - draw)} />
      </svg>
    </div>
  );
};

export const Center: React.FC<{ children: React.ReactNode; gap?: number; style?: React.CSSProperties }> = ({ children, gap = 28, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap, padding: 120, textAlign: "center", ...style }}>{children}</AbsoluteFill>
);
