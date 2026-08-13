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

/** [PROTOTYPE — issue #56] One of the three edges an opponent's seat can sit against. */
export type Zone = "left" | "top" | "right";

/**
 * [PROTOTYPE — issue #56] Cycles a turn-ordered opponent list across left/top/right:
 * 1st -> left, 2nd -> top, 3rd -> right, 4th -> left (2nd slot), 5th -> top (2nd slot).
 * `right` never doubles — a 6-player cap means at most 5 opponents exist.
 */
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

export function seatZones<T>(opponents: readonly T[]): Record<Zone, T[]> {
  const zones: Record<Zone, T[]> = { left: [], top: [], right: [] };
  opponents.forEach((opponent, i) => {
    zones[zoneAt(i)].push(opponent);
  });
  return zones;
}
