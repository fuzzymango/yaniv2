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
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MAX_SCORE,
  handValue,
  isValidSet,
  legalDiscards,
  pickupCandidates,
  type GameError,
  type PlayerGameView,
} from "@yaniv/shared";
import { RoomManager } from "@yaniv/server/src/roomManager.ts";
import { mulberry32 } from "@yaniv/server/src/rng.ts";
import { createSocketServer } from "@yaniv/server/src/socketServer.ts";
import {
  io as connectClient,
  type ManagerOptions,
  type Socket as ClientSocket,
  type SocketOptions,
} from "socket.io-client";
import type { Clock } from "../src/pacing.ts";
import { createSession, type Session, type SessionSnapshot } from "../src/session.ts";
import { isLegalCall } from "../src/turn.ts";
import { testClock } from "./helpers.ts";

interface Harness {
  /**
   * A session on its own connection — one per player, as in a browser tab each.
   *
   * On a clock that runs every beat the moment it is asked for, unless the test hands one
   * in: a suite about anything other than pacing wants the positions as the server sent
   * them, not spread over seconds of real time. A test that *is* about pacing hands in a
   * clock it holds.
   */
  openSession: (clock?: Clock) => Promise<Session>;
  /**
   * Take a session's connection away, the way a tunnel or a locked phone does.
   *
   * `keepTrying` is the difference between the two kinds of drop a browser sees. A
   * transport closed underneath the client leaves socket.io reconnecting on its own,
   * which is what actually happens on a flaky network; `disconnect()` is a deliberate
   * hang-up and stays down.
   */
  drop: (session: Session, keepTrying?: boolean) => void;
  /**
   * Push an `errorMessage` at every connected client — the one thing in the contract the
   * server may say unprompted that is not about a room going away.
   *
   * Emitted through the real server's `io`, so the session hears it over the wire exactly
   * as it would in production. Nothing in the server sends one today, which is precisely
   * why a test has to.
   */
  announce: (error: GameError) => void;
  close: () => Promise<void>;
}

/**
 * How every connection in this suite is opened. The reconnection delays are far shorter
 * than the second a browser waits, so a test that watches a connection come back does not
 * spend one waiting for it.
 */
const CONNECTION: Partial<ManagerOptions & SocketOptions> = {
  transports: ["websocket"],
  reconnectionDelay: 20,
  reconnectionDelayMax: 50,
};

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
  /**
   * Which connection belongs to which session, so a test can take one away without the
   * session core having to hand its socket back out. It owns the socket and nothing else
   * reaches for it — including this suite.
   */
  const connections = new Map<Session, ClientSocket>();

  return {
    openSession: (clock = testClock()) =>
      new Promise((resolve) => {
        const client = connectClient(`http://localhost:${port}`, { ...CONNECTION });
        // `once`, because a connection that comes back fires this again — and a second
        // session on the same socket would double every handler the first one attached.
        client.once("connect", () => {
          const session = createSession(client, clock);
          connections.set(session, client);
          resolve(session);
        });
      }),
    drop: (session, keepTrying = false) => {
      const client = connections.get(session);
      if (!client) throw new Error("that session was never opened here");
      if (keepTrying) client.io.engine.close();
      else client.disconnect();
    },
    announce: (error) => io.emit("errorMessage", error),
    close: async () => {
      for (const client of connections.values()) client.disconnect();
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
async function hostARoom(
  server: Harness,
  name: string,
  clock?: Clock,
): Promise<[Session, string]> {
  const host = await server.openSession(clock);
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
async function soloMatch(server: Harness, clock?: Clock): Promise<Session> {
  const [host] = await hostARoom(server, "Ada", clock);
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

/**
 * The seed the Yaniv tests are played on.
 *
 * Reaching a callable hand is a race: five bots are shedding as fast as this seat is and
 * each of them calls the instant it is legal, so on most deals a bot ends the round first.
 * This one is a deal where the human seat gets there — in two turns, which also keeps the
 * suite quick. Nothing else about it is special, and `playUntilCallable` says so out loud
 * if it ever stops being true.
 */
const HUMAN_CALLS_FIRST = 27;

/** Worth taking face up rather than gambling on the deck, for the driver below. */
const CHEAP_PICKUP = 3;

/**
 * One turn, taken through the intents a pair of taps would go through.
 *
 * The policy is: shed the most valuable set the rules allow, and take a face-up card only
 * when it is cheap enough to be worth having. That is roughly what the bots do, which is
 * the point — a seat playing worse than they do never gets to call at all. It reads the
 * rulebook for what is legal, exactly as the client does, and decides for itself what is
 * wise; there is no import from `bot.ts` here, and a smarter bot must not quietly change
 * what this drives.
 */
function takeATurn(session: Session, view: PlayerGameView): void {
  const heaviest = legalDiscards(view.you.hand).sort(
    (a, b) => handValue(b) - handValue(a),
  )[0]!;
  for (const card of heaviest) session.toggleCard(card.id);

  const cheapest = [...pickupCandidates(view.lastDiscard)].sort(
    (a, b) => a.value - b.value,
  )[0];
  session.commitTurn(
    cheapest !== undefined && cheapest.value <= CHEAP_PICKUP
      ? { kind: "discard", cardId: cheapest.id }
      : { kind: "deck" },
  );
}

/** Play the one human seat down to a hand it may call Yaniv on, and stop there. */
async function playUntilCallable(session: Session): Promise<SessionSnapshot> {
  for (let move = 0; move < 100; move++) {
    const resting = await waitForSnapshot(
      session,
      "a move of our own",
      (s) =>
        s.view !== null &&
        !s.busy &&
        (s.view.phase !== "playing" || s.view.currentTurnPlayerId === s.view.you.id),
    );
    const view = resting.view!;
    assert.equal(view.phase, "playing", "a bot called Yaniv before this seat could");
    if (isLegalCall(view.you.hand)) return resting;

    takeATurn(session, view);
  }
  throw new Error("the hand never came down to one Yaniv could be called on");
}

/** Resolve as soon as any of these sessions publishes anything, so the driver can look again. */
function anyPublication(sessions: Session[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error("the table stopped moving with the match unfinished"));
    }, 2000);
    const unsubscribes = sessions.map((s) =>
      s.subscribe(() => {
        stop();
        resolve();
      }),
    );
  });
}

/**
 * Play a whole match out, however many humans are at the table, and stop on the standings.
 *
 * Driven entirely off published snapshots — the same surface a screen reads — because
 * nothing else tells a client whose move it is. Each pass looks at every session, acts for
 * whichever one the position is waiting on, and otherwise sleeps until something is
 * published. Deciding from the snapshots as they stand, rather than waiting on any one
 * connection to reach an expected position, is what keeps it right when two sockets are
 * told about a move in different orders.
 *
 * Every seat calls Yaniv the instant its hand allows it, which is what the bots do and what
 * gets a match to 100 quickly. The host deals each next round, since nobody else may.
 *
 * It returns only once *every* session is resting on the finished match, not merely the
 * host's: whoever called the last Yaniv is still locked until the standings reach them, and
 * a caller that acted on their behalf a moment earlier would be sending into that lock.
 */
async function playToMatchEnd(sessions: Session[]): Promise<SessionSnapshot> {
  const [host] = sessions as [Session, ...Session[]];
  /** The round already asked to be dealt past — the ack for it lands before the deal does. */
  let dealtFrom = -1;

  for (let step = 0; step < 500; step++) {
    const seen = sessions.map((s) => s.getSnapshot());
    const [onHost] = seen as [SessionSnapshot, ...SessionSnapshot[]];
    if (seen.every((s) => s.view?.phase === "gameEnd" && !s.busy)) return onHost;

    const turn = seen.findIndex(
      ({ view, busy }) =>
        !busy && view?.phase === "playing" && view.currentTurnPlayerId === view.you.id,
    );

    if (turn !== -1) {
      const mover = sessions[turn]!;
      const view = seen[turn]!.view!;
      if (isLegalCall(view.you.hand)) mover.callYaniv();
      else takeATurn(mover, view);
    } else if (
      onHost.view?.phase === "roundEnd" &&
      !onHost.busy &&
      onHost.view.roundNumber !== dealtFrom
    ) {
      dealtFrom = onHost.view.roundNumber;
      host.startNextRound();
    } else {
      await anyPublication(sessions);
    }
  }
  throw new Error("nobody busted past the maximum score in 500 moves");
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

/**
 * Slapping down (docs/rules.md §9): the one action taken while the turn belongs to
 * somebody else.
 *
 * Every test here needs two humans. `startGame` seats bots behind the two of them and
 * `playBotTurns` runs the seat after ours in the same tick, so a window opened in front
 * of a bot is shut before the broadcast announcing it has been drawn (ADR-0005) — the
 * guest sitting directly behind the host is what holds one open long enough to tap.
 */
describe("slapping down", () => {
  /**
   * One fishing turn: shed a card whose rank the hand holds only once, and draw from the
   * deck. Every copy still in hand is a copy that cannot come back off the top, and a
   * joker never opens a window at all, so this is the discard most likely to.
   */
  function fishForAWindow(session: Session, view: PlayerGameView): void {
    const hand = view.you.hand;
    const lonely = hand.find(
      (c) => c.suit !== null && hand.filter((o) => o.rank === c.rank).length === 1,
    );
    session.toggleCard((lonely ?? hand[0]!).id);
    session.commitTurn({ kind: "deck" });
  }

  /**
   * Sit two humans down and play until the host draws a card they may slap down,
   * stopping exactly there: the window open, the turn with the guest, nothing else moved.
   *
   * Only the host's windows count. The roster is seated in join order, so the guest is
   * behind the host and a bot is behind the guest — a window of the guest's own is shut
   * again in the same tick it opened.
   */
  async function playToAnOpenWindow(server: Harness): Promise<[Session, Session]> {
    const [host, guest] = await hostAndGuest(server);
    const hostId = host.getSnapshot().view!.you.id;
    const guestId = guest.getSnapshot().view!.you.id;
    host.startGame();

    /**
     * The position the driver last acted from, by identity. Snapshots are replaced
     * wholesale, so "a view we have not played yet" is what keeps the loop moving: the
     * two sessions learn of each move separately, and waiting only on the *shape* of a
     * position would read the one just played as the next one to play.
     */
    let played: PlayerGameView | null = null;
    const nextToPlay = (s: SessionSnapshot) =>
      s.view !== null &&
      !s.busy &&
      s.view !== played &&
      s.view.phase !== "lobby" &&
      (s.view.phase !== "playing" ||
        s.view.currentTurnPlayerId === hostId ||
        s.view.currentTurnPlayerId === guestId);

    for (let step = 0; step < 400; step++) {
      const at = await waitForSnapshot(host, "a human to be needed", nextToPlay);
      const view = at.view!;
      played = view;

      // The fishing is what takes the turns, so a round or a match running out along
      // the way is dealt with and carried on from rather than being the end of it.
      if (view.phase !== "playing") {
        if (view.phase === "gameEnd") host.playAgain();
        else host.startNextRound();
        continue;
      }

      if (view.currentTurnPlayerId === guestId) {
        const theirs = await waitForSnapshot(
          guest,
          "the guest's own view of their turn",
          (s) =>
            s.view !== null &&
            !s.busy &&
            s.view.phase === "playing" &&
            s.view.currentTurnPlayerId === guestId,
        );
        fishForAWindow(guest, theirs.view!);
        await waitForSnapshot(guest, "the guest's turn to land", (s) => !s.busy);
        continue;
      }

      fishForAWindow(host, view);
      const landed = await waitForSnapshot(host, "the host's turn to land", (s) => !s.busy);
      if (landed.view!.you.slapdownEligible) return [host, guest];
    }
    throw new Error("no slapdown window ever opened");
  }

  it("tells the player whose window it is, and nobody else", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await playToAnOpenWindow(server);

      assert.equal(
        host.getSnapshot().view!.you.slapdownEligible,
        true,
        "the window is on the position the screen reads",
      );
      const seenByGuest = guest.getSnapshot().view!;
      assert.equal(seenByGuest.you.slapdownEligible, false);
      assert.ok(
        !JSON.stringify(seenByGuest).includes('"slapdownEligible":true'),
        "an open window leaked into the other player's position",
      );
    } finally {
      await server.close();
    }
  });

  it("puts the drawn card back down without taking a turn", async () => {
    const server = await startServer(7);
    try {
      const [host] = await playToAnOpenWindow(server);
      const before = host.getSnapshot().view!;

      host.slapDown();
      assert.equal(
        host.getSnapshot().busy,
        true,
        "the target went dead the instant it was tapped, not on the ack",
      );

      const landed = await waitForSnapshot(host, "the slap to land", (s) => !s.busy);
      const after = landed.view!;
      assert.equal(landed.error, null);
      assert.equal(after.you.hand.length, before.you.hand.length - 1, "a card lighter");
      assert.equal(
        after.lastDiscard.length,
        before.lastDiscard.length + 1,
        "and it joined the set it matches",
      );
      assert.equal(
        after.currentTurnPlayerId,
        before.currentTurnPlayerId,
        "a slapdown is not a turn",
      );
      assert.equal(after.you.slapdownEligible, false, "the window closed behind it");
    } finally {
      await server.close();
    }
  });

  it("sends one slap however many times the pile is tapped", async () => {
    const server = await startServer(7);
    try {
      const [host] = await playToAnOpenWindow(server);
      const before = host.getSnapshot().view!;

      host.slapDown();
      host.slapDown();
      host.slapDown();

      const landed = await waitForSnapshot(host, "the slap to land", (s) => !s.busy);
      assert.equal(landed.error, null, "a second slap would have been refused");
      assert.equal(landed.view!.you.hand.length, before.you.hand.length - 1);
    } finally {
      await server.close();
    }
  });

  /**
   * Both events in flight with nothing arbitrating them but the order the server takes
   * them in (ADR-0005). Whichever way it falls, the player is left with one whole
   * outcome — a card lighter, or told why not — and never half of each.
   */
  it("resolves a race with the next player one way or the other", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await playToAnOpenWindow(server);
      const before = host.getSnapshot().view!;

      // Sent from the position the host is still holding: the broadcast that closes the
      // window has not reached them, which is exactly when a real thumb loses this race.
      fishForAWindow(guest, guest.getSnapshot().view!);
      host.slapDown();

      /*
       * Waited on by outcome rather than by the lock, because off turn the lock lets go
       * on whatever position arrives first — which in the losing case is the guest's
       * turn, a beat before the refusal that answers the slap.
       */
      const landed = await waitForSnapshot(
        host,
        "the race to settle",
        (s) =>
          !s.busy &&
          (s.error !== null || s.view!.you.hand.length === before.you.hand.length - 1),
      );
      if (landed.error === null) {
        assert.equal(landed.view!.you.hand.length, before.you.hand.length - 1);
      } else {
        assert.equal(landed.error.code, "SLAPDOWN_NOT_AVAILABLE");
        assert.equal(
          landed.view!.you.hand.length,
          before.you.hand.length,
          "a refused slap left them holding what they had",
        );
      }
    } finally {
      await server.close();
    }
  });

  it("never sends a slap when there is no window", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);

      host.slapDown();

      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = host.getSnapshot();
      assert.equal(settled.busy, false, "nothing was sent, so nothing is locked");
      assert.equal(settled.error, null, "and nothing was refused, so there is nothing to say");
    } finally {
      await server.close();
    }
  });
});

describe("watching the bots play", () => {
  /**
   * Every position the session has published, in order and without repeats — a screen's
   * whole experience of a chain. Snapshots change for reasons other than a new position
   * (a card chosen, the controls locking), so identity is what says a move was drawn.
   */
  function positionsShownTo(session: Session): PlayerGameView[] {
    let drawn = session.getSnapshot().view;
    const shown: PlayerGameView[] = [];
    session.subscribe(() => {
      const { view } = session.getSnapshot();
      if (view !== null && view !== drawn) shown.push(view);
      drawn = view;
    });
    return shown;
  }

  it("shows a run of bot turns one move at a time", async () => {
    const server = await startServer(7);
    try {
      const clock = testClock();
      const host = await soloMatch(server, clock);
      const ours = host.getSnapshot().view!;

      // From here the test owns time, so nothing moves except when it says so.
      clock.hold();
      const shown = positionsShownTo(host);

      takeATurn(host, ours);
      await waitForSnapshot(host, "our own move", (s) => s.view !== ours);

      // Our own move is on screen before the bots have finished arriving, which is the
      // point of it going straight through: a player's own play never waits on a queue.
      assert.equal(shown.length, 1, "shown at once, with no beat asked for first");
      assert.equal(host.getSnapshot().busy, false, "and the controls came straight back");

      // The rest of the chain lands within milliseconds — the server paces nothing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        shown.length,
        1,
        "the bots' moves are waiting, not drawn over each other on arrival",
      );

      for (let beat = 0; clock.pending() > 0; beat++) {
        assert.ok(beat < 20, "the chain should have played out long before this");
        const before = shown.length;
        clock.tick();
        assert.ok(shown.length - before <= 1, "a beat is one move, never a jump");
      }

      // Our move and one per bot seat behind it. An early Yaniv would cut the chain short
      // and this is not the seed for that — the number is what "five bot turns read as
      // five moves" means when it is counted.
      assert.equal(shown.length, MAX_PLAYERS, "one position drawn per move, and no more");
      assert.deepEqual(
        shown[shown.length - 1],
        host.getSnapshot().view,
        "and the chain ends on the position the server actually left the table in",
      );

      // What each bot discarded was on the table while its move was being shown. Card ids
      // are unique within a round, so a repeated face-up discard would mean a move whose
      // own discard was never drawn.
      const discards = shown
        .filter((view) => view.phase === "playing")
        .map((view) => view.lastDiscard.map((card) => card.id).join(" "));
      assert.equal(
        new Set(discards).size,
        discards.length,
        "every move was watched with its own discard face up",
      );
    } finally {
      await server.close();
    }
  });

  it("drops what a closed room still had left to show", async () => {
    const server = await startServer(7);
    try {
      const [host, roomCode] = await hostARoom(server, "Ada");

      const clock = testClock();
      clock.hold();
      const guest = await server.openSession(clock);
      guest.joinRoom(roomCode, "Grace");
      await seated(guest, "the guest");

      // Two more players arrive while the first position is still on the guest's screen,
      // so there are seats filled that they have not been shown yet. Any burst queues —
      // a lobby filling up is the one that needs no match under way to arrange.
      for (const name of ["Alan", "Edsger"]) {
        const other = await server.openSession();
        other.joinRoom(roomCode, name);
        await seated(other, name);
      }
      assert.equal(
        guest.getSnapshot().view!.opponents.length,
        1,
        "the guest is a position or two behind, so there is something waiting",
      );

      host.exitToMenu();

      // What was waiting is a room that no longer exists. Drawing it a beat later would
      // put the guest back in a lobby they have already been told is gone.
      const closed = await waitForSnapshot(guest, "the room closing", (s) => s.view === null);
      assert.match(closed.notice ?? "", /host/);
      assert.equal(clock.pending(), 0, "the beat stopped with the room");
      assert.equal(guest.getSnapshot().view, null, "and nothing was drawn behind it");
    } finally {
      await server.close();
    }
  });
});

describe("calling Yaniv", () => {
  it("ends the round and turns every hand face up", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      await playUntilCallable(host);

      host.callYaniv();
      assert.equal(host.getSnapshot().busy, true, "locked the instant the call went out");

      const scored = await waitForSnapshot(host, "the round to be scored", (s) => !s.busy);

      // The same timing the lock on a turn is about: the server acks the call before it
      // broadcasts the scored round, so a lock released on the ack would let go over a
      // position still showing a round in progress.
      assert.equal(scored.view!.phase, "roundEnd", "released on the scored round, not the ack");
      assert.equal(scored.error, null);

      const result = scored.view!.roundResult;
      assert.ok(result, "a finished round comes with the round it finished");
      assert.equal(result.callerId, scored.view!.you.id, "this seat called it");
      assert.equal(result.players.length, MAX_PLAYERS, "every seat is accounted for");
      assert.ok(
        result.players.every((p) => p.hand.length > 0),
        "every hand is face up, which is what makes the call checkable",
      );

      const you = result.players.find((p) => p.playerId === scored.view!.you.id)!;
      assert.equal(
        you.scoreAfter,
        scored.view!.you.score,
        "the round's points and the score they made are the same story",
      );
    } finally {
      await server.close();
    }
  });

  it("never calls Yaniv on a hand the rules do not permit it on", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      const hand = host.getSnapshot().view!.you.hand;
      assert.equal(isLegalCall(hand), false, "five dealt cards are worth more than the threshold");

      // A control that is inert should send nothing when it is tapped anyway, and say
      // nothing either: nothing was asked for, so nothing was refused.
      host.callYaniv();

      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = host.getSnapshot();
      assert.equal(settled.busy, false, "nothing was sent, so nothing is locked");
      assert.equal(settled.error, null);
      assert.equal(settled.view!.phase, "playing", "the round is still being played");
      assert.equal(settled.view!.currentTurnPlayerId, settled.view!.you.id, "the turn is still theirs");
    } finally {
      await server.close();
    }
  });

  it("leaves nothing chosen behind on the round that ended", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      const ready = await playUntilCallable(host);

      // Choosing cards and then calling instead is an ordinary way to change your mind,
      // and what it leaves behind matters: a card id is the same string every round (the
      // deck is rebuilt, not shuffled on), so a choice carried across a deal would come
      // back highlighted over whatever card inherited its id.
      host.toggleCard(ready.view!.you.hand[0]!.id);
      host.callYaniv();

      const scored = await waitForSnapshot(
        host,
        "the scored round",
        (s) => s.view?.phase === "roundEnd" && !s.busy,
      );
      assert.deepEqual(scored.selection, [], "a scored round has no move to make from it");
    } finally {
      await server.close();
    }
  });

  it("deals the next round when the host asks for it", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      await playUntilCallable(host);
      host.callYaniv();
      await waitForSnapshot(
        host,
        "the scored round",
        (s) => s.view?.phase === "roundEnd" && !s.busy,
      );

      host.startNextRound();

      const dealt = await waitForSnapshot(
        host,
        "the next round",
        (s) => s.view?.phase === "playing",
      );
      assert.equal(dealt.view!.roundNumber, 2);
      assert.equal(dealt.view!.you.hand.length, HAND_SIZE, "a fresh hand, not the scored one");
      assert.equal(dealt.view!.roundResult, null, "the last round's hands are off the table");
    } finally {
      await server.close();
    }
  });
});

describe("a finished match", () => {
  it("stops on a position that says who won", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const over = await playToMatchEnd([host]);

      const view = over.view!;
      assert.equal(view.phase, "gameEnd");
      assert.ok(view.winnerIds, "a finished match names its winners");
      assert.ok(view.winnerIds.length >= 1, "and a tie names all of them");
      assert.ok(
        [view.you, ...view.opponents].some((p) => p.score > MAX_SCORE),
        "somebody busted past the maximum, which is what ended it",
      );
      assert.equal(over.busy, false, "and the standings are a screen to act from");
    } finally {
      await server.close();
    }
  });

  it("deals another match for the same table when the host asks", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const over = await playToMatchEnd([host]);
      const table = over.view!.opponents.map((o) => o.id);

      host.playAgain();

      const dealt = await waitForSnapshot(
        host,
        "another match",
        (s) => s.view?.phase === "playing",
      );
      assert.equal(dealt.error, null);
      assert.equal(dealt.view!.roundNumber, 1, "a fresh match, not the next round of the old one");
      assert.equal(dealt.view!.you.score, 0, "and everybody starts level again");
      assert.equal(dealt.view!.you.hand.length, HAND_SIZE);
      assert.equal(dealt.view!.roundResult, null, "the match that ended is off the table");
      assert.deepEqual(
        dealt.view!.opponents.map((o) => o.id),
        table,
        "the same table, without the code being read out again",
      );
    } finally {
      await server.close();
    }
  });

  it("refuses a guest's play again and leaves the standings where they were", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);
      host.startGame();
      await playToMatchEnd([host, guest]);

      guest.playAgain();

      // Whether the control is offered is the screen's business; whether another match is
      // dealt is the server's, exactly as it is in the lobby.
      const refused = await waitForSnapshot(guest, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "NOT_HOST");
      assert.equal(refused.view!.phase, "gameEnd", "still looking at how it finished");
      assert.equal(host.getSnapshot().view!.phase, "gameEnd", "on the host's screen too");
    } finally {
      await server.close();
    }
  });

  it("still names a player who left after the match ended", async () => {
    const server = await startServer(7);
    try {
      const [host, guest] = await hostAndGuest(server);
      host.startGame();
      await playToMatchEnd([host, guest]);
      const guestId = guest.getSnapshot().view!.you.id;

      guest.exitToMenu();

      const gone = await waitForSnapshot(guest, "the guest's menu", (s) => s.view === null);
      assert.equal(gone.error, null, "leaving a finished match is not a failure");

      const shrunk = await waitForSnapshot(
        host,
        "the roster to shrink",
        (s) => !s.view!.opponents.some((o) => o.id === guestId),
      );
      assert.equal(shrunk.view!.phase, "gameEnd", "the match is still over and still on screen");

      // The seat is gone but the match they played is not, and the round that ended it
      // carries their name — which is the whole of what the standings need to keep listing
      // them, winner's mark and all.
      const departed = shrunk.view!.roundResult!.players.find((p) => p.playerId === guestId);
      assert.ok(departed, "the round result names its own players");
      assert.ok(departed.name.length > 0);
    } finally {
      await server.close();
    }
  });

  it("leaves the room from the standings without dropping the connection", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      await playToMatchEnd([host]);

      host.exitToMenu();

      const menu = await waitForSnapshot(host, "the main menu", (s) => s.view === null);
      assert.equal(menu.error, null);

      // Straight into another room, which is what makes this an exit rather than a
      // disconnect — a connection still bound to the finished match would be told
      // ALREADY_IN_ROOM.
      host.createRoom("Ada");
      const another = await waitForSnapshot(host, "a room of their own", (s) => s.view !== null);
      assert.equal(another.error, null);
      assert.equal(another.view!.phase, "lobby");
    } finally {
      await server.close();
    }
  });
});

/**
 * The ways a session goes wrong, and what a player is told about each.
 *
 * A dropped connection is the one that matters most on a phone: the tab is backgrounded,
 * the socket is torn down with no chance to react, and the room goes with it (ADR-0004).
 * Nothing on the screen would say so, and every control on the table would still look
 * live, which is the state this covers.
 */
describe("when the connection goes", () => {
  it("says so when the connection drops", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      assert.equal(host.getSnapshot().connected, true, "the table was being played on");

      server.drop(host);

      const gone = await waitForSnapshot(host, "the drop", (s) => !s.connected);
      assert.equal(gone.busy, false, "nothing is in flight over a socket that is not there");
    } finally {
      await server.close();
    }
  });

  it("does not leave the controls locked when a move's connection drops", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const view = host.getSnapshot().view!;

      // A turn on its way out when the socket goes: the ack that would have released the
      // lock is never coming, and neither is the position behind it.
      takeATurn(host, view);
      assert.equal(host.getSnapshot().busy, true, "the move is in flight");

      server.drop(host);

      const gone = await waitForSnapshot(host, "the drop", (s) => !s.connected);
      assert.equal(gone.busy, false);
    } finally {
      await server.close();
    }
  });

  it("returns to the main menu, saying why, when the connection comes back", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);

      // The transport closed underneath the client rather than hung up, so socket.io
      // reconnects by itself — the flaky-network case, and the only one that comes back.
      server.drop(host, true);
      await waitForSnapshot(host, "the drop", (s) => !s.connected);

      const back = await waitForSnapshot(host, "the connection", (s) => s.connected);
      assert.equal(
        back.view,
        null,
        "the room did not survive the drop, so there is no table to return to",
      );
      assert.ok(back.notice, "and the player is told where it went");
      assert.equal(back.error, null, "which is news, not a refusal of anything they did");
      assert.deepEqual(back.selection, [], "nothing chosen carries into a room that is gone");

      // A working connection, not merely a hopeful screen: the proof is a room on it.
      host.createRoom("Ada");
      const another = await waitForSnapshot(host, "a fresh room", (s) => s.view !== null);
      assert.equal(another.view!.phase, "lobby");
      assert.equal(another.notice, null, "and the news goes when they act again");
    } finally {
      await server.close();
    }
  });

  it("says so when there is no server to reach", async () => {
    // A port nothing is listening on: the page opened with the server down, or with no
    // signal at all. Never connected rather than disconnected, and the same dead screen
    // from the player's side — taps buffered into a socket that has reached nothing.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const client = connectClient(`http://localhost:${port}`, { ...CONNECTION });
    try {
      const session = createSession(client, testClock());

      const nothing = await waitForSnapshot(session, "the failure", (s) => !s.connected);
      assert.equal(nothing.view, null, "there was never a room to be in");
      assert.equal(nothing.notice, null, "and so nothing was lost to say anything about");
    } finally {
      client.disconnect();
    }
  });

  it("shows an error the server sends unprompted", async () => {
    const server = await startServer(7);
    try {
      const host = await soloMatch(server);
      const pushed: GameError = { code: "WRONG_PHASE", message: "Something went wrong" };

      server.announce(pushed);

      const told = await waitForSnapshot(host, "the error", (s) => s.error !== null);
      assert.deepEqual(told.error, pushed);
      assert.equal(told.view!.phase, "playing", "the table is still there to show it on");
    } finally {
      await server.close();
    }
  });

  it("does not push an error at a player with no room to be in", async () => {
    const server = await startServer(7);
    try {
      const menu = await server.openSession();

      // The same rule a rejected ack goes by: an error with no room to be about is one
      // nothing on the main menu can explain, and nothing there can act on.
      server.announce({ code: "WRONG_PHASE", message: "Something went wrong" });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(menu.getSnapshot().error, null);
    } finally {
      await server.close();
    }
  });
});
