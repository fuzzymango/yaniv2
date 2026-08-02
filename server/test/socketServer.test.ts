/**
 * The socket transport, exercised over real connections.
 *
 * Every test here drives a real `socket.io-client` against a real Socket.io server on an
 * ephemeral port. Nothing calls a handler directly or inspects `socket.data`: the whole
 * point of this layer is its wire behaviour, so a suite that stubbed the socket API would
 * be testing a stand-in for the thing under test. That also means facts about server
 * state are observed through the socket — room cleanup is proven by a later join being
 * rejected, not by asking the RoomManager.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { GameError } from "@yaniv/shared";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { RoomManager } from "../src/roomManager.ts";
import { createSocketServer } from "../src/socketServer.ts";

/** The ack shape every request/response event replies with. Mirrors `Ack<T>`. */
type AckResult<T> = { ok: true; value: T } | { ok: false; error: GameError };

interface Harness {
  /** Open a new client connection, resolving once it is actually connected. */
  connect: () => Promise<ClientSocket>;
  close: () => Promise<void>;
}

/**
 * Stand up a server on an ephemeral port. Port 0 lets the OS pick, so suites can run
 * concurrently and no test depends on a fixed port being free.
 */
async function startServer(): Promise<Harness> {
  const httpServer = createServer();
  const io = createSocketServer(httpServer, new RoomManager());

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  const clients: ClientSocket[] = [];

  return {
    connect: () =>
      new Promise((resolve) => {
        // Skip the HTTP long-polling handshake: it adds latency and a second
        // transport's worth of failure modes for no extra coverage.
        const client = connectClient(`http://localhost:${port}`, {
          transports: ["websocket"],
        });
        clients.push(client);
        client.on("connect", () => resolve(client));
      }),
    close: async () => {
      for (const client of clients) client.disconnect();
      await io.close();
    },
  };
}

/**
 * Emit an event and resolve with its ack, so tests read top to bottom.
 *
 * The timeout matters: an event the server has no handler for never acks at all, and
 * without this the whole suite would hang instead of failing. A missing handler should
 * look like a failing test, not a wedged CI job.
 */
function ask<T>(
  client: ClientSocket,
  event: string,
  ...args: unknown[]
): Promise<AckResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server never acked "${event}"`)),
      1000,
    );
    client.emit(event, ...args, (result: AckResult<T>) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/** Unwrap a successful ack, failing the test with the error code if it was a rejection. */
function expectOk<T>(result: AckResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Resolve with the next `event` this client receives.
 *
 * Call this *before* triggering whatever should cause the broadcast, and await it after —
 * subscribing afterwards races the server and passes or fails on timing.
 */
function nextEvent<T>(client: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "${event}" broadcast arrived`)),
      1000,
    );
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Unwrap a rejection, failing the test if the call unexpectedly succeeded. */
function expectError<T>(result: AckResult<T>): GameError {
  if (result.ok) assert.fail("expected a rejection, got success");
  return result.error;
}

let server: Harness;

before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});

/** Create a room and return its code, for tests whose subject is what happens next. */
async function createRoom(name = "Ada"): Promise<string> {
  const host = await server.connect();
  return expectOk(
    await ask<{ roomCode: string; playerId: string }>(host, "createRoom", name),
  ).roomCode;
}

describe("createRoom", () => {
  it("gives the creator a room code and their player id", async () => {
    const client = await server.connect();

    const result = await ask<{ roomCode: string; playerId: string }>(
      client,
      "createRoom",
      "Ada",
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Codes are short enough to read aloud and type — see docs/rules.md.
    assert.equal(result.value.roomCode.length, 4);
    assert.ok(result.value.playerId.length > 0, "a player id was issued");
  });
});

describe("joinRoom", () => {
  it("admits a second player to an existing room under their own identity", async () => {
    const host = await server.connect();
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );

    const joiner = await server.connect();
    const joined = expectOk(
      await ask<{ playerId: string }>(joiner, "joinRoom", created.roomCode, "Grace"),
    );

    assert.ok(joined.playerId.length > 0, "a player id was issued");
    assert.notEqual(
      joined.playerId,
      created.playerId,
      "each player gets a distinct identity",
    );
  });

  /*
   * The engine already enforces each of these; what is under test is that the rejection
   * survives the transport as a specific code rather than a dropped call, a thrown
   * exception, or a generic failure a client cannot branch on.
   */

  it("rejects an unknown room code", async () => {
    const client = await server.connect();

    const result = await ask(client, "joinRoom", "ZZZZ", "Grace");

    assert.equal(expectError(result).code, "ROOM_NOT_FOUND");
  });

  it("rejects an unusable name", async () => {
    const roomCode = await createRoom();
    const client = await server.connect();

    const result = await ask(client, "joinRoom", roomCode, "   ");

    assert.equal(expectError(result).code, "INVALID_NAME");
  });

  it("rejects a join once the table is full", async () => {
    const roomCode = await createRoom();

    // The table seats six (docs/rules.md); the creator holds one seat already.
    for (let seat = 0; seat < 5; seat++) {
      const filler = await server.connect();
      expectOk(await ask(filler, "joinRoom", roomCode, `Player${seat}`));
    }

    const latecomer = await server.connect();
    const result = await ask(latecomer, "joinRoom", roomCode, "Tony");

    assert.equal(expectError(result).code, "ROOM_FULL");
  });
});

/**
 * A connection carries exactly one identity for its whole life. Without this, a second
 * create or join would silently overwrite the first, orphaning a seated player that no
 * connection can act for — and reconnect, which would be the only way to recover, is
 * deliberately out of scope.
 */
describe("one identity per connection", () => {
  it("rejects a second createRoom on the same connection", async () => {
    const client = await server.connect();
    expectOk(await ask(client, "createRoom", "Ada"));

    const result = await ask(client, "createRoom", "Ada again");

    assert.equal(expectError(result).code, "ALREADY_IN_ROOM");
  });

  it("rejects a join from a connection that already created a room", async () => {
    const otherRoom = await createRoom("Grace");
    const client = await server.connect();
    expectOk(await ask(client, "createRoom", "Ada"));

    const result = await ask(client, "joinRoom", otherRoom, "Ada elsewhere");

    assert.equal(expectError(result).code, "ALREADY_IN_ROOM");
  });

  it("rejects a second joinRoom on the same connection", async () => {
    const first = await createRoom("Ada");
    const second = await createRoom("Grace");
    const client = await server.connect();
    expectOk(await ask(client, "joinRoom", first, "Alan"));

    const result = await ask(client, "joinRoom", second, "Alan elsewhere");

    assert.equal(expectError(result).code, "ALREADY_IN_ROOM");
  });
});

describe("playerJoined", () => {
  it("announces a new arrival to everyone already in the room", async () => {
    const host = await server.connect();
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );

    const announced = nextEvent<string>(host, "playerJoined");
    const joiner = await server.connect();
    expectOk(await ask(joiner, "joinRoom", roomCode, "Grace"));

    assert.equal(await announced, "Grace");
  });
});

describe("disconnect", () => {
  /**
   * Poll a room code with real join attempts until one is rejected.
   *
   * A client-side disconnect is processed by the server asynchronously, so there is no
   * instant the test can synchronously observe. Polling through the public interface is
   * also exactly how a real client would discover the room is gone.
   */
  async function joinUntilRejected(roomCode: string): Promise<GameError> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = await server.connect();
      const result = await ask(probe, "joinRoom", roomCode, `Probe${attempt}`);
      if (!result.ok) return result.error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("the room kept accepting joins");
  }

  it("removes the room, so its code stops resolving", async () => {
    const host = await server.connect();
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );

    host.disconnect();

    assert.equal((await joinUntilRejected(roomCode)).code, "ROOM_NOT_FOUND");
  });
});
