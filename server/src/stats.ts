/**
 * Whose account a Yaniv call counts towards — the one stat V0 keeps (docs/adr/0023).
 *
 * The write itself hangs off the `callYaniv` handler in `socketServer.ts`, fired and never
 * awaited; this is only the judgement it asks first, kept pure and in a file of its own on
 * `autoDealSeat`'s pattern: a question about a seat, answered once, with the layer above
 * doing what it is told.
 *
 * It is a named function rather than an inline `accountId !== null` because two of its
 * three answers are the same value for different reasons. A **guest** is a human who took
 * the seat without an account (docs/adr/0022); a **bot** is not a guest at all, but nobody.
 * A bot's call never reaches the handler anyway — `playBotTurn` applies it directly — and
 * that is not enough: it would make the rule an accident of routing, and a bot path that
 * ever grows a tail of its own asks here and gets the same answer.
 */

import type { AccountId } from "./profiles.ts";
import type { GameState } from "./state.ts";
import { getPlayer } from "./state.ts";

/**
 * The account `playerId`'s Yaniv call is credited to, or `null` where it is credited to
 * nobody: a bot, a guest, or a seat that is not at this table. Total, so the caller has
 * one question to ask and nothing to check before asking it.
 */
export function accountToCredit(state: GameState, playerId: string): AccountId | null {
  const player = getPlayer(state, playerId);
  if (!player || player.isBot) return null;
  return player.accountId;
}
