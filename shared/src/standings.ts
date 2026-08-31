/**
 * The final table of a finished match: everyone who played it, **ordered by how long they
 * lasted** — the one player still in the match at the top, then the rest by the round they
 * went out in, latest first (docs/rules.md §7).
 *
 * Not lowest score first, which is what a match decided on totals used to want. A match now
 * ends when one player is left standing, so outlasting somebody places you above them
 * whatever the two of you are holding: a player eliminated in round 5 on 120 finished the
 * match ahead of one eliminated in round 2 on 101, having been there for three rounds the
 * other never saw. Least is best *within* a round — two players out in the same one are
 * separated by their final scores, so the order is decided rather than arbitrary.
 *
 * Here rather than in either client for the reason the rulebook is (ADR-0002): the browser
 * and the terminal harness both have to answer "who won, and where did everybody finish"
 * from the same `PlayerGameView`, and two copies of that answer are two chances to disagree
 * about a match that is already over. What is left to each of them is how a row is drawn.
 *
 * **The roster is the whole of it.** From the first deal it is append-only, so a player who
 * gave up their seat is still in the view — marked `departed`, with the score and the round
 * they left frozen on it — and there is nothing to rebuild from anywhere else. See
 * "Standings" in CONTEXT.md.
 *
 * Pure over the view, so it costs `shared` none of its dependency-freedom.
 */

import type { PlayerGameView } from "./views.ts";

/** One line of the final table. */
export interface Standing {
  playerId: string;
  name: string;
  /** What they finished the match on: frozen at the round they went out in, if they did. */
  score: number;
  /** They gave up their seat, and the roster kept it. Still part of the match's record. */
  departed: boolean;
}

/**
 * How long a seat lasted, as a number to order by: the round it went out in, or one past
 * every round there could be while it is still in the match. Written as a comparison rather
 * than subtracted, because two seats still in the match are both infinite and `Infinity -
 * Infinity` is `NaN` — a comparator answering `NaN` sorts by nothing at all. The engine
 * ends a match at one survivor, so that is a position the rules do not reach; a total order
 * that holds anyway costs one branch.
 */
function byLasted(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return b - a;
}

export function standings(view: PlayerGameView): Standing[] {
  const roster = [view.you, ...view.opponents];

  return roster
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      score: p.score,
      departed: p.departed,
      outInRound: p.outInRound,
    }))
    .sort(
      (a, b) =>
        byLasted(a.outInRound, b.outInRound) ||
        a.score - b.score ||
        /*
         * Nothing about the match separates them, and the roster cannot: a view hoists its
         * own viewer to the front of it (`you`, then everybody else), so a roster position
         * read off one is not the position read off another — and a match that is over must
         * not finish two ways depending on whose screen it is. The player id is the one
         * thing here every screen holds the same, so it decides the last of the ties: an
         * arbitrary order, but the same arbitrary order everywhere, which is the whole of
         * what is being bought.
         */
        (a.playerId < b.playerId ? -1 : 1),
    )
    .map(({ playerId, name, score, departed }) => ({ playerId, name, score, departed }));
}
