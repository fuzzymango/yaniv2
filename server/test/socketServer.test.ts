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
import type { GameError, PlayerGameView } from "@yaniv/shared";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { decideTurn } from "../src/bot.ts";
import { HAND_SIZE, MAX_PLAYERS, MAX_SCORE, YANIV_THRESHOLD } from "../src/config.ts";
import { createDeck } from "../src/deck.ts";
import { RoomManager } from "../src/roomManager.ts";
import { mulberry32 } from "../src/rng.ts";
import { handValue } from "../src/rules.ts";
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
 *
 * Pass a `seed` when a test's subject is the play itself rather than the wiring: the
 * deal then repeats exactly, so a test can be written against the cards that actually
 * come out rather than whatever the system rng felt like dealing.
 */
async function startServer(seed?: number): Promise<Harness> {
  const httpServer = createServer();
  const rooms =
    seed === undefined
      ? new RoomManager()
      : new RoomManager({
          rng: mulberry32(seed),
          newRoomRng: () => mulberry32(seed + 1),
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
  }

  /**
   * The serializer is unit tested for this, but the criterion is about what actually
   * goes down the wire — including the burst of broadcasts a run of bot turns produces,
   * which is the path most likely to reach for state directly and skip the serializer.
   */
  it("never puts another player's cards or the draw pile on the wire", async () => {
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

    it("refuses to leave mid-match, where quitting is still a disconnect", async () => {
      const { seats } = await openLobby(["Ada"]);
      expectOk(await ask(seats[0]!.client, "startGame"));

      const result = await ask(seats[0]!.client, "exitToMenu");

      assert.equal(expectError(result).code, "WRONG_PHASE");
    });

    it("rejects a leave from a connection that is not in a room", async () => {
      const stranger = await table.connect();

      const result = await ask(stranger, "exitToMenu");

      assert.equal(expectError(result).code, "PLAYER_NOT_FOUND");
    });
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
