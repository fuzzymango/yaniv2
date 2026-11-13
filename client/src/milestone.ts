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
 * show yet. It says nothing about pixels, elements or clocks: the table latches the count and
 * runs the one clock it is read by.
 *
 * Total in the same way as its sibling: every pair of positions has an answer, and "nothing
 * to count" is one of them; every elapsed time has a frame, before the count and after it.
 */

import type { PlayerGameView, PlayerRoundResultView } from "@yaniv/shared";
import { scoreLabel } from "./score.ts";
import { MILESTONE_COUNT_MS, MILESTONE_PULSE_MS } from "./timing.ts";

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
 * `round` is the scorecard's length on the position that scored it — the key the table
 * latches the count on, so a republication of the same round neither restarts nor cuts it
 * off. The seats are a non-empty tuple on `Announcement`'s precedent: an empty count is
 * unconstructible, and "nothing to count" has exactly one spelling.
 */
export type Countdown = {
  readonly round: number;
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
  return first === undefined ? null : { round: arriving.scorecard.length, seats: [first, ...rest] };
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

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
