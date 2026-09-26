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
import { getPlayer } from "./state.ts";

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
 * state. It credits the caller one Yaniv call, whether the call stood or was Assafed.
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
  }

  return earned;
}
