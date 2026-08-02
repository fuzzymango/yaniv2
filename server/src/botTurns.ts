/**
 * Playing the seats the server owns.
 *
 * A bot has no connection to act for it, so whenever the turn reaches one the server
 * has to take it — otherwise a table of one human and five bots deadlocks the moment
 * the human's turn ends.
 */

import type { PlayerGameView } from "@yaniv/shared";
import type { BotAction } from "./bot.ts";
import { decideTurn } from "./bot.ts";
import { callYaniv, takeTurn } from "./game.ts";
import type { RoomManager } from "./roomManager.ts";
import { serializeStateForPlayer } from "./serialize.ts";

/** Injected so a test can drive a deliberately broken bot. Defaults to the real one. */
export type DecideTurn = (view: PlayerGameView) => BotAction;

/**
 * Play out every consecutive bot turn, stopping once the turn reaches a player the
 * server does not control or the round ends.
 *
 * `onTurnPlayed` fires once per action, so a chain of bot moves can be published one at
 * a time rather than collapsing into a single final position. There is deliberately no
 * pause between them: pacing bot moves for a human to watch is the client's job.
 */
export function playBotTurns(
  rooms: RoomManager,
  roomCode: string,
  onTurnPlayed: (playerId: string) => void,
  decide: DecideTurn = decideTurn,
): void {
  for (;;) {
    const state = rooms.getState(roomCode);
    // A phase other than `playing` means the round ended on the last action.
    if (state?.phase !== "playing") return;

    const playerId = state.round.currentTurnPlayerId;
    if (!rooms.isBot(roomCode, playerId)) return;

    // The bot decides from the same payload a client receives, never from raw state.
    const decision = decide(serializeStateForPlayer(state, playerId));
    const result =
      decision.type === "yaniv"
        ? rooms.apply(roomCode, (s) => callYaniv(s, playerId))
        : rooms.apply(roomCode, (s, rng) => takeTurn(s, playerId, decision.action, rng));

    // A rejected bot decision is a defect in the bot, not a rule violation by a player:
    // there is no client to report it to, and continuing would spin on a turn nobody
    // can take. Throw, and let it surface as the server fault it is.
    if (!result.ok) {
      throw new Error(
        `Bot ${playerId} in room ${roomCode} made an illegal decision: ` +
          `${result.error.code}: ${result.error.message}`,
      );
    }

    onTurnPlayed(playerId);
  }
}
