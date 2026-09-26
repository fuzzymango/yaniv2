/**
 * What follows a new position, owned in one place (docs/adr/0025).
 *
 * Every position a room reaches is followed by the same tail: it is published to every
 * seat, the auto-deal (docs/adr/0014) and the sweep (0015) are reconsidered, whatever bot
 * turns it handed over to are played (0011), and whatever stats it earned are credited
 * (0024). Until this module existed the socket layer wired that tail by hand at each route
 * that made a position, and a route that forgot a step was a table waiting on a bot that
 * never moved. Here the calls run the whole of it themselves, so no caller can apply a
 * transition without everything behind it.
 *
 * It wraps the room manager and hides it: `RoomManager` keeps storage, seat issuing and its
 * pure, observed `apply`, and nothing above this module reaches it. With it are the room
 * timer registry, the bot runner, the auto-dealer, the sweeper and the stats write, each
 * constructed here — so no construction site can be handed the wrong room handle, the
 * objection ADR-0024 had to the wrapper it rejected.
 *
 * Nothing here knows what a socket is. It publishes through `RoomsPort`, and only views
 * cross that: every one is built here, through the serializer, so a `GameState` never
 * reaches the transport and the security boundary sits inside this module.
 *
 * Nothing outside this file and the tests drives `RoomManager` but `scripts/play.ts` —
 * `index.ts` only constructs one, and `createSocketServer` only composes this from it — and
 * that on purpose: a bots-only table with nobody connected is one this module treats as
 * dead, never auto-dealt and swept after a minute, and bending that for a script would put
 * a policy exception into shipped code.
 */

import type { PlayerGameView } from "@yaniv/shared";
import { createAutoDealer } from "./autoDeal.ts";
import type { BotTurnRunnerOptions } from "./botTurns.ts";
import { createBotTurnRunner } from "./botTurns.ts";
import type { Clock } from "./clock.ts";
import { removePlayer } from "./game.ts";
import type { AccountId, ProfileStore } from "./profiles.ts";
import { ok, type Result } from "./result.ts";
import type { Claimant, RoomManager } from "./roomManager.ts";
import { createRoomSweeper, unattended } from "./roomSweep.ts";
import { createRoomTimers } from "./roomTimers.ts";
import type { Rng } from "./rng.ts";
import { serializeStateForPlayer } from "./serialize.ts";
import { statsEarned } from "./stats.ts";
import type { ActionResult, GameState } from "./state.ts";
import { getPlayer } from "./state.ts";

/**
 * How a room reaches the people at it: two calls, both **synchronous by rule**. A
 * publication has to describe the position that stood when it was made — it is made from
 * inside a bot's timer and from handlers that may be racing one — so an answer arriving a
 * tick later would be describing whatever the room had become by then.
 */
export interface RoomsPort {
  /**
   * The player ids with a live, seated connection to this room, right now (issue #146).
   * Asked at the moment of publishing and never stored, so no flag anywhere can be left
   * stale by a drop (docs/adr/0013).
   */
  connected: (roomCode: string) => ReadonlySet<string>;
  /** Hand every connection in the room the view for the seat it is bound to. */
  deliver: (roomCode: string, views: ReadonlyMap<string, PlayerGameView>) => void;
}

/**
 * What a room's life runs on. The clock every timer is set on and the stats write are
 * **required**, on ADR-0013's grounds — a composition that forgot one would be a room
 * whose timers ran on a clock nobody chose or whose stats went nowhere — and the write is
 * the store's one method and not the store, so this module cannot reach accounts or
 * sessions. Bot think time is the runner's own option, defaulted there.
 */
export interface RoomsOptions extends BotTurnRunnerOptions {
  clock: Clock;
  recordStats: ProfileStore["recordStats"];
  /** Where a stats write that failed is reported (docs/adr/0023, 0024). */
  log: (...args: unknown[]) => void;
}

/** A change to one room: the shape `RoomManager.apply` takes, a pure transition. */
export type Transition = (state: GameState, rng: Rng) => ActionResult;

/**
 * A seat given up, as the transport needs to tell the room: who it was — read before the
 * removal, since afterwards a lobby has no player to read it from — and whether the room
 * ended with it.
 */
export interface Departure {
  name: string;
  ended: boolean;
}

export interface Rooms {
  /**
   * Open a room seated with its host. Publishes nothing: the host is not connected to it
   * until the transport has put them in it, which is `attendanceChanged`'s to report.
   */
  createRoom: (
    hostName: string,
    accountId: AccountId | null,
  ) => Result<{ roomCode: string; playerId: string; resumeToken: string }>;
  /**
   * Seat a player, or hand an account back the seat it holds (`resumed`), answering the
   * name they were seated under — the engine's normalised one, not the one off the wire.
   * Publishes nothing, for `createRoom`'s reason.
   */
  joinRoom: (
    roomCode: string,
    playerName: string,
    accountId: AccountId | null,
  ) => Result<{ playerId: string; resumeToken: string; resumed: boolean; name: string }>;
  /** Judge a claim on a seat that exists (`RoomManager.claimSeat`). Publishes nothing. */
  claimSeat: (roomCode: string, playerId: string, claimant: Claimant) => Result<null>;
  /**
   * `RoomManager.seatBots`, pure: for folding into the start transition, so a start that is
   * refused discards the seating with it.
   */
  seatBots: (state: GameState) => GameState;
  /**
   * Apply a transition and everything that follows it. On success, in order: stored, its
   * observers told (the stats write), `accepted` called, published, the auto-deal and the
   * sweep reconsidered, bot turns run. On a refusal nothing is called, published or
   * scheduled — a refused action costs nobody anything.
   *
   * `accepted` is where the caller acks, so a move is acked before its broadcast by this
   * module's ordering rather than by each caller remembering to. Answers whether the
   * transition stood, and never the position: `viewFor` is the one read there is.
   */
  apply: (roomCode: string, transition: Transition, accepted: () => void) => Result<null>;
  /**
   * Give up a seat: `removePlayer`, then either the room ends with it — every seat left
   * departed or a bot, so its timers are all cancelled, it is dropped and nothing is
   * published — or the same tail `apply` runs. `accepted` is called first either way,
   * handed the departure this answers with, so the caller can release the connection and
   * tell whoever stayed before the roster that explains it goes out.
   */
  leave: (
    roomCode: string,
    playerId: string,
    accepted: (departure: Departure) => void,
  ) => Result<Departure>;
  /**
   * Who is connected moved — a seat was bound or a connection went — so the position is
   * republished and the auto-deal and sweep reconsidered. No bot turns: attendance changes
   * no position, so it hands no turn over.
   */
  attendanceChanged: (roomCode: string) => void;
  /** One seat's view, against who is connected now, or `null` where the room has gone. */
  viewFor: (roomCode: string, playerId: string) => PlayerGameView | null;
}

/**
 * Every seat *given up*: the humans have all left, or the lobby has emptied. Asked after a
 * departure, and answered by dropping the room on the spot.
 *
 * Bots are counted out rather than waited on. A bot never departs and never asks for
 * anything, so a table of them with the last human gone is a room playing to nobody — and,
 * with no player left who could leave, one nothing else would ever end.
 *
 * Deliberately **not** `roomSweep.ts`'s `unattended`, which the sweep and this share a shape
 * with and nothing else: that one asks who is *connected*, and is answered a minute later
 * because a drop is survivable. Leaving is not, so this is answered at once — and a room
 * left holding one seat whose player has merely dropped is this one's `false` and that
 * one's `true`, which is the whole difference between the two exits.
 */
function abandoned(state: GameState): boolean {
  return state.players.every((p) => p.departed || p.isBot);
}

export function createRooms(
  manager: RoomManager,
  port: RoomsPort,
  options: RoomsOptions,
): Rooms {
  const timers = createRoomTimers(options.clock);
  const botTurns = createBotTurnRunner(manager, timers, options);
  const autoDeal = createAutoDealer(manager, timers);
  const roomSweep = createRoomSweeper(manager, timers);

  /**
   * Write whatever a transition earned the accounts at its table (docs/adr/0024).
   *
   * Registered once, on the room manager, rather than hung off the calls below: every
   * route to a new position — a human's move, a bot's, the auto-deal, an exit — passes
   * through its `apply`, so a route that is added later is counted without anybody
   * remembering to.
   *
   * Started and awaited nowhere, so a database that is slow or down is a counter lost and
   * nothing more (docs/adr/0023): the failure is logged naming the account — a missing
   * account told apart from a dead connection — and dropped. No retry and no queue. The
   * store still throws, as ADR-0019 says it must; it is this one caller that decides its
   * write is not worth a card game waiting on.
   *
   * The write is called from inside a `.then`, which does two things. A store that throws
   * rather than rejecting lands in the same `.catch` instead of out of `apply`. And the
   * store is not reached until the synchronous work that made the move — the ack, the
   * publication, the bot turns scheduled — has finished: the game first, the stat after it.
   */
  function recordEarned(before: GameState, after: GameState): void {
    for (const [accountId, delta] of statsEarned(before, after)) {
      Promise.resolve()
        .then(() => options.recordStats(accountId, delta))
        .catch((error: unknown) =>
          options.log(`Recording stats for account ${accountId} failed:`, error),
        );
    }
  }
  manager.observe(recordEarned);

  /**
   * Hand every connected seat its own view of the current position, then reconsider what
   * the room has waiting.
   *
   * Every view is built from **one** connected set, asked once, so every view of one
   * position agrees about who was there when it was built (docs/adr/0013). One per
   * connected seat, each through the serializer, is the only shape that cannot leak: the
   * raw state holds every hand and the draw pile order. See serialize.ts.
   *
   * It is also where the auto-deal and the sweep are reconsidered, and for one reason
   * rather than two: each answer turns on the position and on who is connected, and
   * publishing is the one moment both are in hand and the only moment either can have
   * changed. Hung off each caller instead, a new one that forgot would be a table that
   * stalls or a room that is never swept. Both are idempotent, so publishing for any other
   * reason — a seat going quiet, a seat sat back down at, an empty room's bots going on
   * publishing a move apiece — neither starts a second countdown nor restarts one running.
   */
  function publish(roomCode: string): void {
    const state = manager.getState(roomCode);
    if (!state) return;

    const connected = port.connected(roomCode);
    const views = new Map<string, PlayerGameView>();
    for (const playerId of connected) {
      views.set(playerId, serializeStateForPlayer(state, playerId, connected));
    }
    port.deliver(roomCode, views);

    // The deal it may schedule is followed like any other new position: published, and the
    // seat it opened on played if it is a bot's — which, here, it always is.
    autoDeal.consider(roomCode, connected, () => afterNewPosition(roomCode));
    roomSweep.consider(roomCode, connected, () => sweep(roomCode));
  }

  /**
   * Play out any bot turns the last position handed over to, publishing each one as it
   * happens. Bots have no connection of their own, so without this the table would
   * deadlock the moment the turn left a human.
   *
   * Each of those turns waits out bot think time first, so a chain reaches the table one
   * move per beat rather than all of it inside this call — the moves are spaced out because
   * they *happen* spaced out. Safe to call while a run is already pending: the runner keeps
   * at most one per room, so an action landing mid-pause — a slapdown is the one that
   * matters — neither hurries the waiting turn nor delays it.
   */
  function runBotTurns(roomCode: string): void {
    botTurns.run(roomCode, () => publish(roomCode));
  }

  /** What follows a new position, once it is stored: publication, then the bots. */
  function afterNewPosition(roomCode: string): void {
    publish(roomCode);
    runBotTurns(roomCode);
  }

  /**
   * A room that has ended, dropped. Nobody is told: it ends because it is empty, never
   * because one player decided everyone else's game was over (docs/adr/0012).
   *
   * Everything it had waiting on the clock goes with it — a bot mid-think, a deal, a
   * sweep: a room that has ended stops doing things, and no entry is left behind under a
   * code that may be issued again. One call, so a new timer is covered by being in the
   * registry rather than by anyone remembering to cancel it here.
   */
  function destroy(roomCode: string): void {
    timers.cancelRoom(roomCode);
    manager.removeRoom(roomCode);
  }

  /**
   * The far end of a room's grace period: nobody has been connected to it for
   * `ROOM_SWEEP_MS`, so it goes (issue #150). Nobody is told — there is no connection left
   * that this could be news to.
   *
   * The question is asked once more before the room is dropped, and of the port rather
   * than the set the pause was started with. A returning connection cancels this by being
   * published to, and a claim is seated before it is — so one landing in the last tick of
   * the minute would otherwise have its room swept out from under it. One `unattended`
   * call, so the judgement cannot come out two ways at the two ends of the same pause.
   */
  function sweep(roomCode: string): void {
    const state = manager.getState(roomCode);
    if (!state) return;
    if (!unattended(state, port.connected(roomCode))) return;
    destroy(roomCode);
  }

  return {
    createRoom: (hostName, accountId) => {
      const created = manager.createRoom(hostName, accountId);
      if (!created.ok) return created;
      // Destructured deliberately: the manager also hands back the full `GameState`,
      // which must never leave this module.
      const { roomCode, playerId, resumeToken } = created.value;
      return ok({ roomCode, playerId, resumeToken });
    },

    joinRoom: (roomCode, playerName, accountId) => {
      const joined = manager.joinRoom(roomCode, playerName, accountId);
      if (!joined.ok) return joined;
      const { playerId, resumeToken, resumed, state } = joined.value;
      const name = getPlayer(state, playerId)?.name ?? playerName;
      return ok({ playerId, resumeToken, resumed, name });
    },

    claimSeat: (roomCode, playerId, claimant) => {
      const claimed = manager.claimSeat(roomCode, playerId, claimant);
      return claimed.ok ? ok(null) : claimed;
    },

    seatBots: (state) => manager.seatBots(state),

    apply: (roomCode, transition, accepted) => {
      const result = manager.apply(roomCode, transition);
      if (!result.ok) return result;
      accepted();
      afterNewPosition(roomCode);
      return ok(null);
    },

    leave: (roomCode, playerId, accepted) => {
      const before = manager.getState(roomCode);
      const name = (before && getPlayer(before, playerId)?.name) ?? "";

      const result = manager.apply(roomCode, (state) => removePlayer(state, playerId));
      if (!result.ok) return result;

      const departure: Departure = { name, ended: abandoned(result.value) };
      accepted(departure);
      if (departure.ended) destroy(roomCode);
      else afterNewPosition(roomCode);
      return ok(departure);
    },

    attendanceChanged: publish,

    viewFor: (roomCode, playerId) => {
      const state = manager.getState(roomCode);
      return state ? serializeStateForPlayer(state, playerId, port.connected(roomCode)) : null;
    },
  };
}
