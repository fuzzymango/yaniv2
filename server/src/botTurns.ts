/**
 * Playing the seats the server owns, and the pause each one takes first.
 *
 * A bot has no connection to act for it, so whenever the turn reaches one the server
 * has to take it — otherwise a table of one human and five bots deadlocks the moment
 * the human's turn ends.
 *
 * It does not take it straight away. A bot waits out **bot think time** before deciding,
 * every bot and every turn alike, which is what makes the table read as a game being
 * played rather than a result being announced — and what gives a human long enough to
 * win the slapdown window their own turn just opened, which same-tick bot turns made
 * unreachable (ADR-0005).
 *
 * Nothing here knows what a socket is: the runner is handed a room manager, the room
 * timer registry and a callback, exactly as the loop it replaced was.
 */

import type { PlayerGameView } from "@yaniv/shared";
import type { BotAction } from "./bot.ts";
import { decideTurn } from "./bot.ts";
import { BOT_THINK_MS } from "./config.ts";
import { callYaniv, takeTurn } from "./game.ts";
import type { RoomManager } from "./roomManager.ts";
import type { RoomTimers } from "./roomTimers.ts";
import { NO_CONNECTIONS, serializeStateForPlayer } from "./serialize.ts";
import type { GameStateActive } from "./state.ts";

/** Injected so a test can drive a deliberately broken bot. Defaults to the real one. */
export type DecideTurn = (view: PlayerGameView) => BotAction;

/**
 * The turn standing in front of a room, where it is one the server plays itself, as the
 * seat and the position it would be played from — and `null` where there is nothing to
 * play: a phase other than `playing` means the round ended on the last action, and a
 * human's turn is not the server's to take.
 *
 * Asked twice per turn, and deliberately: once to decide whether a pause is worth
 * scheduling, and again when it elapses, since the position may have moved under it.
 */
function botSeatToPlay(
  rooms: RoomManager,
  roomCode: string,
): { state: GameStateActive; playerId: string } | null {
  const state = rooms.getState(roomCode);
  if (state?.phase !== "playing") return null;

  const playerId = state.round.currentTurnPlayerId;
  return rooms.isBot(roomCode, playerId) ? { state, playerId } : null;
}

/**
 * Play the turn standing in front of a room, if it belongs to a seat the server owns.
 *
 * Answers who played, or `null` where there was nothing to play. One turn only — walking
 * a chain of them is the runner's job, since each link waits out its own think time.
 */
export function playBotTurn(
  rooms: RoomManager,
  roomCode: string,
  decide: DecideTurn = decideTurn,
): string | null {
  const seat = botSeatToPlay(rooms, roomCode);
  if (!seat) return null;
  const { state, playerId } = seat;

  // The bot decides from the same payload a client receives, never from raw state. Read
  // now rather than when the turn was scheduled: an action may have landed during the
  // pause — a slapdown is the case that matters — and the bot plays the position in
  // front of it, so a slapped card is one it can see and take. Who is connected is not
  // part of that judgement and no connection is being served here, hence `NO_CONNECTIONS`.
  const decision = decide(serializeStateForPlayer(state, playerId, NO_CONNECTIONS));
  const result =
    decision.type === "yaniv"
      ? rooms.apply(roomCode, (s) => callYaniv(s, playerId))
      : rooms.apply(roomCode, (s, rng) => takeTurn(s, playerId, decision.action, rng));

  // A rejected bot decision is a defect in the bot, not a rule violation by a player:
  // there is no client to report it to, and continuing would spin on a turn nobody
  // can take. Throw, and let it surface as the server fault it is — now from a timer
  // rather than a handler, which is why the message names the room and the seat.
  if (!result.ok) {
    throw new Error(
      `Bot ${playerId} in room ${roomCode} made an illegal decision: ` +
        `${result.error.code}: ${result.error.message}`,
    );
  }

  return playerId;
}

export interface BotTurnRunnerOptions {
  /** How long a bot waits before its turn. Zero for a suite about something else. */
  thinkTimeMs?: number;
}

/**
 * The seats the server owns, played on a clock.
 *
 * One pending run per room, and that is the whole of what keeps a timer nobody is
 * waiting on tractable: every in-game action runs bot turns on success, so a slapdown
 * arriving mid-pause would otherwise schedule a second chain over the first and play a
 * bot's turn twice. A second request while one is pending is therefore a no-op — not a
 * restart, which would punish the slapper with a slower game, and not an immediate play,
 * which would punish them with a faster opponent.
 *
 * That "one pending run" is now the registry's `botTurn` purpose rather than a `Map` kept
 * here: one room holds one timer per purpose by construction, and abandoning a room's
 * pending turn is `cancelRoom` at the seam that destroys rooms, along with everything
 * else that room had waiting.
 */
export interface BotTurnRunner {
  /**
   * Play out whatever bot turns the room is standing on, one per think time, publishing
   * each through `onTurnPlayed` as it happens. Returns at once; nothing waits on it.
   */
  run: (roomCode: string, onTurnPlayed: (playerId: string) => void) => void;
}

export function createBotTurnRunner(
  rooms: RoomManager,
  timers: RoomTimers,
  options: BotTurnRunnerOptions = {},
): BotTurnRunner {
  const thinkTimeMs = options.thinkTimeMs ?? BOT_THINK_MS;

  /**
   * Wait out think time, take the turn, then do it again for whatever seat it hands over
   * to. A callback continuation rather than `async`/`await`, because the clock's contract
   * is `after(ms, fn) -> cancel` — and deliberately, since it keeps an illegal bot
   * decision an ordinary uncaught exception rather than an unhandled rejection.
   */
  function schedule(roomCode: string, onTurnPlayed: (playerId: string) => void): void {
    if (!botSeatToPlay(rooms, roomCode)) return;

    timers.set(roomCode, "botTurn", thinkTimeMs, () => {
      const playerId = playBotTurn(rooms, roomCode);
      // The seat stopped being one to play during the pause: the round ended under it,
      // or the room went. Either way there is nothing to publish and nothing to chain.
      if (playerId === null) return;

      onTurnPlayed(playerId);
      schedule(roomCode, onTurnPlayed);
    });
  }

  return {
    run: (roomCode, onTurnPlayed) => {
      if (timers.has(roomCode, "botTurn")) return;
      schedule(roomCode, onTurnPlayed);
    },
  };
}
