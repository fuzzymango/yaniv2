/**
 * What a seat says about itself beyond its name and score: the lobby's one-word status slot
 * (issue #146), and the nameplate's badges (spec #293).
 *
 * **The status slot** (`seatStatus`). A seat can be several of these at once — somebody who
 * left is out of the match and has no connection either — so the slot is a priority rather
 * than a set: one word, saying the most final thing that is true of it. **Left beats away
 * beats watching.** A player who has given the seat up is not somebody to wait for, whatever
 * their socket did on the way out; a player merely away might come back; and "watching" is
 * the one thing this must never say of a table nobody is looking at. Null is the ordinary
 * case: a player still in the match with somebody behind them, and a bot, which is connected
 * always and watching never.
 *
 * **The badges** (`seatBadges`). Up to two icons, so a nameplate can say a seat is out *and*
 * why it is still there or not. A bot is marked as one from `isBot` on the wire, never from
 * its name (docs/adr/0029), so an empty badge slot means somebody playing.
 *
 * Pure and total over what the wire already carries.
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

/** What may be drawn in a plate's badge slot, in the order it is drawn. */
export type Badge = "out" | "away" | "left" | "watching" | "bot";

/**
 * A seat's badges, in display order and never more than two: Out first, then one of Bot,
 * Away or Watching — or Left, alone.
 *
 * - **Left beats everything.** A seat given up for good is not out in any sense worth a
 *   second badge, and Away is about a connection it no longer has a use for.
 * - **A bot is Bot**, plus Out once knocked out; never Away, Watching or Left, which the
 *   server never sends of it anyway.
 * - **`outShown` gates Out and Watching** in the round that knocked the seat out, so the
 *   plate never tells the end of a milestone count before it lands (spec #280). The caller
 *   decides it, passing true for a seat out from an earlier round. Away is not gated: it is
 *   about the connection, not the round.
 *
 * `isBot` is optional so the viewer's own `SelfView`, which has none, reads as a person.
 */
export function seatBadges(
  seat: Pick<OpponentView, "outInRound" | "departed" | "connected" | "spectating"> & {
    isBot?: boolean;
  },
  { outShown }: { outShown: boolean },
): Badge[] {
  const out = seat.outInRound !== null && outShown;
  const badges: Badge[] = out ? ["out"] : [];
  if (seat.isBot) return [...badges, "bot"];
  if (seat.departed) return ["left"];
  if (!seat.connected) return [...badges, "away"];
  if (out && seat.spectating) return [...badges, "watching"];
  return badges;
}
