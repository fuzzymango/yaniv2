/**
 * What a scored round says about one player, in one line.
 *
 * The whole of it is: where they now stand, and what this round did to get them there. Two
 * numbers rather than the three a seat used to carry — a delta, a total and the hand's own
 * value — because the hand is face up beside the label by then, and adding it up is what
 * the cards are for (issue #78).
 *
 * **Signed even at zero**, and that is not a flourish: these two numbers sit next to each
 * other in a label a few characters wide, and a bare `0` beside `0 pts` is two numbers
 * nobody can tell apart. The sign is what says which of them is the round.
 *
 * Pure and total, like `turn.ts` and `settings.ts` beside it, and used for every seat's
 * label and for the viewer's own footer — one function, so a player cannot be told two
 * different things about the same round depending on where they are sitting.
 */

/** A player's total after the round, and what the round added to it. */
export function scoreLabel(score: number, delta: number): string {
  return `${score} pts (${delta < 0 ? delta : `+${delta}`})`;
}
