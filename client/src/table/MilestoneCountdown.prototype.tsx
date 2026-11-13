/**
 * PROTOTYPE — throwaway. Issue #279 (spec), #275 (request). Not production code: no tests, a
 * rAF per seat, numbers chosen by eye. Lives on `prototype/milestone-countdown` only.
 *
 * The question: what should the milestone countdown *look* like? The spec fixes the
 * behaviour (when it starts, what the label says, `OUT` withheld, reduced motion); the three
 * open variables are the burst's shape, the count's pacing and the pulse. Each variant below
 * takes a different answer to all three, so they disagree on structure rather than on colour.
 *
 * `Table.tsx`'s `ScoredDetail` hands a milestone seat to `MilestoneCountdown` whenever the
 * context below is provided — which only `MilestonePrototype.tsx` does.
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PlayerRoundResultView } from "@yaniv/shared";

export type VariantKey = "A" | "B" | "C" | "D";

export interface Variant {
  key: VariantKey;
  name: string;
  /** One line on what is different about it, shown in the switcher. */
  blurb: string;
  burst: "ring" | "sheen" | "flare" | "shock";
  /** Progress through the count (0..1) → share of the 50 drained so far (0..1). */
  ease: (t: number) => number;
  /** The number's scale at a moment of the count. */
  pulse: (p: PulseInput) => number;
  /** How long the burst element stays mounted, ms from the count's start. */
  burstMs: number;
  /** A hit on landing: the number overshoots and settles. */
  slam: boolean;
}

interface PulseInput {
  /** Progress through the count, 0..1. */
  t: number;
  /** ms since the count started. */
  e: number;
  /** ms since the number last changed. */
  sinceTick: number;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInCubic = (t: number) => t ** 3;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

export const VARIANTS: readonly Variant[] = [
  {
    key: "A",
    name: "Laser ring · linear · steady throb",
    blurb: "A white-hot laser head carves a blue ring round the namecard once; the count drains evenly; the number throbs at a steady 4Hz.",
    burst: "ring",
    ease: (t) => t,
    pulse: ({ e }) => 1 + 0.1 * (0.5 - 0.5 * Math.cos((2 * Math.PI * e) / 250)),
    burstMs: 600,
    slam: false,
  },
  {
    key: "B",
    name: "Sheen · ease-out drain · tick pop",
    blurb: "A bright band glints across the seat; the score drains fast then crawls in; every tick pops.",
    burst: "sheen",
    ease: easeOutCubic,
    pulse: ({ sinceTick }) => 1 + 0.24 * Math.exp(-sinceTick / 70),
    burstMs: 600,
    slam: false,
  },
  {
    key: "C",
    name: "Glow flare · accelerating · rising heartbeat",
    blurb: "A white-hot blue bloom at the seat; the count starts slow and rushes the end; the beat grows, then slams.",
    burst: "flare",
    ease: easeInCubic,
    pulse: ({ t, e }) => {
      // A chirp: 3Hz rising to 7Hz, amplitude rising with it, only the upstroke kept.
      const s = e / 1000;
      const phase = 2 * Math.PI * (3 * s + 2 * s * s);
      return 1 + (0.05 + 0.22 * t) * Math.max(0, Math.sin(phase));
    },
    burstMs: 550,
    slam: true,
  },
  {
    key: "D",
    name: "Shockwave · ease-in-out · hard beat",
    blurb: "Two rings ripple out from the score itself; the count rolls like an odometer; a hard, square beat.",
    burst: "shock",
    ease: smoothstep,
    pulse: ({ e }) => 1 + 0.28 * Math.sin((Math.PI * (e % 220)) / 220) ** 8,
    burstMs: 900,
    slam: false,
  },
];

export interface MilestonePrototype {
  variant: Variant;
  reduced: boolean;
  /** `performance.now()` at the moment the round was "scored" — the replay. */
  epoch: number;
  /** ms after the epoch the count starts: every banner gone. */
  startAt: number;
  /** How long the count lasts. */
  countMs: number;
}

export const MilestonePrototypeContext = createContext<MilestonePrototype | null>(null);

/** ms since the epoch, re-rendered every frame until `until`. */
function useElapsed(epoch: number, until: number): number {
  const [now, setNow] = useState(() => performance.now() - epoch);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const e = performance.now() - epoch;
      setNow(e);
      if (e < until) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [epoch, until]);
  return now;
}

/**
 * A milestone seat's score row: the `OUT` mark (withheld until the count lands) and the
 * equation, unfolded while the total drains and folded once it has.
 */
export function MilestoneCountdown({
  player,
  wentOut,
}: {
  player: PlayerRoundResultView;
  wentOut: boolean;
}) {
  const proto = useContext(MilestonePrototypeContext)!;
  const { variant, reduced, epoch, startAt, countMs } = proto;

  const reduction = player.milestoneReduction;
  const landedOn = player.scoreAfter + reduction;
  const before = player.scoreAfter - player.delta + reduction;
  const net = player.delta - reduction;

  const elapsed = useElapsed(epoch, startAt + countMs + 700);
  const e = elapsed - startAt;
  const t = Math.min(1, Math.max(0, e / countMs));
  const stage = e < 0 ? "before" : t < 1 ? "counting" : "landed";
  const value = stage === "before" ? landedOn : landedOn - Math.round(reduction * variant.ease(t));

  // When the number last changed, for a pulse that pops on each tick.
  const lastValue = useRef(value);
  const lastTickAt = useRef(0);
  if (value !== lastValue.current) {
    lastValue.current = value;
    lastTickAt.current = e;
  }

  let scale = 1;
  if (!reduced && stage === "counting") {
    scale = variant.pulse({ t, e, sinceTick: e - lastTickAt.current });
  }
  if (!reduced && stage === "landed" && variant.slam) {
    const since = e - countMs;
    scale = 1 + 0.45 * Math.exp(-since / 90) * Math.cos(since / 45);
  }

  const showBurst = stage === "counting" && e < variant.burstMs;
  const burst = !showBurst ? null : variant.burst === "ring" && !reduced ? (
    <LaserRing e={e} />
  ) : (
    <span
      className={reduced ? "msp-burst msp-burst--glow" : `msp-burst msp-burst--${variant.burst}`}
      aria-hidden="true"
    />
  );

  const withheld = wentOut && stage !== "landed";

  return (
    <>
      {/* Seat-level bursts sit on `.table-seat`'s box (or the footer's); the shockwave rides
          the number instead, so it is drawn inside the number's wrapper below. */}
      {variant.burst !== "shock" || reduced ? burst : null}
      {wentOut && !withheld && <span className="seat__mark seat__mark--out msp-out-in">out</span>}
      <span
        className={`player__score msp-score msp-score--${stage}${withheld ? " msp-pending-out" : ""}`}
      >
        {before}{" "}
        <span key={stage === "landed" ? "folded" : "unfolded"} className={stage === "landed" ? "msp-flip" : ""}>
          {stage === "landed" ? (net < 0 ? "-" : "+") : "+"}{" "}
          {stage === "landed" ? Math.abs(net) : player.delta}
        </span>{" "}
        ={" "}
        <span className="msp-num-wrap">
          {variant.burst === "shock" && !reduced ? burst : null}
          <span
            className={`msp-num msp-num--${stage}`}
            style={{ transform: `scale(${scale})` } as CSSProperties}
          >
            {value}
          </span>
        </span>{" "}
        pts
      </span>
    </>
  );
}

/*
 * A — the laser. The ring is a stroke round the namecard's own box, traced by distance along
 * its measured perimeter (positions below are percent of it) rather than by angle, so the head moves at one speed down
 * a long footer and a short seat label alike. Behind the head the trail falls off linearly to
 * nothing over `tail` of the perimeter — 80, a fifth sharper than the old conic sweep's tail,
 * which ran the whole lap. `?tail=` overrides it, to tune by eye.
 */
const LASER_SWEEP_MS = 420;
const LASER_FADE_MS = 180;
const LASER_SEGMENTS = 28;
const easeInOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);

function laserTail(): number {
  const t = Number(new URLSearchParams(window.location.search).get("tail"));
  return t > 0 && t <= 100 ? t : 80;
}

function LaserRing({ e }: { e: number }) {
  const tail = laserTail();
  // The perimeter in px, measured once mounted: `pathLength` does not rescale dashes set as CSS.
  const measure = useRef<SVGRectElement>(null);
  const [perimeter, setPerimeter] = useState(0);
  useLayoutEffect(() => setPerimeter(measure.current?.getTotalLength() ?? 0), []);
  const px = perimeter / 100;
  const head = 100 * easeInOutSine(Math.min(1, e / LASER_SWEEP_MS));
  const opacity = e <= LASER_SWEEP_MS ? 1 : Math.max(0, 1 - (e - LASER_SWEEP_MS) / LASER_FADE_MS);

  // A stroke from `a` to `b` along the perimeter, as a dash.
  const dash = (a: number, b: number) => ({
    strokeDasharray: `${(b - a) * px}px ${perimeter * 2}px`,
    strokeDashoffset: `${-a * px}px`,
  });

  const segments = [];
  for (let i = 0; i < LASER_SEGMENTS; i++) {
    const near = head - (i * tail) / LASER_SEGMENTS;
    const far = Math.max(0, head - ((i + 1) * tail) / LASER_SEGMENTS);
    if (near <= 0) break;
    const d = (i + 0.5) / LASER_SEGMENTS; // 0 at the head, 1 at the tail's end
    const white = Math.max(0, 1 - d * 7) * 100; // the first seventh of the tail is white-hot
    segments.push(
      <rect
        key={i}
        className="msp-laser__trail"
        style={{
          ...dash(far, near),
          opacity: 1 - d,
          stroke: `color-mix(in srgb, #fff ${white}%, var(--milestone))`,
        }}
      />,
    );
  }

  return (
    <svg className="msp-burst msp-laser" style={{ opacity }} aria-hidden="true">
      <rect ref={measure} className="msp-laser__measure" />
      {perimeter > 0 && <g className="msp-laser__glow">{segments}</g>}
      {perimeter > 0 && head > 0 && (
        <rect className="msp-laser__head" style={dash(Math.max(0, head - 8 / px), head)} /* 8px of head, whatever the card */ />
      )}
    </svg>
  );
}
