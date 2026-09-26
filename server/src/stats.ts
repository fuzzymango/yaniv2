/**
 * What an account's stats are owed for a transition, and whose account that is
 * (docs/adr/0024).
 *
 * Pure, and in a file of its own on `autoDealSeat`'s pattern: a question about a position,
 * answered once, with the layer above doing what it is told. The socket layer asks
 * `statsEarned` of every accepted transition — the room manager hands it each one — and
 * writes whatever comes back, fired and never awaited.
 *
 * Every stat is read off the position before and after, never off which handler ran: a
 * fact about a match can be made true by a human's move, a bot's, the auto-deal or an exit,
 * and each route counting it for itself would be a route that one day forgets to.
 */

import type { AccountId, StatsDelta } from "./profiles.ts";
import type { GameState } from "./state.ts";
import { getPlayer, inMatch } from "./state.ts";

/**
 * The account `playerId`'s play is credited to, or `null` where it is credited to
 * nobody: a bot, a guest, or a seat that is not at this table. Total, so the caller has
 * one question to ask and nothing to check before asking it.
 *
 * A named function rather than an inline `accountId !== null` because two of its three
 * answers are the same value for different reasons. A **guest** is a human who took the
 * seat without an account (docs/adr/0022); a **bot** is not a guest at all, but nobody —
 * which is what lets every stat be read off the state, a bot's call included, and still
 * count nothing of a bot's.
 */
export function accountToCredit(state: GameState, playerId: string): AccountId | null {
  const player = getPlayer(state, playerId);
  if (!player || player.isBot) return null;
  return player.accountId;
}

/**
 * The stats each account earned in the transition `before` → `after`: one merged delta per
 * account, and no entry for an account that earned nothing — so a transition that changed
 * no fact a stat counts answers an empty map, and there is nothing to write.
 *
 * **A round scored** is the scorecard growing by a row — the key the client's call
 * announcement uses — and never the phase leaving `playing`, which the last opponent
 * leaving can also do, with no round scored and the previous round's result still on the
 * state. It credits the caller one Yaniv call, whether the call stood or was Assafed, and
 * where it was Assafed, the caller a call Assafed too — one delta, merged — and the Assafer
 * one Assaf. The Assafer is the one player the result names (`docs/rules.md` §6): anybody
 * else who was also at or under the call lost the tie-break and gets nothing, so the stat
 * agrees with the red cell and the banner the table showed. A call that stood is never
 * stored, being a Yaniv call not Assafed.
 *
 * **A match seen through** is two facts, and a seat is credited one game completed by
 * whichever it meets. **Eliminated**: its `outInRound` set across the transition while it
 * is not departed — whoever's call scored the round, a bot's included; a seat that went out
 * by leaving earns nothing, and one already out earns nothing for leaving afterwards.
 * **Won**: the phase becoming `gameEnd`, which credits the one `winnerIds` names a game
 * completed and a game won — by a scored round or by the last opponent leaving, with or
 * without a round behind it. Losses are never stored, being games completed less games won,
 * and a win lands in the same delta as the call that made it, so no interrupted write can
 * leave a completed game that was not also won. Leaving a finished match, and play again,
 * make neither fact true.
 *
 * Nothing is counted twice because each fact becomes true in exactly one accepted
 * transition — a property of the engine, not of this function (docs/adr/0024).
 */
export function statsEarned(before: GameState, after: GameState): Map<AccountId, StatsDelta> {
  const earned = new Map<AccountId, StatsDelta>();

  /** Add `delta` to whatever `playerId`'s account has earned so far, if anybody's. */
  const credit = (playerId: string, delta: StatsDelta): void => {
    const accountId = accountToCredit(after, playerId);
    if (accountId === null) return;

    const merged: StatsDelta = { ...earned.get(accountId) };
    for (const [stat, amount] of Object.entries(delta) as Array<[keyof StatsDelta, number]>) {
      merged[stat] = (merged[stat] ?? 0) + amount;
    }
    earned.set(accountId, merged);
  };

  const result = after.lastRoundResult;
  if (after.scorecard.length > before.scorecard.length && result) {
    credit(result.callerId, { yanivCalls: 1 });
    if (result.assaferId !== null) {
      credit(result.callerId, { callsAssafed: 1 });
      credit(result.assaferId, { assafs: 1 });
    }
  }

  for (const player of after.players) {
    const seat = getPlayer(before, player.id);
    if (seat && inMatch(seat) && !inMatch(player) && !player.departed) {
      credit(player.id, { gamesCompleted: 1 });
    }
  }

  // Always one winner (docs/rules.md §7), so the first is the only.
  if (before.phase !== "gameEnd" && after.phase === "gameEnd" && after.winnerIds) {
    credit(after.winnerIds[0]!, { gamesCompleted: 1, gamesWon: 1 });
  }

  return earned;
}
