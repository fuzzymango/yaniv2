/**
 * What one seat's status slot says, and the order the three things it could say are asked
 * in (issue #146).
 *
 * A seat can be several of these at once — somebody who left is out of the match and has no
 * connection either — so the slot is a priority rather than a set of badges: one word, in
 * the place a word about this seat goes, saying the most final thing that is true of it.
 * **Left beats away beats watching.** A player who has given the seat up is not somebody to
 * wait for, whatever their socket did on the way out; a player merely away might come back;
 * and "watching" is the one thing this must never say of a table nobody is looking at.
 *
 * Null is the ordinary case and covers two seats that need no marker: a player still in the
 * match with somebody behind them, and **a bot** — connected always, watching never, so it
 * falls out of the rule rather than being a case in it. That is what makes an empty slot
 * unambiguous: no marker means a bot, or somebody playing.
 *
 * Pure and total over what the wire already carries — the felt's seats and the lobby's
 * roster rows ask it of the same fields and get the same answer.
 */

import type { OpponentView } from "@yaniv/shared";

/** The three things a seat can be other than playing and present. */
export type SeatStatus = "left" | "away" | "watching";

/** The word for each, said once so no screen can word it differently. */
export const STATUS_LABEL: Record<SeatStatus, string> = {
  left: "left",
  away: "away",
  watching: "watching",
};

/**
 * What a seat's slot says, or null when it says nothing.
 *
 * Named off `OpponentView` rather than restated, so the three fields cannot drift from the
 * wire — and structural, so the viewer's own view answers it too, both views carrying the
 * same three fields.
 */
export function seatStatus(
  seat: Pick<OpponentView, "departed" | "connected" | "spectating">,
): SeatStatus | null {
  if (seat.departed) return "left";
  if (!seat.connected) return "away";
  return seat.spectating ? "watching" : null;
}
