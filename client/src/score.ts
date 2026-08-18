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
 * A player's total after the round, and what the round added to it.
 *
 * The whole of what a label needs. Two numbers rather than the three a seat used to carry —
 * a delta, a total and the hand's own value — because the hand is face up beside the label
 * by then, and adding it up is what the cards are for (issue #78).
 *
 * **Signed even at zero**, and that is not a flourish: these two numbers sit next to each
 * other in a label a few characters wide, and a bare `0` beside `0 pts` is two numbers nobody
 * can tell apart. The sign is what says which of them is the round.
 *
 * Used for every seat's label and for the viewer's own footer — one function, so a player
 * cannot be told two different things about the same round depending on where they sit.
 */
export function scoreLabel(score: number, delta: number): string {
  return `${score} pts (${delta < 0 ? delta : `+${delta}`})`;
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
