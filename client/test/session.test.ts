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
import { HAND_SIZE, MAX_PLAYERS, isValidSet } from "@yaniv/shared";
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

/**
 * A room to join, taken the way another player would: off the host's screen.
 *
 * Waits for the controls to unlock as well as for the room, because the server publishes
 * the lobby *before* it acks the creation — so the first snapshot with a view in it is
 * one the host still cannot act from.
 */
async function hostARoom(server: Harness, name: string): Promise<[Session, string]> {
  const host = await server.openSession();
  host.createRoom(name);
  const snapshot = await waitForSnapshot(
    host,
    "the host's room",
    (s) => s.view !== null && !s.busy,
  );
  return [host, snapshot.view!.roomCode];
}

/** The same wait, for a guest who has just been seated in somebody else's room. */
const seated = (session: Session, who: string) =>
  waitForSnapshot(session, `${who} to be seated`, (s) => s.view !== null && !s.busy);

/**
 * The smallest table with two humans on it — the shape every question about who may do
 * what needs, since a lone host is host by default and cannot be refused anything.
 */
async function hostAndGuest(server: Harness): Promise<[Session, Session]> {
  const [host, roomCode] = await hostARoom(server, "Ada");
  const guest = await server.openSession();
  guest.joinRoom(roomCode, "Grace");
  await seated(guest, "the guest");
  return [host, guest];
}

/**
 * A match under way, waiting on the one human in it.
 *
 * Whoever opens is chosen at random (ADR-0001) and the server plays every bot seat out
 * before it stops, so waiting for our own turn is the only way to know the table has
 * come to rest — and the only position a turn can be taken from.
 */
async function soloMatch(server: Harness): Promise<Session> {
  const [host] = await hostARoom(server, "Ada");
  host.startGame();
  await waitForSnapshot(
    host,
    "the host's turn",
    (s) => s.view !== null && s.view.currentTurnPlayerId === s.view.you.id && !s.busy,
  );
  return host;
}

/**
 * The same match with two humans at it, handed back as [whoever is on turn, whoever is
 * not] — which the test asks for rather than assumes, since the opener is random.
 *
 * Both are waited on, because "the bots have finished" is a fact about the position and
 * each connection learns it separately.
 */
async function twoHumanMatch(server: Harness): Promise<[Session, Session]> {
  const [host, guest] = await hostAndGuest(server);
  const hostId = host.getSnapshot().view!.you.id;
  const guestId = guest.getSnapshot().view!.you.id;
  host.startGame();

  const restsOnAHuman = (s: SessionSnapshot) =>
    s.view !== null &&
    s.view.phase === "playing" &&
    (s.view.currentTurnPlayerId === hostId || s.view.currentTurnPlayerId === guestId) &&
    !s.busy;

  const [seenByHost] = await Promise.all([
    waitForSnapshot(host, "the host's table", restsOnAHuman),
    waitForSnapshot(guest, "the guest's table", restsOnAHuman),
  ]);
  return seenByHost.view!.currentTurnPlayerId === hostId ? [host, guest] : [guest, host];
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

  it("fills every empty seat with a bot when the host starts", async () => {
    const server = await startServer(7);
    try {
      const [host] = await hostARoom(server, "Ada");
      host.startGame();

      const playing = await waitForSnapshot(
        host,
        "the match to start",
        (s) => s.view?.phase === "playing",
      );

      // Nobody was asked how many opponents they wanted: creating and starting is the
      // whole of setting a match up.
      assert.equal(
        playing.view!.opponents.length,
        MAX_PLAYERS - 1,
        "every seat the host did not fill is a bot",
      );
      assert.equal(playing.view!.you.hand.length, HAND_SIZE, "and the cards are dealt");
    } finally {
      await server.close();
    }
  });

  it("refuses a guest's start and leaves the lobby where it was", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);

      guest.startGame();

      // Whether the control is offered is the screen's business; whether the match
      // starts is the server's, and this is how a guest is told the rule.
      const refused = await waitForSnapshot(guest, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "NOT_HOST");
      assert.equal(refused.view!.phase, "lobby", "still waiting on the host");

      // Nothing was dealt behind the refusal, on the host's screen either.
      assert.equal(host.getSnapshot().view!.phase, "lobby");
      assert.equal(host.getSnapshot().view!.you.hand.length, 0);
    } finally {
      await server.close();
    }
  });

  it("frees only their own seat when a guest exits to the menu", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);
      await waitForSnapshot(host, "the table to fill", (s) => s.view?.opponents.length === 1);

      guest.exitToMenu();

      const gone = await waitForSnapshot(guest, "the guest's menu", (s) => s.view === null);
      assert.equal(gone.error, null, "leaving a room is not a failure");

      const stayed = await waitForSnapshot(
        host,
        "the table to shrink",
        (s) => s.view?.opponents.length === 0,
      );
      assert.equal(stayed.view!.phase, "lobby", "the room plays on for whoever remains");

      // Straight into another room, which is the whole point of an exit that is not a
      // disconnect — a connection still bound to the old room would be told
      // ALREADY_IN_ROOM instead.
      guest.createRoom("Grace");
      const another = await waitForSnapshot(guest, "a room of their own", (s) => s.view !== null);
      assert.equal(another.error, null);
    } finally {
      await server.close();
    }
  });

  it("closes the room and says why when the host exits", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);

      host.exitToMenu();

      const hostGone = await waitForSnapshot(host, "the host's menu", (s) => s.view === null);
      assert.equal(hostGone.error, null);

      // The guest was sitting doing nothing, so the room going away has to reach them
      // where they are rather than waiting for them to tap something.
      const closed = await waitForSnapshot(guest, "the guest's menu", (s) => s.view === null);
      assert.match(
        closed.notice ?? "",
        /host/,
        "the reason it closed, so the guest is not left guessing",
      );
      assert.equal(closed.error, null, "nothing the guest did was refused");
    } finally {
      await server.close();
    }
  });

  it("does not blame a guest for an action the closing room refused", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);

      // Both leave at once. The server sees them in some order, and if the host's lands
      // first the guest's own exit comes back `PLAYER_NOT_FOUND` — the room they were
      // asking to leave is already gone. Either way the guest ends up on the menu, and
      // either way that must be the whole of it: a refusal costs the player nothing, so
      // it cannot leave them reading an error about a room that no longer exists.
      host.exitToMenu();
      guest.exitToMenu();

      await waitForSnapshot(guest, "the guest's menu", (s) => s.view === null);

      // The late ack would land a round trip behind, so give it one before believing it
      // changed nothing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = guest.getSnapshot();
      assert.equal(settled.view, null);
      assert.equal(settled.error, null, "nothing the guest did was their fault");
    } finally {
      await server.close();
    }
  });

  it("lets a closed-out player straight into another room", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);

      host.exitToMenu();
      await waitForSnapshot(guest, "the room to close", (s) => s.notice !== null);

      // The menu is a menu, not a dead end: whatever happened to the last room, the
      // controls on this screen work.
      guest.createRoom("Grace");
      const own = await waitForSnapshot(guest, "a room of their own", (s) => s.view !== null);
      assert.equal(own.view!.phase, "lobby");
      assert.equal(own.notice, null, "the last room's news is not this room's");
      assert.equal(own.error, null);
    } finally {
      await server.close();
    }
  });
});

describe("taking a turn", () => {
  it("discards the selection and draws the deck in one action", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const chosen = host.getSnapshot().view!.you.hand[0]!;

      host.toggleCard(chosen.id);
      assert.deepEqual(host.getSnapshot().selection, [chosen.id], "chosen, not yet sent");

      host.commitTurn({ kind: "deck" });
      assert.equal(host.getSnapshot().busy, true, "locked the instant the turn went out");

      const landed = await waitForSnapshot(host, "the turn to land", (s) => !s.busy);

      // The lock is what proves the *timing*: the server acks a turn before it
      // broadcasts the result, so a lock released on the ack would let go while the
      // last view still showed this card in hand and this player on turn.
      assert.ok(
        !landed.view!.you.hand.some((c) => c.id === chosen.id),
        "the lock held until a strictly newer position arrived, not merely until the ack",
      );
      assert.equal(landed.error, null);
      assert.deepEqual(landed.selection, [], "the selection went with the turn");
      assert.equal(landed.view!.you.hand.length, HAND_SIZE, "discarded one, drew one");
      assert.deepEqual(
        landed.view!.lastDiscard.map((c) => c.id),
        [chosen.id],
        "and the card is face up for whoever plays next",
      );
    } finally {
      await server.close();
    }
  });

  it("takes an end of the discard when that is what was tapped", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const before = host.getSnapshot().view!;
      const wanted = before.lastDiscard[0]!;

      host.toggleCard(before.you.hand[0]!.id);
      host.commitTurn({ kind: "discard", cardId: wanted.id });

      const landed = await waitForSnapshot(host, "the turn to land", (s) => !s.busy);
      assert.equal(landed.error, null, "the client offered only what the server accepts");
      assert.ok(
        landed.view!.you.hand.some((c) => c.id === wanted.id),
        "the tapped card was drawn, not one off the deck",
      );
    } finally {
      await server.close();
    }
  });

  it("gives the controls back when a turn is refused", async () => {
    const server = await startServer(7);
    try {
      const [, waiting] = await twoHumanMatch(server);
      const chosen = waiting.getSnapshot().view!.you.hand[0]!;

      // A legal discard, out of turn. Turn order is the server's to own — the client
      // does not second-guess it, so the refusal is how this player is told.
      waiting.toggleCard(chosen.id);
      waiting.commitTurn({ kind: "deck" });
      assert.equal(waiting.getSnapshot().busy, true);

      const refused = await waitForSnapshot(waiting, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "NOT_YOUR_TURN");
      assert.equal(refused.busy, false, "released on the ack — no new position is coming");
      assert.deepEqual(
        refused.selection,
        [chosen.id],
        "a refused action costs nothing, so the cards they chose are still chosen",
      );
    } finally {
      await server.close();
    }
  });

  it("sends one turn however many times the deck is tapped", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const chosen = host.getSnapshot().view!.you.hand[0]!;
      host.toggleCard(chosen.id);

      // A phone on a slow connection double-taps far more readily than a keyboard
      // double-presses. The second turn would be refused — the cards it names have
      // already left the hand — and the player would be blamed for a lag they cannot see.
      host.commitTurn({ kind: "deck" });
      host.commitTurn({ kind: "deck" });

      await waitForSnapshot(host, "the turn to land", (s) => !s.busy);

      // The second send, had it been made, would be answered a round trip behind the
      // first, so give it one before believing it never was.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(host.getSnapshot().error, null, "only one turn was ever sent");
    } finally {
      await server.close();
    }
  });

  it("keeps a selection across a view that leaves the hand alone", async () => {
    const server = await startServer(7);
    try {
      const [mover, waiting] = await twoHumanMatch(server);
      const chosen = waiting.getSnapshot().view!.you.hand[0]!;
      waiting.toggleCard(chosen.id);

      const played = mover.getSnapshot().view!.you.hand[0]!;
      mover.toggleCard(played.id);
      mover.commitTurn({ kind: "deck" });

      await waitForSnapshot(waiting, "somebody else's move", (s) =>
        s.view!.lastDiscard.some((c) => c.id === played.id),
      );
      assert.deepEqual(
        waiting.getSnapshot().selection,
        [chosen.id],
        "their own hand did not change, so neither did what they had chosen from it",
      );
    } finally {
      await server.close();
    }
  });

  it("never sends a turn the rules do not permit", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const hand = host.getSnapshot().view!.you.hand;

      // Five dealt cards always hold two that make no set between them, and tapping
      // both is the ordinary way to find that out — so it has to cost nothing at all.
      const illegal = hand.find((c) => !isValidSet([hand[0]!, c]));
      assert.ok(illegal, "a hand of five holds two cards that are not a set");
      host.toggleCard(hand[0]!.id);
      host.toggleCard(illegal.id);

      host.commitTurn({ kind: "deck" });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = host.getSnapshot();
      assert.equal(settled.busy, false, "nothing was sent, so nothing is locked");
      assert.equal(settled.error, null, "and nothing was refused, so there is nothing to say");
      assert.equal(
        settled.view!.currentTurnPlayerId,
        settled.view!.you.id,
        "the turn is still theirs",
      );
    } finally {
      await server.close();
    }
  });
});
