/**
 * Whether a scored round has a milestone count to play, whose seats it counts at, and what
 * each of their lines says at a moment of it.
 *
 * The pure half of the **milestone countdown** (spec #280), and `announcement.ts`'s sibling:
 * two positions in — the one on the screen and the one that has just arrived — and either a
 * description of what to count or nothing at all. A seat whose total a round left exactly on
 * a multiple of 50 is shown landing there and then draining by 50 (docs/rules.md §7); this
 * says which seats and between which two numbers, and — given how far into the count a frame
 * is — what the line says, how large its total is drawn and whether the news of going out may
 * show yet — and which count the table holds, given the one it held (`latchCount`). It says
 * nothing about pixels, elements or clocks: the table runs the one clock (`countClock.ts`) the
 * count is read by.
 *
 * Total in the same way as its sibling: every pair of positions has an answer, and "nothing
 * to count" is one of them; every elapsed time has a frame, before the count and after it.
 */

import type { Phase, PlayerGameView, PlayerRoundResultView } from "@yaniv/shared";
import { scoreLabel } from "./score.ts";
import {
  MILESTONE_COUNT_MS,
  MILESTONE_PULSE_MS,
  MILESTONE_RING_FADE_MS,
  MILESTONE_RING_MS,
} from "./timing.ts";

/** One seat's count: where its total landed and where the milestone leaves it. */
export interface MilestoneCount {
  readonly playerId: string;
  /** The multiple of 50 the round's points took the total to: `scoreAfter + reduction`. */
  readonly landedOn: number;
  /** The total the round recorded, once the milestone has taken its 50 off: `scoreAfter`. */
  readonly settlesOn: number;
}

/**
 * The round being counted and every seat counting in it, or null when there is nothing.
 *
 * `round` and `phase` are the scorecard's length and the phase on the position that scored it
 * — together the key the table latches the count on (`countLive`), so a republication of the
 * same round neither restarts nor cuts it off. The seats are a non-empty tuple on
 * `Announcement`'s precedent: an empty count is unconstructible, and "nothing to count" has
 * exactly one spelling.
 */
export type Countdown = {
  readonly round: number;
  readonly phase: Phase;
  readonly seats: readonly [MilestoneCount, ...MilestoneCount[]];
} | null;

/**
 * What the arriving position has to count, or null.
 *
 * **The announcement's trigger exactly** (`announcementFrom`, whose comment gives the
 * reasoning at length): the scorecard has grown by a row from a position that was on the
 * screen. The result beside it is left standing between rounds, and survives a deal, a drop,
 * a departure and a seat resumed — so a count read off it would start again on each. The
 * newest row is definitionally the round just scored, and it carries everything a count
 * needs, so the trigger and the content are one fact.
 *
 * The phase is never asked, so a milestone in the round that ends the match counts at
 * `gameEnd`. `shown` is null where nothing was on screen to arrive from — a cold boot or a
 * seat claimed back — and a count is an event, not a record: the scorecard's blue cell is.
 */
export function countdownFrom(shown: PlayerGameView | null, arriving: PlayerGameView): Countdown {
  if (shown === null) return null;
  if (arriving.scorecard.length <= shown.scorecard.length) return null;

  const row = arriving.scorecard[arriving.scorecard.length - 1];
  if (row === undefined) return null;

  const seats = row.players
    .filter((line) => line.milestoneReduction > 0)
    .map(({ playerId, scoreAfter, milestoneReduction }) => ({
      playerId,
      landedOn: scoreAfter + milestoneReduction,
      settlesOn: scoreAfter,
    }));

  const [first, ...rest] = seats;
  return first === undefined
    ? null
    : { round: arriving.scorecard.length, phase: arriving.phase, seats: [first, ...rest] };
}

/**
 * Whether a count the table has latched is still the one on the screen: the round it was
 * scored in, in the phase it was scored in (spec #280).
 *
 * The round alone is not enough. A deal leaves the scored phase with the scorecard unchanged,
 * and so does a departure that ends the match from `roundEnd`: `gameEnd` reveals that same
 * round again, with no new row, and `App` keeps the same table mounted under the standings. So
 * either one ends the count only because the phase moved. A republication of the same round (a
 * drop, a reconnect, a departure that leaves the match going) changes neither, and the count
 * runs on through it.
 */
export function countLive(count: NonNullable<Countdown>, view: PlayerGameView): boolean {
  return view.phase === count.phase && view.scorecard.length === count.round;
}

/**
 * A count the table is holding: the countdown it was handed, when it started, and whether the
 * viewer asked for reduced motion at that moment — asked once, as a flight asks it, a count being
 * short enough that a preference changed halfway through can wait for the next one.
 */
export interface LatchedCount {
  readonly count: NonNullable<Countdown>;
  readonly startedAt: number;
  readonly still: boolean;
}

/**
 * The count the table holds once `view` and `countdown` are on the screen, given the one it held
 * before (spec #280).
 *
 * **A countdown it has not latched yet is latched**, `start` asked for the moment and the
 * preference — so a new count replaces a stale one, and the same countdown, seen again on a
 * re-render of the same snapshot, is not latched twice. Countdowns are told apart by identity:
 * the session replaces its snapshot wholesale and clears the one-shot on the next publication,
 * so a countdown object is one arrival.
 *
 * **Otherwise the latch is kept while it is live** (`countLive`) — a republication of the same
 * round neither restarts nor cuts it off — **and dropped the first time it is not**, returning
 * null, so it can never come back to life on a later position that happens to share its key, a
 * rematch ending on as many rounds as this one did.
 *
 * Returns `latch` itself when nothing changed, so a caller can tell an update from none by
 * identity.
 */
export function latchCount(
  latch: LatchedCount | null,
  countdown: Countdown,
  view: PlayerGameView,
  start: () => { readonly startedAt: number; readonly still: boolean },
): LatchedCount | null {
  if (countdown !== null && countdown !== latch?.count) return { count: countdown, ...start() };
  return latch !== null && countLive(latch.count, view) ? latch : null;
}

/** Whether `playerId` is one of the seats the latched count counts at. */
export function isCounting(latch: LatchedCount | null, playerId: string): boolean {
  return latch?.count.seats.some((seat) => seat.playerId === playerId) ?? false;
}

/**
 * Whether a seat's namecard may wear the news that this round took it out — the red ring
 * beside the `OUT` mark (spec #280, amended on review #281) — read at the grain the table
 * re-renders on: a count is either still running or `landed`, never a frame in between.
 *
 * `countFrame`'s own answer, asked at the count's first moment for a seat still counting and
 * after its end for every other, so the ring and the mark cannot disagree about when.
 */
export function outShownFor(
  latch: LatchedCount | null,
  landed: boolean,
  line: PlayerRoundResultView,
  wentOut: boolean,
): boolean {
  const running = !landed && isCounting(latch, line.playerId);
  return countFrame(line, wentOut, running ? 0 : Infinity).outShown;
}

/** What one seat's scored line says at a moment of its count. */
export interface CountFrame {
  /** Still draining, or done — the moment the line goes back to the sentence every seat reads. */
  readonly stage: "counting" | "landed";
  /** The total the line ends on at this moment. */
  readonly total: number;
  /** `${before} + ${delta} = ${total} pts` while counting; `scoreLabel(...)` once landed. */
  readonly label: string;
  /**
   * The label up to its total — `${lead}${total} pts` is `label`, at every moment — so the table
   * can draw the total in a box of its own and throb it without the sentence around it.
   */
  readonly lead: string;
  /**
   * How large the total is drawn: `pulseScale` while counting, and at rest — exactly 1 — once
   * landed, so the line every seat reads is never drawn mid-throb. Whether to draw it at all is
   * the table's, which asks the reduced-motion preference (spec #280).
   */
  readonly scale: number;
  /** Whether the seat may wear the news that this round took it out: `OUT` and the red ring. */
  readonly outShown: boolean;
}

/**
 * One seat's line, `elapsedMs` into its count.
 *
 * **While counting** the sentence is the round unfolded — where they stood, the round's raw
 * points, and the total those took them to — and the total drains **linearly** to where the
 * milestone left it (variant A, #279: a total read as falling steadily, not as a number being
 * swapped). The two fixed numbers are exactly `scoreLabel`'s `scoreBefore` and the wire's
 * `delta`, so the unfolded sentence and the folded one are the same arithmetic.
 *
 * **Once landed** it is `scoreLabel`'s sentence, unchanged — one frame from the count to the line
 * every other scored seat reads, never a third wording.
 *
 * **Going out waits for the landing** (spec #280, amended on plan review #281): on a seat that
 * hit a milestone and went out in the same round, `OUT` and the red ring tell the end of the
 * count before it is over — and the count is the news. A seat that went out with nothing to
 * count shows both at once, as it always has; so does any line no milestone touched, which is
 * landed from the start, so a seat that is not counting can never be drawn as one.
 *
 * **The total throbs while it drains** (`pulseScale`), and rests the moment it lands.
 *
 * Total over any elapsed time: before 0 (a frame stamped a hair before the table latched the
 * count) it reads as the count's first moment, and from `MILESTONE_COUNT_MS` on as its last.
 */
export function countFrame(player: PlayerRoundResultView, wentOut: boolean, elapsedMs: number): CountFrame {
  const { scoreAfter, delta, milestoneReduction } = player;
  const landed = milestoneReduction === 0 || elapsedMs >= MILESTONE_COUNT_MS;
  if (landed) {
    const label = scoreLabel(scoreAfter, delta, milestoneReduction);
    return {
      stage: "landed",
      total: scoreAfter,
      label,
      lead: label.slice(0, label.lastIndexOf(" = ") + " = ".length),
      scale: 1,
      outShown: wentOut,
    };
  }

  const landedOn = scoreAfter + milestoneReduction;
  const total = landedOn - Math.round(milestoneReduction * clamp01(elapsedMs / MILESTONE_COUNT_MS));
  const lead = `${landedOn - delta} + ${delta} = `;
  return {
    stage: "counting",
    total,
    label: `${lead}${total} pts`,
    lead,
    scale: elapsedMs < 0 ? 1 : pulseScale(elapsedMs),
    outShown: false,
  };
}

/**
 * How large a draining total is drawn, `elapsedMs` into its count: 1 at the start of every
 * throb, 1.1 half of one in, and back, every `MILESTONE_PULSE_MS` — a steady 4Hz (spec #280).
 *
 * A raised cosine rather than a triangle, so the number eases into and out of each extreme
 * instead of bouncing off it — variant A's curve exactly (#279). Periodic and nothing else: it
 * knows nothing of where the count ends, which is `countFrame`'s to say.
 */
export function pulseScale(elapsedMs: number): number {
  return 1 + 0.1 * (0.5 - 0.5 * Math.cos((2 * Math.PI * elapsedMs) / MILESTONE_PULSE_MS));
}

/**
 * A stretch of a namecard's perimeter, in percent of it from where the lap starts — the units of
 * a rect drawn with `pathLength="100"`, so the browser turns them into lengths and nothing here,
 * or in the component that draws them, has to measure the namecard.
 */
export interface RingStroke {
  readonly from: number;
  readonly to: number;
}

/** One segment of the trail behind the head: how much of it is left, and how white it still is. */
export interface RingSegment extends RingStroke {
  /** 1 at the head, falling off linearly to nothing at the tail's end. */
  readonly opacity: number;
  /** How far from milestone blue to white the stroke is mixed: 1 at the head, 0 a seventh back. */
  readonly white: number;
}

/** The laser ring at one moment of the count: how visible it is, its head and the trail behind. */
export interface RingFrame {
  /** The whole ring's opacity: 1 through the lap, then fading. */
  readonly opacity: number;
  /** The white-hot head, or null before it has moved. */
  readonly head: RingStroke | null;
  /** The trail, head end first. Empty before the head has moved. */
  readonly trail: readonly RingSegment[];
}

/** How many strokes the trail is drawn in: enough that its fade reads as smooth on a seat label. */
const RING_SEGMENTS = 28;
/** How much of the lap the trail reaches back over, falling off to nothing at its end. */
const RING_TAIL = 80;
/** How much of the trail, from the head back, is white cooling to blue. */
const RING_WHITE = 1 / 7;
/**
 * The head's length. A share of the perimeter rather than a length in pixels, which is what
 * measuring nothing costs (spec #280): tuned by eye to read as variant A's 8px head on an
 * opponent's seat label, and accepted to be proportionally longer on the viewer's footer.
 */
const RING_HEAD = 2.5;

/**
 * The laser ring traced once round a counting seat's namecard, `elapsedMs` into the count, or
 * null once its lap and its fade are both done — the moment it is unmounted (spec #280).
 *
 * The head goes round the perimeter once, eased in and out (`easeInOutSine`), so it leaves and
 * arrives rather than being switched on and off at speed. Behind it the trail falls off
 * linearly to nothing over `RING_TAIL` of the lap, cut where the lap began, its first seventh
 * white and cooling to milestone blue — variant A exactly (#279). The ring is whole through the
 * lap and then fades where it finished.
 *
 * Total over any elapsed time: before 0 it is the count's first moment, nothing yet traced, and
 * at `Infinity` — a seat that is not counting — it is gone.
 */
export function ringFrame(elapsedMs: number): RingFrame | null {
  const fadingFor = elapsedMs - MILESTONE_RING_MS;
  if (fadingFor >= MILESTONE_RING_FADE_MS) return null;

  const at = 100 * easeInOutSine(clamp01(elapsedMs / MILESTONE_RING_MS));
  const trail: RingSegment[] = [];
  for (let i = 0; i < RING_SEGMENTS; i += 1) {
    const to = at - (i * RING_TAIL) / RING_SEGMENTS;
    if (to <= 0) break;
    const along = (i + 0.5) / RING_SEGMENTS; // 0 at the head, 1 at the tail's end
    trail.push({
      from: Math.max(0, at - ((i + 1) * RING_TAIL) / RING_SEGMENTS),
      to,
      opacity: 1 - along,
      white: Math.max(0, 1 - along / RING_WHITE),
    });
  }

  return {
    opacity: fadingFor <= 0 ? 1 : 1 - fadingFor / MILESTONE_RING_FADE_MS,
    head: at > 0 ? { from: Math.max(0, at - RING_HEAD), to: at } : null,
    trail,
  };
}

const easeInOutSine = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * t);

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
