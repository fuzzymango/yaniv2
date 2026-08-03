/**
 * The Socket.io transport: the seam between connected clients and the pure engine.
 *
 * This module only wires handlers onto an `io` instance — it never calls `listen`. The
 * process that opens a port is separate, so tests and harnesses can each stand up their
 * own server on an ephemeral port without duplicating any of this.
 */

import type { Server as HttpServer } from "node:http";
import type { Ack, ClientToServerEvents, ServerToClientEvents } from "@yaniv/shared";
import { Server } from "socket.io";
import { playBotTurns } from "./botTurns.ts";
import { callYaniv, startGame, startNextRound, takeTurn } from "./game.ts";
import { err } from "./result.ts";
import type { RoomManager } from "./roomManager.ts";
import type { Rng } from "./rng.ts";
import { serializeStateForPlayer } from "./serialize.ts";
import type { ActionResult, GameState } from "./state.ts";
import { getPlayer } from "./state.ts";

/**
 * Who a connection is. Set once, when the connection creates or joins a room, and read
 * by every handler thereafter — a client-supplied player id is never trusted, or a socket
 * could act as any player simply by saying so.
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

    for (const socketId of io.sockets.adapter.rooms.get(roomCode) ?? []) {
      const socket = io.sockets.sockets.get(socketId);
      const playerId = socket?.data.session?.playerId;
      if (!socket || !playerId) continue;
      socket.emit("gameStateUpdate", serializeStateForPlayer(state, playerId));
    }
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

  io.on("connection", (socket) => {
    const alreadySeated = () =>
      err("ALREADY_IN_ROOM", "This connection is already in a room");

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
      const { roomCode, playerId } = created.value;
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
      ack({ ok: true, value: { roomCode, playerId } });
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

      const { playerId, state } = joined.value;
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

      ack({ ok: true, value: { playerId } });
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

    socket.on("startNextRound", (ack) => {
      act(ack, (session, state, rng) =>
        startNextRound(state, session.playerId, rng),
      );
    });

    /**
     * A dropped connection ends the room it belonged to. This is one-directional
     * cleanup, not reconnect support: with no way for a player to resume a session,
     * a room whose player is gone can never be played again, so keeping it would only
     * leak memory. Deliberately unconditional — see the room lifecycle notes in
     * CLAUDE.md for why reconnect is out of scope.
     */
    socket.on("disconnect", () => {
      const session = socket.data.session;
      if (!session) return;
      rooms.removeRoom(session.roomCode);
    });
  });

  return io;
}
