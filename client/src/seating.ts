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
 * that doubles keeps both opponents in turn order, so the table reads the same way round
 * on everybody's screen — the whole point of sorting by `bySeat` in the first place.
 *
 * `right` cannot hold two: doubling it needs a 6th opponent, and `MAX_PLAYERS` is 6, so
 * five is all there ever are. That is a fact about the room, not a case handled here.
 *
 * Generic over the opponent because the two screens due to consume it hold different
 * payloads — the live table a `PlayerGameView` opponent, the round-end reveal a scored
 * player off the round's own record — and the same seats have to come out of both without
 * either being wrapped in a type this function would then have to know about. Neither
 * calls it yet; the layout that will is a later ticket.
 */
export function seatZones<T>(opponents: readonly T[]): Record<Zone, T[]> {
  const zones: Record<Zone, T[]> = { left: [], top: [], right: [] };
  opponents.forEach((opponent, i) => {
    zones[zoneAt(i)].push(opponent);
  });
  return zones;
}
