/**
 * The final table of a finished match: everyone who played it, lowest score first, because
 * in Yaniv least is best (docs/rules.md §7).
 *
 * Here rather than in either client for the reason the rulebook is (ADR-0002): the browser
 * and the terminal harness both have to answer "who won, and where did everybody finish"
 * from the same `PlayerGameView`, and two copies of that answer are two chances to disagree
 * about a match that is already over. What is left to each of them is how a row is drawn.
 *
 * The standings are not the roster. A player who exits to the main menu from a finished
 * match gives up their seat and leaves `opponents`, but leaving does not undo how the match
 * finished — so their row is rebuilt from the round result, which carries its own copy of
 * their name and their final score for exactly this reason. Dropping it instead would take
 * a departed winner's mark off the board with them. See "Standings" in CONTEXT.md.
 *
 * Pure over the view, so it costs `shared` none of its dependency-freedom.
 */

import type { PlayerGameView } from "./views.ts";

/** One line of the final table. */
export interface Standing {
  playerId: string;
  name: string;
  /** What they finished the match on. */
  score: number;
  /** They have given up their seat since the match ended, and are named from its record. */
  departed: boolean;
}

export function standings(view: PlayerGameView): Standing[] {
  const seated: Standing[] = [view.you, ...view.opponents].map((p) => ({
    playerId: p.id,
    name: p.name,
    score: p.score,
    departed: false,
  }));

  const departed: Standing[] = (view.roundResult?.players ?? [])
    .filter((p) => !seated.some((s) => s.playerId === p.playerId))
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      // The score the deciding round left them on, which is the score they finished on:
      // nothing has been scored since, and nothing will be.
      score: p.scoreAfter,
      departed: true,
    }));

  /**
   * Level scores are broken by where the two were sitting, so the order is the one every
   * other screen lists the table in and does not shuffle between renders. A player who has
   * left is in no `turnOrder` to be found in, and sits after whoever stayed.
   */
  const seatOf = (playerId: string) => {
    const seat = view.turnOrder.indexOf(playerId);
    return seat === -1 ? view.turnOrder.length : seat;
  };

  return [...seated, ...departed].sort(
    (a, b) => a.score - b.score || seatOf(a.playerId) - seatOf(b.playerId),
  );
}
