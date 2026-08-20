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

function zoneAt(i: number): Zone {
  switch (i % 3) {
    case 0:
      return "left";
    case 1:
      return "top";
    default:
      return "right";
  }
}

/**
 * Deals a turn-ordered opponent list around the table: 1st left, 2nd top, 3rd right, 4th
 * back to left, 5th back to top. Every zone is filled before any is doubled, and a zone
 * that doubles keeps both opponents in turn order — the whole point of sorting the roster
 * first, whether by `bySeat` or `byRelativeSeat`, before ever handing it to this function.
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
  const zones: Record<Zone, T[]> = { left: [], top: [], right: [] };
  opponents.forEach((opponent, i) => {
    zones[zoneAt(i)].push(opponent);
  });
  return zones;
}
