/**
 * A room's life, driven through `Rooms` with no socket under it (docs/adr/0025).
 *
 * `Rooms` is built here as the socket layer builds it, with a recording port in the
 * adapter's place: the test says who is connected, and every delivery is kept. The clock
 * is driven by hand, so time moves only when a test ticks it, and the room manager is
 * seeded, so a failure reproduces from its seed. Stats go to the in-memory store, through
 * a write a test may stand a slow or failing store in front of.
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
import {
  createMemoryProfileStore,
  type AccountId,
  type ProfileStore,
  type StatsDelta,
} from "../src/profiles.ts";
import type { Result } from "../src/result.ts";
import { RoomManager } from "../src/roomManager.ts";
import { createRooms, type Rooms, type RoomsPort, type Transition } from "../src/rooms.ts";
import { mulberry32 } from "../src/rng.ts";
import {
  RESUME_TOKEN_MARK,
  expectErr,
  markedResumeTokens,
  fishingDiscard,
  occupant,
  playingSelf,
  seatBehind,
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
  /**
   * Every stats write `Rooms` started, in the order it started them — whatever the store
   * then did with it.
   */
  asked: { accountId: AccountId; delta: StatsDelta }[];
  /** Everything `Rooms` logged. */
  logged: unknown[][];
}

/** The stats write, as a test stands in front of the store it would have gone to. */
type StatsWrite = (accountId: AccountId, delta: StatsDelta, store: ProfileStore) => Promise<void>;

/**
 * Compose `Rooms` the way `createSocketServer` does, over a recording port.
 *
 * Bot think time is left at its default: nothing here waits it out, the clock holding every
 * timer until a test ticks it, and a pause of the shipped length is one fewer thing that
 * differs from the room a player sits down at. `settings` seeds every room, `botCount`
 * among them — zero unless a test asks, as it is for a real room (docs/adr/0006). A test
 * pins its own `seed` where it is written against the cards one deals, and its own `port`
 * where the transport is what it is about. Stats go to the memory store, or to `profiles`
 * where a test signs somebody up before the room is built; a test about a store that is
 * slow, down or broken swaps the write itself with `recordStats`, which is handed the store
 * it stands in front of.
 */
function harness(
  settings: Partial<RoomSettings> = {},
  {
    seed = 7,
    port = recordingPort(),
    profiles = createMemoryProfileStore(),
    recordStats = (accountId, delta, store) => store.recordStats(accountId, delta),
  }: {
    seed?: number;
    port?: RecordingPort;
    profiles?: ProfileStore | undefined;
    recordStats?: StatsWrite | undefined;
  } = {},
): Harness {
  const clock = testClock();
  const asked: Harness["asked"] = [];
  const logged: unknown[][] = [];
  const manager = new RoomManager({
    rng: mulberry32(seed),
    newResumeToken: markedResumeTokens(),
    newRoomRng: () => mulberry32(seed + 1),
    defaultSettings: settings,
  });
  const rooms = createRooms(manager, port, {
    clock,
    recordStats: (accountId, delta) => {
      asked.push({ accountId, delta });
      return recordStats(accountId, delta, profiles);
    },
    log: (...args) => logged.push(args),
  });
  return { rooms, port, clock, profiles, asked, logged };
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

/**
 * Open a room and connect its host, as `createRoom` over a socket does. Answers the seat
 * with the token it is claimed back by, for the tests about coming back to one.
 */
function host(
  h: Harness,
  name = "Ada",
  accountId: string | null = null,
): Seated & { resumeToken: string } {
  const { roomCode, playerId, resumeToken } = unwrap(h.rooms.createRoom(occupant(name, accountId)));
  arrive(h, { roomCode, playerId });
  return { roomCode, playerId, resumeToken };
}

/**
 * A lone human knocked out by the first round seed 2 deals, three bots playing on — so the
 * scored round it is left watching is one only the room can deal on (docs/adr/0014). A
 * guest, unless a test seats them under an account in the store it hands over.
 */
function outAndWatching({
  profiles,
  accountId = null,
}: { profiles?: ProfileStore; accountId?: AccountId | null } = {}): {
  h: Harness;
  ada: Seated;
  scored: PlayerGameView;
} {
  const h = harness({ botCount: 3, maxScore: 20 }, { seed: 2, profiles });
  const ada = host(h, "Ada", accountId);
  start(h, ada);
  const scored = playUntil(h, [ada], (v) => v.phase === "roundEnd");
  assert.ok(scored.you.spectating, "the round put the human out");
  return { h, ada, scored };
}

/** Seat and connect a second player, as `joinRoom` over a socket does. */
function join(
  h: Harness,
  roomCode: string,
  name: string,
  accountId: AccountId | null = null,
): Seated {
  const { playerId } = unwrap(h.rooms.joinRoom(roomCode, occupant(name, accountId)));
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

/** `seat`'s turn, taken by shedding `discard` — one card, always legal — and drawing blind. */
function shed(h: Harness, seat: Seated, discard: string): void {
  apply(h, seat.roomCode, (state, rng) =>
    takeTurn(state, seat.playerId, { discardCardIds: [discard], draw: { source: "deck" } }, rng),
  );
}

/** `seat` slaps the card they drew down, answering whether the room took it. */
function slap(h: Harness, seat: Seated): Result<null> {
  return h.rooms.apply(seat.roomCode, (state) => slapDown(state, seat.playerId), () => {});
}

/**
 * Deal a human in against bots and hand the turn to one, so the room has a bot thinking —
 * a timer that, left behind by a room that has gone, would fire at its code.
 */
function botThinking(h: Harness, human: Seated): void {
  start(h, human);
  const view = viewOf(h, human);
  if (view.currentTurnPlayerId === human.playerId) {
    shed(h, human, playingSelf(view).hand[0]!.id);
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
    const { roomCode, playerId, resumeToken } = host(h);

    unwrap(h.rooms.leave(roomCode, playerId, () => {}));

    expectErr(h.rooms.joinRoom(roomCode, occupant("Alan")), "ROOM_NOT_FOUND");
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
    unwrap(h.rooms.joinRoom(ada.roomCode, occupant("Alan")));
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

  /** The room is holding a deal for its one spectator (docs/adr/0014) when they go. */
  it("cancels a waiting deal when its last human leaves", () => {
    const { h, ada } = outAndWatching();
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

  /** How many views the human has been handed so far. */
  const seenCount = (h: Harness, ada: Seated) =>
    h.port.received(ada.roomCode, ada.playerId).length;
  /** The views the human has been handed after the first `count`. */
  const receivedAfter = (h: Harness, ada: Seated, count: number) =>
    h.port.received(ada.roomCode, ada.playerId).slice(count);

  /** Let the one bot thinking play, and answer the position it produced. */
  function think(h: Harness, ada: Seated): PlayerGameView {
    const before = seenCount(h, ada);
    assert.deepEqual(h.clock.delays(), [BOT_THINK_MS], "one bot thinking, for the interval");
    h.clock.tick();
    const played = receivedAfter(h, ada, before);
    assert.equal(played.length, 1, "the beat played one move, delivered on its own");
    return played[0]!;
  }

  it("leaves a bot's turn unplayed in the tick that handed it over", () => {
    const { h, ada, deal } = sitDown(4242);
    assert.equal(deal.currentTurnPlayerId, ada.playerId, "the host takes the first turn");
    const before = seenCount(h, ada);

    shed(h, ada, fishingDiscard(deal));

    const delivered = receivedAfter(h, ada, before);
    assert.equal(delivered.length, 1, "the bot moved in the tick that handed it the turn");
    assert.equal(delivered[0]!.currentTurnPlayerId, seatBehind(deal, ada.playerId, 1));
    assert.deepEqual(h.clock.delays(), [BOT_THINK_MS], "and it is thinking about its turn");
  });

  it("plays it once think time has elapsed", () => {
    const { h, ada, deal } = sitDown(4242);
    shed(h, ada, fishingDiscard(deal));

    const played = think(h, ada);

    assert.equal(
      played.currentTurnPlayerId,
      seatBehind(deal, ada.playerId, 2),
      "the first bot played and handed on to the second",
    );
  });

  it("advances a chain one turn per interval, in seating order", () => {
    const { h, ada, deal } = sitDown(4242);
    shed(h, ada, fishingDiscard(deal));

    // Every seat behind the host, one tick at a time. `think` asserts a single timer was
    // waiting for each and a single delivery came of it, so nothing here can be two moves
    // in one beat.
    const seats: (string | null)[] = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) seats.push(think(h, ada).currentTurnPlayerId);

    assert.deepEqual(
      seats,
      [2, 3, 4, 5, 6].map((n) => seatBehind(deal, ada.playerId, n)),
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

      const opened = think(h, ada);
      assert.equal(
        opened.currentTurnPlayerId,
        seatBehind(deal, deal.currentTurnPlayerId!, 1),
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
        // A limit no run of rounds reaches, so the match never ends under the fishing.
        assert.equal(at.phase, "playing", `the fishing stopped in ${at.phase}`);
        assert.equal(at.currentTurnPlayerId, ada.playerId, "the table stopped on a bot");

        shed(h, ada, fishingDiscard(at));
        const landed = viewOf(h, ada);
        if (landed.phase === "playing" && slapdownOpen(landed)) return landed;
      }
      assert.fail("no slapdown window ever opened");
    }

    it("lets a human win a window the bot behind them is still thinking in", () => {
      const { h, ada } = sitDown(20250811);
      const open = fishForAWindow(h, ada);

      unwrap(slap(h, ada));

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
      const before = seenCount(h, ada);

      unwrap(slap(h, ada));

      assert.equal(receivedAfter(h, ada, before).length, 1, "only the slap itself was published");
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

      unwrap(slap(h, ada));
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
 * Dealing a scored round on when nobody left in the match can deal it (docs/adr/0014).
 *
 * A spectator whose match went on without them watches the bots that beat them play; only
 * a player still in the match may deal the next round (docs/adr/0012), so the room deals it
 * after a pause — at `roundEnd` and nowhere else, where every seat still in the match is a
 * bot, and while somebody is watching. Each condition is a rule, so each has a table here
 * that fails it alone and is left waiting on nothing but what a drop starts.
 *
 * The clock is the whole of it again: a deal that is not waiting is asserted as precisely
 * as one that is, and the interval says which pause a timer is.
 */
describe("auto-dealing a table only bots are still playing", () => {
  it("deals the next round for a spectator once the pause has elapsed", () => {
    const { h, ada, scored } = outAndWatching();
    assert.deepEqual(h.clock.delays(), [AUTO_DEAL_MS], "the scored round waits to deal itself on");
    const seen = h.port.received(ada.roomCode, ada.playerId).length;

    h.clock.tickAt(AUTO_DEAL_MS);

    const delivered = h.port.received(ada.roomCode, ada.playerId).slice(seen);
    assert.equal(delivered.length, 1, "the deal was published, once");
    const dealt = delivered[0]!;
    assert.equal(dealt.phase, "playing", "the next round, dealt by nobody at the table");
    assert.equal(dealt.roundNumber, scored.roundNumber + 1, "the round after the one it watched");
    assert.ok(dealt.you.spectating, "and the spectator is still watching, not dealt in");
    assert.deepEqual(
      h.clock.delays(),
      [BOT_THINK_MS],
      "and followed like any other new position: the bot it opened on is thinking",
    );
  });

  /**
   * The standings are there to be read, and play again is offered to anybody still in the
   * room (docs/adr/0012). The same spectator watches the bots play the match out, so the
   * position differs from a dealable one by its phase alone.
   */
  it("leaves a finished match up", () => {
    const { h, ada } = outAndWatching();

    const finished = playUntil(h, [ada], (v) => v.phase === "gameEnd");

    assert.ok(finished.you.spectating, "somebody is watching the bots that finished it");
    assert.equal(h.clock.pending(), 0, "a finished match waits on nothing");
  });

  /**
   * A human still in the match is who the round is waiting for, whether or not there is a
   * connection behind them: a drop costs a seat nothing (docs/adr/0013), and dealing the
   * next round out from under one is the one thing it must not cost.
   */
  it("waits on a human still in the match, dropped or not", () => {
    // A limit no round of this reaches, so the human is scored rather than knocked out.
    const h = harness({ botCount: 3, maxScore: MAX_SCORE_LIMITS.max });
    const ada = host(h);
    start(h, ada);
    const scored = playUntil(h, [ada], (v) => v.phase === "roundEnd");
    assert.ok(!scored.you.spectating, "the human is still in the match");
    assert.equal(h.clock.pending(), 0, "the round is the human's to deal");

    drop(h, ada);

    // The room's own grace period is the only thing a drop starts (docs/adr/0015).
    assert.deepEqual(h.clock.delays(), [ROOM_SWEEP_MS], "and still theirs once they have gone");
  });

  /**
   * Somebody watching is not enough while somebody else is still playing: the round is
   * theirs to deal, and the one knocked out is watching them, not the bots. Two humans, so
   * the conditions come apart — one spectating, one in the match — which a lone human never
   * can.
   */
  it("waits on a human still in the match while another watches", () => {
    const h = harness({ botCount: 2, maxScore: 20 }, { seed: 2 });
    const ada = host(h);
    const grace = join(h, ada.roomCode, "Grace");
    start(h, ada);
    playUntil(h, [ada, grace], (v) => v.phase === "roundEnd");
    const watching = [ada, grace].filter((seat) => viewOf(h, seat).you.spectating);
    assert.equal(watching.length, 1, "the round put exactly one of them out");

    assert.equal(h.clock.pending(), 0, "the round is the other human's to deal");
  });

  it("calls the pause off when the spectator it was for goes, and on again when they return", () => {
    const { h, ada } = outAndWatching();

    drop(h, ada);
    // A table with nobody watching plays to nobody: the deal is off, and what takes its
    // place is the room's grace period. The two never run together — the deal wants a
    // spectator there and the sweep wants nobody.
    assert.deepEqual(h.clock.delays(), [ROOM_SWEEP_MS], "a table nobody watches is not dealt on");

    arrive(h, ada);
    assert.deepEqual(h.clock.delays(), [AUTO_DEAL_MS], "the spectator back is waiting again");
  });

  // The spectator *leaving* is ending a room: "cancels a waiting deal when its last human
  // leaves", above.
});

/**
 * Sweeping a room nobody is in any more (docs/adr/0015).
 *
 * A room ends when its last seat leaves, which says nothing about the exits players do not
 * take: a tab closed, a phone backgrounded. Those rooms are given a minute and then dropped
 * — a minute rather than nothing, because a reload is a disconnect and a seat is resumable
 * precisely so a drop costs nothing (docs/adr/0013).
 *
 * A return is told to `Rooms` the way `resumeSeat` tells it: the seat claimed, then the
 * connection counted in. The room having gone is observed as a client would find it —
 * a join refused, no view to build — never by asking the manager.
 */
describe("sweeping a room nobody is in", () => {
  /** One human alone in a fresh room, bots seated at the deal if a test asks for them. */
  function aloneInARoom(botCount = 0): { h: Harness; ada: Seated; resumeToken: string } {
    const h = harness({ botCount });
    const { resumeToken, ...ada } = host(h);
    return { h, ada, resumeToken };
  }

  /** The seat claimed back by its token, as `resumeSeat` claims it before it publishes. */
  function claimBack(h: Harness, ada: Seated, resumeToken: string): void {
    unwrap(h.rooms.claimSeat(ada.roomCode, ada.playerId, { accountId: null, resumeToken }));
  }

  function comeBack(h: Harness, ada: Seated, resumeToken: string): void {
    claimBack(h, ada, resumeToken);
    arrive(h, ada);
  }

  const sweepWaiting = (h: Harness) => h.clock.delays().includes(ROOM_SWEEP_MS);

  it("drops a room no human has been connected to for the grace period", () => {
    const { h, ada } = aloneInARoom();
    assert.ok(!sweepWaiting(h), "a room with somebody in it is not counted down");

    drop(h, ada);
    assert.ok(sweepWaiting(h), "the grace period is running");
    assert.ok(h.rooms.viewFor(ada.roomCode, ada.playerId), "the drop itself dropped the room");

    h.clock.tickAt(ROOM_SWEEP_MS);

    assert.equal(h.rooms.viewFor(ada.roomCode, ada.playerId), null, "the room is still there");
    expectErr(h.rooms.joinRoom(ada.roomCode, occupant("Alan")), "ROOM_NOT_FOUND");
  });

  /** A reload is a disconnect, and the connection coming back is the whole answer to one. */
  it("keeps a room whose connection comes back inside the grace period", () => {
    const { h, ada, resumeToken } = aloneInARoom();
    drop(h, ada);
    assert.ok(sweepWaiting(h), "the grace period is running");

    comeBack(h, ada, resumeToken);

    assert.equal(h.clock.pending(), 0, "nothing is counting the room down");
    unwrap(h.rooms.joinRoom(ada.roomCode, occupant("Alan")));
  });

  it("gives a lone human against bots their match back after a reload", () => {
    const { h, ada, resumeToken } = aloneInARoom(2);
    botThinking(h, ada);
    const before = viewOf(h, ada);

    drop(h, ada);
    assert.ok(sweepWaiting(h), "the grace period is running");
    comeBack(h, ada, resumeToken);

    const view = viewOf(h, ada);
    assert.equal(view.phase, "playing", "the same round, still being played");
    assert.equal(view.roundNumber, before.roundNumber);
    assert.deepEqual(
      playingSelf(view).hand.map((c) => c.id),
      playingSelf(before).hand.map((c) => c.id),
      "and the same hand in front of them",
    );
    assert.ok(!sweepWaiting(h), "nothing is counting the room down");
  });

  /**
   * A claim is seated before it is published, so a return landing in the grace period's
   * last tick has a connection the transport knows of and `Rooms` has not yet been told
   * about. The far end asks the port again rather than trusting the set the pause began
   * with, or that return would have its room swept out from under it.
   */
  it("asks who is there again before dropping the room", () => {
    const { h, ada, resumeToken } = aloneInARoom();
    drop(h, ada);

    // Claimed and in the transport's room, with `attendanceChanged` still to come.
    claimBack(h, ada, resumeToken);
    h.port.setConnected(ada.roomCode, [ada.playerId]);
    h.clock.tickAt(ROOM_SWEEP_MS);

    assert.ok(h.rooms.viewFor(ada.roomCode, ada.playerId), "the room was swept from under them");
    unwrap(h.rooms.joinRoom(ada.roomCode, occupant("Alan")));
  });

  // What a swept room takes with it is ending a room's: "cancels a bot's pending turn when
  // it is swept", above.
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

/**
 * Stats, read off every accepted transition by the observer `Rooms` registers on the room
 * manager (docs/adr/0024, 0025) — so each route to a new position is here: a human's move,
 * a bot's on the clock, the auto-deal, and an exit.
 *
 * The write is started inside a resolved promise and awaited by nothing (docs/adr/0023), so
 * no call that earned a stat has reached the store by the time it returns. A test reading
 * the store lets the writes land first; `h.asked` is what `Rooms` started, whatever the
 * store then did with it.
 *
 * What each transition earns is `statsEarned`'s, and pinned down by `stats.test.ts`. What is
 * proved here is that every route reaches it, that what it answers is written — one merged
 * delta per account per transition — and that a store which hangs, rejects or throws costs
 * a counter and never the table.
 */
describe("stats counted on the players' accounts", () => {
  /**
   * Let every write started so far land. The event loop's next turn, not a timer: every
   * write is a promise chain queued already, and no real time passes.
   */
  const writesLanded = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** An account in `profiles` for a seat to be taken under, as a first Google sign-in makes. */
  async function signUp(profiles: ProfileStore, name: string): Promise<AccountId> {
    const { id } = await profiles.createAccount(name, {
      kind: "google",
      identifier: `google-sub-for-${name}`,
      secret: null,
    });
    return id;
  }

  async function statsOf(h: Harness, accountId: AccountId) {
    const account = await h.profiles.loadAccount(accountId);
    assert.ok(account, `no account ${accountId}`);
    return account;
  }

  /**
   * A signed-in human at a table of `bots` bots, dealt in — at a limit no run of rounds
   * reaches, since some tests here play a good many looking for a call of one kind, and a
   * human knocked out on the way could deal no next round (docs/adr/0012).
   */
  async function againstBots({
    bots = 3,
    recordStats,
  }: {
    bots?: number;
    recordStats?: StatsWrite;
  } = {}): Promise<{ h: Harness; ada: Seated; accountId: AccountId }> {
    const h = harness({ botCount: bots, maxScore: MAX_SCORE_LIMITS.max }, { recordStats });
    const accountId = await signUp(h.profiles, "Ada");
    const ada = host(h, "Ada", accountId);
    start(h, ada);
    return { h, ada, accountId };
  }

  /** The rounds scored so far that `seat` called. */
  const calledBy = (view: PlayerGameView, seat: Seated) =>
    view.scorecard.filter((round) => round.callerId === seat.playerId);

  /**
   * What `seat`'s account is owed for the rounds scored so far, one write per round and in
   * the order they were scored: a call of theirs, merged with its being Assafed where it
   * was, or an Assaf of somebody else's call. A round they neither called nor Assafed owes
   * them nothing, a bot's call included. Only for a table nobody has gone out at.
   */
  const owed = (view: PlayerGameView, seat: Seated): StatsDelta[] =>
    view.scorecard.flatMap((round): StatsDelta[] => {
      if (round.callerId === seat.playerId) {
        return [round.assaferId === null ? { yanivCalls: 1 } : { yanivCalls: 1, callsAssafed: 1 }];
      }
      return round.assaferId === seat.playerId ? [{ assafs: 1 }] : [];
    });

  describe("a human's move", () => {
    it("counts a signed-in player's call on their account", async () => {
      const { h, ada, accountId } = await againstBots();

      playUntil(h, [ada], (v) => calledBy(v, ada).length === 1);
      await writesLanded();

      assert.equal((await statsOf(h, accountId)).yanivCalls, 1);
    });

    it("counts a call that was Assafed exactly as one that stood, and as Assafed", async () => {
      const { h, ada, accountId } = await againstBots();

      const scored = playUntil(h, [ada], (v) => {
        const mine = calledBy(v, ada);
        return mine.some((r) => r.assaferId !== null) && mine.some((r) => r.assaferId === null);
      });
      await writesLanded();

      const mine = calledBy(scored, ada);
      const stats = await statsOf(h, accountId);
      assert.equal(stats.yanivCalls, mine.length);
      assert.equal(stats.callsAssafed, mine.filter((r) => r.assaferId !== null).length);
    });

    it("writes nothing for a guest's call", async () => {
      const h = harness({ botCount: 3, maxScore: MAX_SCORE_LIMITS.max });
      const ada = host(h);
      start(h, ada);

      playUntil(h, [ada], (v) => calledBy(v, ada).length === 2);
      await writesLanded();

      assert.deepEqual(h.asked, []);
    });
  });

  /**
   * Played on the room's own clock, with no call of the player's anywhere under it — and
   * credited to the player all the same, where it is theirs to be credited.
   */
  describe("a bot's move", () => {
    it("counts an Assaf on the account of a player who catches a bot's call", async () => {
      const { h, ada, accountId } = await againstBots({ bots: 1 });

      playUntil(h, [ada], (v) =>
        v.scorecard.some((r) => r.callerId !== ada.playerId && r.assaferId === ada.playerId),
      );
      await writesLanded();

      assert.equal((await statsOf(h, accountId)).assafs, 1);
    });

    /**
     * The whole of what was written, write by write: one merged delta per round owed —
     * a call and its being Assafed are one write, not two that could half land — and none
     * at all for a bot's call the player had no part in.
     */
    it("writes nothing for a bot's call the player did not Assaf", async () => {
      const { h, ada, accountId } = await againstBots();

      const scored = playUntil(
        h,
        [ada],
        (v) =>
          calledBy(v, ada).some((r) => r.assaferId !== null) &&
          v.scorecard.some((r) => r.callerId !== ada.playerId && r.assaferId !== ada.playerId),
      );
      await writesLanded();

      assert.deepEqual(
        h.asked,
        owed(scored, ada).map((delta) => ({ accountId, delta })),
      );
      assert.equal((await statsOf(h, accountId)).yanivCalls, calledBy(scored, ada).length);
    });

    /**
     * At a limit of 1 any round the player does not win puts them out, and a player who
     * never calls cannot win one but by an Assaf — which the seed does not deal, the
     * assertion on the phase saying so if it ever does.
     */
    it("counts a match a bot's call knocks the player out of as completed, and not won", async () => {
      const h = harness({ botCount: 1, maxScore: MAX_SCORE_LIMITS.min });
      const accountId = await signUp(h.profiles, "Ada");
      const ada = host(h, "Ada", accountId);
      start(h, ada);

      const ended = (() => {
        for (let step = 0; step < 5000; step++) {
          const at = viewOf(h, ada);
          if (at.phase === "gameEnd") return at;
          assert.equal(at.phase, "playing", "a round was scored and the player survived it");
          if (at.currentTurnPlayerId !== ada.playerId) {
            h.clock.tick();
            continue;
          }
          shed(h, ada, playingSelf(at).hand[0]!.id);
        }
        assert.fail("the bot never called");
      })();
      assert.notDeepEqual(ended.winnerIds, [ada.playerId], "the bot won the match");
      await writesLanded();

      const stats = await statsOf(h, accountId);
      assert.equal(stats.gamesCompleted, 1);
      assert.equal(stats.gamesWon, 0);
    });
  });

  /**
   * The rounds after a signed-in player is knocked out are dealt by the room and played by
   * bots, so nothing on this route is anybody's to be credited — and what is proved is that
   * nothing is: the match the player saw through was counted when they went out, and the
   * bots finishing it off without them count it no second time.
   */
  describe("the auto-deal", () => {
    it("credits a spectator nothing more for the rounds it deals on", async () => {
      const profiles = createMemoryProfileStore();
      const accountId = await signUp(profiles, "Ada");
      const { h, ada, scored } = outAndWatching({ profiles, accountId });
      await writesLanded();
      const atElimination = h.asked.length;
      assert.equal((await statsOf(h, accountId)).gamesCompleted, 1, "counted going out");

      const ended = playUntil(h, [ada], (v) => v.phase === "gameEnd");
      await writesLanded();

      assert.ok(ended.roundNumber > scored.roundNumber, "the room dealt a round on");
      assert.deepEqual(h.asked.slice(atElimination), [], "the rounds after were credited");
      const stats = await statsOf(h, accountId);
      assert.equal(stats.gamesCompleted, 1);
      assert.equal(stats.gamesWon, 0);
    });
  });

  /**
   * Nobody's move ends this match: the second-to-last player leaving does, with no round
   * ever scored — and the one left has seen it through, and won. The leaver went out by
   * going, which completes nothing.
   */
  describe("an exit", () => {
    it("counts a match an exit ends as completed and won by whoever is left", async () => {
      const h = harness();
      const adaAccount = await signUp(h.profiles, "Ada");
      const graceAccount = await signUp(h.profiles, "Grace");
      const ada = host(h, "Ada", adaAccount);
      const grace = join(h, ada.roomCode, "Grace", graceAccount);
      start(h, ada);

      const { ended } = unwrap(h.rooms.leave(ada.roomCode, grace.playerId, () => {}));
      assert.equal(ended, false, "the room stood for the one left in it");
      assert.equal(viewOf(h, ada).phase, "gameEnd");
      await writesLanded();

      const stats = await statsOf(h, adaAccount);
      assert.equal(stats.gamesCompleted, 1);
      assert.equal(stats.gamesWon, 1);
      assert.equal((await statsOf(h, graceAccount)).gamesCompleted, 0);
    });
  });

  /**
   * A human's own move again, and the one stat a turn does not earn. Two humans and no
   * bots, so Grace plays directly after Ada whatever the seating the deal draws
   * (docs/rules.md §2), and the window Ada's draw opens is hers until Grace moves.
   */
  describe("a slapdown", () => {
    /**
     * Ada and Grace, both signed in, played until Ada draws a card she may slap down and
     * left exactly there: her window open, the turn on Grace, nothing else moved. Nobody
     * calls, so the round the fishing starts in is the one it ends in.
     */
    async function toAnOpenWindow(): Promise<{
      h: Harness;
      ada: Seated & { accountId: AccountId };
      grace: Seated & { accountId: AccountId };
    }> {
      const h = harness({ maxScore: MAX_SCORE_LIMITS.max }, { seed: 20250811 });
      const adaAccount = await signUp(h.profiles, "Ada");
      const graceAccount = await signUp(h.profiles, "Grace");
      const ada = { ...host(h, "Ada", adaAccount), accountId: adaAccount };
      const grace = {
        ...join(h, ada.roomCode, "Grace", graceAccount),
        accountId: graceAccount,
      };
      start(h, ada);

      for (let step = 0; step < 400; step++) {
        const at = viewOf(h, ada);
        assert.equal(at.phase, "playing", `the fishing stopped in ${at.phase}`);
        const mover = at.currentTurnPlayerId === ada.playerId ? ada : grace;
        shed(h, mover, fishingDiscard(viewOf(h, mover)));
        if (mover === ada && slapdownOpen(viewOf(h, ada))) return { h, ada, grace };
      }
      assert.fail("no slapdown window ever opened");
    }

    it("counts an accepted slapdown on the slapper's account, a refused one on nobody's", async () => {
      const { h, ada, grace } = await toAnOpenWindow();

      unwrap(slap(h, ada));
      for (const late of [grace, ada]) expectErr(slap(h, late), "SLAPDOWN_NOT_AVAILABLE");
      await writesLanded();

      assert.equal((await statsOf(h, ada.accountId)).slapdowns, 1);
      assert.equal((await statsOf(h, grace.accountId)).slapdowns, 0);
    });

    it("counts nothing for a slap the next player's turn got in ahead of", async () => {
      const { h, ada, grace } = await toAnOpenWindow();
      shed(h, grace, playingSelf(viewOf(h, grace)).hand[0]!.id);

      expectErr(slap(h, ada), "SLAPDOWN_NOT_AVAILABLE");
      await writesLanded();

      assert.equal((await statsOf(h, ada.accountId)).slapdowns, 0);
    });
  });

  /**
   * A database that is slow or down costs a counter and never the table (docs/adr/0023):
   * the write is started once the move it was earned by has been made and published, and
   * nothing waits on it.
   */
  describe("a store that is slow or down", () => {
    const never = () => new Promise<void>(() => {});

    it("is not reached until the move it was earned by has been published", async () => {
      const h = harness({}, { recordStats: never });
      const ada = host(h, "Ada", await signUp(h.profiles, "Ada"));
      const grace = join(h, ada.roomCode, "Grace");
      start(h, ada);
      const delivered = h.port.deliveries(ada.roomCode).length;

      unwrap(h.rooms.leave(ada.roomCode, grace.playerId, () => {}));

      assert.equal(
        h.port.received(ada.roomCode, ada.playerId).at(-1)?.phase,
        "gameEnd",
        "the match's end was published",
      );
      assert.equal(h.port.deliveries(ada.roomCode).length, delivered + 1);
      assert.deepEqual(h.asked, [], "the store was reached inside the call");
      await writesLanded();
      assert.equal(h.asked.length, 1, "and was reached after it");
    });

    /**
     * The scored rounds go out and the next are dealt and played — bots and all — over
     * writes still pending, and the store is asked for every one of them.
     */
    it("holds up nothing when the store never answers", async () => {
      const { h, ada, accountId } = await againstBots({ recordStats: never });

      playUntil(h, [ada], (v) => calledBy(v, ada).length === 2);
      const scored = playUntil(h, [ada], (v) => calledBy(v, ada).length === 3);
      await writesLanded();

      assert.deepEqual(
        h.asked.map((write) => write.accountId),
        owed(scored, ada).map(() => accountId),
        "the store was asked, and hung",
      );
    });

    /**
     * Dropped, and logged naming the account — so a missing account can be told from a
     * dead connection — and nothing else. An unhandled rejection would take the whole
     * process down, and this suite with it.
     */
    it("logs a failed write naming the account, and plays on", async () => {
      const failure = new Error("the database is down");
      const { h, ada, accountId } = await againstBots({
        recordStats: () => Promise.reject(failure),
      });

      const scored = playUntil(h, [ada], (v) => calledBy(v, ada).length === 2);
      await writesLanded();

      assert.equal(h.logged.length, owed(scored, ada).length);
      for (const entry of h.logged) {
        assert.ok(String(entry[0]).includes(accountId), "the log names the account");
        assert.ok(entry.includes(failure), "and carries the failure");
      }
    });

    /**
     * `ProfileStore` promises a promise, and both shipped stores keep that by being
     * `async` — but one that threw before returning a promise would otherwise throw out of
     * `apply`, past the `.catch` meant for it. The same answer, whichever way it fails.
     */
    it("logs a store that throws rather than rejecting, and plays on", async () => {
      const failure = new Error("thrown, not rejected");
      const { h, ada } = await againstBots({
        recordStats: () => {
          throw failure;
        },
      });

      const scored = playUntil(h, [ada], (v) => calledBy(v, ada).length === 2);
      await writesLanded();

      assert.equal(h.logged.length, owed(scored, ada).length);
      assert.ok(h.logged.every((entry) => entry.includes(failure)));
    });
  });
});
