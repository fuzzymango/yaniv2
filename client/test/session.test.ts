/**
 * The session core, driven against a real server.
 *
 * These stand up an actual Socket.io server on an ephemeral port with a seeded
 * `RoomManager` and point the session at it through a real `socket.io-client`, the same
 * way `server/test/cli/session.test.ts` drives the terminal harness. The session core's
 * whole job is to be a client, so a suite that stubbed the socket would be testing a
 * stand-in for the thing under test.
 *
 * Nothing here reaches into the `RoomManager` or the session's internals. Every
 * assertion is on a snapshot — the same thing a component reads — and every fact the
 * test knows about the server, it learned over the wire.
 *
 * No browser and no React: the session core is a plain module, which is exactly why it
 * can be tested under `node:test` at all.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { MAX_PLAYERS } from "@yaniv/shared";
import { RoomManager } from "@yaniv/server/src/roomManager.ts";
import { mulberry32 } from "@yaniv/server/src/rng.ts";
import { createSocketServer } from "@yaniv/server/src/socketServer.ts";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { createSession, type Session, type SessionSnapshot } from "../src/session.ts";

interface Harness {
  /** A session on its own connection — one per player, as in a browser tab each. */
  openSession: () => Promise<Session>;
  close: () => Promise<void>;
}

/** A server on an OS-assigned port, seeded so every run deals the same cards. */
async function startServer(seed: number): Promise<Harness> {
  const httpServer = createServer();
  const io = createSocketServer(
    httpServer,
    new RoomManager({
      rng: mulberry32(seed),
      newRoomRng: () => mulberry32(seed + 1),
    }),
  );

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  const clients: ClientSocket[] = [];

  return {
    openSession: () =>
      new Promise((resolve) => {
        const client = connectClient(`http://localhost:${port}`, {
          transports: ["websocket"],
        });
        clients.push(client);
        client.on("connect", () => resolve(createSession(client)));
      }),
    close: async () => {
      for (const client of clients) client.disconnect();
      await io.close();
    },
  };
}

/**
 * Wait for the session to publish a snapshot satisfying `ready` — now, or on a later
 * one. Subscribing is the whole of the public read surface, so a test that can only
 * wait this way is a test that cannot cheat.
 */
function waitForSnapshot(
  session: Session,
  what: string,
  ready: (snapshot: SessionSnapshot) => boolean,
): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const snapshot = session.getSnapshot();
      if (!ready(snapshot)) return false;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
      return true;
    };

    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${what}`));
    }, 2000);
    const unsubscribe = session.subscribe(() => settle());

    settle();
  });
}

/** A room to join, taken the way another player would: off the host's screen. */
async function hostARoom(server: Harness, name: string): Promise<[Session, string]> {
  const host = await server.openSession();
  host.createRoom(name);
  const snapshot = await waitForSnapshot(host, "the host's room", (s) => s.view !== null);
  return [host, snapshot.view!.roomCode];
}

describe("the session core", () => {
  it("creates a room and shows its code", async () => {
    const server = await startServer(7);
    try {
      const session = await server.openSession();
      session.createRoom("Ada");

      const { view } = await waitForSnapshot(session, "the new room", (s) => s.view !== null);

      assert.equal(view!.phase, "lobby");
      assert.match(view!.roomCode, /^[A-Z2-9]{4}$/, "a 4-character code to read aloud");
      assert.equal(view!.you.name, "Ada");
    } finally {
      await server.close();
    }
  });

  it("joins a room whose code was typed in lowercase", async () => {
    const server = await startServer(7);
    try {
      const [host, roomCode] = await hostARoom(server, "Ada");

      const guest = await server.openSession();
      guest.joinRoom(roomCode.toLowerCase(), "Grace");

      const joined = await waitForSnapshot(guest, "the joined room", (s) => s.view !== null);
      assert.equal(joined.view!.roomCode, roomCode, "the code is normalised, not rejected");
      assert.equal(joined.error, null);
      assert.deepEqual(
        joined.view!.opponents.map((p) => p.name),
        ["Ada"],
        "the guest sees who is already seated",
      );

      // The host's own screen moves too, which is the wire-level proof the join landed
      // in the room the guest thought they were typing.
      const seated = await waitForSnapshot(
        host,
        "the host's table to fill",
        (s) => s.view?.opponents.length === 1,
      );
      assert.deepEqual(seated.view!.opponents.map((p) => p.name), ["Grace"]);
    } finally {
      await server.close();
    }
  });

  it("leaves a player on the main menu when the code is wrong", async () => {
    const server = await startServer(7);
    try {
      const session = await server.openSession();
      session.joinRoom("ZZZZ", "Ada");

      const refused = await waitForSnapshot(session, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "ROOM_NOT_FOUND");
      assert.equal(refused.view, null, "no room, so the main menu is still the screen");

      // Still able to act, which is the whole point of staying on the menu — and, since
      // the server refuses a second entry from a connection already in a room, proof
      // that the failed join left nothing bound behind it.
      session.createRoom("Ada");
      const created = await waitForSnapshot(session, "a room of their own", (s) => s.view !== null);
      assert.equal(created.error, null, "the refusal is cleared by the next attempt");
    } finally {
      await server.close();
    }
  });

  it("says so when the room is full", async () => {
    const server = await startServer(7);
    try {
      const [, roomCode] = await hostARoom(server, "Ada");

      // The host is already seated, so this fills the table exactly.
      for (let seat = 1; seat < MAX_PLAYERS; seat++) {
        const guest = await server.openSession();
        guest.joinRoom(roomCode, `Guest ${seat}`);
        await waitForSnapshot(guest, `guest ${seat} to be seated`, (s) => s.view !== null);
      }

      const latecomer = await server.openSession();
      latecomer.joinRoom(roomCode, "Grace");

      const refused = await waitForSnapshot(latecomer, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "ROOM_FULL");
      assert.equal(refused.view, null);
    } finally {
      await server.close();
    }
  });

  it("refuses an empty name without asking the server", async () => {
    const server = await startServer(7);
    try {
      const session = await server.openSession();
      session.createRoom("   ");

      const refused = await waitForSnapshot(session, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "INVALID_NAME");
      assert.equal(refused.view, null);

      // The proof that nothing was emitted, phrased in the only terms a client has: a
      // connection the server had seated would be turned away with ALREADY_IN_ROOM.
      session.createRoom("Ada");
      const created = await waitForSnapshot(session, "the room", (s) => s.view !== null);
      assert.equal(created.view!.you.name, "Ada");
    } finally {
      await server.close();
    }
  });

  it("asks for one room however many times the control is tapped", async () => {
    const server = await startServer(7);
    try {
      const session = await server.openSession();
      // A phone on a slow connection double-taps far more readily than a keyboard
      // double-presses, and the second ask would come back as ALREADY_IN_ROOM — an
      // error about the transport, shown to a player who did nothing wrong.
      session.createRoom("Ada");
      session.createRoom("Ada");

      const created = await waitForSnapshot(session, "the room", (s) => s.view !== null);
      assert.equal(created.error, null);

      // The second ask, had it been made, would be answered after the first — so give
      // the server a round trip to say so before believing it never was.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(session.getSnapshot().error, null, "only one room was ever asked for");
    } finally {
      await server.close();
    }
  });

  it("refuses to join under an empty name too", async () => {
    const server = await startServer(7);
    try {
      const [, roomCode] = await hostARoom(server, "Ada");

      const guest = await server.openSession();
      guest.joinRoom(roomCode, "");

      const refused = await waitForSnapshot(guest, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "INVALID_NAME");
      assert.equal(refused.view, null);
    } finally {
      await server.close();
    }
  });
});
