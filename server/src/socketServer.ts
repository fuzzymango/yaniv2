/**
 * The Socket.io transport: the seam between connected clients and the pure engine.
 *
 * This module only wires handlers onto an `io` instance — it never calls `listen`. The
 * process that opens a port is separate, so tests and harnesses can each stand up their
 * own server on an ephemeral port without duplicating any of this.
 */

import type { Server as HttpServer } from "node:http";
import type { Ack, ClientToServerEvents, ServerToClientEvents } from "@yaniv/shared";
import { Server, type Socket } from "socket.io";
import { createAutoDealer } from "./autoDeal.ts";
import type { BotTurnRunnerOptions } from "./botTurns.ts";
import { createBotTurnRunner } from "./botTurns.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import {
  callYaniv,
  playAgain,
  removePlayer,
  slapDown,
  startGame,
  startNextRound,
  takeTurn,
  updateSettings,
} from "./game.ts";
import type { ProfileStore } from "./profiles.ts";
import { err, ok, type Result } from "./result.ts";
import type { RoomManager } from "./roomManager.ts";
import { createRoomSweeper, unattended } from "./roomSweep.ts";
import { createRoomTimers } from "./roomTimers.ts";
import type { Rng } from "./rng.ts";
import { serializeStateForPlayer } from "./serialize.ts";
import type { ActionResult, GameState } from "./state.ts";
import { getPlayer } from "./state.ts";

/**
 * Who a connection is. Set once, when the connection creates, joins or resumes a seat in
 * a room, and read by every handler thereafter — a client-supplied player id is never
 * trusted, or a socket could act as any player simply by saying so. `resumeSeat` is no
 * exception: what it trusts is the token presented alongside the id, not the id.
 *
 * Stored as one optional object rather than two optional fields so a half-bound
 * connection (a room without a player, or the reverse) is unrepresentable.
 */
interface Session {
  playerId: string;
  roomCode: string;
}

interface SocketData {
  session?: Session;
}

export type YanivServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

type YanivSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/**
 * What a server may be built with rather than told at runtime: the clock its bots think
 * on and how long they think for, both defaulted, so production construction is one line
 * and unchanged.
 *
 * The runner's own options plus the clock every timer in the server is set on — the one
 * thing owned here rather than by a behaviour, since the registry it builds is shared by
 * all of them. A test seam first: a suite about something other than timing switches the
 * pause off, and one about timing drives the clock by hand.
 */
export interface SocketServerOptions extends BotTurnRunnerOptions {
  /** Defaults to real time. A test drives one by hand instead. */
  clock?: Clock;
}

/**
 * Attach the game's event handlers to a new Socket.io server on `httpServer`.
 *
 * `profiles` is **required, not defaulted**, for ADR-0013's reason: a call site needing a
 * capability should not be able to forget it, and a server that had quietly composed
 * itself a store nobody chose would be a server whose accounts go wherever the default
 * went. Which store it is, is stated in the command that boots — `npm run serve` against
 * a database, `npm run serve:memory` against memory (docs/adr/0019) — and this layer is
 * indifferent to the answer.
 *
 * Nothing here reads it yet: the auth handlers that do arrive with the sign-in events, and
 * the argument lands first so every composition in the repo already names its store.
 */
export function createSocketServer(
  httpServer: HttpServer,
  rooms: RoomManager,
  profiles: ProfileStore,
  options: SocketServerOptions = {},
): YanivServer {
  const io: YanivServer = new Server(httpServer);
  const timers = createRoomTimers(options.clock ?? systemClock);
  const botTurns = createBotTurnRunner(rooms, timers, options);
  const autoDeal = createAutoDealer(rooms, timers);
  const roomSweep = createRoomSweeper(rooms, timers);

  /**
   * Send every connection in a room its own view of the current state.
   *
   * Deliberately synchronous. `io.in(room).fetchSockets()` would be the idiomatic call,
   * but it is async, and this has to publish the position that stood when it was called:
   * it is invoked from inside a bot's timer callback and from a handler that may be
   * racing one, so a promise resolving a tick later would be publishing whatever the
   * room had become by then rather than the move it was handed.
   *
   * Never `io.to(room).emit(state)`: the raw state holds every hand and the draw pile
   * order. One send per socket, each through the serializer, is the only shape that
   * cannot leak. See serialize.ts.
   *
   * It is also where the room's auto-deal is reconsidered (issue #148), and there is one
   * reason for that rather than two: the answer turns on the position and on who is
   * connected, and publishing is the one moment both are in hand and the only moment
   * either can have changed. Hanging it off each handler instead would make a new one
   * that forgets it a table that stalls, which is exactly the failure this exists to
   * remove. `consider` is idempotent, so publishing for any other reason — a seat going
   * quiet, a seat sat back down at — neither starts a second countdown nor restarts the
   * one that is running.
   */
  function broadcastState(roomCode: string): void {
    const state = rooms.getState(roomCode);
    if (!state) return;

    const members = membersOf(roomCode);
    const connected = connectedPlayers(members);
    for (const member of members) {
      const playerId = member.data.session?.playerId;
      if (!playerId) continue;
      member.emit("gameStateUpdate", serializeStateForPlayer(state, playerId, connected));
    }

    // The deal it may schedule is `act`'s own tail: the position goes out, and the seat
    // it opened on is played if it is a bot's — which, here, it always is.
    autoDeal.consider(roomCode, connected, () => {
      broadcastState(roomCode);
      runBotTurns(roomCode);
    });

    // And the room's own grace period, on the same grounds and out of the same two facts
    // (issue #150): publishing is when who is connected can have changed, and a sweep
    // hung off each handler that might empty a room would be one a new handler forgets.
    // Both considerations are idempotent, so the two live happily on one broadcast — a
    // room with nobody in it goes on publishing its bots' moves, and neither the deal it
    // will not get nor the sweep it will is restarted by any of them.
    roomSweep.consider(roomCode, connected, () => sweepRoom(roomCode));
  }

  /**
   * Who is there right now: the player ids behind one snapshot of a room's connections
   * (issue #146).
   *
   * Over the very sockets the send below is about to walk, which is the whole reason
   * connection is derived rather than stored (docs/adr/0013) — the answer is read off the
   * connections that exist at the moment a position is published, so there is no flag
   * anywhere for a drop to leave stale. Taken from the snapshot rather than the room, so
   * every view of one position agrees about who was there when it was built.
   */
  function connectedPlayers(members: YanivSocket[]): ReadonlySet<string> {
    const present = new Set<string>();
    for (const member of members) {
      const playerId = member.data.session?.playerId;
      if (playerId) present.add(playerId);
    }
    return present;
  }

  /**
   * Every live connection in a room, as a snapshot.
   *
   * Copied out of the adapter's own set rather than walked in place: releasing a member,
   * or disconnecting one, mutates the very set the walk is reading. Callers that only
   * read still take the copy, so no walk here has to be checked against what it does.
   */
  function membersOf(roomCode: string): YanivSocket[] {
    return [...(io.sockets.adapter.rooms.get(roomCode) ?? [])]
      .map((socketId) => io.sockets.sockets.get(socketId))
      .filter((member): member is YanivSocket => member !== undefined);
  }

  /**
   * Play out any bot turns the last action handed over to, publishing each one as it
   * happens. Bots have no connection of their own, so without this the table would
   * deadlock the moment the turn left the player.
   *
   * Each of those turns waits out bot think time first, so a chain reaches the table one
   * move per beat rather than all of it inside this call. The pacing is the server's:
   * the moves are spaced out because they *happen* spaced out.
   *
   * Safe to call while a run is already pending — the runner keeps at most one per room,
   * and an action landing mid-pause neither hurries the waiting turn nor delays it.
   */
  function runBotTurns(roomCode: string): void {
    botTurns.run(roomCode, () => broadcastState(roomCode));
  }

  /**
   * Release a connection from the room it is bound to: no session, no membership.
   *
   * Both halves matter. Without the cleared session the connection would still be told
   * `ALREADY_IN_ROOM` by every later create or join, so leaving a room would be as final
   * as it is today. Without the `leave` it would stay a member of the Socket.io room, and
   * a later room issued the same code would leak its broadcasts to a stranger.
   *
   * Clearing the session first is also what makes it safe to publish immediately
   * afterwards: `broadcastState` skips sessionless sockets, so a player who has just left
   * is never handed a view of a table they are no longer seated at — which the serializer
   * would refuse to build in any case.
   */
  function release(target: YanivSocket, roomCode: string): void {
    // Deleted rather than set to undefined: the field is genuinely absent on a connection
    // that is not in a room, which is exactly the shape a fresh connection has.
    delete target.data.session;
    void target.leave(roomCode);
  }

  /**
   * A room with nobody left in it, dropped rather than left running. Nobody is told: the
   * seat that has just gone was the last one, so there is no connection this could be
   * news to — which is the whole difference from the host's old close-room button, and
   * the point of removing it (docs/adr/0012). A room now ends because it is empty, never
   * because one player decided everyone else's game was over.
   *
   * Everything it had waiting on the clock is abandoned along with it — a bot mid-think
   * today, and whatever else is scheduled per room tomorrow: a room that has ended stops
   * doing things, and no entry is left behind under a code that may be issued again. One
   * call, so a new timer is covered by being in the registry rather than by anyone
   * remembering to cancel it here.
   *
   * A room whose players are all *disconnected* is a different question, and it is
   * `sweepRoom`'s: they still hold their seats, and a reload is a disconnect.
   */
  function destroyRoom(roomCode: string): void {
    timers.cancelRoom(roomCode);
    rooms.removeRoom(roomCode);
  }

  /**
   * The far end of a room's grace period: nobody has been connected to it for
   * `ROOM_SWEEP_MS`, so it goes (issue #150). Nobody is told — there is no connection left
   * that this could be news to, which is what makes it the same shape as a room whose last
   * seat left rather than a match being ended on anybody.
   *
   * The question is asked once more before the room is dropped, and against the live
   * sockets rather than the set the pause was started with. A returning connection cancels
   * this by publishing (`broadcastState`), and `resumeSeat` seats itself before it
   * publishes — so a claim landing in the last tick of the minute would otherwise have its
   * room swept out from under it. One `unattended` call, so the judgement cannot come out
   * two ways at the two ends of the same pause.
   */
  function sweepRoom(roomCode: string): void {
    const state = rooms.getState(roomCode);
    if (!state) return;
    if (!unattended(state, connectedPlayers(membersOf(roomCode)))) return;
    destroyRoom(roomCode);
  }

  /**
   * Every seat *given up*: the humans have all left, or the lobby has emptied. Asked after
   * a departure, and answered by dropping the room on the spot.
   *
   * Bots are counted out rather than waited on. A bot never departs and never asks for
   * anything, so a table of them with the last human gone is a room playing to nobody —
   * and, with no player left who could leave, one nothing else would ever end.
   *
   * Deliberately **not** `roomSweep.ts`'s `unattended`, which the sweep and this share a
   * shape with and nothing else: that one asks who is *connected*, and is answered a minute
   * later because a drop is survivable. Leaving is not, so this is answered at once — and a
   * room left holding one seat whose player has merely dropped is this one's `false` and
   * that one's `true`, which is the whole difference between the two exits.
   */
  function abandoned(state: GameState): boolean {
    return state.players.every((p) => p.departed || p.isBot);
  }

  io.on("connection", (socket) => {
    const alreadySeated = () =>
      err("ALREADY_IN_ROOM", "This connection is already in a room");

    /**
     * The caller's session and the room behind it, or the rejection to ack instead.
     *
     * Used by the one handler that is not `act`-shaped — leaving — because it needs the
     * room itself to decide what to do with it, rather than only a transition to apply.
     */
    function currentRoom(): Result<{ session: Session; state: GameState }> {
      const session = socket.data.session;
      if (!session) return err("PLAYER_NOT_FOUND", "This connection is not in a room");

      const state = rooms.getState(session.roomCode);
      if (!state) return err("ROOM_NOT_FOUND", `No room with code ${session.roomCode}`);
      return ok({ session, state });
    }

    socket.on("createRoom", async (playerName, ack) => {
      if (socket.data.session) {
        ack(alreadySeated());
        return;
      }

      const created = rooms.createRoom(playerName);
      if (!created.ok) {
        ack({ ok: false, error: created.error });
        return;
      }

      // Destructured deliberately: `createRoom` also hands back the full `GameState`,
      // which must never cross this boundary. See serialize.ts.
      const { roomCode, playerId, resumeToken } = created.value;
      socket.data.session = { playerId, roomCode };

      // Socket.io's own room concept maps 1:1 onto a game's room code, so broadcasts to
      // a game can address it by code directly. Awaited so membership is established
      // before the client is told it is in.
      await socket.join(roomCode);

      /*
       * The lobby is a position like any other, so it is published rather than left for
       * the client to infer from the ack — without this a host would sit in front of an
       * empty screen until somebody else turned up.
       *
       * Published *before* the ack, unlike `act()`, which acks first. An event with no
       * listener is dropped, so this ordering settles what a client that only subscribes
       * once it is acked sees: nothing. It cannot arrive a beat later and be mistaken
       * for the position that client is actually waiting on. A client that wants the
       * lobby — the harness does — subscribes before it emits, and gets it.
       */
      broadcastState(roomCode);
      ack({ ok: true, value: { roomCode, playerId, resumeToken } });
    });

    socket.on("joinRoom", async (roomCode, playerName, ack) => {
      if (socket.data.session) {
        ack(alreadySeated());
        return;
      }

      const joined = rooms.joinRoom(roomCode, playerName);
      if (!joined.ok) {
        ack({ ok: false, error: joined.error });
        return;
      }

      const { playerId, resumeToken, state } = joined.value;
      socket.data.session = { playerId, roomCode };
      await socket.join(roomCode);

      // The engine's normalised name, not the raw one off the wire.
      const seatedName = getPlayer(state, playerId)?.name ?? playerName;
      // `socket.to` excludes the sender: an arrival is news to everyone but the arriver.
      socket.to(roomCode).emit("playerJoined", seatedName);

      // Everyone, the arriver included, gets the new roster — the announcement above
      // says who turned up, this is the table they turned up to. Ordered ahead of the
      // ack for the same reason as in `createRoom`.
      broadcastState(roomCode);

      ack({ ok: true, value: { playerId, resumeToken } });
    });

    /**
     * Take back a seat that already exists. The credential is the whole of the check:
     * a player id is public — it names opponents in every view — so presenting one
     * proves nothing, and the token is what says this connection is entitled to the
     * seat behind it.
     *
     * A room that has gone is said so plainly, since `joinRoom` already answers that
     * question for any code and there is nothing left to withhold. What is inside one is
     * a different matter: a wrong token, a player the room never held and a seat that has
     * been given up share a single code, or a room code would become a way of fishing for
     * the seats behind it.
     *
     * That last case is checked here rather than left to the client forgetting its
     * credential: a roster is append-only from the first deal, so a departed seat and its
     * token now outlive the player, and a stale tab holding one would otherwise rebind to
     * a seat its owner gave up and be handed every broadcast after it. Leaving is final,
     * and the server is what says so.
     *
     * The position goes back in the ack, and the room is published to behind it: a seat
     * that was away is being sat back down at, which is news to everyone looking at that
     * seat (issue #146). It was invisible until connection reached the wire, and the ack
     * still comes first — the returning client is answered by the event it sent, the way
     * every other action here is, and the broadcast reaches it as one more position.
     */
    socket.on("resumeSeat", async (request, ack) => {
      if (socket.data.session) {
        ack(alreadySeated());
        return;
      }

      const { roomCode, playerId, resumeToken } = request;
      const state = rooms.getState(roomCode);
      if (!state) {
        ack(err("ROOM_NOT_FOUND", `No room with code ${roomCode}`));
        return;
      }

      const player = getPlayer(state, playerId);
      if (!player || player.departed || player.resumeToken !== resumeToken) {
        ack(err("INVALID_RESUME_TOKEN", "That seat cannot be resumed"));
        return;
      }

      socket.data.session = { playerId, roomCode };
      await socket.join(roomCode);

      /*
       * One live connection per seat, and the newer one wins. A second tab is not
       * co-presence: two connections acting as one player would each be shown a table
       * the other could move out from under it. Dropped rather than merely unbound, so
       * the device it belongs to finds out — an unbound socket would sit there looking
       * connected and refusing every tap.
       *
       * *After* this connection is seated, not before: the drop publishes the room
       * (issue #146), and evicting first would broadcast one position with this seat
       * absent from the room's sockets — a reload would blink "away" at everybody on its
       * way back to the table.
       */
      for (const member of membersOf(roomCode)) {
        if (member.id === socket.id) continue;
        if (member.data.session?.playerId === playerId) member.disconnect();
      }

      ack({
        ok: true,
        value: {
          view: serializeStateForPlayer(
            state,
            playerId,
            connectedPlayers(membersOf(roomCode)),
          ),
        },
      });
      broadcastState(roomCode);
    });

    /**
     * Every in-game action has the same shape: identify the caller from their session,
     * run the transition, and — only if it stood — publish the new position and play
     * out whatever bot turns it handed over to.
     *
     * A rejection acks the error and stops there. Nothing is published, so a refused
     * action costs the player nothing: the turn is still theirs to take again.
     */
    function act(
      ack: Ack<null>,
      transition: (session: Session, state: GameState, rng: Rng) => ActionResult,
    ): void {
      const session = socket.data.session;
      if (!session) {
        ack(err("PLAYER_NOT_FOUND", "This connection is not in a room"));
        return;
      }

      const result = rooms.apply(session.roomCode, (state, rng) =>
        transition(session, state, rng),
      );
      if (!result.ok) {
        ack({ ok: false, error: result.error });
        return;
      }

      ack({ ok: true, value: null });
      broadcastState(session.roomCode);
      runBotTurns(session.roomCode);
    }

    /**
     * The lobby is a position like any other, so a settings change is published like any
     * other move: whoever is sitting in it sees the host's choices land. Ordinary `act`
     * shape despite there being no turn involved — the caller is identified the same way,
     * and a refusal (not the host, not the lobby, not settings a room could play on)
     * publishes nothing, leaving the room exactly as it was.
     *
     * The payload is passed on untrusted. Its wire type is a claim by whoever sent it,
     * and `updateSettings` is where that claim is checked.
     */
    socket.on("updateSettings", (settings, ack) => {
      act(ack, (session, state) => updateSettings(state, session.playerId, settings));
    });

    socket.on("startGame", (ack) => {
      // Seating the bots is the whole of opponent setup: a player creates a room and
      // starts the game, and never manages bots. It happens inside the transition so a
      // start that is then rejected — by someone who is not the host, say — discards the
      // seating along with it, rather than filling the table off a refused call.
      act(ack, (session, state, rng) =>
        startGame(rooms.seatBots(state), session.playerId, rng),
      );
    });

    socket.on("takeTurn", (action, ack) => {
      act(ack, (session, state, rng) =>
        takeTurn(state, session.playerId, action, rng),
      );
    });

    socket.on("callYaniv", (ack) => {
      act(ack, (session, state) => callYaniv(state, session.playerId));
    });

    /**
     * Ordinary `act` shape, despite not being a turn: the caller is identified the same
     * way, the transition is applied the same way, and the position it produces is
     * published the same way. Whoever asks second — the slapper who lost the race, or
     * anyone the window was never open for — is refused by the transition itself, and a
     * refusal costs them nothing.
     *
     * `runBotTurns` is a live re-entry here, not the no-op it once was. A slapdown does
     * not move the turn on, but the seat it was handed to by the `takeTurn` that opened
     * the window may be a bot still thinking — and this call arrives inside its pause.
     * What makes that safe is the runner keeping one pending run per room: the slap
     * lands, the position updates, and the bot plays at its originally scheduled time
     * against the position the slap produced. Acting is punished in neither direction.
     */
    socket.on("slapDown", (ack) => {
      act(ack, (session, state) => slapDown(state, session.playerId));
    });

    socket.on("startNextRound", (ack) => {
      act(ack, (session, state, rng) =>
        startNextRound(state, session.playerId, rng),
      );
    });

    // Bots are deliberately not seated here the way `startGame` seats them: a seat given
    // up by an exit to the menu stays given up. Otherwise ordinary — a randomly chosen
    // opening player may well be a bot, which `act` plays out like any other handover.
    socket.on("playAgain", (ack) => {
      act(ack, (session, state, rng) => playAgain(state, session.playerId, rng));
    });

    /**
     * Leave the room without dropping the connection — the one exit that is not a
     * disconnect, and now the only way out of a room there is (docs/adr/0012).
     *
     * It costs the rest of the table nothing, whoever is leaving: the host is no longer
     * a special case here, because from the lobby the role migrates to the next seat and
     * from the first deal there is no role at all. What the leaver's own seat becomes is
     * the transition's business — spliced out in the lobby, marked once a match exists.
     *
     * Deliberately not `act`-shaped: an empty room has to be dropped, and "this room no
     * longer exists" is not a `GameState` any transition could return, so that branch
     * lives here, where rooms and connections are owned.
     */
    socket.on("exitToMenu", (ack) => {
      const current = currentRoom();
      if (!current.ok) {
        ack({ ok: false, error: current.error });
        return;
      }

      const { session, state } = current.value;
      // Read before the removal, since afterwards there is no player to read it from.
      const name = getPlayer(state, session.playerId)?.name ?? "";

      const result = rooms.apply(session.roomCode, (current) =>
        removePlayer(current, session.playerId),
      );
      if (!result.ok) {
        ack({ ok: false, error: result.error });
        return;
      }

      release(socket, session.roomCode);
      ack({ ok: true, value: null });

      // The seat that has just gone was the last one: there is nobody to announce it to,
      // and nothing left for the room to be.
      if (abandoned(result.value)) {
        destroyRoom(session.roomCode);
        return;
      }

      // The leaver is already out of the room, so this reaches exactly whoever stayed:
      // who left, and then the table they are left with.
      io.to(session.roomCode).emit("playerLeft", name);
      broadcastState(session.roomCode);
      /*
       * And the same tail every in-game action has (`act`), for the same reason: leaving
       * mid-round hands the turn on where it was the leaver's (issue #147), and a turn
       * handed to a bot is the server's to take. Without this a table would sit on a seat
       * with no connection behind it — a wedge of exactly the kind the withdrawal from the
       * round exists to prevent.
       */
      runBotTurns(session.roomCode);
    });

    /**
     * A connection going away, which costs the room nothing and is told to it anyway.
     *
     * **Nothing is mutated here.** The seat, the player and the room are left exactly as
     * they were, and the player behind them comes back through `resumeSeat`: backgrounding
     * a phone's browser tab drops a socket with no chance to react, and that must not end
     * five other people's match. The turn, if it was theirs, still waits for them.
     *
     * What is new (issue #146) is the broadcast. Connection is derived from the live
     * sockets at the moment a position is published (docs/adr/0013), so the socket that has
     * just gone is already out of the room's set — and this republishes the same position
     * to whoever is left, which is the only way they learn a seat has gone quiet. A table
     * waiting on somebody who is not there explains itself rather than merely stopping.
     *
     * It is also what starts the room's grace period, in passing rather than by name: the
     * broadcast reconsiders the sweep, and a publication with no human behind any seat is
     * exactly the position that asks for one (issue #150). A room nobody comes back to has
     * a minute left, and one whose player reloads is republished to before it is up.
     */
    socket.on("disconnect", () => {
      const session = socket.data.session;
      if (!session) return;
      broadcastState(session.roomCode);
    });
  });

  return io;
}
