/**
 * Where everybody is sitting, for the screens that list them.
 *
 * `turnOrder` is the seating order, so a list sorted by it reads the same way round on
 * every player's screen — which matters as soon as two people are describing the same
 * table to each other. Screens sort *by* it rather than listing *from* it, so every row
 * is a player the view actually carries: there is no id here that could be rendered raw
 * for want of a name.
 */

import type { PlayerGameView } from "@yaniv/shared";

export function bySeat(
  view: PlayerGameView,
): (a: { id: string }, b: { id: string }) => number {
  return (a, b) => view.turnOrder.indexOf(a.id) - view.turnOrder.indexOf(b.id);
}

/**
 * `bySeat`, but relative to the viewer rather than absolute: the next player to act after
 * them sorts first, wrapping round to whoever sits just before them last. `bySeat` reads
 * the same way round on every screen, but only *starting from* the same seat on every
 * screen — for the table, where the viewer's own seat is never one of the zones being
 * filled, that seat is nowhere to anchor from, so absolute position reads correctly only
 * for whoever happens to be first in `turnOrder` and scrambles for everyone else.
 */
export function byRelativeSeat(
  view: PlayerGameView,
): (a: { id: string }, b: { id: string }) => number {
  const { turnOrder } = view;
  const you = turnOrder.indexOf(view.you.id);
  const relative = (id: string): number =>
    (turnOrder.indexOf(id) - you + turnOrder.length) % turnOrder.length;
  return (a, b) => relative(a.id) - relative(b.id);
}

/**
 * The three sides of the felt an opponent can be drawn on, in the order they are dealt.
 * The viewer holds the fourth, and is not a zone: their hand is at the bottom of the
 * screen whoever else is at the table.
 *
 * A list rather than a bare union because a screen has to draw all three whether anybody
 * is sitting at them or not, and the union is taken off it so the two cannot drift.
 */
export const ZONES = ["left", "top", "right"] as const;

export type Zone = (typeof ZONES)[number];

/**
 * How many seats each zone holds at this table size: every zone is filled before any is
 * doubled, which is the distribution a round-robin deal gives — `left` takes every third
 * opponent counting from the first, `top` from the second, `right` from the third. Counted
 * rather than dealt, since the counts are all the contiguous fill below wants of it (#116).
 */
function zoneCounts(total: number): Record<Zone, number> {
  const counts: Record<Zone, number> = { left: 0, top: 0, right: 0 };
  for (let i = 0; i < total; i += 1) {
    switch (i % 3) {
      case 0:
        counts.left += 1;
        break;
      case 1:
        counts.top += 1;
        break;
      default:
        counts.right += 1;
    }
  }
  return counts;
}

/**
 * Deals a turn-ordered opponent list around the table in **contiguous runs**: the first
 * `left.length` opponents fill the left column, the next the top, the last the right. Every
 * zone is filled before any is doubled — `zoneCounts` above — but a doubled zone holds two
 * players who act one after the other rather than three turns apart, which is what makes the
 * sweep round the felt read in turn order at all (issue #116).
 *
 * The left column is **reversed** before it is returned, and it alone: the DOM draws a column
 * top-down, and the viewer's own hand is at the bottom of the screen, so the earliest of the
 * two has to be the lower to keep the path continuous — viewer, up the left, across the top,
 * down the right, back to the viewer. `top` and `right` already run that way round.
 *
 * Sorting the roster first, whether by `bySeat` or `byRelativeSeat`, is the whole point of
 * that: this function reads nothing but the order it is handed.
 *
 * `right` cannot hold two: doubling it needs a 6th opponent, and `MAX_PLAYERS` is 6, so
 * five is all there ever are. That is a fact about the room, not a case handled here.
 *
 * Generic over the opponent because seating is a fact about a list's order and nothing about
 * what is in it: the table zones the live roster in both of its phases (issue #78), and a
 * placement that had to be told what an opponent *is* would be a second thing to keep in
 * step with the wire for no gain.
 */
export function seatZones<T>(opponents: readonly T[]): Record<Zone, T[]> {
  const counts = zoneCounts(opponents.length);
  const afterLeft = counts.left;
  const afterTop = afterLeft + counts.top;
  return {
    left: opponents.slice(0, afterLeft).reverse(),
    top: opponents.slice(afterLeft, afterTop),
    right: opponents.slice(afterTop),
  };
}
