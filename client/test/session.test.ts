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
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS,
  MAX_SCORE,
  YANIV_THRESHOLD,
  handValue,
  isValidSet,
  legalDiscards,
  pickupCandidates,
  type GameError,
  type PlayerGameView,
  type ResumeRequest,
  type RoomSettings,
} from "@yaniv/shared";
import { systemClock } from "@yaniv/server/src/clock.ts";
import { createMemoryProfileStore } from "@yaniv/server/src/profiles.ts";
import { RoomManager } from "@yaniv/server/src/roomManager.ts";
import { mulberry32 } from "@yaniv/server/src/rng.ts";
import { createSocketServer } from "@yaniv/server/src/socketServer.ts";
import { fakeVerifier } from "@yaniv/server/test/auth/verifier.ts";
import { SESSION_TOKEN_MARK, markedSessionTokens } from "@yaniv/server/test/helpers.ts";
import {
  io as connectClient,
  type ManagerOptions,
  type Socket as ClientSocket,
  type SocketOptions,
} from "socket.io-client";
import type { Announcement } from "../src/announcement.ts";
import type { CardFlight } from "../src/flight.ts";
import {
  createSession,
  type AccountStore,
  type Session,
  type SessionOptions,
  type SessionSnapshot,
  type TokenStore,
} from "../src/session.ts";
import { isLegalCall } from "../src/turn.ts";
import { playingSelf, slapdownOpen } from "./helpers.ts";

/**
 * Somewhere to keep a seat's credential, standing in for whatever the browser will use.
 *
 * The store is injected precisely so that this suite can hold it in a variable, read what
 * was put there, and hand the same one to a second session the way a reload hands
 * `localStorage` back to a fresh page — with no browser anywhere in it. What the browser's
 * own store does with a seat is `tokens.test.ts`'s question, not this one's.
 */
function fakeTokens(seat: ResumeRequest | null = null) {
  let held = seat;
  const store: TokenStore = {
    get: () => held,
    set: (next) => {
      held = next;
    },
    clear: () => {
      held = null;
    },
  };
  return { store, stored: () => held };
}

/** The same, for the session token: `fakeTokens`' reasoning, one key over. */
function fakeAccount(sessionToken: string | null = null) {
  let held = sessionToken;
  const store: AccountStore = {
    get: () => held,
    set: (next) => {
      held = next;
    },
    clear: () => {
      held = null;
    },
  };
  return { store, stored: () => held };
}

/**
 * Google, as far as the session core reaches for it: the one call sign-out makes so Google
 * does not sign the player straight back in (docs/adr/0020). Counted, since that it was
 * made is the whole of what can be asserted about it without a browser.
 */
function fakeGoogle() {
  let disabled = 0;
  return {
    google: { disableAutoSelect: () => void disabled++ },
    disabled: () => disabled,
  };
}

interface Harness {
  /**
   * A session on its own connection — one per player, as in a browser tab each.
   *
   * The store is optional for the same reason it is optional in `main.tsx`: a session that
   * keeps nothing behaves exactly as one did before there was anything to keep.
   */
  openSession: (options?: SessionOptions) => Promise<Session>;
  /**
   * A session opened the way a page load opens one — built on a socket that has not
   * connected yet, rather than waited for.
   *
   * That is the whole of what "cold boot" means here, and it is a different path through
   * the session core from `openSession`: a claim made before there is a socket to make it
   * on has to wait for one.
   */
  bootSession: (options: SessionOptions) => Session;
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
  /**
   * Make `idToken` a Google ID token this server's verifier accepts, as the identity
   * named. Every other string is one Google did not vouch for. The real verifier is the
   * one thing no test can reach (docs/adr/0020), so the suite says outright who Google
   * would have vouched for.
   */
  vouchFor: (idToken: string, identity: { sub: string; name?: string | null }) => void;
  /**
   * Set the server's idea of *now* this far from real time — how a session is let lapse
   * without a month of waiting. It is issued in the past rather than judged in the future,
   * because the store judges expiry against wall time (`profiles.ts`), and only the
   * issuing reads this clock. Every timer still runs in real time, which is what the rest
   * of the suite is written against.
   */
  skewClock: (ms: number) => void;
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
async function startServer(
  seed: number,
  botCount = MAX_PLAYERS - 1,
): Promise<Harness> {
  const httpServer = createServer();
  const verifier = fakeVerifier();
  let skew = 0;
  const io = createSocketServer(
    httpServer,
    new RoomManager({
      rng: mulberry32(seed),
      newRoomRng: () => mulberry32(seed + 1),
      // Fills the table, which is what `startGame` did unconditionally until `botCount`
      // became a room setting defaulting to zero (docs/adr/0006). No wire event raises
      // it yet, so this keeps the tables the size these tests were written against.
      defaultSettings: { botCount },
    }),
    // The store the server is composed with (docs/adr/0019): the in-memory one, which is
    // what needs nothing installed, and is where the accounts below are kept.
    createMemoryProfileStore(),
    {
      // Bot think time off. This suite is about a client, and a bot pausing before every
      // turn would cost it real seconds per fished window without telling it anything
      // new — the pause is the server's, and is asserted at the server's own seam.
      thinkTimeMs: 0,
      verifier,
      // Marked, so a snapshot can be swept for one: a token nobody can name is a token
      // nobody can prove stayed off the screen.
      newSessionToken: markedSessionTokens(),
      clock: { after: systemClock.after, now: () => Date.now() + skew },
    },
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
    openSession: (options) =>
      new Promise((resolve) => {
        const client = connectClient(`http://localhost:${port}`, { ...CONNECTION });
        // `once`, because a connection that comes back fires this again — and a second
        // session on the same socket would double every handler the first one attached.
        client.once("connect", () => {
          const session = createSession(client, options);
          connections.set(session, client);
          resolve(session);
        });
      }),
    bootSession: (options) => {
      const client = connectClient(`http://localhost:${port}`, { ...CONNECTION });
      const session = createSession(client, options);
      connections.set(session, client);
      return session;
    },
    drop: (session, keepTrying = false) => {
      const client = connections.get(session);
      if (!client) throw new Error("that session was never opened here");
      if (keepTrying) client.io.engine.close();
      else client.disconnect();
    },
    announce: (error) => io.emit("errorMessage", error),
    vouchFor: verifier.vouchFor,
    skewClock: (ms) => {
      skew = ms;
    },
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
 *
 * `maxScore` is the one setting a test may name, and it is sent through the lobby's own
 * event as a host would send it, so the room plays to a limit it was actually told rather
 * than one a fixture reached in and set. Omitted, the room plays to the default.
 */
async function soloMatch(server: Harness, maxScore?: number): Promise<Session> {
  const [host] = await hostARoom(server, "Ada");
  if (maxScore !== undefined) {
    host.updateSettings({
      handSize: HAND_SIZE,
      yanivThreshold: YANIV_THRESHOLD,
      maxScore,
      botCount: MAX_PLAYERS - 1,
    });
    await waitForSnapshot(
      host,
      "the room to be playing to that score",
      (s) => s.view?.settings.maxScore === maxScore && !s.busy,
    );
  }

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
 * This one is a deal where the human seat gets there. Nothing else about it is special, and
 * `playUntilCallable` says so out loud if it ever stops being true.
 */
const HUMAN_CALLS_FIRST = 15;

/** Worth taking face up rather than gambling on the deck, for the driver below. */
const CHEAP_PICKUP = 3;

/** Whatever is pending, un-tapped — a player changing their mind before they play. */
function untapAll(session: Session): void {
  for (const cardId of session.getSnapshot().selection) session.toggleCard(cardId);
}

/**
 * One turn, taken through the intents a pair of taps would go through.
 *
 * The policy is: shed the most valuable set the rules allow, and take a face-up card only
 * when it is cheap enough to be worth having. That is roughly what the bots do, which is
 * the point — a seat playing worse than they do never gets to call at all. It reads the
 * rulebook for what is legal, exactly as the client does, and decides for itself what is
 * wise; there is no import from `bot.ts` here, and a smarter bot must not quietly change
 * what this drives.
 *
 * It starts from an empty selection rather than assuming one: a seat may have tapped a
 * card while waiting for its turn to come round, and this turn is the one being played
 * now rather than that one composed onto it.
 */
function takeATurn(session: Session, view: PlayerGameView): void {
  untapAll(session);
  const heaviest = legalDiscards(playingSelf(view).hand).sort(
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
    if (isLegalCall(playingSelf(view).hand, view.settings.yanivThreshold)) return resting;

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
 * Play the match on, however many humans are at the table, until the position they are all
 * looking at is the one being played towards.
 *
 * Driven entirely off published snapshots — the same surface a screen reads — because
 * nothing else tells a client whose move it is. Each pass looks at every session, acts for
 * whichever one the position is waiting on, and otherwise sleeps until something is
 * published. Deciding from the snapshots as they stand, rather than waiting on any one
 * connection to reach an expected position, is what keeps it right when two sockets are
 * told about a move in different orders.
 *
 * Every seat calls Yaniv the instant its hand allows it, which is what the bots do and what
 * gets a match to 100 quickly. Each next round is dealt by whichever seat here is still in
 * the match, since only such a seat may (docs/adr/0012) — and the seat that made the room
 * is not always one of them.
 *
 * `reached` is asked of every session's snapshot at once rather than one connection's,
 * because "the table has come to rest here" is a fact about all of them: whoever called the
 * last Yaniv is still locked until the position reaches them, and a driver that acted on
 * their behalf a moment earlier would be sending into that lock.
 */
async function playOn(
  sessions: Session[],
  what: string,
  reached: (seen: SessionSnapshot[]) => boolean,
): Promise<SessionSnapshot[]> {
  /**
   * How many passes a match is given before the driver gives up. Generous rather than
   * tuned: a pass is one look at the table and most of them are spent waiting on a move
   * somebody else is making, so this is nowhere near a count of turns — it is here to fail
   * a driver that has stopped making progress rather than to bound a match.
   */
  const PASSES = 2000;
  /** The round already asked to be dealt past — the ack for it lands before the deal does. */
  let dealtFrom = -1;

  for (let step = 0; step < PASSES; step++) {
    const seen = sessions.map((s) => s.getSnapshot());
    if (reached(seen)) return seen;

    const turn = seen.findIndex(
      ({ view, busy }) =>
        !busy && view?.phase === "playing" && view.currentTurnPlayerId === view.you.id,
    );
    if (turn !== -1) {
      const mover = sessions[turn]!;
      const view = seen[turn]!.view!;
      if (isLegalCall(playingSelf(view).hand, view.settings.yanivThreshold)) mover.callYaniv();
      else takeATurn(mover, view);
      continue;
    }

    const dealer = seen.findIndex(
      ({ view, busy }) =>
        !busy &&
        view?.phase === "roundEnd" &&
        view.you.outInRound === null &&
        view.roundNumber !== dealtFrom,
    );
    if (dealer !== -1) {
      dealtFrom = seen[dealer]!.view!.roundNumber;
      sessions[dealer]!.startNextRound();
      continue;
    }

    await anyPublication(sessions);
  }
  throw new Error(`the match never reached ${what} in ${PASSES} passes`);
}

/** Play a whole match out and stop on the standings, as the host sees them. */
async function playToMatchEnd(sessions: Session[]): Promise<SessionSnapshot> {
  const seen = await playOn(sessions, "the standings", (all) =>
    all.every((s) => s.view?.phase === "gameEnd" && !s.busy),
  );
  return seen[0]!;
}

describe("the session core", () => {
  it("creates a room and shows its code", async () => {
    const server = await startServer(26);
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
    const server = await startServer(26);
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
    const server = await startServer(26);
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
    const server = await startServer(26);
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

  it("refuses an unusable name without asking the server", async () => {
    const server = await startServer(26);
    try {
      const session = await server.openSession();

      // Both ways a name can fail the shared rule, refused by the same check (ADR-0002):
      // a name the server would turn away costs no round trip to be turned away here.
      for (const unusable of ["   ", "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)]) {
        session.createRoom(unusable);

        // Asserted without awaiting anything, which is the proof that nothing was sent:
        // an answer that had come from the server could not be on the snapshot yet.
        const refused = session.getSnapshot();
        assert.equal(refused.error?.code, "INVALID_NAME", `refused ${unusable.length}`);
        assert.equal(refused.busy, false, "nothing is in flight to wait for");
        assert.equal(refused.view, null);
      }

      // And the controls really are free — which also says the server was never asked
      // for a room: a connection it had seated would answer this with ALREADY_IN_ROOM.
      session.createRoom("Ada");
      const created = await waitForSnapshot(session, "the room", (s) => s.view !== null);
      assert.equal(created.view!.you.name, "Ada");
    } finally {
      await server.close();
    }
  });

  it("asks for one room however many times the control is tapped", async () => {
    const server = await startServer(26);
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
    const server = await startServer(26);
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
    const server = await startServer(26);
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
      assert.equal(playingSelf(playing.view!).hand.length, HAND_SIZE, "and the cards are dealt");
      assert.equal(
        playing.view!.settings.yanivThreshold,
        YANIV_THRESHOLD,
        "and the room's settings came with the position",
      );
    } finally {
      await server.close();
    }
  });

  it("seats only as many bots as the room asks for", async () => {
    const server = await startServer(26, 2);
    try {
      const [host] = await hostARoom(server, "Ada");
      host.startGame();

      const playing = await waitForSnapshot(
        host,
        "the match to start",
        (s) => s.view?.phase === "playing",
      );

      assert.equal(playing.view!.opponents.length, 2, "botCount seats, not a full table");
    } finally {
      await server.close();
    }
  });

  it("refuses a start with nobody to play against", async () => {
    const server = await startServer(26, 0);
    try {
      const [host] = await hostARoom(server, "Ada");
      host.startGame();

      const refused = await waitForSnapshot(host, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "NOT_ENOUGH_PLAYERS");
      assert.equal(refused.view!.phase, "lobby", "still waiting in the lobby");
    } finally {
      await server.close();
    }
  });

  it("refuses a guest's start and leaves the lobby where it was", async () => {
    const server = await startServer(26);
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
      assert.equal(playingSelf(host.getSnapshot().view!).hand.length, 0);
    } finally {
      await server.close();
    }
  });

  it("frees only their own seat when a guest exits to the menu", async () => {
    const server = await startServer(26);
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

  /**
   * The host's exit is a seat going, exactly like anyone else's (docs/adr/0012): the room
   * plays on for whoever remains, and the role goes with the roster that arrives behind it.
   */
  it("hands the lobby on when the host exits, leaving the room standing", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await hostAndGuest(server);
      await waitForSnapshot(host, "the table to fill", (s) => s.view?.opponents.length === 1);
      const guestId = guest.getSnapshot().view!.you.id;

      host.exitToMenu();

      const hostGone = await waitForSnapshot(host, "the host's menu", (s) => s.view === null);
      assert.equal(hostGone.error, null);

      const stayed = await waitForSnapshot(
        guest,
        "the roster to shrink",
        (s) => s.view?.opponents.length === 0,
      );
      assert.equal(stayed.view!.phase, "lobby", "the room plays on for whoever remains");
      assert.equal(stayed.view!.hostId, guestId, "and they are now its host");
      assert.equal(stayed.notice, null, "there is no news of a room ending, because none did");
      assert.equal(stayed.error, null, "nothing the guest did was refused");
    } finally {
      await server.close();
    }
  });

  it("does not blame a guest for an action the closing room refused", async () => {
    const server = await startServer(26);
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

  it("lets a player who has left straight into another room", async () => {
    const server = await startServer(26);
    try {
      const [, guest] = await hostAndGuest(server);

      guest.exitToMenu();
      await waitForSnapshot(guest, "the guest's menu", (s) => s.view === null && !s.busy);

      // The menu is a menu, not a dead end: whatever became of the last room, the
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

  /**
   * The seat is forgotten on the way out, whoever is leaving and whatever they were in
   * the middle of: a credential kept for a room this player has got up from would only
   * sit them back down at it on the next page load.
   */
  it("forgets the seat of a player who leaves", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const host = await server.openSession({ seat: tokens.store });
      host.createRoom("Ada");
      await waitForSnapshot(host, "the room", (s) => s.view !== null && !s.busy);
      assert.ok(tokens.stored(), "seated, so there is a seat to claim back");

      host.exitToMenu();
      await waitForSnapshot(host, "the host's menu", (s) => s.view === null && !s.busy);

      assert.equal(tokens.stored(), null, "a seat given up is not one to return to");
    } finally {
      await server.close();
    }
  });

  /**
   * Mid-round is a way out like any other (issue #147): nobody is trapped at a table that
   * has gone quiet. The leaver lands on the menu on the ack alone, exactly as they do from
   * the lobby — the server stops publishing to a connection it has turned out of a room —
   * and the round carries on for whoever stayed, one seat shorter.
   */
  it("leaves a room mid-round, and the round plays on without them", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await twoHumanMatch(server);
      const guestId = guest.getSnapshot().view!.you.id;

      guest.exitToMenu();

      const gone = await waitForSnapshot(guest, "the menu", (s) => s.view === null && !s.busy);
      assert.equal(gone.error, null, "leaving is not something to be refused any more");

      const stayed = await waitForSnapshot(
        host,
        "the seat to be marked as given up",
        (s) => s.view?.opponents.some((o) => o.id === guestId && o.departed) ?? false,
      );
      assert.equal(stayed.view!.phase, "playing", "the round plays on for whoever stayed");
      assert.ok(
        !stayed.view!.turnOrder.includes(guestId),
        "and it is played without the seat that went",
      );
      assert.ok(
        stayed.view!.seating.includes(guestId),
        "which still holds its place at the table",
      );
    } finally {
      await server.close();
    }
  });

  /** The credential goes with the seat mid-round too: leaving means something (#147). */
  it("forgets the seat of a player who leaves mid-round", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const host = await server.openSession({ seat: tokens.store });
      host.createRoom("Ada");
      await waitForSnapshot(host, "the room", (s) => s.view !== null && !s.busy);
      host.startGame();
      await waitForSnapshot(host, "the deal", (s) => s.view?.phase === "playing");
      assert.ok(tokens.stored(), "seated, so there is a seat to claim back");

      host.exitToMenu();
      await waitForSnapshot(host, "the menu", (s) => s.view === null && !s.busy);

      assert.equal(tokens.stored(), null, "a seat given up mid-round is not one to return to");
    } finally {
      await server.close();
    }
  });
});

/**
 * The room's settings, edited from the lobby by whoever owns it.
 *
 * The intent is the session core's whole part in docs/adr/0006 — there is no control that
 * sends it yet, and these drive it exactly as a lobby editor will. What the settings are
 * *for* is asserted elsewhere: `turn.test.ts` covers the threshold reaching the call
 * check, and the server's own suites cover a room actually playing by them.
 */
describe("the room's settings", () => {
  /** Every field moved off its default, so nothing here can pass by coincidence. */
  const RAISED: RoomSettings = {
    handSize: 7,
    yanivThreshold: 11,
    maxScore: 50,
    botCount: 1,
  };

  it("carries the host's edit to every screen in the lobby", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await hostAndGuest(server);

      host.updateSettings(RAISED);
      assert.equal(host.getSnapshot().busy, true, "locked while the edit is in flight");

      // The ack is what releases the controls, and it comes back ahead of the position it
      // produced — so the settled snapshot is still showing the settings that were edited.
      const settled = await waitForSnapshot(host, "the controls", (s) => !s.busy);
      assert.equal(settled.error, null);

      const edited = await waitForSnapshot(
        host,
        "the host's own screen",
        (s) => s.view!.settings.handSize === RAISED.handSize,
      );
      assert.deepEqual(edited.view!.settings, RAISED, "all four fields, at once");

      // The other connection was sitting still and is told anyway, which is what makes
      // this the room's configuration rather than the host's own screen.
      const seen = await waitForSnapshot(
        guest,
        "the guest to be told",
        (s) => s.view!.settings.handSize === RAISED.handSize,
      );
      assert.deepEqual(seen.view!.settings, RAISED);
      assert.equal(seen.error, null, "nothing the guest did, and nothing to refuse");
    } finally {
      await server.close();
    }
  });

  it("deals the hand size the host asked for", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await hostAndGuest(server);

      host.updateSettings(RAISED);
      await waitForSnapshot(host, "the host's edit", (s) => !s.busy);
      host.startGame();

      // The proof the edit was the room's and not a number on a screen: the deal is the
      // first thing that plays by it, and both seats get it.
      for (const [session, who] of [[host, "the host"], [guest, "the guest"]] as const) {
        const dealt = await waitForSnapshot(
          session,
          `${who}'s hand`,
          (s) => s.view!.phase !== "lobby",
        );
        assert.equal(playingSelf(dealt.view!).hand.length, RAISED.handSize);
      }
    } finally {
      await server.close();
    }
  });

  it("refuses a guest's edit and releases the controls on the refusal alone", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await hostAndGuest(server);

      guest.updateSettings(RAISED);

      // Nothing is broadcast behind a refused edit, so this waits on the ack and nothing
      // else — which is the whole of why the intent settles on one.
      const refused = await waitForSnapshot(guest, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "NOT_HOST");
      assert.equal(refused.busy, false, "and the lobby is a screen to act from again");
      assert.equal(
        refused.view!.settings.handSize,
        HAND_SIZE,
        "the room still plays by what its host chose",
      );
      assert.equal(host.getSnapshot().view!.settings.handSize, HAND_SIZE, "on both screens");
    } finally {
      await server.close();
    }
  });

  it("refuses the host's own edit once the match has started", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await hostAndGuest(server);
      host.startGame();
      await waitForSnapshot(
        host,
        "the match to start",
        (s) => s.view!.phase !== "lobby" && !s.busy,
      );

      host.updateSettings(RAISED);

      const refused = await waitForSnapshot(host, "the refusal", (s) => s.error !== null);
      assert.equal(refused.error!.code, "WRONG_PHASE");
      assert.equal(refused.busy, false);
      assert.equal(
        refused.view!.settings.handSize,
        HAND_SIZE,
        "a match plays out under the settings it was dealt under",
      );
      assert.equal(guest.getSnapshot().view!.settings.handSize, HAND_SIZE);
    } finally {
      await server.close();
    }
  });
});

describe("taking a turn", () => {
  it("discards the selection and draws the deck in one action", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const chosen = playingSelf(host.getSnapshot().view!).hand[0]!;

      host.toggleCard(chosen.id);
      assert.deepEqual(host.getSnapshot().selection, [chosen.id], "chosen, not yet sent");

      host.commitTurn({ kind: "deck" });
      assert.equal(host.getSnapshot().busy, true, "locked the instant the turn went out");

      const landed = await waitForSnapshot(host, "the turn to land", (s) => !s.busy);

      // The lock is what proves the *timing*: the server acks a turn before it
      // broadcasts the result, so a lock released on the ack would let go while the
      // last view still showed this card in hand and this player on turn.
      assert.ok(
        !playingSelf(landed.view!).hand.some((c) => c.id === chosen.id),
        "the lock held until a strictly newer position arrived, not merely until the ack",
      );
      assert.equal(landed.error, null);
      assert.deepEqual(landed.selection, [], "the selection went with the turn");
      assert.equal(playingSelf(landed.view!).hand.length, HAND_SIZE, "discarded one, drew one");
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
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const before = host.getSnapshot().view!;
      const wanted = before.lastDiscard[0]!;

      host.toggleCard(playingSelf(before).hand[0]!.id);
      host.commitTurn({ kind: "discard", cardId: wanted.id });

      const landed = await waitForSnapshot(host, "the turn to land", (s) => !s.busy);
      assert.equal(landed.error, null, "the client offered only what the server accepts");
      assert.ok(
        playingSelf(landed.view!).hand.some((c) => c.id === wanted.id),
        "the tapped card was drawn, not one off the deck",
      );
    } finally {
      await server.close();
    }
  });

  it("gives the controls back when a turn is refused", async () => {
    const server = await startServer(26);
    try {
      const [, waiting] = await twoHumanMatch(server);
      const chosen = playingSelf(waiting.getSnapshot().view!).hand[0]!;

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
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const chosen = playingSelf(host.getSnapshot().view!).hand[0]!;
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
    const server = await startServer(26);
    try {
      const [mover, waiting] = await twoHumanMatch(server);
      const chosen = playingSelf(waiting.getSnapshot().view!).hand[0]!;
      waiting.toggleCard(chosen.id);

      const played = playingSelf(mover.getSnapshot().view!).hand[0]!;
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
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const hand = playingSelf(host.getSnapshot().view!).hand;

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
 * Every test here needs two humans. This suite's server is built with bot think time off —
 * so a bot plays as soon as the event loop lets it, and a window opened in front of one is
 * shut before the broadcast announcing it has been drawn. The guest sitting directly behind
 * the host is what holds one open long enough to tap, and with the seating drawn at the
 * deal (docs/rules.md §2) only a table of the two of them promises that.
 */
describe("slapping down", () => {
  /**
   * One fishing turn: shed a card whose rank the hand holds only once, and draw from the
   * deck. Every copy still in hand is a copy that cannot come back off the top, and a
   * joker never opens a window at all, so this is the discard most likely to.
   */
  function fishForAWindow(session: Session, view: PlayerGameView): void {
    const hand = playingSelf(view).hand;
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
   * Only the host's windows count, and the server this is played on seats no bots: the
   * seating is drawn at the deal (docs/rules.md §2), and a table of two is the one where
   * the guest is behind the host whatever the draw.
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
      if (slapdownOpen(landed.view!)) return [host, guest];
    }
    throw new Error("no slapdown window ever opened");
  }

  it("tells the player whose window it is, and nobody else", async () => {
    const server = await startServer(26, 0);
    try {
      const [host, guest] = await playToAnOpenWindow(server);

      assert.equal(
        slapdownOpen(host.getSnapshot().view!),
        true,
        "the window is on the position the screen reads",
      );
      // The guest's view of that same position, which is the one with the turn on them:
      // the one before it is their own move's, and may hold a window of their own.
      const guestId = guest.getSnapshot().view!.you.id;
      const seenByGuest = (
        await waitForSnapshot(
          guest,
          "the guest to see the host's move",
          (s) => s.view?.phase === "playing" && s.view.currentTurnPlayerId === guestId,
        )
      ).view!;
      assert.equal(slapdownOpen(seenByGuest), false);
      assert.ok(
        !JSON.stringify(seenByGuest).includes('"slapdownEligible":true'),
        "an open window leaked into the other player's position",
      );
    } finally {
      await server.close();
    }
  });

  it("puts the drawn card back down without taking a turn", async () => {
    const server = await startServer(26, 0);
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
      assert.equal(playingSelf(after).hand.length, playingSelf(before).hand.length - 1, "a card lighter");
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
      assert.equal(slapdownOpen(after), false, "the window closed behind it");
    } finally {
      await server.close();
    }
  });

  it("sends one slap however many times the pile is tapped", async () => {
    const server = await startServer(26, 0);
    try {
      const [host] = await playToAnOpenWindow(server);
      const before = host.getSnapshot().view!;

      host.slapDown();
      host.slapDown();
      host.slapDown();

      const landed = await waitForSnapshot(host, "the slap to land", (s) => !s.busy);
      assert.equal(landed.error, null, "a second slap would have been refused");
      assert.equal(playingSelf(landed.view!).hand.length, playingSelf(before).hand.length - 1);
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
    const server = await startServer(26, 0);
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
          (s.error !== null || playingSelf(s.view!).hand.length === playingSelf(before).hand.length - 1),
      );
      if (landed.error === null) {
        assert.equal(playingSelf(landed.view!).hand.length, playingSelf(before).hand.length - 1);
      } else {
        assert.equal(landed.error.code, "SLAPDOWN_NOT_AVAILABLE");
        assert.equal(
          playingSelf(landed.view!).hand.length,
          playingSelf(before).hand.length,
          "a refused slap left them holding what they had",
        );
      }
    } finally {
      await server.close();
    }
  });

  it("never sends a slap when there is no window", async () => {
    const server = await startServer(26);
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

/**
 * The move a position was reached by, published for whatever draws the cards flying
 * (issue #69). What counts as one is `flight.ts`'s question and is answered there, against
 * fixtures; these are about the field arriving where a screen would read it, off a real
 * server and a real chain of bot turns.
 */
describe("the move to animate", () => {
  /** Every flight the session published, in order — one per move it had something to show for. */
  function flightsShownTo(session: Session): CardFlight[] {
    const flights: CardFlight[] = [];
    session.subscribe(() => {
      const { flight } = session.getSnapshot();
      if (flight !== null) flights.push(flight);
    });
    return flights;
  }

  it("carries the move a position was reached by", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const chosen = playingSelf(host.getSnapshot().view!).hand[0]!;

      host.toggleCard(chosen.id);
      host.commitTurn({ kind: "deck" });

      const ours = await waitForSnapshot(
        host,
        "our own move to animate",
        (s) => s.flight?.playerId === s.view?.you.id,
      );

      const flight = ours.flight!;
      assert.ok(flight.kind === "turn", "a discard and a draw is a turn");
      assert.deepEqual(
        flight.discarded.map((c) => c.id),
        [chosen.id],
        "the card that left our hand",
      );
      assert.equal(flight.drawSource, "deck");
      assert.ok(flight.drawnCard, "and the card we drew, which is ours to know");
      assert.ok(
        playingSelf(ours.view!).hand.some((c) => c.id === flight.drawnCard!.id),
        "and which the position it arrived with has put in our hand",
      );
    } finally {
      await server.close();
    }
  });

  it("keeps a bot's deck draw as hidden as the server left it", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const flights = flightsShownTo(host);

      takeATurn(host, host.getSnapshot().view!);
      await waitForSnapshot(
        host,
        "the chain to come back round",
        (s) =>
          s.view !== null &&
          !s.busy &&
          (s.view.phase !== "playing" || s.view.currentTurnPlayerId === s.view.you.id),
      );

      // Nothing here re-decides what may be shown — the field is the server's redaction
      // as it arrived (ADR-0007), and this is the wire proving it reaches the animation
      // as a card with no face.
      const theirs = flights.filter((f) => f.playerId !== host.getSnapshot().view!.you.id);
      assert.ok(theirs.length > 0, "a chain of bot moves was watched");
      for (const flight of theirs) {
        // Every move in the chain is a turn: a bot never slaps down (ADR-0005).
        assert.ok(flight.kind === "turn", "a bot's move is a turn");
        if (flight.drawSource === "deck") {
          assert.equal(flight.drawnCard, null, "a bot's deck draw is nobody else's to see");
        } else {
          assert.ok(flight.drawnCard, "a card off the pile was face up before it was taken");
        }
      }
    } finally {
      await server.close();
    }
  });

  it("has nothing to animate when the seat is claimed back", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);

      // A move has to have happened for the returning position to carry one at all.
      takeATurn(host, host.getSnapshot().view!);
      await waitForSnapshot(
        host,
        "the chain to come back round",
        (s) => s.view !== null && !s.busy && s.view.lastMove !== null,
      );

      server.drop(host, true);
      await waitForSnapshot(host, "the drop", (s) => !s.connected);

      const back = await waitForSnapshot(host, "the seat", (s) => s.connected && !s.resuming);
      assert.ok(back.view!.lastMove, "the table has a move standing behind it");
      assert.equal(back.flight, null, "but nobody was there to watch it happen");
    } finally {
      await server.close();
    }
  });

  it("does not carry a move into the next thing published", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);

      takeATurn(host, host.getSnapshot().view!);
      const resting = await waitForSnapshot(
        host,
        "our next turn",
        (s) =>
          s.view !== null &&
          !s.busy &&
          s.view.phase === "playing" &&
          s.view.currentTurnPlayerId === s.view.you.id,
      );

      // A card in flight belongs to the publication that announced the move and to no
      // other, so anything published after it — here, a tap choosing a card — has none.
      host.toggleCard(playingSelf(resting.view!).hand[0]!.id);
      assert.equal(host.getSnapshot().flight, null, "a tap is not a move to animate");
    } finally {
      await server.close();
    }
  });
});

/**
 * The call a scored round arrived on, published for whatever announces it over a seat
 * (issue #156). Which seats and in what order is `announcement.ts`'s question and is
 * answered there, against fixtures; these are about the field arriving where a screen would
 * read it, off a real server — and above all about the paths that must *not* announce.
 */
describe("the call to announce", () => {
  /** Every announcement the session published, with the position it arrived on. */
  function callsHeardBy(session: Session): { announced: Announcement; phase: string }[] {
    const heard: { announced: Announcement; phase: string }[] = [];
    session.subscribe(() => {
      const { announcement, view } = session.getSnapshot();
      if (announcement !== null) heard.push({ announced: announcement, phase: view!.phase });
    });
    return heard;
  }

  it("announces the caller when a round is scored", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      await playUntilCallable(host);

      host.callYaniv();
      const scored = await waitForSnapshot(
        host,
        "the scored round",
        (s) => s.view?.phase === "roundEnd" && !s.busy,
      );

      assert.deepEqual(scored.announcement, [
        { playerId: scored.view!.you.id, call: "yaniv" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("announces it to everybody at the table", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const [onTurn, waiting] = await twoHumanMatch(server);
      const heard = callsHeardBy(waiting);

      // Stopped at the first sight of a scored round, by any of them: the driver deals the
      // next round as soon as a seat is free to ask for one, and a second round scored here
      // would be a second call announced.
      await playOn([onTurn, waiting], "a scored round", (all) =>
        all.some((s) => s.view?.phase === "roundEnd"),
      );
      const scored = await waitForSnapshot(
        waiting,
        "the round as this seat sees it",
        (s) => s.view?.phase === "roundEnd" && !s.busy,
      );

      const row = scored.view!.scorecard.at(-1)!;
      assert.equal(heard.length, 1, "one round was scored, so one call was announced");
      assert.equal(heard[0]!.announced![0]!.call, "yaniv", "the call comes first");
      assert.equal(heard[0]!.announced![0]!.playerId, row.callerId);
      if (row.assaferId !== null) {
        assert.equal(heard[0]!.announced![1]!.call, "assaf", "and the answer to it second");
        assert.equal(heard[0]!.announced![1]!.playerId, row.assaferId);
      } else {
        assert.equal(heard[0]!.announced!.length, 1, "a call that stood is announced alone");
      }
    } finally {
      await server.close();
    }
  });

  it("announces exactly the rounds a match scored, in the order they were scored", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const heard = callsHeardBy(host);
      const over = await playToMatchEnd([host]);

      const rows = over.view!.scorecard;
      assert.ok(rows.length > 1, "a match worth reading the ledger of");
      assert.equal(heard.length, rows.length, "one announcement per scored round, and no more");

      rows.forEach((row, i) => {
        const announced = heard[i]!.announced!;
        assert.equal(announced[0]!.playerId, row.callerId, "the caller, first");
        assert.equal(announced[0]!.call, "yaniv");
        if (row.assaferId === null) {
          assert.equal(announced.length, 1);
        } else {
          assert.equal(announced[1]!.playerId, row.assaferId, "the Assafer, second");
          assert.equal(announced[1]!.call, "assaf");
        }
      });

      // The match-winning call arrives as a `gameEnd`, never as a `roundEnd` — a trigger
      // that named the phase would leave the loudest call of the match unannounced.
      assert.equal(heard.at(-1)!.phase, "gameEnd", "the final call is announced too");
    } finally {
      await server.close();
    }
  });

  it("does not carry a call into the next thing published", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      await playUntilCallable(host);
      host.callYaniv();
      await waitForSnapshot(
        host,
        "the scored round",
        (s) => s.announcement !== null && !s.busy,
      );

      host.startNextRound();
      const dealt = await waitForSnapshot(host, "the next round", (s) => s.view?.phase === "playing");
      assert.equal(dealt.announcement, null, "a deal is not a call to announce");
    } finally {
      await server.close();
    }
  });

  it("does not announce again when somebody else's connection drops", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const [onTurn, waiting] = await twoHumanMatch(server);
      const heard = callsHeardBy(waiting);
      await playOn([onTurn, waiting], "a scored round", (all) =>
        all.some((s) => s.view?.phase === "roundEnd"),
      );
      await waitForSnapshot(waiting, "the scored round", (s) => s.announcement !== null);
      assert.equal(heard.length, 1, "the round was announced once");

      // A drop republishes the room to whoever is left (docs/adr/0013) — the same scored
      // round, arriving again. The scorecard has not grown, so nothing has happened.
      server.drop(onTurn);
      await waitForSnapshot(
        waiting,
        "the seat to go quiet",
        (s) => s.view!.opponents.some((o) => !o.connected),
      );
      assert.equal(heard.length, 1, "and republishing it is not it happening again");
    } finally {
      await server.close();
    }
  });

  it("does not announce a round to a seat that has just been claimed back", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      const host = await soloMatch(server);
      await playUntilCallable(host);
      host.callYaniv();
      await waitForSnapshot(host, "the scored round", (s) => s.announcement !== null);

      server.drop(host, true);
      await waitForSnapshot(host, "the drop", (s) => !s.connected);

      const back = await waitForSnapshot(host, "the seat", (s) => s.connected && !s.resuming);
      assert.equal(back.view!.phase, "roundEnd", "the round is still scored on the table");
      assert.equal(back.announcement, null, "but nobody was there to hear it called");
    } finally {
      await server.close();
    }
  });

  it("announces nothing for a match ended by a departure", async () => {
    const server = await startServer(HUMAN_CALLS_FIRST);
    try {
      // Two humans and no bots, so that one of them leaving leaves one player in the match
      // and ends it — the position this is about, and the one no call was made to reach.
      const [host, guest] = await hostAndGuest(server);
      host.updateSettings({
        handSize: HAND_SIZE,
        yanivThreshold: YANIV_THRESHOLD,
        maxScore: MAX_SCORE,
        botCount: 0,
      });
      await waitForSnapshot(
        host,
        "the table to empty of bots",
        (s) => s.view?.settings.botCount === 0 && !s.busy,
      );
      const heard = callsHeardBy(guest);
      host.startGame();

      await playOn([host, guest], "a scored round", (all) =>
        all.some((s) => s.view?.phase === "roundEnd"),
      );
      await waitForSnapshot(guest, "the scored round", (s) => s.announcement !== null);
      await waitForSnapshot(host, "the caller's own copy of it", (s) => !s.busy);
      assert.equal(heard.length, 1);

      // The last round's result is still standing behind this `gameEnd`, and nobody called
      // anything to reach it (issue #147). A trigger read off that field would invent a call.
      host.exitToMenu();
      const ended = await waitForSnapshot(
        guest,
        "the match to end under them",
        (s) => s.view?.phase === "gameEnd",
      );
      assert.ok(ended.view!.roundResult, "the previous round is still on the table");
      assert.equal(ended.announcement, null, "and it is not announced a second time");
      assert.equal(heard.length, 1, "nothing new was called");
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

  it("draws every position the server sends, as it arrives", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const ours = host.getSnapshot().view!;
      const shown = positionsShownTo(host);

      takeATurn(host, ours);

      // The chain plays out and the turn comes back round to this seat. This suite runs the
      // server with no think time (see `startServer`), so every bot move lands within
      // milliseconds of the last — which is exactly the arrival pattern that would have been
      // queued before issue #135, and is now drawn straight through.
      await waitForSnapshot(
        host,
        "the table coming back to rest",
        (s) => s.view!.currentTurnPlayerId === s.view!.you.id && s.view !== ours && !s.busy,
      );

      // Our move and one per bot seat behind it. An early Yaniv would cut the chain short
      // and this is not the seed for that — the number is what "five bot turns read as five
      // moves" means when it is counted, with nothing dropped for arriving in a burst.
      assert.equal(shown.length, MAX_PLAYERS, "one position drawn per move, and no more");
      assert.deepEqual(
        shown[shown.length - 1],
        host.getSnapshot().view,
        "and the chain ends on the position the server actually left the table in",
      );

      // What each bot discarded was on the table while its move was being drawn. Card ids
      // are unique within a round, so a repeated face-up discard would mean a move whose
      // own discard was never drawn.
      const discards = shown
        .filter((view) => view.phase === "playing")
        .map((view) => view.lastDiscard.map((card) => card.id).join(" "));
      assert.equal(
        new Set(discards).size,
        discards.length,
        "every move was drawn with its own discard face up",
      );
    } finally {
      await server.close();
    }
  });

  it("puts a player's own move on the screen without waiting on anything", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const ours = host.getSnapshot().view!;
      const shown = positionsShownTo(host);

      takeATurn(host, ours);
      await waitForSnapshot(host, "our own move", (s) => s.view !== ours);

      // The first position drawn after a turn is the turn itself, not whatever the bots had
      // made of the table by the time a queue got round to letting it go.
      assert.equal(
        shown[0]!.lastMove?.playerId,
        ours.you.id,
        "the first thing drawn is the player's own move",
      );
      assert.equal(host.getSnapshot().busy, false, "and the controls came straight back");
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
      const view = host.getSnapshot().view!;
      assert.equal(
        isLegalCall(playingSelf(view).hand, view.settings.yanivThreshold),
        false,
        "five dealt cards are worth more than the threshold",
      );

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
      host.toggleCard(playingSelf(ready.view!).hand[0]!.id);
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
      assert.equal(playingSelf(dealt.view!).hand.length, HAND_SIZE, "a fresh hand, not the scored one");
      assert.equal(dealt.view!.roundResult, null, "the last round's hands are off the table");
    } finally {
      await server.close();
    }
  });
});

describe("a finished match", () => {
  it("stops on a position that says who won", async () => {
    const server = await startServer(26);
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
    const server = await startServer(26);
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
      assert.equal(playingSelf(dealt.view!).hand.length, HAND_SIZE);
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

  /**
   * Another match is anyone's to deal, whether or not they made the room and whether or
   * not the last match went on without them (docs/adr/0012). Whether the control is
   * offered is the screen's business; whether a match is dealt is the server's.
   */
  it("deals another match when the player who did not make the room asks", async () => {
    const server = await startServer(26);
    try {
      const [host, guest] = await hostAndGuest(server);
      host.startGame();
      await playToMatchEnd([host, guest]);

      guest.playAgain();

      const dealt = await waitForSnapshot(
        guest,
        "the new match",
        (s) => s.view!.phase === "playing",
      );
      assert.equal(dealt.error, null, "nothing they asked for was refused");
      assert.equal(dealt.view!.roundNumber, 1, "a new match, not another round");

      const other = await waitForSnapshot(
        host,
        "the other player to be dealt in",
        (s) => s.view!.phase === "playing",
      );
      assert.equal(other.view!.roundNumber, 1, "into the same new match, having asked for nothing");
    } finally {
      await server.close();
    }
  });

  it("still names a player who left after the match ended", async () => {
    const server = await startServer(26);
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
        "the seat to be marked as given up",
        (s) => s.view!.opponents.some((o) => o.id === guestId && o.departed),
      );
      assert.equal(shrunk.view!.phase, "gameEnd", "the match is still over and still on screen");

      // The seat is given up but the match they played is not, and the round that ended
      // it carries their name — which is the whole of what the standings need to keep
      // listing them, winner's mark and all.
      const departed = shrunk.view!.roundResult!.players.find((p) => p.playerId === guestId);
      assert.ok(departed, "the round result names its own players");
      assert.ok(departed.name.length > 0);
    } finally {
      await server.close();
    }
  });

  it("leaves the room from the standings without dropping the connection", async () => {
    const server = await startServer(26);
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
 * The seed the match that goes on without somebody is played on.
 *
 * Which seat busts first is the deal's, and this is one where a human does it with another
 * human and a bot or two still playing — the position the suite below is about, and one the
 * seat that made the room may itself be knocked out of. Nothing else about it is special,
 * and `matchGoneOnWithout` says so out loud if it ever stops being true.
 */
const HUMAN_GOES_OUT_FIRST = 2;

/**
 * A maximum score one scored round takes a seat past, with seats left under it.
 *
 * Low enough that a hand still holding five cards busts on the first round — a seat playing
 * to 100 is several rounds from being knocked out of anything — and high enough that the
 * table it leaves is still two or more seats, so the round scores somebody out of a match
 * that goes on rather than ending one. Read against the seed the suite plays on, and the
 * test says so out loud if it stops being true.
 */
const OUT_IN_ONE_ROUND = 20;

/**
 * A match still being played by a table one of its humans is no longer at:
 * [the seat watching, a seat still in it].
 *
 * Which of the two goes out is the deal's business, so it is read off the position rather
 * than assumed — the same way `twoHumanMatch` asks who opens rather than deciding.
 */
async function matchGoneOnWithout(server: Harness): Promise<[Session, Session]> {
  const [host, guest] = await hostAndGuest(server);
  host.startGame();
  const table = [host, guest];

  const watching = (s: SessionSnapshot) => s.view !== null && s.view.you.spectating;
  const stillPlaying = (s: SessionSnapshot) =>
    s.view !== null && !s.view.you.spectating && s.view.you.outInRound === null;

  const seen = await playOn(table, "a seat the match had gone on without", (all) =>
    all.every((s) => !s.busy && s.view?.phase !== "gameEnd") &&
    all.some(watching) &&
    all.some(stillPlaying),
  );

  return [table[seen.findIndex(watching)]!, table[seen.findIndex(stillPlaying)]!];
}

/**
 * What the session core owes a player the match has gone on without (issue #149).
 *
 * The three questions are one question asked at three moments: a seat that has stopped
 * playing holds no hand, so there is nothing pending on it, nothing to send from it, and
 * nothing about coming back to it that turns it back into a seat being played. The client
 * narrows `SelfView` once (issue #143) and the rest is meant to fall out — these are what
 * says it does, over a real server rather than a fixture that could be built spectating and
 * playing at once.
 */
describe("when the match goes on without you", () => {
  it("drops a pending selection when the position arriving has taken its owner out", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server, OUT_IN_ONE_ROUND);

      /*
       * Play on, holding a card tapped between turns, until the round is scored. The tap is
       * made off turn on purpose: that is the only place a selection can be pending when
       * somebody else's move ends the round, and a selection surviving positions arriving
       * underneath it is what it lives in the session core for.
       */
      let chosen: readonly string[] = [];
      for (let move = 0; ; move++) {
        assert.ok(move < 100, "the round was never scored");
        const resting = await waitForSnapshot(
          host,
          "our turn, or the round being scored",
          (s) =>
            s.view !== null &&
            !s.busy &&
            (s.view.phase !== "playing" ||
              s.view.currentTurnPlayerId === s.view.you.id),
        );
        if (resting.view!.phase !== "playing") break;

        takeATurn(host, resting.view!);
        const played = await waitForSnapshot(host, "the move to land", (s) => !s.busy);
        assert.equal(
          played.view!.phase,
          "playing",
          "a turn of our own does not end a round — only a Yaniv call does, and we call none",
        );

        chosen = [playingSelf(played.view!).hand[0]!.id];
        host.toggleCard(chosen[0]!);
        assert.deepEqual(
          host.getSnapshot().selection,
          chosen,
          "a card is chosen, waiting for this seat's turn to come round",
        );
      }

      const scored = host.getSnapshot();

      // What the assertions below are about: the round was ended by somebody else's move
      // with a tap of ours still pending, which the revealed hand is the proof of — the
      // card was there to be chosen when the scored position arrived. Without this the
      // test could pass having had nothing to lose.
      const ours = scored.view!.roundResult!.players.find(
        (p) => p.playerId === scored.view!.you.id,
      )!;
      assert.equal(chosen.length, 1, "a card was tapped while waiting for our turn");
      assert.ok(
        ours.hand.some((card) => card.id === chosen[0]),
        "and was still held when the round was scored, so it was still chosen",
      );
      assert.notEqual(
        scored.view!.you.outInRound,
        null,
        "the round that was scored took this seat out of the match",
      );
      assert.equal(
        scored.view!.phase,
        "roundEnd",
        "and left a match still being played, which is what makes them a watcher of one",
      );
      assert.equal(scored.view!.you.spectating, true);
      assert.deepEqual(
        scored.selection,
        [],
        "so nothing is left chosen for a turn it can no longer take",
      );
    } finally {
      await server.close();
    }
  });

  it("offers a spectator no move, no call and no slapdown", async () => {
    const server = await startServer(HUMAN_GOES_OUT_FIRST);
    try {
      const [watcher, player] = await matchGoneOnWithout(server);

      // Watched from a live round rather than a scored one: a round nobody is playing has
      // no move to withhold, so it would prove nothing.
      player.startNextRound();
      const watching = await waitForSnapshot(
        watcher,
        "the round they are watching",
        (s) => s.view?.phase === "playing" && !s.busy,
      );
      const view = watching.view!;
      assert.equal(view.you.spectating, true);
      assert.equal("hand" in view.you, false, "with no hand to build a turn out of");
      assert.equal(slapdownOpen(view), false, "and no window to slap into");

      // Every intent a table offers, tapped by somebody with nothing to tap with. Each is
      // silence rather than a refusal: `busy` never goes up, so nothing reached the wire.
      watcher.toggleCard(view.lastDiscard[0]!.id);
      watcher.commitTurn({ kind: "deck" });
      watcher.commitTurn({ kind: "discard", cardId: view.lastDiscard[0]!.id });
      watcher.callYaniv();
      watcher.slapDown();

      const after = watcher.getSnapshot();
      assert.deepEqual(after.selection, [], "there is no hand for a choice to be about");
      assert.equal(after.busy, false, "and nothing was sent to be waiting on");
      assert.equal(after.error, null, "so nothing was refused either");
      assert.equal(after.view, view, "the position is exactly where it was");
    } finally {
      await server.close();
    }
  });

  it("sits back down as a spectator when the connection comes back", async () => {
    const server = await startServer(HUMAN_GOES_OUT_FIRST);
    try {
      const [watcher, player] = await matchGoneOnWithout(server);
      const table = watcher.getSnapshot().view!;

      server.drop(watcher, true);
      await waitForSnapshot(watcher, "the drop", (s) => !s.connected);

      const back = await waitForSnapshot(
        watcher,
        "the seat",
        (s) => s.connected && !s.resuming,
      );
      assert.equal(back.view!.roomCode, table.roomCode, "the same table, not the menu");
      assert.equal(back.view!.you.spectating, true, "and the same standing at it");
      assert.equal(back.notice, null, "nothing was lost, so there is nothing to say");
      assert.equal(back.error, null);
      assert.equal(back.busy, false);
      assert.deepEqual(back.selection, [], "and no hand to have anything chosen from");

      // A seat really claimed back rather than a position left on the screen: the proof is
      // the next round arriving on it, which only a socket back in the room is sent.
      player.startNextRound();
      const dealt = await waitForSnapshot(
        watcher,
        "the next round",
        (s) => s.view?.phase === "playing",
      );
      assert.equal(dealt.view!.you.spectating, true, "still watching, a round later");
    } finally {
      await server.close();
    }
  });
});

/**
 * The ways a session goes wrong, and what a player is told about each.
 *
 * A dropped connection is the one that matters most on a phone: the tab is backgrounded and
 * the socket is torn down with no chance to react. Nothing on the screen would say so, and
 * every control on the table would still look live, which is the state this covers — along
 * with the way back out of it, since the seat is held for whoever can produce its
 * credential and the whole point of keeping one is sitting down in it again.
 */
describe("when the connection goes", () => {
  it("says so when the connection drops", async () => {
    const server = await startServer(26);
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
    const server = await startServer(26);
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

  it("sits back down at the same table when the connection comes back", async () => {
    const server = await startServer(26);
    try {
      const host = await soloMatch(server);
      const table = host.getSnapshot().view!;

      // The transport closed underneath the client rather than hung up, so socket.io
      // reconnects by itself — the flaky-network case, and the only one that comes back.
      server.drop(host, true);
      await waitForSnapshot(host, "the drop", (s) => !s.connected);

      const back = await waitForSnapshot(
        host,
        "the seat",
        (s) => s.connected && !s.resuming,
      );
      assert.equal(back.view!.roomCode, table.roomCode, "the same table, not the menu");
      assert.equal(back.view!.phase, "playing");
      assert.equal(back.notice, null, "nothing was lost, so there is nothing to say");
      assert.equal(back.error, null);
      assert.equal(back.busy, false);

      // A seat really claimed back, not merely a position left on the screen: the proof
      // is a move made from it.
      takeATurn(host, back.view!);
      const played = await waitForSnapshot(host, "the move", (s) => !s.busy);
      assert.equal(played.error, null, "the server took the turn from this connection");
    } finally {
      await server.close();
    }
  });

  /**
   * A seat that cannot be had back — the room has gone from the server, or the credential
   * was refused — lands on the main menu with the news and nothing to retry.
   *
   * Driven from a cold boot rather than a reconnect, because there is no longer a way for
   * a room to disappear under a player who is sitting in it (docs/adr/0012): a room ends
   * when its last seat leaves, and that seat is the one leaving. A page opening on a
   * credential for a room the server does not have is the case that remains — a restart,
   * the documented cost of rooms living in memory — and it is the same `claimSeat` a
   * returning connection uses.
   */
  it("returns to the main menu, saying why, when the seat cannot be had back", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      tokens.store.set({
        roomCode: "ZZZZ",
        playerId: "nobody",
        resumeToken: "for a room that is not there",
      });

      const player = await server.openSession({ seat: tokens.store });

      const back = await waitForSnapshot(
        player,
        "the failed claim",
        (s) => s.connected && !s.resuming,
      );
      assert.equal(back.view, null, "there is no table to return to");
      assert.ok(back.notice, "and the player is told so");
      assert.equal(back.error, null, "which is news, not a refusal of anything they did");
      assert.equal(back.busy, false);
      assert.equal(tokens.stored(), null, "the credential goes with the seat");

      // A working connection, not merely a hopeful screen: the proof is a room on it.
      player.createRoom("Grace");
      const another = await waitForSnapshot(player, "a fresh room", (s) => s.view !== null);
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
      const session = createSession(client);

      const nothing = await waitForSnapshot(session, "the failure", (s) => !s.connected);
      assert.equal(nothing.view, null, "there was never a room to be in");
      assert.equal(nothing.notice, null, "and so nothing was lost to say anything about");
    } finally {
      client.disconnect();
    }
  });

  it("stops claiming a seat when there is no server to claim it from", async () => {
    // The same dead port as above, opened on a page that has a seat to ask for. The claim
    // never reaches anybody, so nothing is ever going to answer it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const tokens = fakeTokens({
      roomCode: "ABCD",
      playerId: "a-seat-somewhere",
      resumeToken: "its-token",
    });
    const client = connectClient(`http://localhost:${port}`, { ...CONNECTION });
    try {
      const session = createSession(client, { seat: tokens.store });
      assert.equal(session.getSnapshot().resuming, true, "the claim is owed from the off");

      const nothing = await waitForSnapshot(session, "the failure", (s) => !s.connected);
      assert.equal(nothing.resuming, false, "but nothing has been asked of anybody");
      assert.equal(nothing.busy, false);
      assert.equal(nothing.notice, null, "and no seat has been refused to say so about");
      assert.ok(tokens.stored(), "the seat is still there to ask for when a socket lands");
    } finally {
      client.disconnect();
    }
  });

  it("shows an error the server sends unprompted", async () => {
    const server = await startServer(26);
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
    const server = await startServer(26);
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

  it("claims a stored seat back on a cold boot, before the main menu", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const first = await server.openSession({ seat: tokens.store });
      first.createRoom("Ada");
      const lobby = await waitForSnapshot(
        first,
        "the room",
        (s) => s.view !== null && !s.busy,
      );
      const { roomCode } = lobby.view!;
      assert.equal(tokens.stored()?.roomCode, roomCode, "the seat was written down");

      // The page is reloaded: the socket goes for good and a fresh session comes up on
      // the same store, which is all a new page inherits from the old one.
      server.drop(first);
      const back = server.bootSession({ seat: tokens.store });

      assert.equal(back.getSnapshot().resuming, true, "the claim is under way at once");
      assert.equal(back.getSnapshot().view, null, "with nothing yet to show for it");

      const seat = await waitForSnapshot(back, "the seat", (s) => !s.resuming);
      assert.equal(seat.view!.roomCode, roomCode, "the room it left off in");
      assert.equal(seat.view!.you.name, "Ada", "and the same seat at it");
      assert.equal(seat.busy, false, "with the controls back");
      assert.equal(seat.notice, null);
      assert.equal(seat.error, null);
    } finally {
      await server.close();
    }
  });

  it("forgets a seat it is refused, and says the game has gone", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const first = await server.openSession({ seat: tokens.store });
      first.createRoom("Ada");
      await waitForSnapshot(first, "the room", (s) => s.view !== null && !s.busy);

      // A credential that names a live room and cannot open a seat in it — a token from
      // a room the server has since forgotten, or one that was never this seat's.
      tokens.store.set({ ...tokens.stored()!, resumeToken: "not-that-seat's-token" });
      server.drop(first);

      const back = server.bootSession({ seat: tokens.store });
      const menu = await waitForSnapshot(back, "the refusal", (s) => !s.resuming);

      assert.equal(menu.view, null, "which leaves the main menu");
      assert.ok(menu.notice, "and says why they are looking at it");
      assert.equal(menu.error, null, "news, not a refusal of anything they did");
      assert.equal(menu.busy, false);
      assert.equal(tokens.stored(), null, "a credential that fails is not kept to fail again");
    } finally {
      await server.close();
    }
  });

  it("forgets the seat when the player gives it up", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const session = await server.openSession({ seat: tokens.store });
      session.createRoom("Ada");
      await waitForSnapshot(session, "the room", (s) => s.view !== null && !s.busy);
      assert.ok(tokens.stored(), "seated, so there is a seat to claim back");

      session.exitToMenu();
      await waitForSnapshot(session, "the menu", (s) => s.view === null && !s.busy);

      assert.equal(tokens.stored(), null, "a seat given up is not one to come back to");

      // And not held in memory either, which only a returning connection can show: one
      // that still had the seat would claim it, and be told the seat had gone.
      server.drop(session, true);
      await waitForSnapshot(session, "the drop", (s) => !s.connected);
      const back = await waitForSnapshot(session, "the connection", (s) => s.connected);
      assert.equal(back.notice, null, "nothing was asked for, so nothing was refused");
      assert.equal(back.resuming, false, "and nothing was claimed on the way back");
      assert.equal(back.view, null);
    } finally {
      await server.close();
    }
  });

  /**
   * The credential is written down as the *server* spells the room, not as it was typed,
   * and it is given up when the seat is.
   */
  it("remembers the room as the server spells it, and forgets it on the way out", async () => {
    const server = await startServer(26);
    try {
      const [, roomCode] = await hostARoom(server, "Ada");
      const tokens = fakeTokens();
      const guest = await server.openSession({ seat: tokens.store });
      guest.joinRoom(roomCode.toLowerCase(), "Grace");
      await seated(guest, "the guest");
      assert.equal(
        tokens.stored()?.roomCode,
        roomCode,
        "the room as the server spells it, not as it was typed",
      );

      guest.exitToMenu();
      await waitForSnapshot(guest, "the guest's menu", (s) => s.view === null && !s.busy);

      assert.equal(tokens.stored(), null, "a seat given up is not one to claim back");
    } finally {
      await server.close();
    }
  });
});

/** What every Google ID token this suite presents starts with, so a snapshot can be swept for one. */
const ID_TOKEN_MARK = "id-token-for-";

/**
 * Every snapshot a session publishes from here on, in order — what a screen would have
 * been handed, frame by frame. The sweeps below read the lot rather than the last one,
 * because a credential that was on the screen for one frame was on the screen.
 */
function recordSnapshots(session: Session): SessionSnapshot[] {
  const seen = [session.getSnapshot()];
  session.subscribe(() => seen.push(session.getSnapshot()));
  return seen;
}

/** Whether no snapshot so far carried any trace of either credential. */
function carriesNoCredential(seen: readonly SessionSnapshot[]): boolean {
  return seen.every((snapshot) => {
    const written = JSON.stringify(snapshot);
    return !written.includes(ID_TOKEN_MARK) && !written.includes(SESSION_TOKEN_MARK);
  });
}

/** Settled: nothing in flight and nothing still being claimed back. */
const settled = (session: Session, what: string) =>
  waitForSnapshot(session, what, (s) => !s.busy && !s.resuming);

/**
 * A player who has signed in for the first time and confirmed their name — the account
 * exists on the server, and this session holds the session token that remembers it.
 */
async function signUp(
  server: Harness,
  who: { sub: string; name: string },
  options: SessionOptions = {},
): Promise<Session> {
  const idToken = `${ID_TOKEN_MARK}${who.sub}`;
  server.vouchFor(idToken, { sub: who.sub, name: who.name });
  const session = await server.openSession(options);
  session.signIn(idToken);
  await waitForSnapshot(session, "the name to confirm", (s) => s.account.status === "nameNeeded");
  session.createAccount(who.name);
  await waitForSnapshot(
    session,
    "the account",
    (s) => s.account.status === "signedIn" && !s.busy,
  );
  return session;
}

describe("an account", () => {
  it("starts every session a guest", async () => {
    const server = await startServer(26);
    try {
      const session = await server.openSession();
      assert.deepEqual(session.getSnapshot().account, { status: "guest" });
    } finally {
      await server.close();
    }
  });

  it("asks a new player to confirm the name Google suggested, then signs them in", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const idToken = `${ID_TOKEN_MARK}ada`;
      server.vouchFor(idToken, { sub: "google-ada", name: "Ada Lovelace" });
      const session = await server.openSession({ account: account.store });

      session.signIn(idToken);
      const confirm = await settled(session, "the name to confirm");
      assert.deepEqual(confirm.account, { status: "nameNeeded", suggestedName: "Ada Lovelace" });
      assert.equal(account.stored(), null, "no account exists yet, so there is none to remember");

      session.createAccount("Ada");
      const signedIn = await settled(session, "the account");
      assert.equal(signedIn.account.status, "signedIn");
      assert.equal(
        signedIn.account.status === "signedIn" && signedIn.account.account.displayName,
        "Ada",
      );
      assert.equal(signedIn.error, null);
      assert.ok(account.stored()?.startsWith(SESSION_TOKEN_MARK), "the session is written down");
      assert.equal(signedIn.view, null, "still the main menu: signing in is not a room");
    } finally {
      await server.close();
    }
  });

  it("signs a returning player straight in, with no name to confirm", async () => {
    const server = await startServer(26);
    try {
      await signUp(server, { sub: "google-ada", name: "Ada" });

      const account = fakeAccount();
      const again = await server.openSession({ account: account.store });
      again.signIn(`${ID_TOKEN_MARK}google-ada`);
      const back = await settled(again, "the account");

      assert.equal(back.account.status, "signedIn");
      assert.ok(account.stored(), "and remembered on this page too");
    } finally {
      await server.close();
    }
  });

  it("never puts either credential on the snapshot", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const idToken = `${ID_TOKEN_MARK}ada`;
      server.vouchFor(idToken, { sub: "google-ada", name: "Ada" });
      const session = await server.openSession({ account: account.store });
      const seen = recordSnapshots(session);

      session.signIn(idToken);
      await settled(session, "the name to confirm");
      session.createAccount("Ada");
      await settled(session, "the account");
      session.renameAccount("Countess");
      await waitForSnapshot(
        session,
        "the new name",
        (s) => s.account.status === "signedIn" && s.account.account.displayName === "Countess",
      );
      session.createRoom("");
      await seated(session, "the account");

      // The reload, and everything it resumes.
      const back = server.bootSession({ account: account.store });
      const seenAfter = recordSnapshots(back);
      await settled(back, "the account back");

      assert.ok(account.stored(), "the session was really issued and really held");
      assert.ok(carriesNoCredential(seen), "no frame of the sign-in carried a credential");
      assert.ok(carriesNoCredential(seenAfter), "nor any frame of the resume");
    } finally {
      await server.close();
    }
  });

  it("releases the controls on each account event's own answer", async () => {
    const server = await startServer(26);
    try {
      const idToken = `${ID_TOKEN_MARK}ada`;
      server.vouchFor(idToken, { sub: "google-ada", name: "Ada" });
      const session = await server.openSession();

      // None of these produces a position, so no newer broadcast is coming to wait for:
      // the ack is the only answer there is, and the lock goes with it.
      session.signIn(idToken);
      assert.equal(session.getSnapshot().busy, true, "locked on the way out");
      assert.equal((await settled(session, "signIn's ack")).view, null);

      session.createAccount("Ada");
      assert.equal(session.getSnapshot().busy, true);
      await settled(session, "createAccount's ack");

      session.renameAccount("Countess");
      assert.equal(session.getSnapshot().busy, true);
      await settled(session, "renameAccount's ack");

      session.signOut();
      assert.equal(session.getSnapshot().busy, true);
      const out = await settled(session, "signOut's ack");
      assert.equal(out.error, null);
    } finally {
      await server.close();
    }
  });

  it("sends one sign-in however many times it is asked for", async () => {
    const server = await startServer(26);
    try {
      const idToken = `${ID_TOKEN_MARK}ada`;
      server.vouchFor(idToken, { sub: "google-ada", name: "Ada" });
      const session = await server.openSession();

      session.signIn(idToken);
      session.signIn("a second token, dropped on the locked controls");
      const answer = await settled(session, "the answer");

      assert.equal(answer.account.status, "nameNeeded", "the first was the one sent");
      assert.equal(answer.error, null);
    } finally {
      await server.close();
    }
  });

  it("says so when Google did not vouch for the token, and stays a guest", async () => {
    const server = await startServer(26);
    try {
      const session = await server.openSession();

      session.signIn("a token nobody vouched for");
      const refused = await settled(session, "the refusal");

      assert.equal(refused.error?.code, "INVALID_CREDENTIAL");
      assert.deepEqual(refused.account, { status: "guest" });
    } finally {
      await server.close();
    }
  });

  it("drops a first sign-in the player backs out of, holding nothing from it", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const idToken = `${ID_TOKEN_MARK}ada`;
      server.vouchFor(idToken, { sub: "google-ada", name: "Ada" });
      const session = await server.openSession({ account: account.store });
      session.signIn(idToken);
      await settled(session, "the name to confirm");

      session.cancelSignIn();
      assert.deepEqual(session.getSnapshot().account, { status: "guest" });
      assert.equal(session.getSnapshot().busy, false, "nothing was sent to wait on");

      // The ID token went with it: there is nothing left to confirm a name against.
      session.createAccount("Ada");
      assert.equal(session.getSnapshot().busy, false, "so nothing is sent");
      assert.deepEqual(session.getSnapshot().account, { status: "guest" });
      assert.equal(account.stored(), null);
    } finally {
      await server.close();
    }
  });

  it("refuses an unusable account name without asking the server", async () => {
    const server = await startServer(26);
    try {
      const idToken = `${ID_TOKEN_MARK}ada`;
      server.vouchFor(idToken, { sub: "google-ada", name: "Ada" });
      const session = await server.openSession();
      session.signIn(idToken);
      await settled(session, "the name to confirm");

      session.createAccount("   ");
      const refused = session.getSnapshot();
      assert.equal(refused.error?.code, "INVALID_NAME");
      assert.equal(refused.busy, false, "answered here, with nothing sent");
      assert.equal(refused.account.status, "nameNeeded", "still there to be answered");

      // And the ID token is still held: a better name goes through.
      session.createAccount("Ada");
      const signedIn = await settled(session, "the account");
      assert.equal(signedIn.account.status, "signedIn");
      assert.equal(signedIn.error, null);

      session.renameAccount("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1));
      const tooLong = session.getSnapshot();
      assert.equal(tooLong.error?.code, "INVALID_NAME");
      assert.equal(tooLong.busy, false);
      assert.equal(
        tooLong.account.status === "signedIn" && tooLong.account.account.displayName,
        "Ada",
      );
    } finally {
      await server.close();
    }
  });

  /*
   * The rename panel closes on exactly this — the standing it was opened over being
   * replaced — so it is pinned here rather than left an accident of `publish`: a panel
   * answered by a refusal has to stay up to say so, and one answered by the new name has
   * to go, even when the new name is the old one.
   */
  it("replaces the standing a rename was asked over only when the rename lands", async () => {
    const server = await startServer(26);
    try {
      const session = await signUp(server, { sub: "google-ada", name: "Ada" });
      const asked = session.getSnapshot().account;

      session.renameAccount("   ");
      assert.equal(session.getSnapshot().error?.code, "INVALID_NAME");
      assert.equal(session.getSnapshot().account, asked, "refused: the same standing");

      session.renameAccount("Ada");
      const renamed = await settled(session, "renameAccount's ack");
      assert.equal(renamed.error, null);
      assert.notEqual(renamed.account, asked, "landed, if to the very same name: a new one");
      assert.deepEqual(renamed.account, asked);
    } finally {
      await server.close();
    }
  });

  /*
   * What the rename panel does on its way in and out: a refusal it was showing is about a
   * question nobody is asking once it closes, and one left over from the menu is not an
   * answer about a name — so neither is carried across the panel's edge.
   */
  it("lets go of a refusal once it has been read, and of nothing else", async () => {
    const server = await startServer(26);
    try {
      const session = await signUp(server, { sub: "google-ada", name: "Ada" });
      const standing = session.getSnapshot().account;
      session.renameAccount("   ");
      assert.equal(session.getSnapshot().error?.code, "INVALID_NAME");

      session.clearError();

      const after = session.getSnapshot();
      assert.equal(after.error, null);
      assert.equal(after.account, standing, "the rename panel it was asked from stays open");
      assert.equal(after.busy, false, "nothing was sent");
    } finally {
      await server.close();
    }
  });

  it("seats a signed-in player under their account's name, asking them for none", async () => {
    const server = await startServer(26);
    try {
      const session = await signUp(server, { sub: "google-ada", name: "Ada" });
      session.renameAccount("Countess");
      await settled(session, "the new name");

      // No name typed: a signed-in menu has no field to type one into.
      session.createRoom("");
      const lobby = await seated(session, "the account");

      assert.equal(lobby.error, null);
      assert.equal(lobby.view!.you.name, "Countess", "the account's name, renamed");
      assert.ok(lobby.view!.you.accountId, "and a seat taken by the account");
      assert.equal(
        lobby.account.status === "signedIn" && lobby.account.account.id,
        lobby.view!.you.accountId,
      );
    } finally {
      await server.close();
    }
  });

  it("signs out: forgets both credentials, tells Google, and plays on as a guest", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const tokens = fakeTokens();
      const { google, disabled } = fakeGoogle();
      const session = await signUp(
        server,
        { sub: "google-ada", name: "Ada" },
        { account: account.store, seat: tokens.store, google },
      );
      // A seat written down on this page some other time — a guest's, from before signing
      // in, which is the one the rule costs (docs/adr/0020).
      tokens.store.set({ roomCode: "WXYZ", playerId: "p", resumeToken: "t" });
      assert.ok(account.stored());

      session.signOut();
      const out = await settled(session, "the sign-out");

      assert.deepEqual(out.account, { status: "guest" });
      assert.equal(account.stored(), null, "the session is forgotten");
      assert.equal(tokens.stored(), null, "and the seat with it (docs/adr/0020)");
      assert.equal(disabled(), 1, "and Google is asked not to sign them straight back in");

      // The server let go too: a room made now is a guest's, under the name typed.
      session.createRoom("Grace");
      const lobby = await seated(session, "the guest");
      assert.equal(lobby.view!.you.name, "Grace");
      assert.equal(lobby.view!.you.accountId, null);
    } finally {
      await server.close();
    }
  });

  it("is not offered at a table, where it would forget the seat being sat in", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const session = await signUp(server, { sub: "google-ada", name: "Ada" }, { seat: tokens.store });
      session.createRoom("");
      await seated(session, "the account");

      session.signOut();

      assert.equal(session.getSnapshot().busy, false, "nothing was sent");
      assert.equal(session.getSnapshot().account.status, "signedIn");
      assert.ok(tokens.stored(), "and the seat is still there to come back to");
    } finally {
      await server.close();
    }
  });

  it("does not sign out over a connection that is down", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const { google, disabled } = fakeGoogle();
      const session = await signUp(
        server,
        { sub: "google-ada", name: "Ada" },
        { account: account.store, google },
      );
      server.drop(session);
      await waitForSnapshot(session, "the drop", (s) => !s.connected);

      // Sent now, it would reach the next connection bound to no account, and the server
      // would have no session left to end: the row would outlive the sign-out by a month.
      session.signOut();

      const after = session.getSnapshot();
      assert.equal(after.busy, false, "nothing was sent into the dead socket");
      assert.equal(after.account.status, "signedIn");
      assert.ok(account.stored(), "and nothing forgotten that the server still holds");
      assert.equal(disabled(), 0);
    } finally {
      await server.close();
    }
  });

  it("stays signed in when the connection drops and comes back", async () => {
    const server = await startServer(26);
    try {
      const session = await signUp(server, { sub: "google-ada", name: "Ada" });

      server.drop(session, true);
      await waitForSnapshot(session, "the drop", (s) => !s.connected);
      const back = await waitForSnapshot(
        session,
        "the connection",
        (s) => s.connected && !s.resuming && !s.busy,
      );
      assert.equal(back.account.status, "signedIn");
      assert.equal(back.notice, null);

      // Bound on the new connection, not merely remembered by the old one's screen: a room
      // made now is the account's.
      session.createRoom("");
      const lobby = await seated(session, "the account");
      assert.ok(lobby.view!.you.accountId);
    } finally {
      await server.close();
    }
  });
});

describe("a cold boot with an account", () => {
  /** Whether a snapshot is one a screen would draw as the main menu. */
  const readsAsMainMenu = (s: SessionSnapshot) => s.view === null && !s.resuming;

  it("resumes the session, then the seat, never showing the main menu between them", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const tokens = fakeTokens();
      const first = await signUp(
        server,
        { sub: "google-ada", name: "Ada" },
        { account: account.store, seat: tokens.store },
      );
      first.createRoom("");
      const lobby = await seated(first, "the account");
      server.drop(first);

      const back = server.bootSession({ account: account.store, seat: tokens.store });
      const seen = recordSnapshots(back);
      assert.equal(back.getSnapshot().resuming, true, "under way from the off");

      const table = await settled(back, "the seat");

      assert.equal(table.view!.roomCode, lobby.view!.roomCode, "the room it left off in");
      assert.equal(table.view!.you.id, lobby.view!.you.id, "the account's own seat");
      assert.equal(table.account.status, "signedIn");
      assert.equal(table.notice, null);
      assert.equal(table.error, null);
      assert.deepEqual(
        seen.filter(readsAsMainMenu),
        [],
        "no frame between the two answers read as the main menu",
      );
    } finally {
      await server.close();
    }
  });

  it("resumes an account with no seat, coming up signed in rather than as a guest", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const first = await signUp(server, { sub: "google-ada", name: "Ada" }, { account: account.store });
      server.drop(first);

      const back = server.bootSession({ account: account.store });
      const seen = recordSnapshots(back);
      const menu = await settled(back, "the account");

      assert.equal(menu.view, null);
      assert.equal(menu.account.status, "signedIn");
      assert.equal(menu.notice, null);
      assert.deepEqual(
        seen.filter((s) => readsAsMainMenu(s) && s.account.status === "guest"),
        [],
        "no frame drew a guest's menu before the account came back",
      );
    } finally {
      await server.close();
    }
  });

  it("lands a lapsed session on the main menu as a guest, told once", async () => {
    const server = await startServer(26);
    try {
      const account = fakeAccount();
      const tokens = fakeTokens();
      // Thirty days fixed from issue (docs/adr/0020), and issued thirty-one days ago.
      server.skewClock(-31 * 24 * 60 * 60 * 1000);
      const first = await signUp(
        server,
        { sub: "google-ada", name: "Ada" },
        { account: account.store, seat: tokens.store },
      );
      first.createRoom("");
      await seated(first, "the account");
      server.drop(first);
      server.skewClock(0);

      const back = server.bootSession({ account: account.store, seat: tokens.store });
      const seen = recordSnapshots(back);
      const menu = await settled(back, "the refusals");

      assert.equal(menu.view, null, "the account's seat cannot be claimed by a guest");
      assert.deepEqual(menu.account, { status: "guest" });
      assert.ok(menu.notice, "and the player is told");
      assert.equal(menu.error, null, "news, not a refusal of anything they did");
      assert.equal(
        new Set(seen.map((s) => s.notice).filter((n) => n !== null)).size,
        1,
        "once: the session and the seat it took are one piece of news",
      );
      assert.equal(account.stored(), null, "a session that fails is not kept to fail again");
      assert.equal(tokens.stored(), null, "nor the seat that went with it");

      // The game still works: a guest's room, under the name typed.
      back.createRoom("Grace");
      const lobby = await seated(back, "the guest");
      assert.equal(lobby.view!.you.accountId, null);
      assert.equal(lobby.notice, null, "and the news goes when they act again");
    } finally {
      await server.close();
    }
  });

  it("still claims a guest seat behind a session it is refused", async () => {
    const server = await startServer(26);
    try {
      const tokens = fakeTokens();
      const guest = await server.openSession({ seat: tokens.store });
      guest.createRoom("Grace");
      const lobby = await seated(guest, "the guest");
      server.drop(guest);

      // A session token the server never issued: refused, as a lapsed one is.
      const account = fakeAccount(`${SESSION_TOKEN_MARK}never-issued`);
      const back = server.bootSession({ account: account.store, seat: tokens.store });
      const table = await settled(back, "the seat");

      assert.equal(table.view!.roomCode, lobby.view!.roomCode, "a guest seat is its token's");
      assert.deepEqual(table.account, { status: "guest" });
      assert.ok(table.notice, "the lapsed sign-in is still news");
      assert.equal(account.stored(), null);
      assert.ok(tokens.stored(), "and the seat is kept");
    } finally {
      await server.close();
    }
  });
});
