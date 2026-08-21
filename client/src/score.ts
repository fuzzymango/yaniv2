/**
 * What a scored round says: one line per player, and one about the round itself.
 *
 * Pure and total, like `turn.ts` and `settings.ts` beside it — a round and a viewer in, a
 * sentence out. It sits here rather than in the screen that draws it for the reason every
 * layout and wording rule in this client does: a component is not tested, and "was the
 * viewer the one who got Assafed?" has more edges than a component should be trusted with.
 *
 * **Names come off the round's own record** (see "A finished round names its own players" in
 * CLAUDE.md), which is the only place a seat given up since is still named.
 */

import type { RoundResultView } from "@yaniv/shared";

/**
 * A round as the equation it is: `${scoreBefore} ${op} ${Math.abs(netDelta)} = ${scoreAfter} pts`.
 *
 * The label is handed the two numbers the wire carries — the total the round left the player
 * on, and the delta it applied to get there — and derives the other two itself, since a
 * player reading a seat cannot: **`scoreBefore = score - delta + milestoneReduction`**, where
 * they stood when the round was dealt, and **`netDelta = delta - milestoneReduction`**, what
 * the round is actually worth once the milestone has given back whatever it gave back. Both
 * fall out of the same identity, so the line always adds up: nothing here is an annotation
 * that a reader has to reconcile against the numbers beside it.
 *
 * **The milestone is folded into the delta rather than noted apart** (docs/rules.md §7 —
 * landing exactly on a multiple of 50 gives 50 back). Annotated, it asked a player to do the
 * arithmetic that made the total believable; absorbed, there is no arithmetic left to do — a
 * round that took 195 to 250 and gave 50 back gained 5, and that is the only figure worth
 * reading in a label a few characters wide.
 *
 * **The operator carries the sign, never the number.** `18 + -12 = 6` is a true sentence and
 * an unreadable one, and it is `-` in front of a magnitude that a player recognizes as points
 * coming off. A round that changed nothing takes the same shape as every other (`32 + 0 = 32
 * pts`) — no case for the winner, because the equation is what says a round happened at all.
 *
 * Used for every seat's label and for the viewer's own footer — one function, so a player
 * cannot be told two different things about the same round depending on where they sit.
 */
export function scoreLabel(score: number, delta: number, milestoneReduction = 0): string {
  const scoreBefore = score - delta + milestoneReduction;
  const netDelta = delta - milestoneReduction;
  return `${scoreBefore} ${netDelta < 0 ? "-" : "+"} ${Math.abs(netDelta)} = ${score} pts`;
}

/**
 * How the round ended, as the one sentence that replaces whose turn it is.
 *
 * The call and the verdict together, because neither means anything without the other: a
 * call that was Assafed cost the caller 30 and won somebody else the round (docs/rules.md
 * §6).
 *
 * Takes the viewer, because a sentence about them says so — "You called Yaniv", not their
 * own name back at them — and that is the only thing here that depends on whose screen it
 * is. A player the round has no record of is "Somebody" rather than a raw id.
 */
export function roundOutcome(result: RoundResultView, youId: string): string {
  const named = (id: string) =>
    result.players.find((player) => player.playerId === id)?.name ?? "Somebody";
  const subject = (id: string) => (id === youId ? "You" : named(id));
  const object = (id: string) => (id === youId ? "you" : named(id));

  const verdict =
    result.assaferId === null ? "it stood." : `Assafed by ${object(result.assaferId)}.`;
  return `${subject(result.callerId)} called Yaniv — ${verdict}`;
}
