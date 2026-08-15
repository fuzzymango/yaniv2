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
  GameError,
  PlayerGameView,
  ResumeRequest,
  RoomSettings,
} from "@yaniv/shared";
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MAX_SCORE,
  YANIV_THRESHOLD,
  handValue,
} from "@yaniv/shared";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { decideTurn } from "../src/bot.ts";
import { createDeck } from "../src/deck.ts";
import { RoomManager } from "../src/roomManager.ts";
import { mulberry32 } from "../src/rng.ts";
import { createSocketServer } from "../src/socketServer.ts";
import { RESUME_TOKEN_MARK, markedResumeTokens } from "./helpers.ts";

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
 */
async function startServer(
  seed?: number,
  botCount = MAX_PLAYERS - 1,
): Promise<Harness> {
  const httpServer = createServer();
  // Every seat this server issues holds a marked token, so a leak test can grep a payload
  // for a string it knows is a credential.
  const newResumeToken = markedResumeTokens();
  const rooms =
    seed === undefined
      ? new RoomManager({ newResumeToken, defaultSettings: { botCount } })
      : new RoomManager({
          rng: mulberry32(seed),
          newResumeToken,
          newRoomRng: () => mulberry32(seed + 1),
          defaultSettings: { botCount },
        });
  const io = createSocketServer(httpServer, rooms);

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
    assert.equal(dealt.you.hand.length, HAND_SIZE);
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
    assert.equal(view.you.hand.length, HAND_SIZE);
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

  before(async () => {
    table = await startServer(4242);
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
    const startedAt = Date.now();
    expectOk(
      await ask(client, "takeTurn", {
        // A single card is always a legal discard, whatever was dealt.
        discardCardIds: [view.you.hand[0]!.id],
        draw: { source: "deck" },
      }),
    );

    await watcher.until((v) => v.currentTurnPlayerId === me, "the turn to come back");

    // One broadcast per turn taken — the player's, then each bot's, in seating order.
    // A single collapsed update would show only the last of these.
    assert.deepEqual(
      watcher.seen.map((v) => v.currentTurnPlayerId),
      [...view.turnOrder.slice(1), me],
    );

    // The server never pauses between bot moves; making a chain watchable is the
    // client's job. The bound is loose enough to survive a slow machine, and far under
    // any pause worth calling a pause.
    assert.ok(
      Date.now() - startedAt < 1000,
      `the whole chain resolved without pauses (took ${Date.now() - startedAt}ms)`,
    );
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
        ["joker-1", "joker-2"].find((id) => !view.you.hand.some((c) => c.id === id))!,
      ],
      draw: { source: "deck" },
    });

    assert.equal(expectError(result).code, "CARD_NOT_IN_HAND");
  });

  it("rejects a discard that is not a legal set", async () => {
    const { client, watcher, view } = await sitDown();
    const [first] = view.you.hand;
    const mismatched = view.you.hand.find((c) => c.rank !== first!.rank);
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
      discardCardIds: [view.you.hand[0]!.id],
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
      discardCardIds: [view.you.hand[0]!.id],
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
        discardCardIds: [view.you.hand[0]!.id],
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

    // Final standings: every hand revealed, and the winner is whoever is lowest.
    assertRoundIsSettled(current);
    const scores = [current.you, ...current.opponents].map((p) => p.score);
    const lowest = Math.min(...scores);
    assert.ok(current.winnerIds && current.winnerIds.length > 0, "a winner was declared");
    for (const winnerId of current.winnerIds!) {
      const winner = [current.you, ...current.opponents].find((p) => p.id === winnerId);
      assert.equal(winner!.score, lowest, "the winner holds the lowest score");
    }
    assert.ok(
      scores.some((score) => score > MAX_SCORE),
      "the match ended because someone busted",
    );
  });

  /** A finished round shows every hand, what each hand cost, and the new totals. */
  function assertRoundIsSettled(view: PlayerGameView): void {
    // Revealing every hand is the one thing this phase opens up. Reaching for the roster
    // to do it would bring the tokens along with the cards.
    assertNoResumeToken(view, `a ${view.phase} view`);
    const result = view.roundResult;
    assert.ok(result, "a finished round reports its result");
    assert.equal(result.players.length, MAX_PLAYERS);

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
      maxScore: MAX_SCORE,
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
        discardCardIds: [view.you.hand[0]!.id],
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
        [...published.you.hand, ...published.lastDiscard].map((card) => card.id),
      );
      const json = JSON.stringify(published);
      for (const cardId of everyCardId) {
        if (maySee.has(cardId)) continue;
        assert.ok(!json.includes(`"${cardId}"`), `${cardId} leaked into a broadcast`);
      }
      for (const opponent of published.opponents) {
        assert.ok(!("hand" in opponent), "an opponent was sent with a hand attached");
      }
    }
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
    assert.notDeepEqual(mine.you.hand, theirs.you.hand, "and they hold different cards");
    assert.ok(
      mine.opponents.some((o) => o.id === otherId),
      "each sees the other as an opponent",
    );
  });

  it("rejects a Yaniv call from a hand that is worth too much", async () => {
    const { client, view } = await sitDown();
    assert.ok(
      handValue(view.you.hand) > YANIV_THRESHOLD,
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
    table = await startServer(97);
  });
  after(async () => {
    await table.close();
  });

  interface Seat {
    client: ClientSocket;
    watcher: Watcher;
    id: string;
    name: string;
  }

  /** A host and, optionally, other humans, all sitting in the same fresh lobby. */
  async function openLobby(names: string[]): Promise<{ roomCode: string; seats: Seat[] }> {
    const [hostName, ...guestNames] = names;
    const client = await table.connect();
    const watcher = watch(client);
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string }>(client, "createRoom", hostName!),
    );
    const seats: Seat[] = [
      { client, watcher, id: created.playerId, name: hostName! },
    ];

    for (const name of guestNames) {
      const guest = await table.connect();
      const guestWatcher = watch(guest);
      const joined = expectOk(
        await ask<{ playerId: string }>(guest, "joinRoom", created.roomCode, name),
      );
      seats.push({ client: guest, watcher: guestWatcher, id: joined.playerId, name });
    }

    return { roomCode: created.roomCode, seats };
  }

  /**
   * Play a table out to a finished match, acting for every human seat with `decideTurn` —
   * the same judgement the server gives its bots, fed each player's own view over the
   * wire, standing in for a client exactly as it does in the full-match test above.
   *
   * Every watcher is reset immediately before each action, so the views waited on
   * afterwards can only be ones the action itself produced.
   */
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
        expectOk(await ask(host.client, "startNextRound"));
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
        [finished.you, ...finished.opponents].some((p) => p.score > MAX_SCORE),
        "the match really did end on a bust",
      );

      host.watcher.reset();
      expectOk(await ask(host.client, "playAgain"));
      const restarted = await host.watcher.until((v) => v.phase === "playing", "the deal");

      assert.equal(restarted.roomCode, roomCode, "the room code does not change");
      assert.equal(restarted.roundNumber, 1);
      assert.equal(restarted.you.hand.length, HAND_SIZE);
      assert.deepEqual(
        [restarted.you, ...restarted.opponents].map((p) => p.score),
        new Array(MAX_PLAYERS).fill(0),
        "nobody carries a score over from the last match",
      );
      assert.equal(restarted.winnerIds, null, "the old winner is no longer declared");
    });

    it("rejects a restart by anyone but the host", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      expectOk(await ask(seats[0]!.client, "startGame"));
      await playToGameEnd(seats);

      const result = await ask(seats[1]!.client, "playAgain");

      assert.equal(expectError(result).code, "NOT_HOST");
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

    it("closes the room for everyone else when the host leaves", async () => {
      const { roomCode, seats } = await openLobby(["Ada", "Grace", "Alan"]);
      const [host, ...guests] = seats;

      const closed = guests.map((g) => nextEvent<string>(g.client, "roomClosed"));
      expectOk(await ask(host!.client, "exitToMenu"));

      for (const reason of await Promise.all(closed)) {
        assert.match(reason, /host/i, "the reason names the host leaving");
      }
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
      const standings = await host!.watcher.until(
        (v) => !v.opponents.some((o) => o.id === guest!.id),
        "the roster to shrink",
      );

      assert.equal(standings.phase, "gameEnd", "the scoreboard is still on screen");
      assert.ok(standings.winnerIds, "and still reports who won");
    });

    it("closes a finished match for everyone else when the host leaves", async () => {
      const { roomCode, seats } = await openLobby(["Ada", "Grace"]);
      expectOk(await ask(seats[0]!.client, "startGame"));
      await playToGameEnd(seats);

      const closed = nextEvent<string>(seats[1]!.client, "roomClosed");
      expectOk(await ask(seats[0]!.client, "exitToMenu"));

      assert.match(await closed, /host/i);
      const latecomer = await table.connect();
      assert.equal(
        expectError(await ask(latecomer, "joinRoom", roomCode, "Tony")).code,
        "ROOM_NOT_FOUND",
      );
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
        restarted.opponents.length,
        MAX_PLAYERS - 2,
        "the table is one seat smaller, and no bot moved in",
      );
      assert.ok(
        !restarted.opponents.some((o) => o.id === guest!.id),
        "the player who left is not back at the table",
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

    // Host and guest are turned away by the same rule, but reach it down different
    // paths — the host's leave is checked before the room would be closed, the guest's
    // by the transition that would have freed their seat.
    it("refuses to leave mid-match, where quitting is still a disconnect", async () => {
      const { seats } = await openLobby(["Ada", "Grace"]);
      expectOk(await ask(seats[0]!.client, "startGame"));

      assert.equal(
        expectError(await ask(seats[0]!.client, "exitToMenu")).code,
        "WRONG_PHASE",
      );
      assert.equal(
        expectError(await ask(seats[1]!.client, "exitToMenu")).code,
        "WRONG_PHASE",
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
 * Two humans seated next to each other is the only arrangement in which that race is
 * real: `startGame` fills the rest of the table with bots, and a bot seated after the
 * slapper takes its turn synchronously, closing the window before any human could reach
 * it (ADR-0005). So Ada acts, Grace is next, and the window stays open until she moves.
 *
 * The window itself cannot be arranged — it is opened by drawing blind off the deck —
 * so the table is played on a seeded server until one appears, and every test here
 * starts from the position that produced it.
 */
describe("slapping down", () => {
  let table: Harness;

  before(async () => {
    table = await startServer(20250811);
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
    const hand = view.you.hand;
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
      if (!adaView.you.slapdownEligible) continue;

      const graceView = await waitFor(grace, "Grace's view of the same position");
      return { ada, grace, adaView, graceView };
    }
    assert.fail("no slapdown window ever opened");
  }

  /** Take Grace's turn, from the view she is holding. */
  const graceTakesHerTurn = (grace: Seat, graceView: PlayerGameView) =>
    ask(grace.client, "takeTurn", {
      discardCardIds: [graceView.you.hand[0]!.id],
      draw: { source: "deck" },
    });

  it("puts the drawn card back down without moving the turn on", async () => {
    const { ada, grace, adaView } = await playToAnOpenWindow();
    ada.watcher.reset();

    expectOk(await ask(ada.client, "slapDown"));

    const after = await ada.watcher.until(
      (v) => v.you.hand.length === adaView.you.hand.length - 1,
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
      adaView.you.hand.some((c) => c.id === slapped.id),
      "the card it went down from was the one she had just drawn",
    );
    assert.ok(
      !after.you.hand.some((c) => c.id === slapped.id),
      "and it left the hand it came from",
    );
    assert.equal(after.currentTurnPlayerId, grace.id, "a slapdown is not a turn");
    assert.equal(after.you.slapdownEligible, false, "the window closed behind it");
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
   */
  it("turns away a slap the next player's turn got in ahead of", async () => {
    const { ada, grace, adaView, graceView } = await playToAnOpenWindow();
    ada.watcher.reset();
    expectOk(await graceTakesHerTurn(grace, graceView));

    const result = await ask(ada.client, "slapDown");

    assert.equal(expectError(result).code, "SLAPDOWN_NOT_AVAILABLE");
    const after = await ada.watcher.until(
      (v) => v.phase !== "playing" || v.currentTurnPlayerId !== grace.id,
      "Grace's turn to be played out",
    );
    assert.equal(
      after.you.hand.length,
      adaView.you.hand.length,
      "the refused slap left Ada holding what she had",
    );
    assert.equal(after.you.slapdownEligible, false, "and no window to try again with");
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
      ? adaView.you.hand.length - 1
      : adaView.you.hand.length;
    if (!slap.ok) assert.equal(slap.error.code, "SLAPDOWN_NOT_AVAILABLE");
    const after = await ada.watcher.until(
      (v) => v.phase !== "playing" || v.currentTurnPlayerId !== grace.id,
      "the position both actions left behind",
    );
    assert.equal(
      after.you.hand.length,
      expectedHand,
      "Ada's hand agrees with the ack she was given",
    );
    // Whoever went first, the window is spent: no order of arrival leaves it open behind
    // both of them.
    assert.equal(after.you.slapdownEligible, false);
  });

  /**
   * The serializer is unit tested for this; here it is the wire that is under test.
   * An open window says its holder drew a rank they had just discarded, so it must
   * never appear in anyone else's payload, in any shape.
   */
  it("never tells the rest of the table that a window is open", async () => {
    const { ada, grace } = await playToAnOpenWindow();

    assert.ok(
      ada.heard.some((v) => v.you.slapdownEligible),
      "Ada really was told about her own window",
    );
    for (const view of grace.heard) {
      assert.equal(view.you.slapdownEligible, false, "Grace was told about a window");
      for (const opponent of view.opponents) {
        assert.ok(
          !("slapdownEligible" in opponent),
          "an opponent arrived carrying an eligibility flag",
        );
      }
      assert.ok(
        !JSON.stringify(view).includes('"slapdownEligible":true'),
        "an open window leaked into Grace's payload",
      );
    }
  });

  it("rejects a slap from a connection that is not in a room", async () => {
    const stranger = await table.connect();

    const result = await ask(stranger, "slapDown");

    assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
  });
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

  before(async () => {
    table = await startServer(4242);
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
        discardCardIds: [before.you.hand[0]!.id],
        draw: { source: "deck" },
      }),
    );
    const played = await watcher.until(
      (view) => view.phase === "playing" && view.you.hand.length === before.you.hand.length,
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
 * Ending a room on purpose. The host is the only one who can, and unlike `exitToMenu`
 * they can do it from anywhere — a table nobody wants to keep playing is a table nobody
 * wants to keep playing, mid-round or not.
 */
describe("closeRoom", () => {
  interface Pair {
    host: ClientSocket;
    guest: ClientSocket;
    roomCode: string;
    guestSeat: { playerId: string; resumeToken: string };
  }

  async function lobbyOfTwo(): Promise<Pair> {
    const host = await server.connect();
    const created = expectOk(
      await ask<{ roomCode: string; playerId: string; resumeToken: string }>(
        host,
        "createRoom",
        "Ada",
      ),
    );
    const guest = await server.connect();
    const joined = expectOk(
      await ask<{ playerId: string; resumeToken: string }>(
        guest,
        "joinRoom",
        created.roomCode,
        "Grace",
      ),
    );
    return { host, guest, roomCode: created.roomCode, guestSeat: joined };
  }

  it("tells everyone else why, and puts the room past joining or resuming", async () => {
    const { host, guest, roomCode, guestSeat } = await lobbyOfTwo();
    const closed = nextEvent<string>(guest, "roomClosed");

    expectOk(await ask(host, "closeRoom"));

    assert.match(await closed, /host/, "the reason names who ended it");
    const probe = await server.connect();
    assert.equal(
      expectError(await ask(probe, "joinRoom", roomCode, "Alan")).code,
      "ROOM_NOT_FOUND",
    );
    const returning = await server.connect();
    assert.equal(
      expectError(
        await ask(returning, "resumeSeat", { roomCode, ...guestSeat }),
      ).code,
      "ROOM_NOT_FOUND",
    );
  });

  it("turns every connection it closed on loose", async () => {
    const { host, guest } = await lobbyOfTwo();

    expectOk(await ask(host, "closeRoom"));

    // Neither is still bound to a room that no longer exists — the closer included,
    // who is never sent the `roomClosed` they caused.
    for (const client of [host, guest]) {
      expectOk(await ask(client, "createRoom", "Somewhere else"));
    }
  });

  it("is refused to anyone but the host, leaving the room standing", async () => {
    const { guest, roomCode } = await lobbyOfTwo();

    const result = await ask(guest, "closeRoom");

    assert.equal(expectError(result).code, "NOT_HOST");
    const probe = await server.connect();
    expectOk(await ask(probe, "joinRoom", roomCode, "Alan"));
  });

  it("closes a room mid-round, where exitToMenu will not", async () => {
    const { host, guest, roomCode } = await lobbyOfTwo();
    expectOk(await ask(host, "startGame"));
    assert.equal(expectError(await ask(host, "exitToMenu")).code, "WRONG_PHASE");
    const closed = nextEvent<string>(guest, "roomClosed");

    expectOk(await ask(host, "closeRoom"));

    await closed;
    const probe = await server.connect();
    assert.equal(
      expectError(await ask(probe, "joinRoom", roomCode, "Alan")).code,
      "ROOM_NOT_FOUND",
    );
  });

  it("rejects a close from a connection that is not in a room", async () => {
    const stranger = await server.connect();

    const result = await ask(stranger, "closeRoom");

    assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
  });
});

describe("disconnect", () => {
  /**
   * A dropped connection now costs the room nothing: the seat is held, and the player
   * behind it comes back through `resumeSeat`. Only the host closing the room ends one.
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
