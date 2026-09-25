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
import type {
  AccountView,
  GameError,
  PlayerGameView,
  ResumeRequest,
  RoomSettings,
  RoundResultView,
  SignedIn,
  SignInResult,
} from "@yaniv/shared";
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MAX_SCORE,
  MAX_SCORE_LIMITS,
  YANIV_THRESHOLD,
  handValue,
} from "@yaniv/shared";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { decideTurn } from "../src/bot.ts";
import { AUTO_DEAL_MS, BOT_THINK_MS, ROOM_SWEEP_MS } from "../src/config.ts";
import { createDeck } from "../src/deck.ts";
import { createMemoryProfileStore, type ProfileStore } from "../src/profiles.ts";
import { RoomManager } from "../src/roomManager.ts";
import { mulberry32 } from "../src/rng.ts";
import type { SocketServerOptions } from "../src/socketServer.ts";
import { createSocketServer } from "../src/socketServer.ts";
import { fakeVerifier, type FakeVerifier } from "./auth/verifier.ts";
import {
  RESUME_TOKEN_MARK,
  SESSION_TOKEN_MARK,
  markedResumeTokens,
  markedSessionTokens,
  playingSelf,
  slapdownOpen,
  testClock,
  type TestClock,
} from "./helpers.ts";

/** The ack shape every request/response event replies with. Mirrors `Ack<T>`. */
type AckResult<T> = { ok: true; value: T } | { ok: false; error: GameError };

interface Harness {
  /** Open a new client connection, resolving once it is actually connected. */
  connect: () => Promise<ClientSocket>;
  /** Google, as far as this server knows: a token verifies if a test vouched for it. */
  google: FakeVerifier;
  close: () => Promise<void>;
}

/**
 * A match short enough to play out over a socket. Every seat but one has to be knocked
 * out for a match to end (docs/rules.md §7), so the limit is what decides how many rounds
 * that takes — and nothing about the wire is proven by playing more of them.
 */
const SHORT_MATCH: Partial<RoomSettings> = { maxScore: 20 };

/**
 * The opposite, for the suites that play a great many rounds looking for a position: a
 * limit no run of them reaches, so nobody is eliminated on the way there.
 */
const LONG_MATCH: Partial<RoomSettings> = { maxScore: MAX_SCORE_LIMITS.max };

/**
 * Stand up a server on an ephemeral port. Port 0 lets the OS pick, so suites can run
 * concurrently and no test depends on a fixed port being free.
 *
 * Pass a `seed` when a test's subject is the play itself rather than the wiring: the
 * deal then repeats exactly, so a test can be written against the cards that actually
 * come out rather than whatever the system rng felt like dealing.
 *
 * `botCount` seeds every room this server creates. It defaults to filling the table,
 * which is what `startGame` did unconditionally until `botCount` became a room setting
 * defaulting to zero (docs/adr/0006) — seeding it keeps the tables below the size their
 * tests were written against without an `updateSettings` call in front of every one of
 * them. Suites about the seating rule itself, or about that event, pass their own.
 *
 * `timing` switches bot think time off by default. Every suite here but the one about the
 * pause itself is about something else, and none of them should have to learn about a
 * clock — nor spend real seconds waiting on a bot. Bot turns are still scheduled rather
 * than played in the handler's own tick, so a test that wants one waits for its broadcast
 * whatever the interval is set to.
 *
 * `settings` is anything else a suite wants every room seeded with. `SHORT_MATCH` is what
 * the suites that play a match all the way out pass: a match now ends when one player is
 * left rather than when the first goes over (docs/rules.md §7), so at the default limit a
 * full table has to be knocked out one seat at a time — a great many rounds over a real
 * socket, for no coverage the same match at a lower limit does not give.
 *
 * `profiles` is the in-memory store unless a suite needs one that answers when it says.
 */
async function startServer(
  seed?: number,
  botCount = MAX_PLAYERS - 1,
  timing: SocketServerOptions = { thinkTimeMs: 0 },
  settings: Partial<RoomSettings> = {},
  profiles: ProfileStore = createMemoryProfileStore(),
): Promise<Harness> {
  const httpServer = createServer();
  // Every seat this server issues holds a marked token, so a leak test can grep a payload
  // for a string it knows is a credential.
  const newResumeToken = markedResumeTokens();
  const defaultSettings = { botCount, ...settings };
  const rooms =
    seed === undefined
      ? new RoomManager({ newResumeToken, defaultSettings })
      : new RoomManager({
          rng: mulberry32(seed),
          newResumeToken,
          newRoomRng: () => mulberry32(seed + 1),
          defaultSettings,
        });
  // The in-memory store, which is what the repo's tests run against (docs/adr/0019); a
  // fake Google; and marked session tokens, for the reason the resume tokens are marked.
  const google = fakeVerifier();
  const io = createSocketServer(httpServer, rooms, profiles, {
    verifier: google,
    newSessionToken: markedSessionTokens(),
    ...timing,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  const clients: ClientSocket[] = [];

  return {
    google,
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

/**
 * Record every view this client is sent, and let a test wait for one it cares about.
 *
 * A chain of bot turns arrives as a burst of separate broadcasts, and the ack for the
 * action that set it off is sent before any of them. So a test needs both the whole
 * sequence — to prove the moves were reported one at a time — and a way to know the
 * burst has finished.
 */
interface Watcher {
  /** Every view received so far, oldest first. */
  seen: PlayerGameView[];
  /** Forget everything so far, so the next burst can be read on its own. */
  reset: () => void;
  /** Wait for a view matching `predicate`, and return it. */
  until: (
    predicate: (view: PlayerGameView) => boolean,
    what: string,
  ) => Promise<PlayerGameView>;
}

function watch(client: ClientSocket): Watcher {
  let seen: PlayerGameView[] = [];
  client.on("gameStateUpdate", (view: PlayerGameView) => seen.push(view));

  return {
    get seen() {
      return seen;
    },
    reset: () => {
      seen = [];
    },
    until: async (predicate, what) => {
      const deadline = Date.now() + 2000;
      for (;;) {
        const found = seen.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

/**
 * A resume token is a seat's credential, so it is a secret of the same class as a hidden
 * hand — worse to lose, since it is the seat itself rather than a look at the cards. No
 * broadcast view carries one, in any phase, to any player, including the one it belongs
 * to: a token reaches its owner through an ack of their own or not at all.
 */
function assertNoResumeToken(view: PlayerGameView, where: string): void {
  assert.ok(
    !JSON.stringify(view).includes(RESUME_TOKEN_MARK),
    `a resume token reached ${where}`,
  );
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

  it("publishes the room's settings with the lobby, before any round is dealt", async () => {
    const client = await server.connect();
    const lobby = nextEvent<PlayerGameView>(client, "gameStateUpdate");

    expectOk(await ask(client, "createRoom", "Ada"));

    assert.deepEqual((await lobby).settings, {
      handSize: HAND_SIZE,
      yanivThreshold: YANIV_THRESHOLD,
      maxScore: MAX_SCORE,
      botCount: MAX_PLAYERS - 1,
    });
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
 * The rest of a token's life is covered where the payloads are: the round-by-round
 * broadcasts and every revealed phase are checked in "playing a match" below.
 */
describe("resume tokens", () => {
  it("reach the seat they belong to, in its own ack and nowhere else", async () => {
    const host = await server.connect();
    const hostViews = watch(host);
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        host,
        "createRoom",
        "Ada",
      ),
    );
    const guest = await server.connect();
    const guestViews = watch(guest);
    const joined = expectOk(
      await ask<{ playerId: string; resumeToken: string }>(
        guest,
        "joinRoom",
        created.roomCode,
        "Grace",
      ),
    );

    // The ack of the event that seated them is the one place a token is handed over,
    // and each seat gets its own — a shared one would be a key to the whole table.
    assert.ok(created.resumeToken.length > 0, "the host was issued a token");
    assert.notEqual(joined.resumeToken, created.resumeToken);

    await guestViews.until((v) => v.opponents.length === 1, "the guest's lobby");
    for (const view of [...hostViews.seen, ...guestViews.seen]) {
      assertNoResumeToken(view, "a lobby view");
    }
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

/** A fresh Google identity for each sign-in, so tests sharing a server share no account. */
let googleAccounts = 0;

/**
 * The sign-in fixture: vouch for a new Google identity, sign in with it and confirm the
 * name — the whole first-visit path, over the wire. Answers the signed-in ack, session
 * token and all, and the ID token, for a test that wants to present it again.
 */
async function signUp(
  client: ClientSocket,
  displayName = "Ada",
  on: Harness = server,
): Promise<SignedIn & { idToken: string }> {
  const idToken = `id-token-${++googleAccounts}`;
  on.google.vouchFor(idToken, { sub: `sub-${googleAccounts}`, name: displayName });

  const first = expectOk(await ask<SignInResult>(client, "signIn", idToken));
  assert.equal(first.status, "nameNeeded");
  const created = expectOk(await ask<SignedIn>(client, "createAccount", idToken, displayName));
  return { ...created, idToken };
}

/** The account a session token resumes, asked from a connection of its own. */
async function resumeFresh(sessionToken: string): Promise<AckResult<{ account: AccountView }>> {
  const other = await server.connect();
  return ask<{ account: AccountView }>(other, "resumeSession", sessionToken);
}

describe("signing in", () => {
  it("drives a first visit end to end: sign in, name, rename, sign out", async () => {
    const client = await server.connect();
    server.google.vouchFor("id-token-ada", { sub: "sub-ada", name: "  Ada Lovelace " });

    assert.deepEqual(expectOk(await ask(client, "signIn", "id-token-ada")), {
      status: "nameNeeded",
      suggestedName: "Ada Lovelace",
    });

    const created = expectOk(
      await ask<SignedIn>(client, "createAccount", "id-token-ada", "Ada"),
    );
    assert.equal(created.status, "signedIn");
    assert.equal(created.account.displayName, "Ada");

    const renamed = { id: created.account.id, displayName: "Countess" };
    assert.deepEqual(expectOk(await ask(client, "renameAccount", " Countess ")), {
      account: renamed,
    });

    // The next visit, which takes the account over from this one (newer wins at bind).
    const next = await server.connect();
    assert.deepEqual(expectOk(await ask(next, "resumeSession", created.sessionToken)), {
      account: renamed,
    });

    assert.equal(expectOk(await ask(next, "signOut")), null);
    assert.equal(
      expectError(await resumeFresh(created.sessionToken)).code,
      "INVALID_SESSION",
      "a signed-out session resumes nobody",
    );
    assert.equal(
      expectError(await ask(next, "renameAccount", "Ada")).code,
      "INVALID_SESSION",
      "and the connection is no longer anybody's",
    );
  });

  it("signs a returning credential straight in, with a session of its own", async () => {
    const first = await server.connect();
    const created = await signUp(first);

    const second = await server.connect();
    const again = expectOk(await ask<SignInResult>(second, "signIn", created.idToken));

    assert.equal(again.status, "signedIn");
    if (again.status !== "signedIn") return;
    assert.deepEqual(again.account, created.account);
    assert.notEqual(again.sessionToken, created.sessionToken);
  });

  it("binds the account a resumed session names", async () => {
    const created = await signUp(await server.connect());
    const returning = await server.connect();

    assert.deepEqual(
      expectOk(await ask(returning, "resumeSession", created.sessionToken)),
      { account: created.account },
    );
    // Bound, as proven by acting as it.
    expectOk(await ask(returning, "renameAccount", "Returned"));
    assert.equal(
      expectOk(await resumeFresh(created.sessionToken)).account.displayName,
      "Returned",
    );
  });

  it("refuses a token Google did not vouch for, and a session it never issued", async () => {
    const client = await server.connect();

    assert.equal(expectError(await ask(client, "signIn", "forged")).code, "INVALID_CREDENTIAL");
    assert.equal(
      expectError(await ask(client, "createAccount", "forged", "Ada")).code,
      "INVALID_CREDENTIAL",
    );
    assert.equal(
      expectError(await ask(client, "resumeSession", `${SESSION_TOKEN_MARK}never`)).code,
      "INVALID_SESSION",
    );
  });

  it("refuses a name the display-name rule does not allow", async () => {
    const client = await server.connect();
    const created = await signUp(client);
    server.google.vouchFor("id-token-unnamed", { sub: "sub-unnamed" });

    assert.equal(
      expectError(await ask(client, "createAccount", "id-token-unnamed", "   ")).code,
      "INVALID_NAME",
    );
    assert.equal(
      expectError(await ask(client, "renameAccount", "x".repeat(21))).code,
      "INVALID_NAME",
    );
    assert.deepEqual(expectOk(await resumeFresh(created.sessionToken)), {
      account: created.account,
    });
  });

  it("refuses a rename from a connection nobody is signed in on", async () => {
    const client = await server.connect();
    assert.equal(expectError(await ask(client, "renameAccount", "Ada")).code, "INVALID_SESSION");
  });

  it("signs out a connection nobody is signed in on without complaint", async () => {
    const client = await server.connect();
    assert.equal(expectOk(await ask(client, "signOut")), null);
  });

  /*
   * A payload's wire type is a claim, and a hash or a `.trim()` over a number throws — in
   * an async handler, an unhandled rejection, which is a crashed server. Asked again after
   * each, so a crash shows up as the next ack never arriving.
   */
  it("refuses a payload that is not a string, and stays up", async () => {
    const client = await server.connect();
    const created = await signUp(client);

    assert.equal(expectError(await ask(client, "signIn", 42)).code, "INVALID_CREDENTIAL");
    assert.equal(expectError(await ask(client, "resumeSession", 42)).code, "INVALID_SESSION");
    assert.equal(
      expectError(await ask(client, "createAccount", created.idToken.slice(0, -1), null)).code,
      "INVALID_CREDENTIAL",
    );
    assert.equal(expectError(await ask(client, "renameAccount", {})).code, "INVALID_NAME");
    assert.deepEqual(expectOk(await resumeFresh(created.sessionToken)), {
      account: created.account,
    });
  });
});

/**
 * An account binding is not a seat binding (docs/adr/0022): it arrives at the main menu
 * before any room, and outlives leaving one. So neither is refused for the other, and
 * binding an account over another replaces it — unlike a room, orphaning nobody.
 */
describe("the account beside the seat", () => {
  it("replaces an account bound already, with no ALREADY_IN_ROOM analogue", async () => {
    const client = await server.connect();
    const ada = await signUp(client, "Ada");
    const grace = await signUp(client, "Grace");

    expectOk(await ask(client, "renameAccount", "Hopper"));

    assert.equal(expectOk(await resumeFresh(grace.sessionToken)).account.displayName, "Hopper");
    assert.equal(
      expectOk(await resumeFresh(ada.sessionToken)).account.displayName,
      "Ada",
      "the account replaced is left as it was",
    );
  });

  it("signs in and out mid-match without touching the seat", async () => {
    const client = await server.connect();
    const watcher = watch(client);
    expectOk(await ask(client, "createRoom", "Ada"));
    expectOk(await ask(client, "startGame"));
    await watcher.until((v) => v.phase === "playing", "the deal");

    const created = await signUp(client);
    expectOk(await ask(client, "resumeSession", created.sessionToken));
    expectOk(await ask(client, "signOut"));

    // Still seated: a second room is refused, and leaving this one is not.
    assert.equal(
      expectError(await ask(client, "createRoom", "Ada")).code,
      "ALREADY_IN_ROOM",
    );
    expectOk(await ask(client, "exitToMenu"));
  });

  it("keeps the account bound through leaving a room", async () => {
    const client = await server.connect();
    const created = await signUp(client);
    expectOk(await ask(client, "createRoom", "Ada"));
    expectOk(await ask(client, "exitToMenu"));

    expectOk(await ask(client, "renameAccount", "Still me"));
    assert.equal(
      expectOk(await resumeFresh(created.sessionToken)).account.displayName,
      "Still me",
    );
  });
});

/**
 * The session token's half of the resume-token sweep above, and stricter: every payload
 * the server sends any socket across a whole signed-in visit is recorded — broadcasts,
 * announcements and acks alike — and each token must turn up in exactly one of them, the
 * ack of the event that issued it (docs/adr/0021). The mutation it catches is the token
 * reaching anywhere else: another ack, a view, another player.
 *
 * What it replaces is a serializer mutation test, withdrawn as vacuous (#175): a session
 * token is never in `GameState`, so no serializer holds one to leak, and a test that broke
 * the serializer on purpose would pass regardless.
 */
describe("session tokens on the wire", () => {
  it("reach the connection that signed in, in the ack that issued them and nowhere else", async () => {
    const payloads: { where: string; payload: unknown }[] = [];

    async function connect(who: string): Promise<ClientSocket> {
      const client = await server.connect();
      client.onAny((event: string, ...args: unknown[]) =>
        payloads.push({ where: `${who} <- ${event}`, payload: args }),
      );
      return client;
    }
    async function recorded<T>(
      who: string,
      client: ClientSocket,
      event: string,
      ...args: unknown[]
    ): Promise<AckResult<T>> {
      const result = await ask<T>(client, event, ...args);
      payloads.push({ where: `${who} <- ${event} ack`, payload: result });
      return result;
    }

    const ada = await connect("ada");
    const grace = await connect("grace");
    const adaViews = watch(ada);
    const graceViews = watch(grace);

    // A first visit: the name step, then the account.
    server.google.vouchFor("id-token-sweep", { sub: "sub-sweep", name: "Ada" });
    await recorded("ada", ada, "signIn", "id-token-sweep");
    const created = expectOk(
      await recorded<SignedIn>("ada", ada, "createAccount", "id-token-sweep", "Ada"),
    );

    // A table, with a guest at it, played into.
    const { roomCode } = expectOk(
      await recorded<{ roomCode: string }>("ada", ada, "createRoom", "Ada"),
    );
    expectOk(await recorded("grace", grace, "joinRoom", roomCode, "Grace"));
    expectOk(await recorded("ada", ada, "startGame"));
    await adaViews.until((v) => v.phase === "playing", "ada's deal");
    await graceViews.until((v) => v.phase === "playing", "grace's deal");
    await recorded("ada", ada, "renameAccount", "Countess");

    // A second tab: resumed — taking the account, and so the seat, over from the first —
    // then signed in afresh with a session of its own, and sat back down at the table.
    const tab = await connect("ada's second tab");
    expectOk(await recorded("tab", tab, "resumeSession", created.sessionToken));
    const again = expectOk(await recorded<SignInResult>("tab", tab, "signIn", "id-token-sweep"));
    assert.equal(again.status, "signedIn");
    if (again.status !== "signedIn") return;
    expectOk(await recorded("tab", tab, "joinRoom", roomCode, "Ada"));

    await recorded("tab", tab, "signOut");
    await recorded("tab", tab, "exitToMenu");
    await graceViews.until((v) => v.opponents.some((o) => o.departed), "ada gone");

    for (const [token, issuedBy] of [
      [created.sessionToken, "ada <- createAccount ack"],
      [again.sessionToken, "tab <- signIn ack"],
    ] as const) {
      assert.ok(token.startsWith(SESSION_TOKEN_MARK), "tokens under test are marked");
      assert.deepEqual(
        payloads.filter((p) => JSON.stringify(p.payload).includes(token)).map((p) => p.where),
        [issuedBy],
      );
    }
    assert.equal(
      payloads.filter((p) => JSON.stringify(p.payload).includes(SESSION_TOKEN_MARK)).length,
      2,
      "no other session token reached any payload",
    );
  });
});

/**
 * A seat is bound to one identity for life and claimed back by that one (docs/adr/0022): a
 * guest seat by its resume token, exactly as before, and an account seat by its account,
 * the token issued and never consulted. The whole check is
 * `player.accountId ? account === player.accountId : token === player.resumeToken`.
 */
describe("a seat claimed by whoever took it", () => {
  interface Seating {
    roomCode: string;
    playerId: string;
    resumeToken: string;
  }

  /** A signed-in connection with a room of its own, and everything needed to come back. */
  async function accountSeat(name = "Ada") {
    const client = await server.connect();
    const account = await signUp(client, name);
    const seat = expectOk(await ask<Seating>(client, "createRoom", "Typed"));
    return { client, account, ...seat };
  }

  async function guestSeat(name = "Grace") {
    const client = await server.connect();
    const seat = expectOk(await ask<Seating>(client, "createRoom", name));
    return { client, ...seat };
  }

  /** Picked field by field, so a fixture spread into one sends nothing but the claim. */
  function resume(client: ClientSocket, { roomCode, playerId, resumeToken }: ResumeRequest) {
    return ask<{ view: PlayerGameView }>(client, "resumeSeat", {
      roomCode,
      playerId,
      resumeToken,
    });
  }

  /** A fresh connection, signed into `sessionToken`'s account — a reload, or a second tab. */
  async function signedInAs(sessionToken: string): Promise<ClientSocket> {
    const client = await server.connect();
    expectOk(await ask(client, "resumeSession", sessionToken));
    return client;
  }

  describe("seating a signed-in player", () => {
    it("takes the name from the account and ignores the one in the payload", async () => {
      const host = await server.connect();
      const hostViews = watch(host);
      await signUp(host, "Ada");
      const { roomCode } = expectOk(await ask<Seating>(host, "createRoom", "Typed"));

      const joiner = await server.connect();
      await signUp(joiner, "Grace");
      expectOk(await ask(joiner, "joinRoom", roomCode, "Also typed"));

      const lobby = await hostViews.until((v) => v.opponents.length === 1, "the join");
      assert.equal(lobby.you.name, "Ada");
      assert.equal(lobby.opponents[0]!.name, "Grace");
    });

    it("takes the name the account was last renamed to", async () => {
      const client = await server.connect();
      const views = watch(client);
      await signUp(client, "Ada");
      expectOk(await ask(client, "renameAccount", "Countess"));

      expectOk(await ask(client, "createRoom", "Ada"));

      const lobby = await views.until((v) => v.phase === "lobby", "the lobby");
      assert.equal(lobby.you.name, "Countess");
    });

    /**
     * Positive, on both views, so an over-zealous redaction is caught at the wire and not
     * by the stats screen that will one day need it. A guest's is null, and so is a bot's.
     */
    it("puts the account on the wire at every seat, the viewer's own included", async () => {
      const host = await server.connect();
      const hostViews = watch(host);
      const ada = await signUp(host, "Ada");
      const { roomCode } = expectOk(await ask<Seating>(host, "createRoom", "Ada"));

      const guest = await server.connect();
      const guestViews = watch(guest);
      const grace = expectOk(await ask<Seating>(guest, "joinRoom", roomCode, "Grace"));
      expectOk(await ask(host, "startGame"));

      const hostView = await hostViews.until((v) => v.phase === "playing", "the deal");
      assert.equal(hostView.you.accountId, ada.account.id);
      assert.equal(hostView.opponents.find((o) => o.id === grace.playerId)!.accountId, null);
      assert.ok(hostView.opponents.length > 1, "bots were seated too");
      for (const opponent of hostView.opponents) {
        if (opponent.id !== grace.playerId) assert.equal(opponent.accountId, null, "a bot's");
      }

      const guestView = await guestViews.until((v) => v.phase === "playing", "the deal");
      assert.equal(guestView.you.accountId, null);
      assert.equal(
        guestView.opponents.find((o) => o.name === "Ada")!.accountId,
        ada.account.id,
      );
    });
  });

  describe("resumeSeat", () => {
    it("hands an account seat back to its account, the token not consulted", async () => {
      const seat = await accountSeat();
      seat.client.disconnect();

      const returning = await signedInAs(seat.account.sessionToken);
      const { view } = expectOk(
        await resume(returning, { ...seat, resumeToken: "not-the-token" }),
      );

      assert.equal(view.you.id, seat.playerId);
      assert.equal(view.you.accountId, seat.account.account.id);
    });

    it("refuses an account seat to its own token, presented by a guest", async () => {
      const seat = await accountSeat();
      seat.client.disconnect();

      const guest = await server.connect();
      assert.equal(expectError(await resume(guest, seat)).code, "INVALID_RESUME_TOKEN");
    });

    it("refuses an account seat to another account, token and all", async () => {
      const seat = await accountSeat();
      seat.client.disconnect();

      const other = await server.connect();
      await signUp(other, "Mallory");
      assert.equal(expectError(await resume(other, seat)).code, "INVALID_RESUME_TOKEN");
    });

    /** The cost ADR-0022 accepts: a signed-out reload cannot claim what the account took. */
    it("refuses an account seat to a connection whose account signed out", async () => {
      const seat = await accountSeat();
      seat.client.disconnect();

      const returning = await signedInAs(seat.account.sessionToken);
      expectOk(await ask(returning, "signOut"));
      assert.equal(expectError(await resume(returning, seat)).code, "INVALID_RESUME_TOKEN");
    });

    it("hands a guest seat back to its token, exactly as before", async () => {
      const seat = await guestSeat();
      seat.client.disconnect();

      const returning = await server.connect();
      assert.equal(expectOk(await resume(returning, seat)).view.you.id, seat.playerId);
    });

    /**
     * Signing in while seated as a guest binds the connection, not the seat — so the seat
     * is still its token's, and a reload that has since signed in gets it back by that.
     */
    it("hands a guest seat back to its token whoever is signed in on the connection", async () => {
      const seat = await guestSeat();
      await signUp(seat.client, "Grace");
      seat.client.disconnect();

      const returning = await server.connect();
      await signUp(returning, "Somebody");
      const { view } = expectOk(await resume(returning, seat));

      assert.equal(view.you.id, seat.playerId);
      assert.equal(view.you.accountId, null, "still a guest seat");
    });

    it("refuses a guest seat to a signed-in connection with the wrong token", async () => {
      const seat = await guestSeat();
      seat.client.disconnect();

      const returning = await server.connect();
      await signUp(returning, "Grace");
      assert.equal(
        expectError(await resume(returning, { ...seat, resumeToken: "not-the-token" })).code,
        "INVALID_RESUME_TOKEN",
      );
    });

    /**
     * Any other answer to any of these would say "that seat exists, and belongs to an
     * account", which is the fishing the shared answer exists to prevent.
     */
    it("answers every failed claim the same way, whatever was wrong", async () => {
      const seat = await accountSeat();
      const guest = await guestSeat();
      const claimant = await server.connect();

      const refusals = [
        await resume(claimant, { ...guest, resumeToken: "not-the-token" }),
        await resume(claimant, { ...guest, playerId: "nobody" }),
        await resume(claimant, seat),
      ].map(expectError);

      assert.deepEqual(refusals, [refusals[0], refusals[0], refusals[0]]);
      assert.equal(refusals[0]!.code, "INVALID_RESUME_TOKEN");
    });
  });

  /**
   * An account is live on one connection at a time, and the newer one wins: a tab left
   * open somewhere else must not lock its player out.
   */
  describe("newer wins at bind", () => {
    for (const how of ["resumeSession", "signIn"] as const) {
      it(`puts down the older connection when a newer one binds the account by ${how}`, async () => {
        const older = await server.connect();
        const account = await signUp(older);
        const dropped = nextEvent<string>(older, "disconnect");

        const newer = await server.connect();
        expectOk(
          how === "resumeSession"
            ? await ask(newer, "resumeSession", account.sessionToken)
            : await ask(newer, "signIn", account.idToken),
        );

        await dropped;
        assert.ok(newer.connected, "the newer connection is the one kept");
      });
    }

    it("puts down the older connection when a newer one creates the account", async () => {
      const older = await server.connect();
      server.google.vouchFor("id-token-twice", { sub: "sub-twice", name: "Ada" });
      expectOk(await ask(older, "createAccount", "id-token-twice", "Ada"));
      const dropped = nextEvent<string>(older, "disconnect");

      // The same credential finishing the name step a second time signs it in.
      const newer = await server.connect();
      expectOk(await ask(newer, "createAccount", "id-token-twice", "Ada"));

      await dropped;
    });

    it("leaves a connection signed into another account alone", async () => {
      const ada = await server.connect();
      await signUp(ada, "Ada");
      const grace = await server.connect();
      await signUp(grace, "Grace");

      // Asked of Ada's connection, and answered: it was not put down.
      expectOk(await ask(ada, "renameAccount", "Still here"));
    });

    it("leaves the connection itself alone when it signs in again", async () => {
      const client = await server.connect();
      const account = await signUp(client);

      expectOk(await ask(client, "resumeSession", account.sessionToken));
      expectOk(await ask(client, "renameAccount", "Still here"));
    });

    /**
     * A reload races its own dead socket: the old tab's `resumeSession` may still be with
     * the store when the new tab's is answered, and a store may answer out of order. The
     * old request resolving last must bind nothing — otherwise it would put down the live
     * tab, which socket.io-client does not reconnect, and strand the player.
     */
    it("binds nothing for a connection that went while the store was answering", async () => {
      const memory = createMemoryProfileStore();
      let held: Promise<void> | null = null;
      let answer = () => {};
      const slow = await startServer(undefined, MAX_PLAYERS - 1, { thinkTimeMs: 0 }, {}, {
        ...memory,
        findSession: async (tokenHash) => {
          if (held) await held;
          return memory.findSession(tokenHash);
        },
      });
      try {
        const account = await signUp(await slow.connect(), "Ada", slow);

        held = new Promise((resolve) => (answer = resolve));
        const dead = await slow.connect();
        dead.emit("resumeSession", account.sessionToken, () => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        dead.disconnect();
        const pending = held;
        held = null;

        const live = await slow.connect();
        expectOk(await ask(live, "resumeSession", account.sessionToken));
        answer();
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.ok(live.connected, "the live tab was not put down");
        expectOk(await ask(live, "renameAccount", "Still here"));
      } finally {
        await slow.close();
      }
    });

    it("hands the seat over too, which the newer connection then sits back down at", async () => {
      const seat = await accountSeat();
      const dropped = nextEvent<string>(seat.client, "disconnect");

      const tab = await signedInAs(seat.account.sessionToken);
      await dropped;

      assert.equal(expectOk(await resume(tab, seat)).view.you.id, seat.playerId);
    });
  });

  /**
   * Joining a room the account already holds a seat in is claiming that seat — the
   * account *is* its credential — so it resumes rather than sitting the player down twice.
   */
  describe("joining a room the account already sits in", () => {
    it("returns the seat it holds, mid-match, rather than adding one", async () => {
      const seat = await accountSeat();
      const guest = await server.connect();
      const guestViews = watch(guest);
      expectOk(await ask(guest, "joinRoom", seat.roomCode, "Grace"));
      expectOk(await ask(seat.client, "startGame"));
      const dealt = await guestViews.until((v) => v.phase === "playing", "the deal");

      const tab = await signedInAs(seat.account.sessionToken);
      const tabViews = watch(tab);
      const joined = expectOk(await ask<Seating>(tab, "joinRoom", seat.roomCode, "Other"));

      assert.equal(joined.playerId, seat.playerId);
      assert.equal(joined.resumeToken, seat.resumeToken, "the seat's own, uniformly acked");
      const view = await tabViews.until((v) => v.phase === "playing", "the seat's position");
      assert.equal(view.you.id, seat.playerId);
      assert.equal(view.you.name, "Ada");
      assert.deepEqual(view.seating, dealt.seating, "nobody was added to the table");
    });

    /**
     * One live connection per seat, whichever door the claim came in by. Signed out while
     * seated, the older connection is bound to no account, so newer-wins never saw it.
     */
    it("puts down a connection still holding the seat", async () => {
      const seat = await accountSeat();
      expectOk(await ask(seat.client, "signOut"));
      const dropped = nextEvent<string>(seat.client, "disconnect");

      const returning = await server.connect();
      expectOk(await ask(returning, "signIn", seat.account.idToken));
      const joined = expectOk(await ask<Seating>(returning, "joinRoom", seat.roomCode, "Ada"));

      assert.equal(joined.playerId, seat.playerId);
      await dropped;
    });

    it("announces no arrival — nobody arrived", async () => {
      const seat = await accountSeat();
      const guest = await server.connect();
      const guestViews = watch(guest);
      expectOk(await ask(guest, "joinRoom", seat.roomCode, "Grace"));
      await guestViews.until((v) => v.opponents.length === 1, "the lobby");

      const announced: string[] = [];
      guest.on("playerJoined", (name: string) => announced.push(name));
      seat.client.disconnect();
      const tab = await signedInAs(seat.account.sessionToken);
      guestViews.reset();
      expectOk(await ask(tab, "joinRoom", seat.roomCode, "Ada"));

      const back = await guestViews.until(
        (v) => v.opponents.length === 1 && v.opponents[0]!.connected,
        "the seat back",
      );
      assert.equal(back.opponents[0]!.id, seat.playerId);
      assert.deepEqual(announced, []);
    });
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

describe("updateSettings", () => {
  /** Every field away from its default, so a partial replace would be visible. */
  const CHOSEN: RoomSettings = {
    handSize: 7,
    yanivThreshold: 3,
    maxScore: 200,
    botCount: 4,
  };

  /** A host and a guest sharing a fresh lobby, each watching their own broadcasts. */
  async function lobbyOfTwo(): Promise<{
    roomCode: string;
    host: ClientSocket;
    hostViews: Watcher;
    guest: ClientSocket;
    guestViews: Watcher;
  }> {
    const host = await server.connect();
    const hostViews = watch(host);
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    const guest = await server.connect();
    const guestViews = watch(guest);
    expectOk(await ask(guest, "joinRoom", roomCode, "Grace"));

    return { roomCode, host, hostViews, guest, guestViews };
  }

  it("publishes the host's new settings to everyone in the room", async () => {
    const { host, hostViews, guestViews } = await lobbyOfTwo();

    hostViews.reset();
    guestViews.reset();
    expectOk(await ask(host, "updateSettings", CHOSEN));

    for (const [who, views] of [
      ["the host", hostViews],
      ["the guest", guestViews],
    ] as const) {
      const updated = await views.until(
        (v) => v.settings.handSize === CHOSEN.handSize,
        `${who}'s view of the new settings`,
      );
      assert.deepEqual(updated.settings, CHOSEN, `${who} sees all four fields`);
      assert.equal(updated.phase, "lobby", `${who} is still in the lobby`);
    }
  });

  it("rejects an edit by anyone but the host, and publishes nothing", async () => {
    const { roomCode, guest, hostViews } = await lobbyOfTwo();

    hostViews.reset();
    assert.equal(
      expectError(await ask(guest, "updateSettings", CHOSEN)).code,
      "NOT_HOST",
    );

    // A later arrival's roster is a broadcast the room certainly does make, so it is the
    // barrier: anything the refused edit had published would have landed ahead of it.
    const latecomer = await server.connect();
    expectOk(await ask(latecomer, "joinRoom", roomCode, "Alan"));
    const roster = await hostViews.until(
      (v) => v.opponents.length === 2,
      "the third seat filling",
    );
    assert.equal(roster.settings.handSize, HAND_SIZE, "the room's settings are untouched");
    assert.equal(hostViews.seen.length, 1, "and nothing was published before it");
  });

  it("rejects an edit once the match has been dealt", async () => {
    const host = await server.connect();
    expectOk(await ask(host, "createRoom", "Ada"));
    expectOk(await ask(host, "startGame"));

    assert.equal(
      expectError(await ask(host, "updateSettings", CHOSEN)).code,
      "WRONG_PHASE",
    );
  });

  /**
   * The typed client cannot construct this — which is the point. The room is a real
   * client's word for what it should play like, and one field it could not have sent is
   * enough to refuse the whole object.
   */
  it("rejects settings no room could be played on, applying none of them", async () => {
    const host = await server.connect();
    const views = watch(host);
    expectOk(await ask(host, "createRoom", "Ada"));

    assert.equal(
      expectError(await ask(host, "updateSettings", { ...CHOSEN, maxScore: 0 })).code,
      "INVALID_SETTINGS",
    );

    // The hand that is dealt is the proof: the valid `handSize` travelling alongside the
    // bad `maxScore` reached the room nowhere.
    views.reset();
    expectOk(await ask(host, "startGame"));
    const dealt = await views.until((v) => v.phase === "playing", "the deal");
    assert.equal(playingSelf(dealt).hand.length, HAND_SIZE);
    assert.equal(dealt.settings.maxScore, MAX_SCORE);
  });

  it("rejects an edit from a connection that is not in a room", async () => {
    const stranger = await server.connect();

    assert.equal(
      expectError(await ask(stranger, "updateSettings", CHOSEN)).code,
      "PLAYER_NOT_FOUND",
    );
  });
});

describe("startGame", () => {
  it("deals the host a hand and fills the table with bot opponents", async () => {
    const host = await server.connect();
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );

    const dealt = nextEvent<PlayerGameView>(host, "gameStateUpdate");
    expectOk(await ask(host, "startGame"));
    const view = await dealt;

    assert.equal(view.phase, "playing");
    assert.equal(playingSelf(view).hand.length, HAND_SIZE);
    assert.equal(
      view.opponents.length,
      MAX_PLAYERS - 1,
      "the empty seats were filled with bots",
    );
    assert.equal(roomCode, view.roomCode);
  });

  it("seats only as many bots as botCount asks for", async () => {
    const small = await startServer(undefined, 2);
    try {
      const host = await small.connect();
      expectOk(
        await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
      );

      const dealt = nextEvent<PlayerGameView>(host, "gameStateUpdate");
      expectOk(await ask(host, "startGame"));
      const view = await dealt;

      assert.equal(view.opponents.length, 2, "botCount seats, not a full table");
      assert.equal(view.settings.botCount, 2, "and the setting is on the wire");
    } finally {
      await small.close();
    }
  });

  it("turns a lone host away once no bots are asked for", async () => {
    const empty = await startServer(undefined, 0);
    try {
      const host = await empty.connect();
      expectOk(
        await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
      );

      // The check this closes was vacuous while `startGame` always filled to six.
      assert.equal(expectError(await ask(host, "startGame")).code, "NOT_ENOUGH_PLAYERS");
    } finally {
      await empty.close();
    }
  });

  /**
   * A rejected start must leave the room exactly as it found it. Seating the bots
   * before checking who asked would fill the table off the back of a call that was
   * refused, and the next player to try the lobby would find it full.
   */
  it("rejects a start by anyone but the host, leaving the lobby open", async () => {
    const host = await server.connect();
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    const joiner = await server.connect();
    expectOk(await ask(joiner, "joinRoom", roomCode, "Grace"));

    const result = await ask(joiner, "startGame");

    assert.equal(expectError(result).code, "NOT_HOST");
    const latecomer = await server.connect();
    expectOk(await ask(latecomer, "joinRoom", roomCode, "Alan"));
  });

  it("rejects a second start once the game is under way", async () => {
    const host = await server.connect();
    expectOk(await ask(host, "createRoom", "Ada"));
    expectOk(await ask(host, "startGame"));

    const result = await ask(host, "startGame");

    assert.equal(expectError(result).code, "WRONG_PHASE");
  });

  it("rejects a start from a connection that is not in a room", async () => {
    const stranger = await server.connect();

    const result = await ask(stranger, "startGame");

    assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
  });

  /**
   * Inherited from #4, which could not exercise this: until this ticket there was no way
   * to start a game over a socket, so there was no started room to be turned away from.
   */
  it("rejects a join once the game has started", async () => {
    const host = await server.connect();
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    expectOk(await ask(host, "startGame"));

    const latecomer = await server.connect();
    const result = await ask(latecomer, "joinRoom", roomCode, "Alan");

    assert.equal(expectError(result).code, "WRONG_PHASE");
  });
});

/**
 * Playing the game itself, on a seeded server so the deal is the same every run.
 */
describe("playing a match", () => {
  let table: Harness;

  // A seed whose deal opens on the host and never knocks them out while bots play on,
  // which is what every test below is written against. Re-chosen when the seating became
  // a draw of its own (docs/rules.md §2), that draw moving every seed's deal along.
  before(async () => {
    table = await startServer(29, MAX_PLAYERS - 1, { thinkTimeMs: 0 }, SHORT_MATCH);
  });
  after(async () => {
    await table.close();
  });

  interface Seat {
    client: ClientSocket;
    watcher: Watcher;
    /** The opening view: the player's dealt hand, with the turn on them. */
    view: PlayerGameView;
  }

  /** Create a room and start the game, returning the player's opening position. */
  async function sitDown(): Promise<Seat> {
    const client = await table.connect();
    const watcher = watch(client);
    expectOk(await ask(client, "createRoom", "Ada"));
    expectOk(await ask(client, "startGame"));
    const view = await watcher.until((v) => v.phase === "playing", "the deal");
    return { client, watcher, view };
  }

  it("resolves every bot's turn after the player's, one broadcast per move", async () => {
    const { client, watcher, view } = await sitDown();
    const me = view.you.id;
    assert.equal(view.currentTurnPlayerId, me, "the host takes the first turn");

    watcher.reset();
    expectOk(
      await ask(client, "takeTurn", {
        // A single card is always a legal discard, whatever was dealt.
        discardCardIds: [playingSelf(view).hand[0]!.id],
        draw: { source: "deck" },
      }),
    );

    await watcher.until((v) => v.currentTurnPlayerId === me, "the turn to come back");

    // One broadcast per turn taken — the player's, then each bot's, in seating order,
    // counted round the table from wherever the deal seated the player (docs/rules.md §2).
    // A single collapsed update would show only the last of these.
    const mine = view.turnOrder.indexOf(me);
    assert.deepEqual(
      watcher.seen.map((v) => v.currentTurnPlayerId),
      [...view.turnOrder.slice(mine + 1), ...view.turnOrder.slice(0, mine), me],
    );

    // How long the chain takes is not this test's subject: this server is built with
    // think time off, and the pause each bot waits out is asserted on a clock of its own
    // further down. What has to hold at any interval is that the moves are separate.
  });

  /*
   * The engine already refuses each of these. What is under test is that the refusal
   * reaches the player as the specific code they can act on, and that the table is left
   * exactly as it was — a rejected action must not cost them their turn.
   */

  it("rejects discarding a card the player is not holding", async () => {
    const { client, watcher, view } = await sitDown();
    watcher.reset();

    const result = await ask(client, "takeTurn", {
      discardCardIds: [
        ["joker-1", "joker-2"].find((id) => !playingSelf(view).hand.some((c) => c.id === id))!,
      ],
      draw: { source: "deck" },
    });

    assert.equal(expectError(result).code, "CARD_NOT_IN_HAND");
  });

  it("rejects a discard that is not a legal set", async () => {
    const { client, watcher, view } = await sitDown();
    const [first] = playingSelf(view).hand;
    const mismatched = playingSelf(view).hand.find((c) => c.rank !== first!.rank);
    assert.ok(mismatched, "the deal held two different ranks");
    watcher.reset();

    // Two cards of different ranks: not a same-rank set, and too short to be a run.
    const result = await ask(client, "takeTurn", {
      discardCardIds: [first!.id, mismatched.id],
      draw: { source: "deck" },
    });

    assert.equal(expectError(result).code, "INVALID_SET");
    assert.deepEqual(watcher.seen, [], "a rejected turn publishes nothing");
  });

  it("rejects picking up a card that is not on offer", async () => {
    const { client, watcher, view } = await sitDown();
    watcher.reset();

    const result = await ask(client, "takeTurn", {
      discardCardIds: [playingSelf(view).hand[0]!.id],
      draw: { source: "discard", cardId: "joker-1" },
    });

    assert.equal(expectError(result).code, "CARD_NOT_PICKUP_ELIGIBLE");
  });

  it("rejects a turn taken by someone it is not the turn of", async () => {
    const host = await table.connect();
    const { roomCode } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    const other = await table.connect();
    const watcher = watch(other);
    expectOk(await ask(other, "joinRoom", roomCode, "Grace"));
    expectOk(await ask(host, "startGame"));
    // The host takes the first turn, so Grace acting now is out of turn.
    const view = await watcher.until((v) => v.phase === "playing", "the deal");

    const result = await ask(other, "takeTurn", {
      discardCardIds: [playingSelf(view).hand[0]!.id],
      draw: { source: "deck" },
    });

    assert.equal(expectError(result).code, "NOT_YOUR_TURN");
  });

  it("lets the player carry on after a rejected turn", async () => {
    const { client, watcher, view } = await sitDown();
    const me = view.you.id;
    expectError(
      await ask(client, "takeTurn", {
        discardCardIds: ["not-a-card"],
        draw: { source: "deck" },
      }),
    );
    watcher.reset();

    // The same hand is still there to play, and the turn is still theirs.
    expectOk(
      await ask(client, "takeTurn", {
        discardCardIds: [playingSelf(view).hand[0]!.id],
        draw: { source: "deck" },
      }),
    );

    await watcher.until((v) => v.currentTurnPlayerId === me, "the turn to come back");
  });

  /**
   * The whole point of the ticket: one connected player, no other humans, plays from the
   * deal to a finished match without anything else driving the table.
   *
   * The player's own moves are chosen with `decideTurn` — the same judgement the server
   * uses for the bots, but fed the player's view over the wire. It is standing in for a
   * client here, which is exactly what it was built to be able to do.
   */
  it("plays a full match through to a finished game", async () => {
    const { client, watcher, view } = await sitDown();
    const me = view.you.id;

    /** The player has something to do again: their turn, or a round to react to. */
    const settled = (v: PlayerGameView) =>
      v.phase !== "playing" || v.currentTurnPlayerId === me;

    let current = view;
    let roundsFinished = 0;

    for (let step = 0; step < 500 && current.phase !== "gameEnd"; step++) {
      if (current.phase === "roundEnd") {
        roundsFinished++;
        assertRoundIsSettled(current);

        watcher.reset();
        expectOk(await ask(client, "startNextRound"));
        current = await watcher.until(settled, "the next round to reach the player");
        continue;
      }

      assert.equal(current.currentTurnPlayerId, me, "it is the player's turn to act");
      const decision = decideTurn(current);

      watcher.reset();
      if (decision.type === "yaniv") {
        expectOk(await ask(client, "callYaniv"));
      } else {
        expectOk(await ask(client, "takeTurn", decision.action));
      }
      current = await watcher.until(settled, "the turn to come back, or the round to end");
    }

    assert.equal(current.phase, "gameEnd", "the match reached a finish");
    // More than one: the match has to survive being handed from round to round, which
    // a single round ending straight into a bust would never exercise.
    assert.ok(
      roundsFinished >= 2,
      `the match ran across several rounds (finished ${roundsFinished})`,
    );
    assert.equal(current.roundNumber, roundsFinished + 1, "every round was dealt");

    // Final standings: every hand revealed, and the winner is the last player left in the
    // match — not whoever is lowest, which is a different player often enough.
    assertRoundIsSettled(current);
    const table = [current.you, ...current.opponents];
    const survivors = table.filter((p) => p.outInRound === null);
    assert.deepEqual(
      survivors.map((p) => p.id),
      current.winnerIds,
      "the one player still in the match is the winner",
    );
    assert.equal(survivors.length, 1);
    for (const player of table) {
      if (player.outInRound === null) continue;
      assert.ok(
        player.score > current.settings.maxScore,
        `${player.name} went out over the room's limit`,
      );
    }
  });

  /** A finished round shows every hand, what each hand cost, and the new totals. */
  function assertRoundIsSettled(view: PlayerGameView): void {
    // Revealing every hand is the one thing this phase opens up. Reaching for the roster
    // to do it would bring the tokens along with the cards.
    assertNoResumeToken(view, `a ${view.phase} view`);
    const result = view.roundResult;
    assert.ok(result, "a finished round reports its result");
    // Exactly the players who played the round, which past an elimination is no longer
    // the whole table: `turnOrder` still names the round being looked at.
    assert.deepEqual(
      result.players.map((p) => p.playerId).sort(),
      [...view.turnOrder].sort(),
    );

    const shownScores = new Map(
      [view.you, ...view.opponents].map((p) => [p.id, p.score]),
    );
    for (const player of result.players) {
      assert.ok(player.hand.length > 0, `${player.name}'s hand was revealed`);
      assert.equal(typeof player.delta, "number");
      assert.equal(
        player.scoreAfter,
        shownScores.get(player.playerId),
        `${player.name}'s new total agrees with the standings`,
      );
    }
    assert.ok(
      result.players.some((p) => p.playerId === result.callerId),
      "the caller is among the revealed hands",
    );
    // `settings` is carried in every phase, `roundEnd` and `gameEnd` included — the
    // client reads `yanivThreshold` off it to decide what to offer. docs/adr/0006.
    assert.deepEqual(view.settings, {
      handSize: HAND_SIZE,
      yanivThreshold: YANIV_THRESHOLD,
      // This suite's own limit, not the shared default: what is being asserted is that
      // the room's settings ride along in every phase, whatever they are.
      ...SHORT_MATCH,
      botCount: MAX_PLAYERS - 1,
    });
  }

  /**
   * The serializer is unit tested for this, but the criterion is about what actually
   * goes down the wire — including the burst of broadcasts a run of bot turns produces,
   * which is the path most likely to reach for state directly and skip the serializer.
   */
  it("never puts another player's cards, the draw pile or a token on the wire", async () => {
    const { client, watcher, view } = await sitDown();
    const me = view.you.id;
    const everyCardId = createDeck().map((card) => card.id);

    watcher.reset();
    expectOk(
      await ask(client, "takeTurn", {
        discardCardIds: [playingSelf(view).hand[0]!.id],
        draw: { source: "deck" },
      }),
    );
    await watcher.until((v) => v.currentTurnPlayerId === me, "the turn to come back");
    assert.ok(watcher.seen.length > 1, "a run of bot turns was published");

    for (const published of watcher.seen) {
      assertNoResumeToken(published, "a broadcast mid-round");
      // Hands are revealed to everyone at roundEnd, where the rules require it.
      if (published.phase !== "playing") continue;

      const maySee = new Set(
        [...playingSelf(published).hand, ...published.lastDiscard].map((card) => card.id),
      );
      // A card taken off the face-up pile is public the moment before it is taken, so
      // `lastMove` is allowed to name it even once it has left the pile for a hand.
      const lastMove = published.lastMove;
      if (lastMove?.drawSource === "discard" && lastMove.drawnCard) {
        maySee.add(lastMove.drawnCard.id);
      }
      // The round's log names public cards of its own — a discarded set was face up when
      // it was laid, and stays namable once buried, that pile being a count on the wire to
      // keep payloads small rather than to keep a secret. So it is checked on its own
      // terms, entry by entry, and lifted out of the payload the rest of this asserts
      // over: widening `maySee` for it would excuse the same card ids everywhere else.
      for (const entry of published.moveHistory) {
        if (entry.kind === "slapdown") continue;
        if (entry.drawSource === "deck" && entry.playerId !== me) {
          assert.equal(entry.drawnCard, null, "a bot's deck draw was logged to us");
        }
      }
      const json = JSON.stringify({ ...published, moveHistory: [] });
      for (const cardId of everyCardId) {
        if (maySee.has(cardId)) continue;
        assert.ok(!json.includes(`"${cardId}"`), `${cardId} leaked into a broadcast`);
      }
      // The other half of the same rule: a card off the deck is a card of the mover's
      // hidden hand, so nobody else is told which one it was.
      if (lastMove?.drawSource === "deck" && lastMove.playerId !== me) {
        assert.equal(lastMove.drawnCard, null, "a bot's deck draw was named to us");
      }
      for (const opponent of published.opponents) {
        assert.ok(!("hand" in opponent), "an opponent was sent with a hand attached");
      }
    }
  });

  /**
   * Bot moves reach the log through the same transitions a human's do, so there is no
   * bot-specific code for this to exercise — only the fact that there isn't.
   */
  it("logs every move of the round, the bots' included, one entry per broadcast", async () => {
    const { client, watcher, view } = await sitDown();
    const me = view.you.id;
    assert.deepEqual(view.moveHistory, [], "a fresh deal has nothing to read back");

    watcher.reset();
    expectOk(
      await ask(client, "takeTurn", {
        discardCardIds: [playingSelf(view).hand[0]!.id],
        draw: { source: "deck" },
      }),
    );
    const back = await watcher.until(
      (v) => v.currentTurnPlayerId === me,
      "the turn to come back",
    );

    assert.equal(
      back.moveHistory.length,
      watcher.seen.length,
      "one logged move per published one",
    );
    assert.equal(back.moveHistory[0]!.playerId, me, "the player's own turn is first");
    assert.deepEqual(
      watcher.seen.map((published) => published.moveHistory.length),
      watcher.seen.map((_, index) => index + 1),
      "the log grew by one move at a time, in step with the broadcasts",
    );
  });

  it("sends each connection its own view of the same table", async () => {
    const host = await table.connect();
    const hostViews = watch(host);
    const { roomCode, playerId: hostId } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    const other = await table.connect();
    const otherViews = watch(other);
    const { playerId: otherId } = expectOk(
      await ask<{ playerId: string }>(other, "joinRoom", roomCode, "Grace"),
    );

    expectOk(await ask(host, "startGame"));

    const mine = await hostViews.until((v) => v.phase === "playing", "Ada's deal");
    const theirs = await otherViews.until((v) => v.phase === "playing", "Grace's deal");

    assert.equal(mine.you.id, hostId, "Ada is 'you' in her own view");
    assert.equal(theirs.you.id, otherId, "Grace is 'you' in hers");
    assert.notDeepEqual(playingSelf(mine).hand, playingSelf(theirs).hand, "and they hold different cards");
    assert.ok(
      mine.opponents.some((o) => o.id === otherId),
      "each sees the other as an opponent",
    );
  });

  it("rejects a Yaniv call from a hand that is worth too much", async () => {
    const { client, view } = await sitDown();
    assert.ok(
      handValue(playingSelf(view).hand) > YANIV_THRESHOLD,
      "the opening hand is above the threshold, as a five-card deal will be",
    );

    const result = await ask(client, "callYaniv");

    assert.equal(expectError(result).code, "YANIV_THRESHOLD_NOT_MET");
  });

  it("rejects starting the next round while one is still being played", async () => {
    const { client } = await sitDown();

    const result = await ask(client, "startNextRound");

    assert.equal(expectError(result).code, "WRONG_PHASE");
  });

  it("rejects playing from a connection that is not in a room", async () => {
    const stranger = await table.connect();

    assert.equal(expectError(await ask(stranger, "callYaniv")).code, "PLAYER_NOT_FOUND");
    assert.equal(
      expectError(await ask(stranger, "startNextRound")).code,
      "PLAYER_NOT_FOUND",
    );
    assert.equal(
      expectError(
        await ask(stranger, "takeTurn", {
          discardCardIds: ["hearts-2"],
          draw: { source: "deck" },
        }),
      ).code,
      "PLAYER_NOT_FOUND",
    );
  });
});

/**
 * Leaving a room deliberately, and starting the next match with whoever stayed.
 *
 * Both actions are only reachable from a position the table has to be driven into, so
 * this suite plays real matches out rather than hand-building states — the point is the
 * wire behaviour of a room that has genuinely finished a game.
 */
describe("play again and exit to menu", () => {
  let table: Harness;

  before(async () => {
    /*
     * One bot, not a full table of them. These suites play matches all the way out, and
     * only a player still in the match may deal the next round (docs/adr/0012): with two
     * bots or more the humans can all be knocked out while the bots play on, leaving a
     * table nobody at it may advance. One bot cannot outlast the humans that way — the
     * match is over the moment it is the only seat left.
     */
    table = await startServer(97, 1, { thinkTimeMs: 0 }, SHORT_MATCH);
  });
  after(async () => {
    await table.close();
  });

  interface Seat {
    client: ClientSocket;
    watcher: Watcher;
    id: string;
    name: string;
    /** The credential this seat was issued, so a test can try to come back to it. */
    resumeToken: string;
  }

  /** A host and, optionally, other humans, all sitting in the same fresh lobby. */
  async function openLobby(names: string[]): Promise<{ roomCode: string; seats: Seat[] }> {
    const [hostName, ...guestNames] = names;
    const client = await table.connect();
    const watcher = watch(client);
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        client,
        "createRoom",
        hostName!,
      ),
    );
    const seats: Seat[] = [
      {
        client,
        watcher,
        id: created.playerId,
        name: hostName!,
        resumeToken: created.resumeToken,
      },
    ];

    for (const name of guestNames) {
      const guest = await table.connect();
      const guestWatcher = watch(guest);
      const joined = expectOk(
        await ask<{ playerId: string; resumeToken: string }>(
          guest,
          "joinRoom",
          created.roomCode,
          name,
        ),
      );
      seats.push({
        client: guest,
        watcher: guestWatcher,
        id: joined.playerId,
        name,
        resumeToken: joined.resumeToken,
      });
    }

    return { roomCode: created.roomCode, seats };
  }

  /**
   * Turn this room's bot off before it is dealt, so the seats a test asserts over are
   * exactly the humans it sat down. The whole settings object goes, as the wire requires
   * (docs/adr/0006), read off the lobby the host is already looking at.
   */
  async function seatNoBots(host: Seat): Promise<void> {
    const lobby = await host.watcher.until((v) => v.phase === "lobby", "the lobby");
    expectOk(await ask(host.client, "updateSettings", { ...lobby.settings, botCount: 0 }));
  }

  /**
   * Play a table out to a finished match, acting for every human seat with `decideTurn` —
   * the same judgement the server gives its bots, fed each player's own view over the
   * wire, standing in for a client exactly as it does in the full-match test above.
   *
   * Every watcher is reset immediately before each action, so the views waited on
   * afterwards can only be ones the action itself produced.
   */
  /** Whether a seat is still in the match, read off whoever's view is to hand. */
  function stillPlaying(view: PlayerGameView, id: string): boolean {
    const seat = view.you.id === id ? view.you : view.opponents.find((o) => o.id === id);
    return seat?.outInRound === null;
  }

  async function playToGameEnd(seats: Seat[]): Promise<PlayerGameView> {
    const host = seats[0]!;
    // The lobby view the deal was preceded by is still in every watcher, and is
    // emphatically not a position anyone is being asked to act on.
    const waitingOnAHuman = (view: PlayerGameView) =>
      view.phase === "roundEnd" ||
      view.phase === "gameEnd" ||
      (view.phase === "playing" && seats.some((s) => s.id === view.currentTurnPlayerId));

    for (let step = 0; step < 500; step++) {
      const position = await host.watcher.until(waitingOnAHuman, "a human to be needed");
      if (position.phase === "gameEnd") return position;

      if (position.phase === "roundEnd") {
        for (const seat of seats) seat.watcher.reset();
        /*
         * Whichever of these seats is still in the match, which by now need not be the one
         * that made the room: nobody is host once the cards are out, and a player the match
         * has gone on without is refused with `NOT_IN_MATCH` (docs/adr/0012).
         */
        const dealer = seats.find((s) => stillPlaying(position, s.id));
        assert.ok(dealer, "somebody at this table can still deal the next round");
        expectOk(await ask(dealer.client, "startNextRound"));
        continue;
      }

      const actor = seats.find((s) => s.id === position.currentTurnPlayerId)!;
      const mine = await actor.watcher.until(
        (v) => v.phase === "playing" && v.currentTurnPlayerId === actor.id,
        `${actor.name}'s own view of their turn`,
      );
      const decision = decideTurn(mine);

      for (const seat of seats) seat.watcher.reset();
      if (decision.type === "yaniv") {
        expectOk(await ask(actor.client, "callYaniv"));
      } else {
        expectOk(await ask(actor.client, "takeTurn", decision.action));
      }
    }
    assert.fail("the match never reached a finish");
  }

  /** Sit one host down alone and play their match out against the bots. */
  async function finishedMatch(): Promise<{ roomCode: string; host: Seat }> {
    const { roomCode, seats } = await openLobby(["Ada"]);
    expectOk(await ask(seats[0]!.client, "startGame"));
    await playToGameEnd(seats);
    return { roomCode, host: seats[0]! };
  }

  describe("playAgain", () => {
    it("deals a fresh match in the same room, with every score back to zero", async () => {
      const { roomCode, host } = await finishedMatch();
      const finished = await host.watcher.until((v) => v.phase === "gameEnd", "the finish");
      assert.ok(
        [finished.you, ...finished.opponents].some(
          (p) => p.score > finished.settings.maxScore,
        ),
        "the match really did end on a bust",
      );

      host.watcher.reset();
      expectOk(await ask(host.client, "playAgain"));
      const restarted = await host.watcher.until((v) => v.phase === "playing", "the deal");

      assert.equal(restarted.roomCode, roomCode, "the room code does not change");
      assert.equal(restarted.roundNumber, 1);
      assert.equal(playingSelf(restarted).hand.length, HAND_SIZE);
      assert.deepEqual(
        [restarted.you, ...restarted.opponents].map((p) => p.score),
        // The seats this room actually has, whatever it was sat down with: what is being
        // asserted is that every one of them is back to zero.
        new Array(restarted.seating.length).fill(0),
        "nobody carries a score over from the last match",
      );
      assert.equal(restarted.winnerIds, null, "the old winner is no longer declared");
    });

    /**
     * Nobody is host by `gameEnd`, and anyone still in the room may deal another match —
     * whether or not the last one went on without them (docs/adr/0012).
     */
    it("is dealt by a player who is not the one who made the room", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      expectOk(await ask(seats[0]!.client, "startGame"));
      await playToGameEnd(seats);

      seats[1]!.watcher.reset();
      expectOk(await ask(seats[1]!.client, "playAgain"));

      const restarted = await seats[1]!.watcher.until(
        (v) => v.phase === "playing",
        "the deal",
      );
      assert.equal(restarted.roundNumber, 1);
    });

    /** A seat given up is nobody's to ask from, and leaving is final. */
    it("refuses a restart asked for by a seat that has been given up", async () => {
      const { seats } = await openLobby(["Ada", "Grace", "Alan"]);
      expectOk(await ask(seats[0]!.client, "startGame"));
      await playToGameEnd(seats);
      const leaver = seats[2]!;
      expectOk(await ask(leaver.client, "exitToMenu"));

      // The connection is out of the room too, so this is the same refusal a stranger
      // gets — the seat behind it is gone either way.
      const result = await ask(leaver.client, "playAgain");

      assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
    });

    it("rejects a restart before the match has finished", async () => {
      const { seats } = await openLobby(["Ada"]);
      expectOk(await ask(seats[0]!.client, "startGame"));

      const result = await ask(seats[0]!.client, "playAgain");

      assert.equal(expectError(result).code, "WRONG_PHASE");
    });

    /**
     * Only reachable at a table that was all humans to begin with: `startGame` fills any
     * empty seat with a bot, and a bot never leaves. Six players, five of whom exit, is
     * the one way the host can be left with nobody to play against.
     */
    it("rejects a restart once too few players are left to play", async () => {
      const { seats } = await openLobby(["Ada", "Grace", "Alan", "Tony", "Edsger", "Barbara"]);
      const [host, ...guests] = seats;
      expectOk(await ask(host!.client, "startGame"));
      await playToGameEnd(seats);

      for (const guest of guests) expectOk(await ask(guest.client, "exitToMenu"));
      const result = await ask(host!.client, "playAgain");

      assert.equal(expectError(result).code, "NOT_ENOUGH_PLAYERS");
    });

    it("rejects a restart from a connection that is not in a room", async () => {
      const stranger = await table.connect();

      const result = await ask(stranger, "playAgain");

      assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
    });
  });

  describe("exitToMenu", () => {
    it("frees only the leaver's seat when they are not the host", async () => {
      const { roomCode, seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;

      const announced = nextEvent<string>(host!.client, "playerLeft");
      host!.watcher.reset();
      expectOk(await ask(guest!.client, "exitToMenu"));

      assert.equal(await announced, "Grace", "whoever stays is told who left");
      const roster = await host!.watcher.until(
        (v) => v.opponents.length === 0,
        "the roster to shrink",
      );
      assert.equal(roster.phase, "lobby", "the lobby carries on for whoever remains");
      assert.equal(roster.roomCode, roomCode);

      // The room is still there to be joined, so the seat really was freed.
      const latecomer = await table.connect();
      expectOk(await ask(latecomer, "joinRoom", roomCode, "Alan"));
    });

    /**
     * The host leaving a lobby is a seat going, not a room ending (docs/adr/0012): the
     * room plays on for whoever remains, and the role moves to the next of them so
     * somebody can still start the match.
     */
    it("hands the lobby on when the one who made the room leaves it", async () => {
      const { roomCode, seats } = await openLobby(["Ada", "Grace", "Alan"]);
      const [host, ...guests] = seats;

      const announced = nextEvent<string>(guests[0]!.client, "playerLeft");
      for (const guest of guests) guest.watcher.reset();
      expectOk(await ask(host!.client, "exitToMenu"));

      assert.equal(await announced, "Ada", "whoever stays is told who left");
      const roster = await guests[0]!.watcher.until(
        (v) => v.seating.length === 2,
        "the roster to shrink",
      );
      assert.equal(roster.phase, "lobby", "the lobby carries on for whoever remains");
      assert.equal(roster.hostId, guests[0]!.id, "and the next seat is now its host");

      // Still there to be joined, and startable by its new host.
      const latecomer = await table.connect();
      expectOk(await ask(latecomer, "joinRoom", roomCode, "Tony"));
      expectOk(await ask(guests[0]!.client, "startGame"));
    });

    /**
     * The last *human* leaving is what ends a room, bots at the table or not: a bot never
     * departs and never asks for anything, so a table of them with nobody watching is a
     * room playing to no one — and, with no player left who could leave, one nothing else
     * would ever end (docs/adr/0012).
     */
    it("drops a room whose last human leaves, bots still seated", async () => {
      const { roomCode, seats } = await openLobby(["Ada"]);
      expectOk(await ask(seats[0]!.client, "startGame"));
      const finished = await playToGameEnd(seats);
      assert.ok(
        finished.opponents.some((o) => o.name.includes("(bot)")),
        "the table this is left with is a bot's",
      );

      expectOk(await ask(seats[0]!.client, "exitToMenu"));

      const latecomer = await table.connect();
      assert.equal(
        expectError(await ask(latecomer, "joinRoom", roomCode, "Tony")).code,
        "ROOM_NOT_FOUND",
      );
    });

    /** The other half: a room ends when the last seat in it goes, and not before. */
    it("drops a room whose last seat leaves", async () => {
      const { roomCode, seats } = await openLobby(["Ada"]);

      expectOk(await ask(seats[0]!.client, "exitToMenu"));

      const latecomer = await table.connect();
      assert.equal(
        expectError(await ask(latecomer, "joinRoom", roomCode, "Tony")).code,
        "ROOM_NOT_FOUND",
      );
    });

    it("leaves the finished match standing for whoever stays", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;
      expectOk(await ask(host!.client, "startGame"));
      await playToGameEnd(seats);

      host!.watcher.reset();
      expectOk(await ask(guest!.client, "exitToMenu"));
      // The seat is marked rather than spliced out: from the first deal a roster is
      // append-only, so the match keeps the record of who played it.
      const standings = await host!.watcher.until(
        (v) => v.opponents.some((o) => o.id === guest!.id && o.departed),
        "the seat to be marked as given up",
      );

      assert.equal(standings.phase, "gameEnd", "the scoreboard is still on screen");
      assert.ok(standings.winnerIds, "and still reports who won");
    });

    /**
     * Leaving is final, and the server is what says so. A roster is append-only from the
     * first deal, so a seat given up keeps its place — and its resume token with it — long
     * after its player has gone; the credential a stale tab is still holding must not be
     * enough to sit back down at it.
     */
    it("refuses to resume a seat that has been given up", async () => {
      const { roomCode, seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;
      expectOk(await ask(host!.client, "startGame"));
      await playToGameEnd(seats);
      expectOk(await ask(guest!.client, "exitToMenu"));

      const returning = await table.connect();
      const result = await ask(returning, "resumeSeat", {
        roomCode,
        playerId: guest!.id,
        resumeToken: guest!.resumeToken,
      });

      // The same code a wrong token gets: a room code is not a way of finding out which
      // of its seats have been given up.
      assert.equal(expectError(result).code, "INVALID_RESUME_TOKEN");
    });

    /**
     * And identically once a match has been played: the seat that made the room is no
     * more special at `gameEnd` than at any other point, the role having retired at the
     * first deal (docs/adr/0012).
     */
    it("leaves a finished match standing when the one who made the room leaves it", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      expectOk(await ask(seats[0]!.client, "startGame"));
      await playToGameEnd(seats);

      seats[1]!.watcher.reset();
      expectOk(await ask(seats[0]!.client, "exitToMenu"));

      const standings = await seats[1]!.watcher.until(
        (v) => v.opponents.some((o) => o.id === seats[0]!.id && o.departed),
        "the seat to be marked as given up",
      );
      assert.equal(standings.phase, "gameEnd", "the scoreboard is still on screen");
      assert.equal(standings.hostId, null, "and nobody is host at a table mid-match");
    });

    /**
     * A seat given up is given up for good. `playAgain` deliberately does not seat a bot
     * in it the way `startGame` fills an untouched lobby.
     */
    it("never refills a vacated seat with a bot on the next match", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;
      expectOk(await ask(host!.client, "startGame"));
      await playToGameEnd(seats);
      expectOk(await ask(guest!.client, "exitToMenu"));

      host!.watcher.reset();
      expectOk(await ask(host!.client, "playAgain"));
      const restarted = await host!.watcher.until((v) => v.phase === "playing", "the deal");

      assert.equal(
        restarted.turnOrder.length,
        // Two humans and a bot, one human gone: nothing has moved into the empty seat.
        2,
        "the table is one seat smaller, and no bot moved in",
      );
      assert.ok(
        !restarted.turnOrder.includes(guest!.id),
        "the player who left is not back at the table",
      );
      assert.equal(
        restarted.opponents.find((o) => o.id === guest!.id)!.departed,
        true,
        "their seat is still listed, and still marked as given up",
      );
    });

    it("frees the connection to create or join another room", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;
      expectOk(await ask(guest!.client, "exitToMenu"));

      // Both halves of "as good as a fresh connection": the leaver may open their own
      // room, and the host, once they close theirs, may go and join it.
      const opened = expectOk(
        await ask<{ roomCode: string; playerId: string }>(
          guest!.client,
          "createRoom",
          "Grace",
        ),
      );
      expectOk(await ask(host!.client, "exitToMenu"));
      expectOk(await ask(host!.client, "joinRoom", opened.roomCode, "Ada"));
    });

    /**
     * Mid-round, over the wire (issue #147). Nobody is trapped at a table that has gone
     * quiet, and whoever stays is told a seat has gone rather than left wondering why the
     * hand in front of them has shrunk by one.
     */
    it("lets a player leave mid-round, and tells the table they have gone", async () => {
      const { seats } = await openLobby(["Ada", "Grace", "Alan"]);
      const [host, guest] = seats;
      // No bot, so the seats this asserts over are exactly the three humans above.
      await seatNoBots(host!);
      expectOk(await ask(host!.client, "startGame"));
      await host!.watcher.until((v) => v.phase === "playing", "the deal");

      const announced = nextEvent<string>(host!.client, "playerLeft");
      host!.watcher.reset();
      expectOk(await ask(guest!.client, "exitToMenu"));

      assert.equal(await announced, "Grace");
      const table = await host!.watcher.until(
        (v) => v.opponents.some((o) => o.id === guest!.id && o.departed),
        "the seat to be marked as given up",
      );
      assert.equal(table.phase, "playing", "the round carries on for whoever stayed");
      assert.ok(!table.turnOrder.includes(guest!.id), "and it is played without them");
      assert.ok(
        table.seating.includes(guest!.id),
        "the seat keeps its place at the table it played at",
      );
    });

    /**
     * A departure is now the second way a match ends — until this, every exit from
     * `playing` went through a Yaniv call. There is no round left to deal to one person.
     */
    it("ends the match when leaving mid-round leaves one player in it", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;
      await seatNoBots(host!);
      expectOk(await ask(host!.client, "startGame"));
      await host!.watcher.until((v) => v.phase === "playing", "the deal");

      host!.watcher.reset();
      expectOk(await ask(guest!.client, "exitToMenu"));

      const finished = await host!.watcher.until(
        (v) => v.phase === "gameEnd",
        "the match to end on the departure",
      );
      assert.deepEqual(finished.winnerIds, [host!.id], "the player left standing wins it");
    });

    /**
     * The turn moving on is only half of not wedging: where it moves on *to* a bot, the
     * server has to play it, exactly as it does when a turn is handed over by a move.
     */
    it("plays the bot's turn when the departure hands it one", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      const [host, guest] = seats;
      // The suite's own room: two humans and the one bot, seated in that order, so the
      // seat after Grace is the bot's and her leaving is what hands it the turn.
      expectOk(await ask(host!.client, "startGame"));
      const dealt = await host!.watcher.until((v) => v.phase === "playing", "the deal");

      // Bots play with no think time here, so the turn only ever comes to rest on a human:
      // one turn from the host at most puts it on the seat about to be given up.
      if (dealt.currentTurnPlayerId === host!.id) {
        host!.watcher.reset();
        const decision = decideTurn(dealt);
        if (decision.type !== "turn") assert.fail("the opening hand is not a Yaniv call");
        expectOk(await ask(host!.client, "takeTurn", decision.action));
      }
      await host!.watcher.until(
        (v) => v.phase === "playing" && v.currentTurnPlayerId === guest!.id,
        "the turn to reach the seat that is leaving",
      );

      host!.watcher.reset();
      expectOk(await ask(guest!.client, "exitToMenu"));

      // Without the bot being run the table would sit on a turn belonging to a seat with
      // no connection behind it, and this would time out.
      await host!.watcher.until(
        (v) => v.phase !== "playing" || v.currentTurnPlayerId === host!.id,
        "the bot to take the turn the departure handed it",
      );
    });

    it("rejects a leave from a connection that is not in a room", async () => {
      const stranger = await table.connect();

      const result = await ask(stranger, "exitToMenu");

      assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
    });
  });
});

/**
 * Slapping down, and the race for the window it opens.
 *
 * Two humans seated next to each other is the arrangement this suite races in, because it
 * is the one that does not depend on a clock: Ada acts, Grace is next, and the window stays
 * open until she moves, whatever the server's bot think time is set to. Racing a bot is a
 * race against that pause, and is asserted on a clock of its own in "bot think time" below.
 *
 * The window itself cannot be arranged — it is opened by drawing blind off the deck —
 * so the table is played on a seeded server until one appears, and every test here
 * starts from the position that produced it.
 */
describe("slapping down", () => {
  let table: Harness;

  before(async () => {
    /*
     * A max score no run of fishing rounds reaches, so nobody is eliminated while this
     * suite hunts for a window. Not because elimination is unwelcome, but because a table
     * whose humans are all out has nobody left who may deal the next round
     * (docs/adr/0012) — and the fishing below would stall there, on a rule this suite is
     * not about.
     *
     * And no bots: the fishing needs Grace to play directly after Ada, which a table of
     * two is whatever the seating the deal draws (docs/rules.md §2).
     */
    table = await startServer(20250811, 0, undefined, LONG_MATCH);
  });
  after(async () => {
    await table.close();
  });

  interface Seat {
    client: ClientSocket;
    watcher: Watcher;
    id: string;
    name: string;
    /** Every view this seat was ever sent, never reset — what the wire actually said. */
    heard: PlayerGameView[];
  }

  function seat(client: ClientSocket, id: string, name: string): Seat {
    const heard: PlayerGameView[] = [];
    client.on("gameStateUpdate", (view: PlayerGameView) => heard.push(view));
    return { client, watcher: watch(client), id, name, heard };
  }

  /**
   * A card worth discarding to fish for a window: one whose rank the player holds only
   * once, since every copy still in hand is a copy that cannot come back off the deck.
   * Jokers are skipped outright — a drawn joker never opens a window.
   */
  function fishingDiscard(view: PlayerGameView): string {
    const hand = playingSelf(view).hand;
    const lonely = hand.find(
      (c) => c.suit !== null && hand.filter((o) => o.rank === c.rank).length === 1,
    );
    return (lonely ?? hand[0]!).id;
  }

  interface OpenWindow {
    ada: Seat;
    grace: Seat;
    /** Ada's view of her own open window, with the turn already on Grace. */
    adaView: PlayerGameView;
    /** Grace's view of the same position — the one she takes her turn from. */
    graceView: PlayerGameView;
  }

  /**
   * Sit Ada and Grace down and play until Ada draws a card she may slap down, leaving
   * the table exactly there: her window open, the turn on Grace, nothing else moved.
   */
  async function playToAnOpenWindow(): Promise<OpenWindow> {
    const adaClient = await table.connect();
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string }>(adaClient, "createRoom", "Ada"),
    );
    const ada = seat(adaClient, created.playerId, "Ada");

    const graceClient = await table.connect();
    const joined = expectOk(
      await ask<{ playerId: string }>(graceClient, "joinRoom", created.roomCode, "Grace"),
    );
    const grace = seat(graceClient, joined.playerId, "Grace");

    expectOk(await ask(ada.client, "startGame"));

    /** Wait for the position this seat is being asked to act on. */
    const waitFor = (of: Seat, what: string) =>
      of.watcher.until(
        (v) => v.phase !== "playing" || v.currentTurnPlayerId === of.id,
        what,
      );

    for (let step = 0; step < 400; step++) {
      const position = await ada.watcher.until(
        (v) =>
          v.phase !== "playing" ||
          v.currentTurnPlayerId === ada.id ||
          v.currentTurnPlayerId === grace.id,
        "a human to be needed",
      );

      if (position.phase === "gameEnd") {
        // The match ran out before a window turned up. Deal another and carry on:
        // the fishing is what takes the time, not any one match.
        ada.watcher.reset();
        grace.watcher.reset();
        expectOk(await ask(ada.client, "playAgain"));
        continue;
      }
      if (position.phase === "roundEnd") {
        ada.watcher.reset();
        grace.watcher.reset();
        expectOk(await ask(ada.client, "startNextRound"));
        continue;
      }

      const actor = position.currentTurnPlayerId === ada.id ? ada : grace;
      const mine = await waitFor(actor, `${actor.name}'s own view of her turn`);
      ada.watcher.reset();
      grace.watcher.reset();
      expectOk(
        await ask(actor.client, "takeTurn", {
          discardCardIds: [fishingDiscard(mine)],
          draw: { source: "deck" },
        }),
      );

      if (actor !== ada) continue;

      // Ada has just drawn. Grace is next and is a person, so if that draw opened a
      // window it is still open, and will stay open until she acts.
      const adaView = await ada.watcher.until(
        (v) => v.phase !== "playing" || v.currentTurnPlayerId === grace.id,
        "the turn to pass to Grace",
      );
      if (!slapdownOpen(adaView)) continue;

      const graceView = await waitFor(grace, "Grace's view of the same position");
      return { ada, grace, adaView, graceView };
    }
    assert.fail("no slapdown window ever opened");
  }

  /** Take Grace's turn, from the view she is holding. */
  const graceTakesHerTurn = (grace: Seat, graceView: PlayerGameView) =>
    ask(grace.client, "takeTurn", {
      discardCardIds: [playingSelf(graceView).hand[0]!.id],
      draw: { source: "deck" },
    });

  it("puts the drawn card back down without moving the turn on", async () => {
    const { ada, grace, adaView } = await playToAnOpenWindow();
    ada.watcher.reset();

    expectOk(await ask(ada.client, "slapDown"));

    const after = await ada.watcher.until(
      (v) => playingSelf(v).hand.length === playingSelf(adaView).hand.length - 1,
      "Ada's hand to shrink",
    );
    const slapped = after.lastDiscard.at(-1)!;
    assert.equal(after.lastDiscard.length, adaView.lastDiscard.length + 1);
    assert.equal(
      slapped.rank,
      adaView.lastDiscard[0]!.rank,
      "the slapped card joined the set it matches",
    );
    assert.ok(
      playingSelf(adaView).hand.some((c) => c.id === slapped.id),
      "the card it went down from was the one she had just drawn",
    );
    assert.ok(
      !playingSelf(after).hand.some((c) => c.id === slapped.id),
      "and it left the hand it came from",
    );
    assert.equal(after.currentTurnPlayerId, grace.id, "a slapdown is not a turn");
    assert.equal(slapdownOpen(after), false, "the window closed behind it");
  });

  /**
   * The fact a client watches a slapdown by, over a real connection: the seat it came out
   * of, which no diff of two positions could name. Told to everyone alike and unredacted —
   * the card is on the face-up pile by the time it is sent. docs/adr/0008.
   */
  it("names the slapper and the card to both seats alike", async () => {
    const { ada, grace, adaView } = await playToAnOpenWindow();
    ada.watcher.reset();
    grace.watcher.reset();

    expectOk(await ask(ada.client, "slapDown"));

    for (const seat of [ada, grace]) {
      const after = await seat.watcher.until(
        (v) => v.lastSlapdown !== null,
        `${seat.name} to be told about the slapdown`,
      );
      assert.equal(after.lastSlapdown!.playerId, ada.id);
      assert.equal(after.lastSlapdown!.card.id, after.lastDiscard.at(-1)!.id);
      assert.ok(
        playingSelf(adaView).hand.some((c) => c.id === after.lastSlapdown!.card.id),
        `${seat.name} was told a card that never came out of Ada's hand`,
      );
    }
  });

  it("says nothing about a slapdown before one is made", async () => {
    const { adaView, graceView } = await playToAnOpenWindow();

    assert.equal(adaView.lastSlapdown, null);
    assert.equal(graceView.lastSlapdown, null, "an open window is not a slapdown");
  });

  it("refuses a second slap once the window is used up", async () => {
    const { ada } = await playToAnOpenWindow();
    expectOk(await ask(ada.client, "slapDown"));

    const result = await ask(ada.client, "slapDown");

    assert.equal(expectError(result).code, "SLAPDOWN_NOT_AVAILABLE");
  });

  it("refuses a slap from anyone the window does not belong to", async () => {
    const { grace } = await playToAnOpenWindow();

    const result = await ask(grace.client, "slapDown");

    assert.equal(expectError(result).code, "SLAPDOWN_NOT_AVAILABLE");
  });

  /**
   * The race, resolved by nothing more than the order the two events arrive in
   * (ADR-0005). Losing it looks exactly like never having had a window.
   *
   * Either refusal counts, and the pair is the whole set: the round may have been scored
   * out from under the slap before it landed. That is the same news to Ada — the window
   * is spent and her hand is untouched, which is what the assertions below actually turn
   * on.
   */
  it("turns away a slap the next player's turn got in ahead of", async () => {
    const { ada, grace, adaView, graceView } = await playToAnOpenWindow();
    ada.watcher.reset();
    expectOk(await graceTakesHerTurn(grace, graceView));

    const result = await ask(ada.client, "slapDown");

    assert.ok(
      ["SLAPDOWN_NOT_AVAILABLE", "WRONG_PHASE"].includes(expectError(result).code),
      `a lost race is refused, got ${expectError(result).code}`,
    );
    const after = await ada.watcher.until(
      (v) => v.phase !== "playing" || v.currentTurnPlayerId !== grace.id,
      "Grace's turn to be played out",
    );
    assert.equal(
      playingSelf(after).hand.length,
      playingSelf(adaView).hand.length,
      "the refused slap left Ada holding what she had",
    );
    assert.equal(slapdownOpen(after), false, "and no window to try again with");
  });

  /**
   * Both events in flight at once, with nothing arbitrating them but the event loop.
   * Whichever order the server happens to take them in, the outcome has to be one of
   * the two whole ones: the slap landed and Ada is a card lighter, or it was refused
   * and she is not. Grace's turn stands either way — it was hers to take.
   */
  it("resolves a genuine race one way or the other, never half of each", async () => {
    const { ada, grace, adaView, graceView } = await playToAnOpenWindow();
    ada.watcher.reset();

    const slapping = ask(ada.client, "slapDown");
    const turning = graceTakesHerTurn(grace, graceView);
    const [slap, turn] = await Promise.all([slapping, turning]);

    expectOk(turn);
    const expectedHand = slap.ok
      ? playingSelf(adaView).hand.length - 1
      : playingSelf(adaView).hand.length;
    if (!slap.ok) assert.equal(slap.error.code, "SLAPDOWN_NOT_AVAILABLE");
    const after = await ada.watcher.until(
      (v) => v.phase !== "playing" || v.currentTurnPlayerId !== grace.id,
      "the position both actions left behind",
    );
    assert.equal(
      playingSelf(after).hand.length,
      expectedHand,
      "Ada's hand agrees with the ack she was given",
    );
    // Whoever went first, the window is spent: no order of arrival leaves it open behind
    // both of them.
    assert.equal(slapdownOpen(after), false);
  });

  /**
   * The serializer is unit tested for this; here it is the wire that is under test.
   * An open window says its holder drew a rank they had just discarded, so it must
   * never appear in anyone else's payload, in any shape.
   *
   * Grace's own windows are hers to be told about — at a table of two she opens them too,
   * fishing — so what is checked on her side is her view of the position Ada's window is
   * open in, and that no opponent entry ever carries the flag at all.
   */
  it("never tells the rest of the table that a window is open", async () => {
    const { ada, grace, adaView, graceView } = await playToAnOpenWindow();

    assert.ok(slapdownOpen(adaView), "Ada really was told about her own window");
    assert.equal(slapdownOpen(graceView), false, "Grace was told about Ada's window");
    assert.ok(
      !JSON.stringify(graceView).includes('"slapdownEligible":true'),
      "Ada's open window leaked into Grace's payload",
    );
    for (const view of [...ada.heard, ...grace.heard]) {
      for (const opponent of view.opponents) {
        assert.ok(
          !("slapdownEligible" in opponent),
          "an opponent arrived carrying an eligibility flag",
        );
      }
    }
  });

  it("rejects a slap from a connection that is not in a room", async () => {
    const stranger = await table.connect();

    const result = await ask(stranger, "slapDown");

    assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
  });
});

/**
 * The pause a bot takes before its turn, and what a human can do inside it.
 *
 * Every server here is built with a clock the test drives by hand, which is the only way
 * to assert a turn has *not* happened yet as precisely as that it has — a suite that
 * waited on real time could only ever say "not for a while yet". Each test gets its own
 * server, since a clock with somebody else's timer on it is a clock that ticks the wrong
 * one.
 *
 * Nothing here reaches for the runner. What is under test is what a client can see: when
 * a position arrives relative to the clock, and what is in it.
 */
describe("bot think time", () => {
  /** A lone human at a table of bots, on a clock nothing moves but this test. */
  interface Table {
    close: () => Promise<void>;
    clock: TestClock;
    client: ClientSocket;
    watcher: Watcher;
    me: string;
    /** The opening position: the deal, whoever it landed on. */
    view: PlayerGameView;
  }

  async function sitDown(seed?: number): Promise<Table> {
    const clock = testClock();
    // A limit no run of rounds reaches (`LONG_MATCH`): these tables are one human against
    // five bots and some of them play a great many rounds fishing for a position. A human
    // knocked out along the way could not deal the next round (docs/adr/0012), and the
    // fishing would stall on a rule none of this is about.
    const harness = await startServer(
      seed,
      MAX_PLAYERS - 1,
      { clock, thinkTimeMs: BOT_THINK_MS },
      LONG_MATCH,
    );
    const client = await harness.connect();
    const watcher = watch(client);
    const { playerId } = expectOk(
      await ask<{ playerId: string }>(client, "createRoom", "Ada"),
    );
    expectOk(await ask(client, "startGame"));
    const view = await watcher.until((v) => v.phase === "playing", "the deal");
    return { close: harness.close, clock, client, watcher, me: playerId, view };
  }

  /**
   * The seat `n` places behind the human in turn order. Counted from the human rather than
   * from the front, the seating being drawn at the deal (docs/rules.md §2).
   */
  function behind(t: Table, n: number): string {
    const order = t.view.turnOrder;
    return order[(order.indexOf(t.me) + n) % order.length]!;
  }

  /**
   * A full round trip through the server, so "nothing was published" is a fact rather
   * than a guess: a socket delivers in order, so anything broadcast before this ack was
   * sent has already arrived by the time it comes back.
   */
  async function roundTrip(t: Table): Promise<void> {
    // Refused, and deliberately: a rejection publishes nothing of its own.
    expectError(await ask(t.client, "startNextRound"));
  }

  /**
   * Let the thinking bot play, and answer the position it produced.
   *
   * The interval it asked for is checked on every tick, which is where "every bot waits
   * the same interval, every time" is actually asserted — a chain that hurried its later
   * moves would look identical from the outside.
   */
  async function think(t: Table): Promise<PlayerGameView> {
    const before = t.watcher.seen.length;
    assert.equal(t.clock.pending(), 1, "exactly one bot was thinking");
    assert.equal(t.clock.tick(), BOT_THINK_MS, "the interval every bot waits");

    const deadline = Date.now() + 2000;
    while (t.watcher.seen.length === before) {
      if (Date.now() > deadline) assert.fail("no move arrived once think time elapsed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return t.watcher.seen[before]!;
  }

  /** Play every bot the table is waiting on, back round to the human or the score. */
  async function advanceBots(t: Table): Promise<void> {
    while (t.clock.pending() > 0) await think(t);
  }

  /** The host's turn, taken by shedding one card and drawing blind. */
  async function takeATurn(t: Table, from: PlayerGameView): Promise<void> {
    expectOk(
      await ask(t.client, "takeTurn", {
        discardCardIds: [fishingDiscard(from)],
        draw: { source: "deck" },
      }),
    );
  }

  /**
   * A card worth discarding to fish for a window: one whose rank the player holds only
   * once, since every copy still in hand is a copy that cannot come back off the deck.
   */
  function fishingDiscard(view: PlayerGameView): string {
    const hand = playingSelf(view).hand;
    const lonely = hand.find(
      (c) => c.suit !== null && hand.filter((o) => o.rank === c.rank).length === 1,
    );
    return (lonely ?? hand[0]!).id;
  }

  it("leaves a bot's turn unplayed in the tick that handed it over", async () => {
    const t = await sitDown(4242);
    try {
      assert.equal(t.view.currentTurnPlayerId, t.me, "the host takes the first turn");
      t.watcher.reset();

      await takeATurn(t, t.view);

      const handedOver = await t.watcher.until(
        (v) => v.currentTurnPlayerId !== t.me,
        "the turn to pass to the bot behind me",
      );
      await roundTrip(t);
      assert.equal(
        t.watcher.seen.length,
        1,
        "the bot moved in the same tick as the turn that handed it over",
      );
      assert.equal(handedOver.currentTurnPlayerId, behind(t, 1));
    } finally {
      await t.close();
    }
  });

  it("plays it once think time has elapsed", async () => {
    const t = await sitDown(4242);
    try {
      t.watcher.reset();
      await takeATurn(t, t.view);
      await t.watcher.until((v) => v.currentTurnPlayerId !== t.me, "the handover");

      const played = await think(t);

      assert.equal(
        played.currentTurnPlayerId,
        behind(t, 2),
        "the first bot played and handed on to the second",
      );
    } finally {
      await t.close();
    }
  });

  it("advances a chain one turn per interval, in seating order", async () => {
    const t = await sitDown(4242);
    try {
      t.watcher.reset();
      await takeATurn(t, t.view);
      await t.watcher.until((v) => v.currentTurnPlayerId !== t.me, "the handover");

      // Every seat behind the host, one tick at a time. `think` asserts a single timer
      // was waiting for each, so nothing here can be two moves in one beat.
      const seats: (string | null)[] = [];
      for (let i = 0; i < MAX_PLAYERS - 1; i++) {
        const played = await think(t);
        assert.equal(t.watcher.seen.length, i + 2, "one broadcast per beat");
        seats.push(played.currentTurnPlayerId);
      }

      assert.deepEqual(
        seats,
        [2, 3, 4, 5, 6].map((n) => behind(t, n)),
        "each bot in turn, and the turn back to the human",
      );
      assert.equal(t.clock.pending(), 0, "nothing is left thinking behind the human");
    } finally {
      await t.close();
    }
  });

  /**
   * The pause is a property of a bot's turn, not of a turn following a human's. An
   * unseeded server is dealt until the opening seat is a bot — which is most of them,
   * five in six — because the same seed always opens on the same seat.
   */
  it("pauses before the first move of a round that opens on a bot", async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const t = await sitDown();
      try {
        if (t.view.currentTurnPlayerId === t.me) continue;

        t.watcher.reset();
        await roundTrip(t);
        assert.equal(t.watcher.seen.length, 0, "the opening bot has not moved");

        const opener = t.view.turnOrder.indexOf(t.view.currentTurnPlayerId!);
        const opened = await think(t);
        assert.equal(
          opened.currentTurnPlayerId,
          t.view.turnOrder[(opener + 1) % t.view.turnOrder.length],
          "the opening bot played, once it had thought about it, and handed on",
        );
        return;
      } finally {
        await t.close();
      }
    }
    assert.fail("no deal ever opened on a bot");
  });

  /**
   * The whole of what makes slapdown against a bot winnable, and the reason this and
   * #125 were one change: there is no window timer, only the pause the next bot takes.
   *
   * The window cannot be arranged — it is opened by drawing blind — so the table is
   * fished until one appears, the bots played out by hand along the way.
   */
  describe("the window it holds open", () => {
    /** Play until the host draws a card they may slap down, and stop exactly there. */
    async function fishForAWindow(t: Table): Promise<PlayerGameView> {
      for (let step = 0; step < 400; step++) {
        // A deal that opened on a bot, or a chain still owed a beat: the loop below only
        // ever waits on a position, so nothing may be left waiting on the clock.
        await advanceBots(t);
        const at = await t.watcher.until(
          // The lobby is still in the watcher on the first pass through, and is not a
          // position anybody is being asked to act on.
          (v) =>
            v.phase !== "lobby" &&
            (v.phase !== "playing" || v.currentTurnPlayerId === t.me),
          "the host to be needed",
        );
        t.watcher.reset();

        if (at.phase === "gameEnd") {
          expectOk(await ask(t.client, "playAgain"));
          continue;
        }
        if (at.phase === "roundEnd") {
          expectOk(await ask(t.client, "startNextRound"));
          continue;
        }

        await takeATurn(t, at);
        const landed = await t.watcher.until(
          (v) => v.phase !== "playing" || v.currentTurnPlayerId !== t.me,
          "the host's own move to land",
        );
        if (landed.phase === "playing" && slapdownOpen(landed)) return landed;
      }
      assert.fail("no slapdown window ever opened");
    }

    it("lets a human win a window the bot behind them is still thinking in", async () => {
      const t = await sitDown(20250811);
      try {
        const open = await fishForAWindow(t);
        t.watcher.reset();

        expectOk(await ask(t.client, "slapDown"));

        const after = await t.watcher.until(
          (v) => v.lastSlapdown !== null,
          "the slap to land",
        );
        assert.equal(after.lastSlapdown!.playerId, t.me);
        assert.equal(
          playingSelf(after).hand.length,
          playingSelf(open).hand.length - 1,
          "the drawn card went back down",
        );
        assert.equal(
          after.currentTurnPlayerId,
          open.currentTurnPlayerId,
          "and the bot it beat has still not moved",
        );
      } finally {
        await t.close();
      }
    });

    it("neither hurries the pending turn nor schedules a second", async () => {
      const t = await sitDown(20250811);
      try {
        await fishForAWindow(t);
        t.watcher.reset();

        expectOk(await ask(t.client, "slapDown"));
        await roundTrip(t);

        assert.equal(t.watcher.seen.length, 1, "only the slap itself was published");
        assert.equal(t.clock.pending(), 1, "one pending turn, not two");
        const played = await think(t);
        assert.equal(t.watcher.seen.length, 2, "and the beat played exactly one move");
        assert.notEqual(played.lastMove, null, "which was a turn, taken by the bot");
      } finally {
        await t.close();
      }
    });

    it("plays the bot's turn against the position the slap produced", async () => {
      const t = await sitDown(20250811);
      try {
        const open = await fishForAWindow(t);
        const slapped = playingSelf(open).hand.find((c) => c.rank === open.lastDiscard[0]!.rank);
        assert.ok(slapped, "the window is over a card matching the set it would join");
        t.watcher.reset();

        expectOk(await ask(t.client, "slapDown"));
        await t.watcher.until((v) => v.lastSlapdown !== null, "the slap to land");
        const played = await think(t);

        // The round's own log, which the bot's turn is written into after the slap: the
        // card was on the pile, in front of it, when it decided.
        const since = played.moveHistory.slice(-2);
        assert.deepEqual(
          since.map((entry) => entry.kind),
          ["slapdown", "turn"],
          "the bot moved after the slap, not around it",
        );
        assert.equal(since[0]!.playerId, t.me);
        assert.equal(
          since[0]!.kind === "slapdown" && since[0]!.card.id,
          slapped.id,
          "and it is the slapped card the bot was looking at",
        );
      } finally {
        await t.close();
      }
    });
  });

  /*
   * A pending turn being called off with the room it belongs to has no test here any
   * more, and there is nowhere left to write one from: the host's close-room button was
   * what ended a room mid-think, and it is gone (docs/adr/0012). A room now ends when its
   * last seat leaves, which is only permitted from the lobby or a finished match — neither
   * of which has a bot thinking in it. The cancellation itself is unchanged and still one
   * call on the registry (`destroyRoom` in socketServer.ts); the seam to assert it from
   * comes back with mid-round leaving (#147) and the abandoned-room sweep (#150).
   */
});

/**
 * Coming back to a seat after the connection holding it has gone.
 *
 * Every phase is exercised, because a resume is only worth having if it works from the
 * one the player happened to drop in — and the four differ in what a view even contains.
 * The table is driven into each of them by playing it, on a seeded server, rather than
 * by reaching behind the wire for a state to hand out.
 */
describe("resumeSeat", () => {
  let table: Harness;

  /*
   * One bot, so the human the tables below are played by cannot be knocked out while play
   * goes on without them — which would leave nobody able to deal the next round
   * (docs/adr/0012) and `playTo` stalled short of `gameEnd`. With a bot, the first
   * elimination is the match's end, whatever the seed deals.
   */
  before(async () => {
    table = await startServer(4242, 1);
  });
  after(async () => {
    await table.close();
  });

  /** A seat and the credential for it: everything a client needs to come back. */
  interface Held {
    client: ClientSocket;
    watcher: Watcher;
    roomCode: string;
    playerId: string;
    resumeToken: string;
  }

  async function seated(name = "Ada"): Promise<Held> {
    const client = await table.connect();
    const watcher = watch(client);
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        client,
        "createRoom",
        name,
      ),
    );
    return { client, watcher, ...created };
  }

  /** What a resuming client sends, so a test can spread it and bend one field. */
  function credentials(seat: Held): ResumeRequest {
    return {
      roomCode: seat.roomCode,
      playerId: seat.playerId,
      resumeToken: seat.resumeToken,
    };
  }

  function resume(client: ClientSocket, request: ResumeRequest) {
    return ask<{ view: PlayerGameView }>(client, "resumeSeat", request);
  }

  /**
   * Play a solo host's table forward until it stands in `target`, acting with the same
   * judgement the server gives its bots. The lobby is not reachable this way and does
   * not need to be — it is where every table already is.
   */
  async function playTo(
    seat: Held,
    target: "playing" | "roundEnd" | "gameEnd",
  ): Promise<PlayerGameView> {
    const settled = (view: PlayerGameView) =>
      view.phase !== "lobby" &&
      (view.phase !== "playing" || view.currentTurnPlayerId === seat.playerId);

    seat.watcher.reset();
    expectOk(await ask(seat.client, "startGame"));

    for (let step = 0; step < 500; step++) {
      const current = await seat.watcher.until(settled, "the player to be needed");
      if (current.phase === target) return current;

      seat.watcher.reset();
      if (current.phase === "roundEnd") {
        expectOk(await ask(seat.client, "startNextRound"));
        continue;
      }
      assert.notEqual(current.phase, "gameEnd", `the match ended before ${target}`);

      const decision = decideTurn(current);
      if (decision.type === "yaniv") {
        expectOk(await ask(seat.client, "callYaniv"));
      } else {
        expectOk(await ask(seat.client, "takeTurn", decision.action));
      }
    }
    assert.fail(`the table never reached ${target}`);
  }

  async function driveTo(
    seat: Held,
    phase: "lobby" | "playing" | "roundEnd" | "gameEnd",
  ): Promise<PlayerGameView> {
    if (phase !== "lobby") return playTo(seat, phase);
    return seat.watcher.until((view) => view.phase === "lobby", "the lobby");
  }

  for (const phase of ["lobby", "playing", "roundEnd", "gameEnd"] as const) {
    it(`survives a drop at ${phase} and hands the position straight back`, async () => {
      const seat = await seated();
      const before = await driveTo(seat, phase);

      seat.client.disconnect();

      const returning = await table.connect();
      const { view } = expectOk(await resume(returning, credentials(seat)));

      assert.equal(view.phase, phase);
      assert.equal(view.you.id, seat.playerId, "the same seat, not a new one");
      assert.deepEqual(view, before, "exactly the position the drop interrupted");
    });
  }

  it("seats the returning connection for real, not just for one ack", async () => {
    const seat = await seated();
    const before = await playTo(seat, "playing");
    seat.client.disconnect();

    const returning = await table.connect();
    const watcher = watch(returning);
    expectOk(await resume(returning, credentials(seat)));

    // A turn taken and broadcast back is the whole of being seated: the connection is
    // recognised as the player, and it is in the room the position is published to.
    expectOk(
      await ask(returning, "takeTurn", {
        discardCardIds: [playingSelf(before).hand[0]!.id],
        draw: { source: "deck" },
      }),
    );
    const played = await watcher.until(
      (view) => view.phase === "playing" && playingSelf(view).hand.length === playingSelf(before).hand.length,
      "the turn to be published back",
    );
    assertNoResumeToken(played, "a resumed connection's view");
  });

  /*
   * A seat is a credential, so the ways of failing to present one are worth pinning
   * down individually — and none of them may cost the room anything.
   */

  it("rejects a token that is not the seat's, leaving the seat resumable", async () => {
    const seat = await seated();
    await driveTo(seat, "lobby");
    seat.client.disconnect();
    const returning = await table.connect();

    const wrong = await resume(returning, {
      ...credentials(seat),
      resumeToken: "not-the-token",
    });

    assert.equal(expectError(wrong).code, "INVALID_RESUME_TOKEN");
    expectOk(await resume(returning, credentials(seat)));
  });

  it("rejects a player the room has never seated", async () => {
    const seat = await seated();
    const returning = await table.connect();

    const result = await resume(returning, {
      ...credentials(seat),
      playerId: "nobody",
    });

    // The same code a wrong token gets: which half was wrong is not a client's business,
    // or a room code would be enough to go fishing for the seats behind it.
    assert.equal(expectError(result).code, "INVALID_RESUME_TOKEN");
  });

  it("rejects a room that is not there", async () => {
    const seat = await seated();
    const returning = await table.connect();

    const result = await resume(returning, { ...credentials(seat), roomCode: "ZZZZ" });

    assert.equal(expectError(result).code, "ROOM_NOT_FOUND");
  });

  it("rejects a resume from a connection that is already in a room", async () => {
    const seat = await seated();
    const other = await seated("Grace");

    const result = await resume(other.client, credentials(seat));

    assert.equal(expectError(result).code, "ALREADY_IN_ROOM");
  });

  /**
   * One live connection per seat. A second device is not co-presence: the newer
   * connection takes the seat and the older one is put down, so two tabs can never
   * disagree about a table both think they are sitting at.
   */
  it("puts down the connection that was still holding the seat", async () => {
    const seat = await seated();
    await driveTo(seat, "lobby");
    const dropped = nextEvent<string>(seat.client, "disconnect");

    const taker = await table.connect();
    const { view } = expectOk(await resume(taker, credentials(seat)));

    assert.equal(view.phase, "lobby");
    await dropped;
  });
});

/**
 * The way a room ends now that no player can close one: its last seat leaves and it goes
 * with them (docs/adr/0012). Nobody is told, because the seat that left was the only one
 * there was to tell.
 */
describe("a room with nobody left in it", () => {
  it("is gone from the server, code and all", async () => {
    const host = await server.connect();
    const { roomCode, playerId, resumeToken } = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        host,
        "createRoom",
        "Ada",
      ),
    );

    expectOk(await ask(host, "exitToMenu"));

    const probe = await server.connect();
    assert.equal(
      expectError(await ask(probe, "joinRoom", roomCode, "Alan")).code,
      "ROOM_NOT_FOUND",
    );
    const returning = await server.connect();
    assert.equal(
      expectError(
        await ask(returning, "resumeSeat", { roomCode, playerId, resumeToken }),
      ).code,
      "ROOM_NOT_FOUND",
    );
  });

  it("stands as long as one seat is still in it", async () => {
    const host = await server.connect();
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    const guest = await server.connect();
    expectOk(await ask(guest, "joinRoom", created.roomCode, "Grace"));

    expectOk(await ask(host, "exitToMenu"));

    const probe = await server.connect();
    expectOk(await ask(probe, "joinRoom", created.roomCode, "Alan"));
  });
});

describe("disconnect", () => {
  /**
   * A seat and the connection holding it, for the suites about who is there. Two humans in
   * a lobby is the smallest table the question means anything at: one of them drops, and
   * the other has to be told something about it.
   */
  interface Seated {
    roomCode: string;
    host: ClientSocket;
    hostId: string;
    /** Every view the host has been sent, watched from before the guest arrived. */
    hostViews: Watcher;
    guest: ClientSocket;
    guestId: string;
    guestToken: string;
  }

  async function twoInALobby(): Promise<Seated> {
    const host = await server.connect();
    const { roomCode, playerId: hostId } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );
    // Subscribed before the join it is about to be told about: a broadcast that has
    // already landed is one no later watcher can be handed.
    const hostViews = watch(host);
    const guest = await server.connect();
    const { playerId: guestId, resumeToken: guestToken } = expectOk(
      await ask<{ playerId: string; resumeToken: string }>(
        guest,
        "joinRoom",
        roomCode,
        "Grace",
      ),
    );
    return { roomCode, host, hostId, hostViews, guest, guestId, guestToken };
  }

  it("tells the rest of the room that a seat has gone quiet", async () => {
    const table = await twoInALobby();

    const quiet = nextEvent<PlayerGameView>(table.host, "gameStateUpdate");
    table.guest.disconnect();
    const view = await quiet;

    assert.equal(view.opponents.find((o) => o.id === table.guestId)!.connected, false);
    assert.equal(view.you.connected, true, "a viewer is never away in their own view");
  });

  /**
   * Display, and nothing else (issue #146). The seat is still there, still in the match and
   * still in the roster: the only difference between the position before the drop and the
   * one published after it is the word for whether anybody is behind it.
   */
  it("changes nothing about the room but who is there", async () => {
    const table = await twoInALobby();
    const before = await table.hostViews.until(
      (v) => v.opponents.length === 1,
      "the full lobby",
    );

    const quiet = nextEvent<PlayerGameView>(table.host, "gameStateUpdate");
    table.guest.disconnect();
    const after = await quiet;

    assert.deepEqual(
      { ...after, opponents: after.opponents.map((o) => ({ ...o, connected: true })) },
      before,
    );
  });

  it("says a seat is back once its player resumes", async () => {
    const table = await twoInALobby();

    const quiet = nextEvent<PlayerGameView>(table.host, "gameStateUpdate");
    table.guest.disconnect();
    await quiet;

    const back = nextEvent<PlayerGameView>(table.host, "gameStateUpdate");
    const returning = await server.connect();
    expectOk(
      await ask(returning, "resumeSeat", {
        roomCode: table.roomCode,
        playerId: table.guestId,
        resumeToken: table.guestToken,
      }),
    );

    assert.equal((await back).opponents.find((o) => o.id === table.guestId)!.connected, true);
  });

  /** A bot has no socket to drop, and is the one seat that carries no marker at all. */
  it("has the bots connected at a table that has been dealt", async () => {
    const host = await server.connect();
    const watcher = watch(host);
    expectOk(await ask(host, "createRoom", "Ada"));
    expectOk(await ask(host, "startGame"));

    const view = await watcher.until((v) => v.phase === "playing", "the deal");

    assert.ok(view.opponents.length > 0, "the table was filled with bots");
    for (const bot of view.opponents) {
      assert.equal(bot.connected, true, `${bot.name} is never away`);
      assert.equal(bot.spectating, false, "and never watching either");
    }
  });

  /**
   * A dropped connection costs the room nothing: the seat is held, and the player behind it
   * comes back through `resumeSeat`. A room ends when its last seat *leaves* (adr/0012).
   *
   * The server processes a disconnect asynchronously, so there is no instant at which
   * "nothing happened" can be observed once and for all — the room is probed repeatedly
   * instead, and a teardown landing late would still be caught by one of the attempts.
   *
   * The probe is a resume with a deliberately wrong token, because it is the one question
   * whose answer turns on the room existing and which costs the room nothing to ask. Four
   * joins would have filled four of its six seats, and the fifth probe would have read a
   * full table as a teardown.
   */
  it("leaves the room standing, so its code keeps resolving", async () => {
    const host = await server.connect();
    const { roomCode, playerId } = expectOk(
      await ask<{ roomCode: string; playerId: string }>(host, "createRoom", "Ada"),
    );

    host.disconnect();

    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const probe = await server.connect();
      const result = await ask(probe, "resumeSeat", {
        roomCode,
        playerId,
        resumeToken: "not-the-token",
      });
      assert.equal(
        expectError(result).code,
        "INVALID_RESUME_TOKEN",
        "the room answered, so it is still there",
      );
    }
  });
});

/**
 * Dealing a scored round on when nobody left in the match can deal it (issue #148).
 *
 * A spectator whose match went on without them watches the bots that beat them play; the
 * round they were knocked out in is up in front of them, and only a player still in the
 * match may deal the next one (docs/adr/0012) — so the server does, after a pause. What
 * is asserted here is what a client can see: whether a pause is waiting on the clock at
 * all, and the position ticking it produces.
 *
 * Every server here is built with a clock this suite drives by hand, bots included: a
 * table nobody is waiting on is exactly what the auto-deal is for, so the tests have to
 * be able to say "nothing is pending" as precisely as "one thing is". Each test gets its
 * own server for the same reason `bot think time` above does.
 */
describe("auto-dealing a table only bots are still playing", () => {
  interface Table {
    close: () => Promise<void>;
    clock: TestClock;
    client: ClientSocket;
    watcher: Watcher;
    me: string;
    /** The latest position this seat has been sent. */
    view: PlayerGameView;
  }

  async function sitDown(
    seed: number,
    bots: number,
    settings: Partial<RoomSettings> = SHORT_MATCH,
  ): Promise<Table> {
    const clock = testClock();
    // A short match by default, since the subject is a human being knocked out of one.
    // The one test about a human who is *not* out yet asks for a long one instead.
    const harness = await startServer(seed, bots, { clock, thinkTimeMs: 0 }, settings);
    const client = await harness.connect();
    const watcher = watch(client);
    const { playerId } = expectOk(
      await ask<{ playerId: string }>(client, "createRoom", "Ada"),
    );
    expectOk(await ask(client, "startGame"));
    const view = await watcher.until((v) => v.phase === "playing", "the deal");
    return { close: harness.close, clock, client, watcher, me: playerId, view };
  }

  /**
   * Move the table on by one position, whatever it is standing on: the human's own turn,
   * a bot waiting on the clock, or a scored round the human may still deal on.
   *
   * The human plays to lose, and deliberately — the point of every test here is a table
   * that has gone on without them. They never call Yaniv and always shed their cheapest
   * card, which is the fastest legal way to be holding an expensive hand when somebody
   * else calls.
   */
  async function next(t: Table): Promise<PlayerGameView> {
    const before = t.watcher.seen.length;

    if (t.view.phase === "playing" && t.view.currentTurnPlayerId === t.me) {
      // The hand arrives sorted ascending by value, so the first card is the cheapest.
      const cheapest = playingSelf(t.view).hand[0]!.id;
      expectOk(
        await ask(t.client, "takeTurn", {
          discardCardIds: [cheapest],
          draw: { source: "deck" },
        }),
      );
    } else if (t.view.phase === "playing") {
      assert.ok(t.clock.pending() > 0, "a bot was waiting to take the turn");
      t.clock.tick();
    } else if (t.view.phase === "roundEnd" && !t.view.you.spectating) {
      expectOk(await ask(t.client, "startNextRound"));
    } else {
      assert.fail(`nothing to play from ${t.view.phase}`);
    }

    const deadline = Date.now() + 2000;
    while (t.watcher.seen.length === before) {
      if (Date.now() > deadline) assert.fail("no position followed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    t.view = t.watcher.seen[t.watcher.seen.length - 1]!;
    return t.view;
  }

  /** Play on until the position answers `done`, or fail saying what it reached instead. */
  async function playUntil(
    t: Table,
    done: (view: PlayerGameView) => boolean,
    what: string,
  ): Promise<PlayerGameView> {
    for (let step = 0; step < 400; step++) {
      if (done(t.view)) return t.view;
      await next(t);
    }
    assert.fail(`the table never reached ${what} (it is at ${t.view.phase})`);
  }

  /** The scored round a knocked-out human is left watching, bots still playing. */
  const watchingAScoredRound = (view: PlayerGameView) =>
    view.phase === "roundEnd" && view.you.spectating;

  /**
   * Wait for the clock to hold exactly `count` timers, so a fact that arrives with a
   * disconnect the server processes asynchronously can be asserted at all.
   */
  async function settle(t: Table, count: number, what: string): Promise<void> {
    const deadline = Date.now() + 1000;
    while (t.clock.pending() !== count) {
      if (Date.now() > deadline) {
        assert.equal(t.clock.pending(), count, what);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * The same wait, for the cases where a count cannot tell the two pauses apart: a drop
   * calls the deal off and starts the room's grace period (issue #150), so one timer
   * stands where one timer stood, and only the interval says which.
   */
  async function settleDelays(t: Table, delays: number[], what: string): Promise<void> {
    const deadline = Date.now() + 1000;
    while (JSON.stringify(t.clock.delays()) !== JSON.stringify(delays)) {
      if (Date.now() > deadline) assert.deepEqual(t.clock.delays(), delays, what);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("deals the next round for a spectator once the pause has elapsed", async () => {
    const t = await sitDown(7, 3);
    try {
      const scored = await playUntil(t, watchingAScoredRound, "a round it was out of");

      assert.equal(t.clock.pending(), 1, "the scored round is waiting to deal itself on");
      // Every position of the match so far is behind us; only what the pause produces
      // should answer the wait below.
      t.watcher.reset();
      assert.equal(t.clock.tick(), AUTO_DEAL_MS, "the pause a spectator reads it in");

      const dealt = await t.watcher.until(
        (v) => v.phase === "playing",
        "the next round, dealt by nobody at the table",
      );
      assert.equal(
        dealt.roundNumber,
        scored.roundNumber + 1,
        "the round after the one it watched",
      );
      assert.ok(dealt.you.spectating, "and the spectator is still watching, not dealt in");
    } finally {
      await t.close();
    }
  });

  /**
   * A finished match waits: the standings are there to be read, and play again is offered
   * to anybody still in the room (docs/adr/0012), so there is always somebody who can
   * answer for it. One bot, so the human going out ends the match on the spot.
   */
  it("leaves a finished match up", async () => {
    const t = await sitDown(97, 1);
    try {
      await playUntil(t, (v) => v.phase === "gameEnd", "a finished match");

      await settle(t, 0, "a finished match waits on nothing");
    } finally {
      await t.close();
    }
  });

  /**
   * A human still in the match is who the round is waiting for, whether or not there is a
   * socket behind them: a drop costs a seat nothing (docs/adr/0013), and dealing the next
   * round out from under one is the one thing it must not cost.
   */
  it("waits on a human still in the match, dropped or not", async () => {
    // A limit no round of this reaches, so the human is scored rather than knocked out.
    const t = await sitDown(7, 3, LONG_MATCH);
    try {
      await playUntil(
        t,
        (v) => v.phase === "roundEnd" && !v.you.spectating,
        "a round it was scored in",
      );

      assert.equal(t.clock.pending(), 0, "the round is the human's to deal");

      t.client.disconnect();
      // The room's own grace period is the only thing a drop starts (issue #150): the
      // round is still waiting for the seat that went quiet, not being dealt out from
      // under it.
      await settleDelays(
        t,
        [ROOM_SWEEP_MS],
        "and still theirs once their connection has gone",
      );
    } finally {
      await t.close();
    }
  });

  /**
   * The spectator leaving is not the same event as their socket going: the seat is given
   * up, the room is left with nothing but bots in it, and it is dropped outright. The
   * pause goes with it — `destroyRoom` calls off everything a room had waiting, which is
   * the whole reason this is set on the registry rather than on a timer of its own.
   */
  it("calls the pause off when the spectator leaves the room", async () => {
    const t = await sitDown(7, 3);
    try {
      await playUntil(t, watchingAScoredRound, "a round it was out of");
      assert.equal(t.clock.pending(), 1, "the pause is running");

      expectOk(await ask(t.client, "exitToMenu"));

      await settle(t, 0, "the room went, and its pause with it");
    } finally {
      await t.close();
    }
  });

  /**
   * A table with nobody watching plays to nobody, so the deal is called off — and what
   * takes its place on the clock is the room's own grace period, the drop being what
   * starts one (issue #150). The two never run together: the deal wants a spectator there
   * and the sweep wants nobody there.
   */
  it("calls the pause off when the spectator it was for goes", async () => {
    const t = await sitDown(7, 3);
    try {
      await playUntil(t, watchingAScoredRound, "a round it was out of");
      assert.deepEqual(t.clock.delays(), [AUTO_DEAL_MS], "the pause is running");

      t.client.disconnect();

      await settleDelays(t, [ROOM_SWEEP_MS], "a table with nobody watching plays to nobody");
    } finally {
      await t.close();
    }
  });
});

/**
 * Sweeping a room nobody is in any more (issue #150).
 *
 * A room ends when its last seat leaves, which says nothing about the exits players do
 * not take: a tab closed, a phone backgrounded, a laptop shut. Those rooms used to stand
 * for as long as the process did. Now they are given a minute and then dropped — a minute
 * rather than nothing, because a reload is a disconnect and a seat is resumable precisely
 * so a drop costs nothing (docs/adr/0013).
 *
 * Every server here is built with a clock this suite drives by hand, and one per test: the
 * subject is what a room has waiting and what firing it does, so the tests have to be able
 * to name a timer and to say "nothing is pending" as precisely as "one thing is". The room
 * having gone is observed the way it is everywhere else here — a later join is refused,
 * not a `RoomManager` asked.
 */
describe("sweeping a room nobody is in", () => {
  interface Abandonable {
    close: () => Promise<void>;
    connect: () => Promise<ClientSocket>;
    clock: TestClock;
    client: ClientSocket;
    watcher: Watcher;
    roomCode: string;
    me: string;
    token: string;
  }

  /** One human in a fresh room, on a clock nothing moves but this test. */
  async function sitDown(bots = 0): Promise<Abandonable> {
    const clock = testClock();
    const harness = await startServer(7, bots, { clock, thinkTimeMs: BOT_THINK_MS });
    const client = await harness.connect();
    const watcher = watch(client);
    const { roomCode, playerId, resumeToken } = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        client,
        "createRoom",
        "Ada",
      ),
    );
    return {
      close: harness.close,
      connect: harness.connect,
      clock,
      client,
      watcher,
      roomCode,
      me: playerId,
      token: resumeToken,
    };
  }

  /**
   * Wait for the grace period to be on the clock, or off it — a disconnect is processed
   * asynchronously, so neither fact is true the instant the socket is told to go.
   */
  async function untilSweep(t: Abandonable, waiting: boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (t.clock.delays().includes(ROOM_SWEEP_MS) !== waiting) {
      if (Date.now() > deadline) {
        assert.fail(
          `the sweep was ${waiting ? "never" : "still"} pending (waiting: ${t.clock.delays()})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Deal a match out and hand the turn to a bot, so the room has one thinking. */
  async function underway(t: Abandonable): Promise<PlayerGameView> {
    expectOk(await ask(t.client, "startGame"));
    const view = await t.watcher.until((v) => v.phase === "playing", "the deal");
    if (view.currentTurnPlayerId !== t.me) return view;

    const cheapest = playingSelf(view).hand[0]!.id;
    expectOk(
      await ask(t.client, "takeTurn", {
        discardCardIds: [cheapest],
        draw: { source: "deck" },
      }),
    );
    return t.watcher.until(
      (v) => v.phase === "playing" && v.currentTurnPlayerId !== t.me,
      "the turn handed to a bot",
    );
  }

  it("drops a room no human has been connected to for the grace period", async () => {
    const t = await sitDown();
    try {
      t.client.disconnect();
      await untilSweep(t, true);

      t.clock.tickAt(ROOM_SWEEP_MS);

      const probe = await t.connect();
      assert.equal(
        expectError(await ask(probe, "joinRoom", t.roomCode, "Alan")).code,
        "ROOM_NOT_FOUND",
        "the room went with the last connection to it",
      );
    } finally {
      await t.close();
    }
  });

  /** A reload is a disconnect, and the socket coming back is the whole answer to one. */
  it("keeps a room whose connection comes back inside the grace period", async () => {
    const t = await sitDown();
    try {
      t.client.disconnect();
      await untilSweep(t, true);

      const returning = await t.connect();
      expectOk(
        await ask(returning, "resumeSeat", {
          roomCode: t.roomCode,
          playerId: t.me,
          resumeToken: t.token,
        }),
      );

      await untilSweep(t, false);
      assert.equal(t.clock.pending(), 0, "nothing is counting the room down");

      const probe = await t.connect();
      expectOk(await ask(probe, "joinRoom", t.roomCode, "Alan"));
    } finally {
      await t.close();
    }
  });

  it("gives a lone human against bots their match back after a reload", async () => {
    const t = await sitDown(2);
    try {
      const before = await underway(t);

      t.client.disconnect();
      await untilSweep(t, true);

      const returning = await t.connect();
      const { view } = expectOk(
        await ask<{ view: PlayerGameView }>(returning, "resumeSeat", {
          roomCode: t.roomCode,
          playerId: t.me,
          resumeToken: t.token,
        }),
      );

      assert.equal(view.phase, "playing", "the same round, still being played");
      assert.equal(view.roundNumber, before.roundNumber);
      assert.deepEqual(
        playingSelf(view).hand.map((c) => c.id),
        playingSelf(before).hand.map((c) => c.id),
        "and the same hand in front of them",
      );
      await untilSweep(t, false);
    } finally {
      await t.close();
    }
  });

  /**
   * A swept room stops doing things. Its bot was mid-think when the last human went, and
   * that turn is called off with everything else the room had waiting — a callback left
   * behind would fire at a code that may be issued again.
   */
  it("takes the room's timers with it", async () => {
    const t = await sitDown(2);
    try {
      await underway(t);
      assert.ok(
        t.clock.delays().includes(BOT_THINK_MS),
        "a bot was thinking about its turn",
      );

      t.client.disconnect();
      await untilSweep(t, true);
      t.clock.tickAt(ROOM_SWEEP_MS);

      assert.equal(t.clock.pending(), 0, "nothing is left on the clock");
      const probe = await t.connect();
      assert.equal(
        expectError(await ask(probe, "joinRoom", t.roomCode, "Alan")).code,
        "ROOM_NOT_FOUND",
      );
    } finally {
      await t.close();
    }
  });
});

/**
 * The match's ledger reaching a real client (docs/adr/0017). What a row *says* is the
 * engine suite's, and what colour a cell wears is the browser client's; this is the wire's
 * own share of it — that the field rides every phase, grows a row when a round is scored,
 * and comes back whole to a connection that dropped and resumed.
 *
 * Nothing is added to the serializer suite for it: there is no redaction here to guard, so
 * the same path end to end is the honest place to look.
 */
describe("the scorecard on the wire", () => {
  let table: Harness;

  before(async () => {
    // A limit no round here reaches: what is under test is a ledger of several rounds, and
    // a table that busts on the first one never has more than one row to lose.
    table = await startServer(4242, 1, { thinkTimeMs: 0 }, LONG_MATCH);
  });
  after(async () => {
    await table.close();
  });

  interface Seat {
    client: ClientSocket;
    watcher: Watcher;
    roomCode: string;
    playerId: string;
    resumeToken: string;
  }

  async function seated(): Promise<Seat> {
    const client = await table.connect();
    const watcher = watch(client);
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        client,
        "createRoom",
        "Ada",
      ),
    );
    return { client, watcher, ...created };
  }

  /** The player has something to do again: their turn, or a round to react to. */
  const settled = (seat: Seat) => (view: PlayerGameView) =>
    view.phase !== "lobby" &&
    (view.phase !== "playing" || view.currentTurnPlayerId === seat.playerId);

  /**
   * Play the table forward one action at a time, with the same judgement the server gives
   * its bots, until the position answers `done`.
   */
  async function playUntil(
    seat: Seat,
    done: (view: PlayerGameView) => boolean,
  ): Promise<PlayerGameView> {
    seat.watcher.reset();
    expectOk(await ask(seat.client, "startGame"));

    for (let step = 0; step < 500; step++) {
      const current = await seat.watcher.until(settled(seat), "the player to be needed");
      if (done(current)) return current;

      seat.watcher.reset();
      if (current.phase === "roundEnd") {
        expectOk(await ask(seat.client, "startNextRound"));
        continue;
      }
      assert.notEqual(current.phase, "gameEnd", "the match ended first");

      const decision = decideTurn(current);
      if (decision.type === "yaniv") {
        expectOk(await ask(seat.client, "callYaniv"));
      } else {
        expectOk(await ask(seat.client, "takeTurn", decision.action));
      }
    }
    assert.fail("the table never reached the position under test");
  }

  it("arrives empty in the lobby, before any round has been scored", async () => {
    const seat = await seated();
    const lobby = await seat.watcher.until((v) => v.phase === "lobby", "the lobby");

    assert.deepEqual(lobby.scorecard, []);
  });

  it("is still empty on the freshly dealt first round", async () => {
    const seat = await seated();
    const dealt = await playUntil(seat, (v) => v.phase === "playing");

    assert.deepEqual(dealt.scorecard, [], "nothing has been scored yet");
  });

  it("has grown by a row once a round has been scored", async () => {
    const seat = await seated();
    const scored = await playUntil(seat, (v) => v.phase !== "playing");

    assert.equal(scored.scorecard.length, 1);
    const [row] = scored.scorecard;
    assert.equal(row!.roundNumber, scored.roundNumber);
    // The round on the reveal and the newest row are the same round, said two ways.
    assert.equal(row!.callerId, scored.roundResult!.callerId);
    assert.equal(row!.assaferId, scored.roundResult!.assaferId);
  });

  /**
   * The fourth phase, and the one this suite's own long-limit server cannot reach: a match
   * that is over still carries its ledger, even though the card is not offered over the
   * standings — the field is not gated on a phase, and nothing downstream should have to
   * know which phases it arrives in.
   */
  it("still carries the ledger once the match is over", async () => {
    const short = await startServer(4242, 1, { thinkTimeMs: 0 }, SHORT_MATCH);
    try {
      const client = await short.connect();
      const watcher = watch(client);
      expectOk(await ask(client, "createRoom", "Ada"));
      expectOk(await ask(client, "startGame"));

      let current = await watcher.until(
        (v) => v.phase !== "lobby" && (v.phase !== "playing" || v.currentTurnPlayerId === v.you.id),
        "the player to be needed",
      );
      for (let step = 0; step < 500 && current.phase !== "gameEnd"; step++) {
        watcher.reset();
        if (current.phase === "roundEnd") {
          expectOk(await ask(client, "startNextRound"));
        } else {
          const decision = decideTurn(current);
          if (decision.type === "yaniv") {
            expectOk(await ask(client, "callYaniv"));
          } else {
            expectOk(await ask(client, "takeTurn", decision.action));
          }
        }
        current = await watcher.until(
          (v) => v.phase !== "playing" || v.currentTurnPlayerId === v.you.id,
          "the player to be needed",
        );
      }

      assert.equal(current.phase, "gameEnd");
      assert.equal(current.scorecard.length, current.roundNumber);
    } finally {
      await short.close();
    }
  });

  it("hands the whole ledger back to a connection that dropped and resumed", async () => {
    const seat = await seated();
    // A round scored, then dealt on: the position a resuming client would otherwise be
    // sent with nothing behind it, there being no `roundResult` at `playing` either.
    const dealtOn = await playUntil(
      seat,
      (v) => v.phase === "playing" && v.scorecard.length > 0,
    );
    assert.equal(dealtOn.scorecard.length, 1);

    seat.client.disconnect();
    const returning = await table.connect();
    const { view } = expectOk(
      await ask<{ view: PlayerGameView }>(returning, "resumeSeat", {
        roomCode: seat.roomCode,
        playerId: seat.playerId,
        resumeToken: seat.resumeToken,
      }),
    );

    assert.deepEqual(view.scorecard, dealtOn.scorecard, "the match's history, not a blank sheet");
  });
});

/**
 * The one stat, over the wire (docs/adr/0023): a signed-in player's accepted `callYaniv`
 * is counted on their account, and nothing about that write reaches the game.
 *
 * Each test builds its own server around a store it can see into — or one that never
 * answers, or always fails — which is the whole reason `startServer` takes one. And each
 * plays a real table out to real calls: `accountToCredit` is unit-tested and the store is
 * contract-tested, and both would pass against a handler that wrote nothing at all.
 */
describe("a Yaniv call counted on the caller's account", () => {
  const opened: Harness[] = [];
  after(async () => {
    for (const harness of opened) await harness.close();
  });

  interface Player {
    client: ClientSocket;
    watcher: Watcher;
    playerId: string;
    /** The account the player sat down under, or `null` for a guest. */
    accountId: string | null;
  }

  /**
   * A player and three bots, dealt in, at a limit nobody reaches: several rounds are
   * played here, and a table that emptied on the way would stop answering.
   */
  async function sitDown(
    profiles: ProfileStore,
    signedIn = true,
    options: SocketServerOptions = {},
  ): Promise<Player> {
    const harness = await startServer(
      7,
      3,
      { thinkTimeMs: 0, ...options },
      LONG_MATCH,
      profiles,
    );
    opened.push(harness);

    const client = await harness.connect();
    const watcher = watch(client);
    const accountId = signedIn ? (await signUp(client, "Ada", harness)).account.id : null;
    const { playerId } = expectOk(
      await ask<{ playerId: string }>(client, "createRoom", "Ada"),
    );
    watcher.reset();
    expectOk(await ask(client, "startGame"));
    return { client, watcher, playerId, accountId };
  }

  /** Every round a table has scored so far, split by whose call ended it. */
  interface Calls {
    mine: RoundResultView[];
    bots: RoundResultView[];
  }

  /**
   * Play on with the bots' own judgement until `done` says enough rounds have been called,
   * answering each call's verdict — so a test can ask for a call that was Assafed without
   * knowing in advance which round that will be.
   */
  async function playUntil(player: Player, done: (calls: Calls) => boolean): Promise<Calls> {
    const calls: Calls = { mine: [], bots: [] };

    for (let step = 0; step < 3000; step++) {
      const current = await player.watcher.until(
        (v) =>
          v.phase !== "lobby" &&
          (v.phase !== "playing" || v.currentTurnPlayerId === player.playerId),
        "the player to be needed",
      );
      player.watcher.reset();

      if (current.phase === "roundEnd") {
        const result = current.roundResult!;
        (result.callerId === player.playerId ? calls.mine : calls.bots).push(result);
        if (done(calls)) return calls;
        expectOk(await ask(player.client, "startNextRound"));
        continue;
      }
      assert.equal(current.phase, "playing", "the match ended first");

      const decision = decideTurn(current);
      if (decision.type === "yaniv") {
        expectOk(await ask(player.client, "callYaniv"));
      } else {
        expectOk(await ask(player.client, "takeTurn", decision.action));
      }
    }
    assert.fail("the table never called the rounds under test");
  }

  /**
   * The memory store with its Yaniv-call write replaced, and every account that write was
   * asked for recorded in order — whatever the replacement then does with it. The
   * replacement is handed the store underneath, which is where the accounts are.
   */
  function storeWith(
    recordYanivCall: (id: string, memory: ProfileStore) => Promise<void>,
  ): { profiles: ProfileStore; asked: string[] } {
    const memory = createMemoryProfileStore();
    const asked: string[] = [];
    return {
      asked,
      profiles: {
        ...memory,
        recordYanivCall: (id) => {
          asked.push(id);
          return recordYanivCall(id, memory);
        },
      },
    };
  }

  it("counts a signed-in player's call on their account", async () => {
    const profiles = createMemoryProfileStore();
    const player = await sitDown(profiles);

    await playUntil(player, ({ mine }) => mine.length === 1);

    assert.equal((await profiles.loadAccount(player.accountId!))!.yanivCalls, 1);
  });

  it("counts a call that was Assafed exactly as one that stood", async () => {
    const profiles = createMemoryProfileStore();
    const player = await sitDown(profiles);

    const { mine } = await playUntil(
      player,
      ({ mine }) =>
        mine.some((r) => r.assaferId !== null) && mine.some((r) => r.assaferId === null),
    );

    assert.equal((await profiles.loadAccount(player.accountId!))!.yanivCalls, mine.length);
  });

  it("writes nothing for a bot's call", async () => {
    const { profiles, asked } = storeWith((id, memory) => memory.recordYanivCall(id));
    const player = await sitDown(profiles);

    const { mine } = await playUntil(
      player,
      ({ mine, bots }) => mine.length > 0 && bots.length > 0,
    );

    assert.deepEqual(asked, mine.map(() => player.accountId));
    assert.equal((await profiles.loadAccount(player.accountId!))!.yanivCalls, mine.length);
  });

  it("writes nothing for a guest's call", async () => {
    const { profiles, asked } = storeWith(async () => {});
    const player = await sitDown(profiles, false);

    await playUntil(player, ({ mine }) => mine.length === 2);

    assert.deepEqual(asked, []);
  });

  /**
   * The write is started after the broadcast and awaited nowhere, so a database that has
   * stopped answering holds up nothing: the call is acked, the scored round goes out, and
   * the next round is dealt and played — bots and all — over the writes still pending.
   */
  it("holds up nothing when the store never answers", async () => {
    const { profiles, asked } = storeWith(() => new Promise(() => {}));
    const player = await sitDown(profiles);

    const { mine } = await playUntil(player, ({ mine }) => mine.length === 2);

    assert.deepEqual(asked, mine.map(() => player.accountId), "the store was asked, and hung");
  });

  /**
   * Dropped, and logged naming the account — so a missing account can be told from a dead
   * connection — and nothing else. An unhandled rejection would take the whole process
   * down, and this suite with it.
   */
  it("logs a failed write naming the account, and plays on", async () => {
    const logged: unknown[][] = [];
    const failure = new Error("the database is down");
    const { profiles } = storeWith(() => Promise.reject(failure));
    const player = await sitDown(profiles, true, { log: (...args) => logged.push(args) });

    const { mine } = await playUntil(player, ({ mine }) => mine.length === 2);

    assert.equal(logged.length, mine.length);
    for (const entry of logged) {
      assert.ok(String(entry[0]).includes(player.accountId!), "the log names the account");
      assert.ok(entry.includes(failure), "and carries the failure");
    }
  });

  /**
   * `ProfileStore` promises a promise, and both shipped stores keep that by being `async`
   * — but an implementation that threw before returning one would otherwise throw out of
   * the handler, past the `.catch` meant for it. The same answer, whichever way it fails.
   */
  it("logs a store that throws rather than rejecting, and plays on", async () => {
    const logged: unknown[][] = [];
    const failure = new Error("thrown, not rejected");
    const { profiles } = storeWith(() => {
      throw failure;
    });
    const player = await sitDown(profiles, true, { log: (...args) => logged.push(args) });

    const { mine } = await playUntil(player, ({ mine }) => mine.length === 2);

    assert.equal(logged.length, mine.length);
    assert.ok(logged.every((entry) => entry.includes(failure)));
  });
});
