/**
 * The Socket.io transport: the seam between connected clients and the pure engine.
 *
 * This module only wires handlers onto an `io` instance — it never calls `listen`. The
 * process that opens a port is separate, so tests and harnesses can each stand up their
 * own server on an ephemeral port without duplicating any of this.
 */

import type { Server as HttpServer } from "node:http";
import type { ClientToServerEvents, ServerToClientEvents } from "@yaniv/shared";
import { Server } from "socket.io";
import { err } from "./result.ts";
import type { RoomManager } from "./roomManager.ts";
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

      ack({ ok: true, value: { playerId } });
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
