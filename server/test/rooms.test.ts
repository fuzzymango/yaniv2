/**
 * A room's life, driven through `Rooms` with no socket under it (docs/adr/0025).
 *
 * `Rooms` is built here as the socket layer builds it, with a recording port in the
 * adapter's place: the test says who is connected, and every delivery is kept. The clock
 * is driven by hand, so time moves only when a test ticks it, and the room manager is
 * seeded, so a failure reproduces from its seed. Stats go to the in-memory store.
 *
 * What a test here may look at is what `Rooms` is answerable for: what the port was
 * handed, what the store was asked to record, and what the calls returned. It never reaches
 * into the timer registry, the bot runner or the manager's map — a test that did would be
 * testing how the room is built rather than what it does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlayerGameView, RoomSettings } from "@yaniv/shared";
import { MAX_PLAYERS, MAX_SCORE_LIMITS } from "@yaniv/shared";
import { decideTurn } from "../src/bot.ts";
import { AUTO_DEAL_MS, BOT_THINK_MS, ROOM_SWEEP_MS } from "../src/config.ts";
import { createDeck } from "../src/deck.ts";
import { callYaniv, slapDown, startGame, startNextRound, takeTurn } from "../src/game.ts";
import { createMemoryProfileStore, type ProfileStore } from "../src/profiles.ts";
import type { Result } from "../src/result.ts";
import { RoomManager } from "../src/roomManager.ts";
import { createRooms, type Rooms, type RoomsPort, type Transition } from "../src/rooms.ts";
import { mulberry32 } from "../src/rng.ts";
import {
  RESUME_TOKEN_MARK,
  expectErr,
  markedResumeTokens,
  playingSelf,
  slapdownOpen,
  testClock,
  unwrap,
  type TestClock,
} from "./helpers.ts";
import { recordingPort, type RecordingPort } from "./recordingPort.ts";

/** `Rooms` and everything a test here observes it through. */
interface Harness {
  rooms: Rooms;
  port: RecordingPort;
  clock: TestClock;
  profiles: ProfileStore;
  /** Everything `Rooms` logged. */
  logged: unknown[][];
}

/**
 * Compose `Rooms` the way `createSocketServer` does, over a recording port.
 *
 * Bot think time is left at its default: nothing here waits it out, the clock holding every
 * timer until a test ticks it, and a pause of the shipped length is one fewer thing that
 * differs from the room a player sits down at. `settings` seeds every room, `botCount`
 * among them — zero unless a test asks, as it is for a real room (docs/adr/0006). A test
 * pins its own `seed` where it is written against the cards one deals, and its own `port`
 * where the transport is what it is about.
 */
function harness(
  settings: Partial<RoomSettings> = {},
  { seed = 7, port = recordingPort() }: { seed?: number; port?: RecordingPort } = {},
): Harness {
  const clock = testClock();
  const profiles = createMemoryProfileStore();
  const logged: unknown[][] = [];
  const manager = new RoomManager({
    rng: mulberry32(seed),
    newResumeToken: markedResumeTokens(),
    newRoomRng: () => mulberry32(seed + 1),
    defaultSettings: settings,
  });
  const rooms = createRooms(manager, port, {
    clock,
    recordStats: (accountId, delta) => profiles.recordStats(accountId, delta),
    log: (...args) => logged.push(args),
  });
  return { rooms, port, clock, profiles, logged };
}

/** A seat, as a test holds on to it. */
interface Seated {
  roomCode: string;
  playerId: string;
}

/**
 * Who is connected moved, told to `Rooms` the way the adapter tells it: the port changed
 * first, then `attendanceChanged`.
 */
function arrive(h: Harness, { roomCode, playerId }: Seated): void {
  h.port.setConnected(roomCode, [...h.port.connected(roomCode), playerId]);
  h.rooms.attendanceChanged(roomCode);
}

function drop(h: Harness, { roomCode, playerId }: Seated): void {
  h.port.setConnected(
    roomCode,
    [...h.port.connected(roomCode)].filter((id) => id !== playerId),
  );
  h.rooms.attendanceChanged(roomCode);
}

/** Open a room and connect its host, as `createRoom` over a socket does. */
function host(h: Harness, name = "Ada", accountId: string | null = null): Seated {
  const { roomCode, playerId } = unwrap(h.rooms.createRoom(name, accountId));
  const seated = { roomCode, playerId };
  arrive(h, seated);
  return seated;
}

/** Seat and connect a second player, as `joinRoom` over a socket does. */
function join(h: Harness, roomCode: string, name: string): Seated {
  const { playerId } = unwrap(h.rooms.joinRoom(roomCode, name, null));
  const seated = { roomCode, playerId };
  arrive(h, seated);
  return seated;
}

/** Apply a transition that is expected to stand, with nothing to do once it has. */
function apply(h: Harness, roomCode: string, transition: Transition): void {
  unwrap(h.rooms.apply(roomCode, transition, () => {}));
}

/** The host deals the first round, bots seated inside the transition as the adapter does. */
function start(h: Harness, { roomCode, playerId }: Seated): void {
  apply(h, roomCode, (state, rng) => startGame(h.rooms.seatBots(state), playerId, rng));
}

/** The position one seat stands at now. */
function viewOf(h: Harness, { roomCode, playerId }: Seated): PlayerGameView {
  const view = h.rooms.viewFor(roomCode, playerId);
  assert.ok(view, `room ${roomCode} is gone`);
  return view;
}

/**
 * Play on until `done` says so: each human by the bot's own judgement when the table needs
 * them, and the server's own timers by ticking the clock when it does not. Answers the
 * first human's position at the stop.
 *
 * A table that needs nobody and has nothing waiting has stopped, which is a failure of
 * whatever the test is about rather than something to wait out.
 */
function playUntil(
  h: Harness,
  humans: Seated[],
  done: (view: PlayerGameView) => boolean,
): PlayerGameView {
  for (let step = 0; step < 5000; step++) {
    const view = viewOf(h, humans[0]!);
    if (done(view)) return view;

    const mover = humans.find((seat) => {
      const own = viewOf(h, seat);
      if (view.phase === "roundEnd") return !own.you.spectating;
      return view.phase === "playing" && view.currentTurnPlayerId === seat.playerId;
    });
    if (mover && view.phase === "roundEnd") {
      apply(h, mover.roomCode, (state, rng) => startNextRound(state, mover.playerId, rng));
      continue;
    }
    if (mover) {
      const decision = decideTurn(viewOf(h, mover));
      apply(h, mover.roomCode, (state, rng) =>
        decision.type === "yaniv"
          ? callYaniv(state, mover.playerId)
          : takeTurn(state, mover.playerId, decision.action, rng),
      );
      continue;
    }

    assert.ok(h.clock.pending() > 0, `the table stopped in ${view.phase}`);
    h.clock.tick();
  }
  assert.fail("the table never reached the position under test");
}

describe("a refused transition", () => {
  it("calls nothing, delivers nothing and schedules nothing", () => {
    const h = harness({ botCount: 2 });
    const ada = host(h);
    start(h, ada);
    const view = playUntil(h, [ada], (v) => v.currentTurnPlayerId === ada.playerId);
    const delivered = h.port.deliveries(ada.roomCode).length;
    assert.equal(h.clock.pending(), 0, "nothing was waiting on the clock to begin with");

    let accepted = false;
    const result: Result<null> = h.rooms.apply(
      ada.roomCode,
      (state, rng) =>
        takeTurn(
          state,
          ada.playerId,
          // No hand holds a card by this id, whatever was dealt.
          { discardCardIds: ["not-a-card"], draw: { source: "deck" } },
          rng,
        ),
      () => {
        accepted = true;
      },
    );

    expectErr(result, "CARD_NOT_IN_HAND");
    assert.equal(accepted, false, "accepted was called for a refusal");
    assert.equal(h.port.deliveries(ada.roomCode).length, delivered, "a refusal was published");
    assert.equal(h.clock.pending(), 0, "a refusal scheduled something");
    assert.deepEqual(viewOf(h, ada), view, "the position moved under a refusal");
  });
});

/**
 * `accepted` is where the adapter acks, so this order is what keeps a move acked before
 * its broadcast — which `session.ts`'s busy lock and the CLI harness's watermark are both
 * built on. It is `Rooms`' ordering, not something each caller remembers.
 */
describe("accepted", () => {
  it("runs before the first delivery of the position it accepted", () => {
    const h = harness();
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    const before = h.port.deliveries(ada.roomCode).length;

    let deliveredAtAccept: number | null = null;
    unwrap(
      h.rooms.apply(
        ada.roomCode,
        (state, rng) => startGame(state, ada.playerId, rng),
        () => {
          deliveredAtAccept = h.port.deliveries(ada.roomCode).length;
        },
      ),
    );

    assert.equal(deliveredAtAccept, before, "the deal was delivered before it was accepted");
    const [deal] = h.port.deliveries(ada.roomCode).slice(before);
    assert.equal(deal?.get(grace.playerId)?.phase, "playing", "and the deal went out after");
  });

  it("runs before a departure's delivery too, handed the departure", () => {
    const h = harness();
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);
    const before = h.port.deliveries(ada.roomCode).length;

    let atAccept: { delivered: number; name: string; ended: boolean } | null = null;
    const departure = unwrap(
      h.rooms.leave(ada.roomCode, grace.playerId, ({ name, ended }) => {
        atAccept = { delivered: h.port.deliveries(ada.roomCode).length, name, ended };
      }),
    );

    assert.deepEqual(atAccept, { delivered: before, name: "Grace", ended: false });
    assert.deepEqual(departure, { name: "Grace", ended: false });
    assert.equal(h.port.deliveries(ada.roomCode).length, before + 1, "the room was told after");
  });
});

/**
 * docs/adr/0013: who is connected is asked of the transport once per publication, so every
 * view of one position agrees about who was there. A transport whose answer moves between
 * two asks — a socket dropping mid-publication — is exactly the case that tells one ask from
 * several, so the port here moves on every one.
 */
describe("a publication", () => {
  it("builds every view of one position from one connected set", () => {
    const recording = recordingPort();
    // Once a test names a seat here, the transport loses it on every other ask.
    let flickering: string | null = null;
    let asked = 0;
    const flickers: RecordingPort = {
      ...recording,
      connected: (roomCode) => {
        const now = recording.connected(roomCode);
        if (flickering === null || ++asked % 2 === 0) return now;
        return new Set([...now].filter((id) => id !== flickering));
      },
    };
    const h = harness({}, { port: flickers });
    const ada = host(h);
    join(h, ada.roomCode, "Grace");
    const alan = join(h, ada.roomCode, "Alan");
    const settled = h.port.deliveries(ada.roomCode).length;

    flickering = alan.playerId;
    start(h, ada);
    h.rooms.attendanceChanged(ada.roomCode);
    h.rooms.attendanceChanged(ada.roomCode);

    const deliveries = h.port.deliveries(ada.roomCode).slice(settled);
    assert.equal(deliveries.length, 3, "the deal and both republications went out");
    assert.ok(
      deliveries.some((d) => !d.has(alan.playerId)) && deliveries.some((d) => d.has(alan.playerId)),
      "the transport never changed its mind, so nothing here tells one ask from several",
    );
    for (const delivery of deliveries) {
      const readings = [...delivery.values()].map((view) =>
        Object.fromEntries(
          [view.you, ...view.opponents].map((seat) => [seat.id, seat.connected]),
        ),
      );
      for (const reading of readings) {
        assert.deepEqual(reading, readings[0], "two views of one position disagreed");
      }
      const connected = Object.entries(readings[0] ?? {})
        .filter(([, present]) => present)
        .map(([id]) => id);
      assert.deepEqual(
        [...delivery.keys()].sort(),
        connected.sort(),
        "a view went to a seat its own set did not have connected, or missed one it did",
      );
    }
  });
});

/**
 * Deal a human in against bots and hand the turn to one, so the room has a bot thinking —
 * a timer that, left behind by a room that has gone, would fire at its code.
 */
function botThinking(h: Harness, human: Seated): void {
  start(h, human);
  const view = viewOf(h, human);
  if (view.currentTurnPlayerId === human.playerId) {
    apply(h, human.roomCode, (state, rng) =>
      takeTurn(
        state,
        human.playerId,
        // A single card is always a legal discard, whatever was dealt.
        { discardCardIds: [playingSelf(view).hand[0]!.id], draw: { source: "deck" } },
        rng,
      ),
    );
  }
  assert.ok(h.clock.delays().includes(BOT_THINK_MS), "a bot is thinking about its turn");
}

describe("leave", () => {
  it("answers ended and delivers nothing when the last human seat goes", () => {
    const h = harness({ botCount: 2 });
    const ada = host(h);
    botThinking(h, ada);
    const delivered = h.port.deliveries(ada.roomCode).length;

    let told: unknown = null;
    const departure = unwrap(
      h.rooms.leave(ada.roomCode, ada.playerId, (d) => {
        told = d;
      }),
    );

    assert.deepEqual(departure, { name: "Ada", ended: true });
    assert.deepEqual(told, departure, "accepted was handed what leave answered");
    assert.equal(h.port.deliveries(ada.roomCode).length, delivered, "an ended room was published");
    assert.equal(h.rooms.viewFor(ada.roomCode, ada.playerId), null, "the room is still there");
  });

  it("ends a lobby its host leaves alone, just the same", () => {
    const h = harness();
    const ada = host(h);
    const delivered = h.port.deliveries(ada.roomCode).length;

    assert.deepEqual(unwrap(h.rooms.leave(ada.roomCode, ada.playerId, () => {})), {
      name: "Ada",
      ended: true,
    });
    assert.equal(h.port.deliveries(ada.roomCode).length, delivered);
    assert.equal(h.rooms.viewFor(ada.roomCode, ada.playerId), null);
  });

  it("keeps a room one human is still seated in, and tells them", () => {
    const h = harness({ botCount: 1 });
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);
    const seen = h.port.received(ada.roomCode, ada.playerId).length;

    assert.deepEqual(unwrap(h.rooms.leave(ada.roomCode, grace.playerId, () => {})), {
      name: "Grace",
      ended: false,
    });

    const told = h.port.received(ada.roomCode, ada.playerId).slice(seen);
    assert.equal(told.length, 1, "the departure was published once");
    assert.ok(told[0]!.opponents.find((o) => o.id === grace.playerId)?.departed);
  });

  /**
   * The last *human* leaving is what ends a room, bots at the table or not — a finished
   * match with nobody left to play again at is a table of bots playing to no one
   * (docs/adr/0012).
   */
  it("ends a finished match its last human leaves, bots still seated", () => {
    const h = harness({ botCount: 2, maxScore: 20 });
    const ada = host(h);
    start(h, ada);
    const finished = playUntil(h, [ada], (v) => v.phase === "gameEnd");
    assert.ok(
      finished.opponents.some((o) => o.name.includes("(bot)")),
      "the table this is left with is a bot's",
    );

    assert.deepEqual(unwrap(h.rooms.leave(ada.roomCode, ada.playerId, () => {})), {
      name: "Ada",
      ended: true,
    });
    assert.equal(h.rooms.viewFor(ada.roomCode, ada.playerId), null, "the room is still there");
  });

  /**
   * Ended is gone, code and all: nothing seats anybody at it again, and the seat that was
   * given up there is not a way back in. Nobody is told, the seat that left being the only
   * one there was to tell.
   */
  it("seats and hands back nobody once it has ended", () => {
    const h = harness();
    const { roomCode, playerId, resumeToken } = unwrap(h.rooms.createRoom("Ada", null));
    arrive(h, { roomCode, playerId });

    unwrap(h.rooms.leave(roomCode, playerId, () => {}));

    expectErr(h.rooms.joinRoom(roomCode, "Alan", null), "ROOM_NOT_FOUND");
    expectErr(
      h.rooms.claimSeat(roomCode, playerId, { accountId: null, resumeToken }),
      "ROOM_NOT_FOUND",
    );
  });

  it("keeps a lobby one seat is still in, open to the next arrival", () => {
    const h = harness();
    const ada = host(h);
    join(h, ada.roomCode, "Grace");

    // Taken off the port inside `accepted`, as the adapter takes the socket out of the room:
    // a lobby splices the seat out, so there is no view left to build for it.
    const departure = h.rooms.leave(ada.roomCode, ada.playerId, () =>
      h.port.setConnected(
        ada.roomCode,
        [...h.port.connected(ada.roomCode)].filter((id) => id !== ada.playerId),
      ),
    );

    assert.deepEqual(unwrap(departure), { name: "Ada", ended: false });
    unwrap(h.rooms.joinRoom(ada.roomCode, "Alan", null));
  });

  /**
   * The difference between leaving and dropping, and so between this exit and the sweep: a
   * seat whose player is merely away is still somebody's, and a room is not ended under it.
   */
  it("keeps a room whose last human seat is only away", () => {
    const h = harness({ botCount: 1 });
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);
    drop(h, ada);

    assert.deepEqual(unwrap(h.rooms.leave(ada.roomCode, grace.playerId, () => {})), {
      name: "Grace",
      ended: false,
    });
    assert.ok(h.rooms.viewFor(ada.roomCode, ada.playerId), "the room was ended");
  });
});

/**
 * A room that has gone stops doing things (docs/adr/0015): whatever it had waiting on the
 * clock goes with it, by either way out, so no callback fires at a code that may be issued
 * again.
 *
 * The proof is the test's own clock standing empty — not the registry's bookkeeping, which
 * is `Rooms`' business, but the one thing every timer in the room is set on. With nothing
 * waiting there is no later tick at all, so none can deliver anything or count a stat. A
 * timer left behind would not show up any other way: firing at a room no longer stored, it
 * does nothing, which is exactly why one would go unnoticed until its code was issued again.
 */
describe("ending a room", () => {
  function assertNothingWaiting(h: Harness): void {
    assert.deepEqual(h.clock.delays(), [], "the room left something on the clock");
    assert.throws(() => h.clock.tick(), /nothing is waiting/);
  }

  it("cancels a bot's pending turn when its last human leaves", () => {
    const h = harness({ botCount: 2 });
    const ada = host(h);
    botThinking(h, ada);

    unwrap(h.rooms.leave(ada.roomCode, ada.playerId, () => {}));
    assertNothingWaiting(h);
  });

  /**
   * The seed deals a round that puts the human out and leaves three bots playing on, so the
   * room is holding a deal for its one spectator (docs/adr/0014) when they go.
   */
  it("cancels a waiting deal when its last human leaves", () => {
    const h = harness({ botCount: 3, maxScore: 20 }, { seed: 2 });
    const ada = host(h);
    start(h, ada);
    playUntil(h, [ada], (v) => v.phase === "roundEnd");
    assert.ok(viewOf(h, ada).you.spectating, "the round put the human out");
    assert.deepEqual(h.clock.delays(), [AUTO_DEAL_MS], "the deal is waiting");

    unwrap(h.rooms.leave(ada.roomCode, ada.playerId, () => {}));
    assertNothingWaiting(h);
  });

  it("cancels a bot's pending turn when it is swept", () => {
    const h = harness({ botCount: 2 });
    const ada = host(h);
    botThinking(h, ada);
    drop(h, ada);
    assert.ok(h.clock.delays().includes(ROOM_SWEEP_MS), "the grace period is running");

    h.clock.tickAt(ROOM_SWEEP_MS);

    assert.equal(h.rooms.viewFor(ada.roomCode, ada.playerId), null, "the room was not swept");
    assertNothingWaiting(h);
  });
});

/**
 * The one read `Rooms` has, for `resumeSeat`'s ack — there is no `getState`, so this is
 * everything the adapter can learn of a position, and it is a view.
 */
describe("viewFor", () => {
  it("returns the seat's own view of the position standing", () => {
    const h = harness({ botCount: 1 });
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);

    const view = viewOf(h, grace);
    assert.equal(view.you.id, grace.playerId);
    assert.equal(view.phase, "playing");
    assert.deepEqual(
      view,
      h.port.received(ada.roomCode, grace.playerId).at(-1),
      "not the view Grace was last delivered of the same position",
    );
  });

  it("returns null for a room that is not there", () => {
    const h = harness();
    const ada = host(h);
    assert.equal(h.rooms.viewFor("NOT-A-ROOM-CODE", ada.playerId), null);
  });
});

/**
 * A bot's turn is scheduled, not played in the tick that handed it over: every bot waits
 * out `BOT_THINK_MS`, every turn alike, and then plays against the position in front of it
 * — so a table of bots reads as a game being played, and a human can win the slapdown
 * window their own turn opened (docs/adr/0005, 0011).
 *
 * The clock is the whole of it: a turn that has *not* happened is asserted as precisely as
 * one that has, and each beat is checked for the interval it asked for — a chain that
 * hurried its later moves would look the same by its deliveries alone.
 */
describe("bot think time", () => {
  /**
   * A lone human at a table of five bots, dealt in. At a limit no run of rounds reaches,
   * since some of these fish a great many rounds for a position, and a human knocked out
   * along the way could deal no next round (docs/adr/0012).
   */
  function sitDown(seed: number): { h: Harness; ada: Seated; deal: PlayerGameView } {
    const h = harness({ botCount: MAX_PLAYERS - 1, maxScore: MAX_SCORE_LIMITS.max }, { seed });
    const ada = host(h);
    start(h, ada);
    return { h, ada, deal: viewOf(h, ada) };
  }

  /** Everything the human has been handed since they had seen `from` views. */
  const receivedSince = (h: Harness, ada: Seated, from: number) =>
    h.port.received(ada.roomCode, ada.playerId).slice(from);
  const receivedSoFar = (h: Harness, ada: Seated) => receivedSince(h, ada, 0).length;

  /** Let the one bot thinking play, and answer the position it produced. */
  function think(h: Harness, ada: Seated): PlayerGameView {
    const before = receivedSoFar(h, ada);
    assert.deepEqual(h.clock.delays(), [BOT_THINK_MS], "one bot thinking, for the interval");
    h.clock.tick();
    const played = receivedSince(h, ada, before);
    assert.equal(played.length, 1, "the beat played one move, delivered on its own");
    return played[0]!;
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

  /** The human's turn, taken by shedding one card and drawing blind. */
  function takeATurn(h: Harness, ada: Seated, from: PlayerGameView): void {
    const discard = fishingDiscard(from);
    apply(h, ada.roomCode, (state, rng) =>
      takeTurn(state, ada.playerId, { discardCardIds: [discard], draw: { source: "deck" } }, rng),
    );
  }

  /** The seat `n` places behind the human in turn order, wrapping round the table. */
  const behind = (deal: PlayerGameView, ada: Seated, n: number) =>
    deal.turnOrder[(deal.turnOrder.indexOf(ada.playerId) + n) % deal.turnOrder.length]!;

  it("leaves a bot's turn unplayed in the tick that handed it over", () => {
    const { h, ada, deal } = sitDown(4242);
    assert.equal(deal.currentTurnPlayerId, ada.playerId, "the host takes the first turn");
    const before = receivedSoFar(h, ada);

    takeATurn(h, ada, deal);

    const delivered = receivedSince(h, ada, before);
    assert.equal(delivered.length, 1, "the bot moved in the tick that handed it the turn");
    assert.equal(delivered[0]!.currentTurnPlayerId, behind(deal, ada, 1));
    assert.deepEqual(h.clock.delays(), [BOT_THINK_MS], "and it is thinking about its turn");
  });

  it("plays it once think time has elapsed", () => {
    const { h, ada, deal } = sitDown(4242);
    takeATurn(h, ada, deal);

    const played = think(h, ada);

    assert.equal(
      played.currentTurnPlayerId,
      behind(deal, ada, 2),
      "the first bot played and handed on to the second",
    );
  });

  it("advances a chain one turn per interval, in seating order", () => {
    const { h, ada, deal } = sitDown(4242);
    takeATurn(h, ada, deal);

    // Every seat behind the host, one tick at a time. `think` asserts a single timer was
    // waiting for each and a single delivery came of it, so nothing here can be two moves
    // in one beat.
    const seats: (string | null)[] = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) seats.push(think(h, ada).currentTurnPlayerId);

    assert.deepEqual(
      seats,
      [2, 3, 4, 5, 6].map((n) => behind(deal, ada, n)),
      "each bot in turn, and the turn back to the human",
    );
    assert.equal(h.clock.pending(), 0, "nothing is left thinking behind the human");
  });

  /**
   * The pause is a property of a bot's turn, not of a turn following a human's. Seeds are
   * dealt in order until one opens on a bot — most do, five in six — so the table this is
   * written against is the same one every run.
   */
  it("pauses before the first move of a round that opens on a bot", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { h, ada, deal } = sitDown(seed);
      if (deal.currentTurnPlayerId === ada.playerId) continue;

      assert.equal(deal.lastMove, null, "the opening bot has not moved");
      assert.deepEqual(h.clock.delays(), [BOT_THINK_MS], "it is thinking about it");

      const opener = deal.turnOrder.indexOf(deal.currentTurnPlayerId!);
      const opened = think(h, ada);
      assert.equal(
        opened.currentTurnPlayerId,
        deal.turnOrder[(opener + 1) % deal.turnOrder.length],
        "the opening bot played, once it had thought about it, and handed on",
      );
      return;
    }
    assert.fail("no deal ever opened on a bot");
  });

  /**
   * The whole of what makes slapdown against a bot winnable: there is no window timer,
   * only the pause the next bot takes (docs/adr/0005).
   *
   * The window cannot be arranged — it is opened by drawing blind — so the table is fished
   * until one appears, the bots played out on the clock along the way.
   */
  describe("the window it holds open", () => {
    /** Play until the human draws a card they may slap down, and stop exactly there. */
    function fishForAWindow(h: Harness, ada: Seated): PlayerGameView {
      for (let step = 0; step < 400; step++) {
        while (h.clock.pending() > 0) think(h, ada);
        const at = viewOf(h, ada);
        if (at.phase === "roundEnd") {
          apply(h, ada.roomCode, (state, rng) => startNextRound(state, ada.playerId, rng));
          continue;
        }
        assert.equal(at.currentTurnPlayerId, ada.playerId, "the table stopped on a bot");

        takeATurn(h, ada, at);
        const landed = viewOf(h, ada);
        if (landed.phase === "playing" && slapdownOpen(landed)) return landed;
      }
      assert.fail("no slapdown window ever opened");
    }

    function slap(h: Harness, ada: Seated): void {
      apply(h, ada.roomCode, (state) => slapDown(state, ada.playerId));
    }

    it("lets a human win a window the bot behind them is still thinking in", () => {
      const { h, ada } = sitDown(20250811);
      const open = fishForAWindow(h, ada);

      slap(h, ada);

      const after = viewOf(h, ada);
      assert.equal(after.lastSlapdown?.playerId, ada.playerId);
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
    });

    it("neither hurries the pending turn nor schedules a second", () => {
      const { h, ada } = sitDown(20250811);
      const open = fishForAWindow(h, ada);
      const before = receivedSoFar(h, ada);

      slap(h, ada);

      assert.equal(receivedSince(h, ada, before).length, 1, "only the slap itself was published");
      // `think` asserts the one timer, and one move out of its beat.
      const played = think(h, ada);
      assert.equal(
        played.lastMove?.playerId,
        open.currentTurnPlayerId,
        "which was a turn, taken by the bot",
      );
    });

    it("plays the bot's turn against the position the slap produced", () => {
      const { h, ada } = sitDown(20250811);
      const open = fishForAWindow(h, ada);
      const slapped = playingSelf(open).hand.find((c) => c.rank === open.lastDiscard[0]!.rank);
      assert.ok(slapped, "the window is over a card matching the set it would join");

      slap(h, ada);
      const played = think(h, ada);

      // The round's own log, which the bot's turn is written into after the slap: the card
      // was on the pile, in front of it, when it decided.
      const since = played.moveHistory.slice(-2);
      assert.deepEqual(
        since.map((entry) => entry.kind),
        ["slapdown", "turn"],
        "the bot moved after the slap, not around it",
      );
      assert.equal(since[0]!.playerId, ada.playerId);
      assert.equal(
        since[0]!.kind === "slapdown" && since[0]!.card.id,
        slapped.id,
        "and it is the slapped card the bot was looking at",
      );
    });
  });
});

/**
 * The security boundary, now inside `Rooms` (docs/adr/0025): every view is built here, so
 * what the port is handed is the whole of what could leak. Asserted over every delivery of
 * whole rounds, with two humans at the table so a view built for the wrong seat would be a
 * hand handed to the other.
 */
describe("what the port is handed", () => {
  const EVERY_CARD_ID = createDeck().map((c) => c.id);

  /**
   * The card ids a view names that its viewer may not know: anything outside their own hand
   * and the face-up discard, bar the one card a pickup took off that pile in plain sight.
   *
   * The round's log is checked on its own terms rather than excused wholesale: a discarded
   * set was face up when it was laid, so it may be named, but a deck draw is somebody's
   * hidden card and is named to its drawer alone.
   *
   * Both allowances are the redaction's own rules, not slack in this check: the pickup is
   * named on the last move (docs/adr/0007) and the log keeps what was laid face up (0010).
   * "Outside the viewer's hand and the face-up discard" means what may be known, and a card
   * everyone watched being played is known.
   */
  function hiddenCardsIn(view: PlayerGameView): string[] {
    const maySee = new Set(
      [...playingSelf(view).hand, ...view.lastDiscard].map((c) => c.id),
    );
    const lastMove = view.lastMove;
    if (lastMove?.drawSource === "discard" && lastMove.drawnCard) {
      maySee.add(lastMove.drawnCard.id);
    }
    const leaked: string[] = [];
    for (const entry of view.moveHistory) {
      if (entry.kind === "turn" && entry.drawSource === "deck" && entry.drawnCard) {
        if (entry.playerId !== view.you.id) leaked.push(entry.drawnCard.id);
      }
    }
    const json = JSON.stringify({ ...view, moveHistory: [] });
    for (const id of EVERY_CARD_ID) {
      if (!maySee.has(id) && json.includes(`"${id}"`)) leaked.push(id);
    }
    return leaked;
  }

  it("carries no card id mid-round outside the viewer's hand and the face-up discard", () => {
    const h = harness({ botCount: 2, maxScore: MAX_SCORE_LIMITS.max }, { seed: 11 });
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);
    playUntil(h, [ada, grace], (v) => v.roundNumber === 3);

    const midRound = h.port
      .deliveries(ada.roomCode)
      .flatMap((delivery) => [...delivery])
      .filter(([, view]) => view.phase === "playing");
    assert.ok(midRound.length > 50, "whole rounds were published");
    for (const [viewer, view] of midRound) {
      assert.equal(view.you.id, viewer, "a seat was handed somebody else's view");
      assert.deepEqual(hiddenCardsIn(view), [], `hidden cards reached ${viewer}`);
      for (const opponent of view.opponents) {
        assert.ok(!("hand" in opponent), "an opponent was sent with a hand attached");
      }
    }
  });

  /**
   * A resume token is a seat's credential — the seat itself, not a look at its cards — and
   * reaches its owner in the answer to the call that seated them and nowhere else. So no
   * view carries one, in any phase, to anybody, its owner included.
   */
  it("carries no resume token, in any phase", () => {
    const h = harness({ botCount: 2, maxScore: 20 });
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);
    const ended = playUntil(h, [ada, grace], (v) => v.phase === "gameEnd");

    const views = [
      ...h.port.deliveries(ada.roomCode).flatMap((delivery) => [...delivery.values()]),
      ended,
      viewOf(h, grace),
    ];
    assert.deepEqual(
      [...new Set(views.map((v) => v.phase))].sort(),
      ["gameEnd", "lobby", "playing", "roundEnd"],
      "a whole match was published",
    );
    for (const view of views) {
      assert.ok(
        !JSON.stringify(view).includes(RESUME_TOKEN_MARK),
        `a resume token reached ${view.you.id} in ${view.phase}`,
      );
    }
  });
});
