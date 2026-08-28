/**
 * Dealing a scored round on when nobody left in the match can deal it.
 *
 * Only a player still in the match may start the next round (docs/adr/0012), which is
 * right while there is one — and leaves a table whose humans have all been knocked out
 * waiting on a button no bot will ever press. A spectator watching the bots that beat
 * them play on would sit in front of a final scoreboard for as long as they cared to
 * look at it (issue #148). So the server deals it instead, once, after a pause long
 * enough to read the round that just finished.
 *
 * Deliberately narrow, and each edge is a rule rather than an oversight:
 *
 * - **Only at `roundEnd`.** A finished match is not dealt on: the standings are there to
 *   be read and play again is offered to anybody still in the room, spectators included,
 *   so there is always somebody who can answer for it.
 * - **Only when every seat still in the match is a bot.** A human who is merely
 *   disconnected still holds their seat and the turn still waits for them
 *   (docs/adr/0013) — dealing the next round out from under them would be the one thing
 *   a drop is not allowed to cost.
 * - **Only while a human is watching.** With nobody connected there is no one for the
 *   table to play to, and a room of bots playing to an empty room is what the sweep is
 *   for rather than what this is.
 *
 * Nothing here knows what a socket is: who is connected arrives as a set, exactly as it
 * does at the serializer, and the pause is set on the room's timer registry so that a
 * room being destroyed calls it off along with everything else it had waiting.
 */

import { AUTO_DEAL_MS } from "./config.ts";
import { startNextRound } from "./game.ts";
import type { RoomManager } from "./roomManager.ts";
import type { RoomTimers } from "./roomTimers.ts";
import type { GameState } from "./state.ts";
import { playersInMatch, spectating } from "./state.ts";

/**
 * The seat this position would be dealt on as, or `null` where it would not be dealt on
 * at all — the whole of the judgement, pure over a state and who is looking at it.
 *
 * The seat matters because `startNextRound` is asked *by* somebody: it refuses anyone not
 * still in the match, so the server deals as one of the bots that are. Which one is
 * immaterial — the transition opens the round on the last one's winner, never on its
 * requester — so the first is taken.
 */
export function autoDealSeat(
  state: GameState,
  connected: ReadonlySet<string>,
): string | null {
  if (state.phase !== "roundEnd") return null;

  const playing = playersInMatch(state);
  if (!playing.every((p) => p.isBot)) return null;

  // `spectating` and nothing hand-rolled beside it: watching-rather-than-playing is
  // derived once, in `state.ts`, and a second copy of those conditions here would be a
  // table dealing itself on for somebody the wire says is not watching.
  if (!state.players.some((p) => spectating(p, connected.has(p.id)))) return null;

  return playing[0]?.id ?? null;
}

export interface AutoDealer {
  /**
   * Reconsider what this room has waiting: start the pause where the position asks for
   * one, call off whatever is waiting where it does not, and leave a pause already
   * running alone.
   *
   * Called after every publication, since publishing is exactly when the answer can have
   * changed — a round being scored, a seat going quiet, a seat being sat back down at.
   * That makes it idempotent by necessity: a countdown that restarted each time would be
   * a scored round a watching spectator could never get past.
   */
  consider: (
    roomCode: string,
    connected: ReadonlySet<string>,
    onDealt: () => void,
  ) => void;
}

export function createAutoDealer(rooms: RoomManager, timers: RoomTimers): AutoDealer {
  return {
    consider: (roomCode, connected, onDealt) => {
      const state = rooms.getState(roomCode);
      const seat = state ? autoDealSeat(state, connected) : null;
      if (seat === null) {
        timers.cancel(roomCode, "autoDeal");
        return;
      }
      if (timers.has(roomCode, "autoDeal")) return;

      timers.set(roomCode, "autoDeal", AUTO_DEAL_MS, () => {
        const dealt = rooms.apply(roomCode, (s, rng) => startNextRound(s, seat, rng));
        // The position moved under the pause without publishing: a spectator dealing it
        // on themselves is acked before it is broadcast, and the answer to losing that
        // race is to have done nothing. Not a defect the way a bot's illegal move is —
        // there is no client at fault, and nothing to report to one.
        if (!dealt.ok) return;
        onDealt();
      });
    },
  };
}
