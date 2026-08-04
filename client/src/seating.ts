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
