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
import { playBotTurns } from "./botTurns.ts";
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
import { err, ok, type Result } from "./result.ts";
import type { RoomManager } from "./roomManager.ts";
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

/** Attach the game's event handlers to a new Socket.io server on `httpServer`. */
export function createSocketServer(
  httpServer: HttpServer,
  rooms: RoomManager,
): YanivServer {
  const io: YanivServer = new Server(httpServer);

  /**
   * Send every connection in a room its own view of the current state.
   *
   * Deliberately synchronous. `io.in(room).fetchSockets()` would be the idiomatic call,
   * but it is async, and this has to be safe to invoke from inside a run of bot turns —
   * by the time a promise resolved, the position it was meant to publish would already
   * have been played past.
   *
   * Never `io.to(room).emit(state)`: the raw state holds every hand and the draw pile
   * order. One send per socket, each through the serializer, is the only shape that
   * cannot leak. See serialize.ts.
   */
  function broadcastState(roomCode: string): void {
    const state = rooms.getState(roomCode);
    if (!state) return;

    for (const member of membersOf(roomCode)) {
      const playerId = member.data.session?.playerId;
      if (!playerId) continue;
      member.emit("gameStateUpdate", serializeStateForPlayer(state, playerId));
    }
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
   * No delay between moves: pacing a chain of bot turns for a human to watch is
   * something the client does with the sequence of broadcasts, not something the
   * server bakes into the wire.
   */
  function runBotTurns(roomCode: string): void {
    playBotTurns(rooms, roomCode, () => broadcastState(roomCode));
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
   * Shut a room down and turn everyone in it loose. Only the host does this, so everybody
   * else is told why rather than being left staring at a table that has stopped
   * answering. The closer hears it as their own ack instead.
   */
  function closeRoom(roomCode: string, reason: string, closer: YanivSocket): void {
    for (const member of membersOf(roomCode)) {
      if (member.id !== closer.id) member.emit("roomClosed", reason);
      release(member, roomCode);
    }
    rooms.removeRoom(roomCode);
  }

  io.on("connection", (socket) => {
    const alreadySeated = () =>
      err("ALREADY_IN_ROOM", "This connection is already in a room");

    /**
     * The caller's session and the room behind it, or the rejection to ack instead.
     *
     * Shared by the two handlers that are not `act`-shaped — leaving and closing —
     * because both need the room itself to decide what to do, rather than a transition
     * to apply to it.
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
     * a different matter: a wrong token and a player the room never held share a single
     * code, or a room code would become a way of fishing for the seats behind it.
     *
     * The position goes back in the ack alone. Nothing is broadcast, because nothing
     * about the table has changed — a resume is invisible to everyone else, who are
     * never told who is connected in the first place.
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
      if (!player || player.resumeToken !== resumeToken) {
        ack(err("INVALID_RESUME_TOKEN", "That seat cannot be resumed"));
        return;
      }

      /*
       * One live connection per seat, and the newer one wins. A second tab is not
       * co-presence: two connections acting as one player would each be shown a table
       * the other could move out from under it. Dropped rather than merely unbound, so
       * the device it belongs to finds out — an unbound socket would sit there looking
       * connected and refusing every tap.
       */
      for (const member of membersOf(roomCode)) {
        if (member.id === socket.id) continue;
        if (member.data.session?.playerId === playerId) member.disconnect();
      }

      socket.data.session = { playerId, roomCode };
      await socket.join(roomCode);

      ack({ ok: true, value: { view: serializeStateForPlayer(state, playerId) } });
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
     * `runBotTurns` matters here even though a slapdown does not move the turn on: the
     * turn was already handed over by the `takeTurn` that opened the window, and if that
     * seat is a bot it has long since played. This is the no-op that says so. See
     * ADR-0005 for why a human effectively cannot reach this ahead of a bot.
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
     * disconnect. Deliberately not `act`-shaped: its two outcomes are not both a
     * `GameState` a single transition could return, so the branch lives here, where
     * rooms and connections are owned.
     *
     * The caller does not choose which outcome they get. A non-host frees their own seat
     * and the room plays on without them; the host closes it for everyone. See CONTEXT.md
     * for why the two phases this is allowed from behave identically.
     */
    socket.on("exitToMenu", (ack) => {
      const current = currentRoom();
      if (!current.ok) {
        ack({ ok: false, error: current.error });
        return;
      }

      const { session, state } = current.value;
      if (session.playerId === state.hostId) {
        /*
         * The host's leave is put to the same transition as everyone else's — it owns
         * which phases a player may leave from, and repeating that rule here would give
         * it two homes to drift between. Only the answer differs: the roster it hands
         * back is thrown away, and the room closed instead.
         */
        const allowed = removePlayer(state, session.playerId);
        if (!allowed.ok) {
          ack({ ok: false, error: allowed.error });
          return;
        }

        closeRoom(session.roomCode, "the host left the room", socket);
        ack({ ok: true, value: null });
        return;
      }

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

      // The leaver is already out of the room, so this reaches exactly whoever stayed:
      // who left, and then the table they are left with.
      io.to(session.roomCode).emit("playerLeft", name);
      broadcastState(session.roomCode);
    });

    /**
     * End the room for everyone, from any phase. The host's alone, and the only thing
     * that closes a room other than the game's own rules — a dropped connection no
     * longer does, so without this a table nobody wants to keep playing would have
     * nothing to end it.
     *
     * Not gated on the phase, unlike `exitToMenu`: a seat that has gone quiet mid-round
     * is exactly the table a host needs to be able to abandon, and there is no hand or
     * turn order left to protect once the room itself is going. Not `act`-shaped for the
     * same reason `exitToMenu` is not — "the room must be destroyed" is not a `GameState`
     * any transition could return.
     */
    socket.on("closeRoom", (ack) => {
      const current = currentRoom();
      if (!current.ok) {
        ack({ ok: false, error: current.error });
        return;
      }

      const { session, state } = current.value;
      if (session.playerId !== state.hostId) {
        ack(err("NOT_HOST", "Only the host can close the room"));
        return;
      }

      closeRoom(session.roomCode, "the host closed the room", socket);
      ack({ ok: true, value: null });
    });

    /*
     * There is deliberately no `disconnect` handler. A dropped connection costs the room
     * nothing: the seat, the player and the room are left exactly as they were, and the
     * player behind them comes back through `resumeSeat`. Backgrounding a phone's browser
     * tab drops a socket with no chance to react, and that must not end five other
     * people's match.
     *
     * The cost is a room nobody ever comes back to, and nobody closes, living until the
     * server restarts — an accepted leak for this pass, of the same shape as rooms being
     * in memory at all. See CLAUDE.md.
     */
  });

  return io;
}
