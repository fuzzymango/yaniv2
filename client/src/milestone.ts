/**
 * Whether a scored round has a milestone count to play, and whose seats it counts at.
 *
 * The pure half of the **milestone countdown** (spec #280), and `announcement.ts`'s sibling:
 * two positions in — the one on the screen and the one that has just arrived — and either a
 * description of what to count or nothing at all. A seat whose total a round left exactly on
 * a multiple of 50 is shown landing there and then draining by 50 (docs/rules.md §7); this
 * says which seats and between which two numbers. It says nothing about pixels, elements or
 * frames — the table latches the count and runs its clock.
 *
 * Total in the same way as its sibling: every pair of positions has an answer, and "nothing
 * to count" is one of them.
 */

import type { PlayerGameView } from "@yaniv/shared";

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
