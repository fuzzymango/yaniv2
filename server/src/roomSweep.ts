/**
 * Dropping a room nobody is in any more.
 *
 * A room ends when its last seat *leaves* (docs/adr/0012), which answers every exit a
 * player actually takes and none of the ones they do not: a tab closed, a phone
 * backgrounded, a laptop shut. Those seats are never given up, so until now the room
 * behind them stood for as long as the process did — in memory, holding a match, and with
 * its bots still playing to nobody where a lone human's table had bots in it.
 *
 * So the room is swept. **Not on the drop**: a reload is a disconnect, and `resumeSeat`
 * exists precisely because a drop must cost a seat nothing (docs/adr/0013) — a lone human
 * playing bots must not lose their match to the second their socket was gone. It is swept
 * once no human has been connected to it for `ROOM_SWEEP_MS`, and the accepted cost is a
 * room whose humans have all dropped going on playing bot turns, to nobody, for up to that
 * long. See docs/adr/0015.
 *
 * Shaped exactly like `autoDeal.ts`, and for the same reasons: pure judgement over a
 * position and who is connected, a pause set on the room's timer registry, and the whole
 * thing reconsidered on every publication rather than hung off each handler that might
 * change the answer. Nothing here knows what a socket is.
 */

import { ROOM_SWEEP_MS } from "./config.ts";
import type { RoomManager } from "./roomManager.ts";
import type { RoomTimers } from "./roomTimers.ts";
import type { GameState } from "./state.ts";

/**
 * Is there nobody this room is *for* — no seat held by a human with a connection behind
 * it? The whole of the judgement, pure over a state and who is connected.
 *
 * Bots are counted out rather than waited on: a bot never leaves and never asks for
 * anything, so a table of them with the last human gone is a room playing to an empty
 * screen. A **departed** seat is counted out too — it has been given up, so whatever still
 * holds its id is not somebody the room is for; the connection behind one is already out
 * of the room's members, and this says so rather than relying on it.
 *
 * Out of the *match* is emphatically not out of the room: a spectator watching the bots
 * that beat them is who a table is being dealt on for (docs/adr/0014), and is attending it.
 */
export function unattended(state: GameState, connected: ReadonlySet<string>): boolean {
  return !state.players.some((p) => !p.isBot && !p.departed && connected.has(p.id));
}

export interface RoomSweeper {
  /**
   * Reconsider what this room has waiting: start the grace period where nobody is
   * attending it, call off whatever is waiting where somebody is, and leave a grace period
   * already running alone.
   *
   * Called after every publication, since publishing is when the answer can have changed —
   * a seat going quiet, a seat being sat back down at, a seat given up. That makes it
   * idempotent by necessity: an empty room's bots go on publishing a move apiece, and a
   * countdown they restarted would be one that never finished.
   *
   * `sweep` is called when the grace period elapses and is what actually drops the room —
   * owning both the rooms and the connections is the socket layer's job, not this module's,
   * and the connections are worth asking again at the far end of a minute.
   */
  consider: (
    roomCode: string,
    connected: ReadonlySet<string>,
    sweep: () => void,
  ) => void;
}

export function createRoomSweeper(rooms: RoomManager, timers: RoomTimers): RoomSweeper {
  return {
    consider: (roomCode, connected, sweep) => {
      const state = rooms.getState(roomCode);
      if (!state || !unattended(state, connected)) {
        timers.cancel(roomCode, "roomSweep");
        return;
      }
      if (timers.has(roomCode, "roomSweep")) return;

      timers.set(roomCode, "roomSweep", ROOM_SWEEP_MS, sweep);
    },
  };
}
