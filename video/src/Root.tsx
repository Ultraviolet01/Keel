import React from "react";
import { Composition } from "remotion";
import { TransitionSeries, springTiming, type TransitionPresentation } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import timeline from "./timeline.json";
import { Alerts, Chains, Cta, Key, Line, Near, Proof, Someone, Team, Treasury, Turn } from "./scenes";

const SCENES: Record<string, React.FC> = { chains: Chains, someone: Someone, key: Key, turn: Turn, line: Line, proof: Proof, treasury: Treasury, team: Team, alerts: Alerts, near: Near, cta: Cta };
// How each scene enters: cuts that push forward on the story beats, fades on the quiet ones.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENTER: Record<string, () => TransitionPresentation<any>> = {
  someone: () => slide({ direction: "from-bottom" }),
  key: () => slide({ direction: "from-bottom" }),
  turn: () => fade(),
  line: () => wipe({ direction: "from-left" }),
  proof: () => slide({ direction: "from-right" }),
  treasury: () => slide({ direction: "from-right" }),
  team: () => slide({ direction: "from-right" }),
  alerts: () => slide({ direction: "from-right" }),
  near: () => fade(),
  cta: () => fade(),
};

const T = timeline.transition;
export const TOTAL = timeline.scenes.reduce((s, x) => s + x.frames, 0) - T * (timeline.scenes.length - 1);

const KeelDemo: React.FC = () => (
  <TransitionSeries>
    {timeline.scenes.flatMap((s, i) => {
      const Scene = SCENES[s.id];
      const seq = (
        <TransitionSeries.Sequence key={s.id} durationInFrames={s.frames}>
          <Scene />
        </TransitionSeries.Sequence>
      );
      if (i === 0) return [seq];
      return [<TransitionSeries.Transition key={`t-${s.id}`} presentation={ENTER[s.id]()} timing={springTiming({ config: { damping: 200 }, durationInFrames: T })} />, seq];
    })}
  </TransitionSeries>
);

export const Root: React.FC = () => <Composition id="KeelDemo" component={KeelDemo} durationInFrames={TOTAL} fps={timeline.fps} width={1920} height={1080} />;
