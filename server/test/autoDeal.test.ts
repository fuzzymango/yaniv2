/**
 * Dealing a table on that nobody left in the match can deal.
 *
 * Two questions, and they are kept apart here exactly as the module keeps them: what a
 * position *says* about auto-dealing (`autoDealSeat`, pure over a state and who is
 * looking at it), and what the room then has waiting on the clock (`consider`, over a
 * real room and a clock this suite drives by hand).
 *
 * States are written into a live room rather than dealt for, as `botTurns.test.ts` does:
 * who is out, who is a bot and who is connected is the entire subject, so all three are
 * stated outright rather than fished for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoDealSeat, createAutoDealer } from "../src/autoDeal.ts";
import { AUTO_DEAL_MS } from "../src/config.ts";
import { ok } from "../src/result.ts";
import { RoomManager } from "../src/roomManager.ts";
import { createRoomTimers } from "../src/roomTimers.ts";
import { mulberry32 } from "../src/rng.ts";
import type { GameState } from "../src/state.ts";
import { makeState, testClock, unwrap, type StateOptions } from "./helpers.ts";

/** A live room holding exactly the state described, under its real room code. */
function room(options: StateOptions): { rooms: RoomManager; roomCode: string } {
  const rooms = new RoomManager({
    rng: mulberry32(11),
    newRoomRng: () => mulberry32(22),
  });
  const { roomCode } = unwrap(rooms.createRoom("Ada", null));
  unwrap(rooms.apply(roomCode, () => ok({ ...makeState(options), roomCode })));
  return { rooms, roomCode };
}

/**
 * A scored round with one human knocked out of it and two bots still playing — the
 * position the whole behaviour exists for. `hands` are what the round is revealing, so
 * the seat that is out holds none.
 */
function botsPlayOn(overrides: StateOptions = {}): GameState {
  return makeState({
    phase: "roundEnd",
    players: [
      { id: "human", outInRound: 1 },
      { id: "bot-1", isBot: true },
      { id: "bot-2", isBot: true },
    ],
    hands: { "bot-1": ["clubs-9", "spades-Q"], "bot-2": ["hearts-9", "clubs-Q"] },
    drawPile: ["diamonds-2", "diamonds-3", "diamonds-5"],
    lastDiscard: ["hearts-4"],
    ...overrides,
  });
}

const WATCHING = new Set(["human"]);

describe("autoDealSeat", () => {
  it("names a seat still in the match when only bots are left in it", () => {
    const seat = autoDealSeat(botsPlayOn(), WATCHING);
    assert.ok(seat !== null, "the round deals itself on");
    assert.ok(["bot-1", "bot-2"].includes(seat), "and deals as a seat still playing");
  });

  it("says nothing while a human is still in the match", () => {
    const state = botsPlayOn({
      players: [
        { id: "human" },
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
      hands: {
        human: ["hearts-K"],
        "bot-1": ["clubs-9", "spades-Q"],
        "bot-2": ["hearts-9", "clubs-Q"],
      },
    });

    assert.equal(autoDealSeat(state, WATCHING), null);
  });

  /**
   * The case that says this is not about who is *there*: a player who has dropped still
   * holds their seat and the turn still waits for them (docs/adr/0013), so a round they
   * are in is not one the server may deal on without them.
   */
  it("says nothing when the human still in the match has merely dropped", () => {
    const state = botsPlayOn({
      players: [
        { id: "human" },
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
      hands: {
        human: ["hearts-K"],
        "bot-1": ["clubs-9", "spades-Q"],
        "bot-2": ["hearts-9", "clubs-Q"],
      },
    });

    assert.equal(autoDealSeat(state, new Set()), null, "nobody is connected");
  });

  it("says nothing when the spectator it would deal for is not there", () => {
    assert.equal(autoDealSeat(botsPlayOn(), new Set()), null);
  });

  it("says nothing when the only human left the room rather than the match", () => {
    const state = botsPlayOn({
      players: [
        { id: "human", outInRound: 1, departed: true },
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
    });

    assert.equal(autoDealSeat(state, WATCHING), null);
  });

  /**
   * A finished match waits for whoever is looking at it: the standings are there to be
   * read, and play again is offered to anybody still in the room.
   */
  it("says nothing at a finished match", () => {
    const state = botsPlayOn({ phase: "gameEnd" });
    assert.equal(autoDealSeat(state, WATCHING), null);
  });

  it("says nothing at a round still being played", () => {
    const state = botsPlayOn({ phase: "playing" });
    assert.equal(autoDealSeat(state, WATCHING), null);
  });

  it("says nothing in a lobby", () => {
    assert.equal(autoDealSeat(makeState({ phase: "lobby" }), WATCHING), null);
  });
});

describe("the auto-dealer", () => {
  function dealer() {
    const clock = testClock();
    const timers = createRoomTimers(clock);
    const { rooms, roomCode } = room({});
    return { clock, timers, rooms, roomCode, autoDeal: createAutoDealer(rooms, timers) };
  }

  /** Put the room into the position that deals itself on, and consider it. */
  function watching(t: ReturnType<typeof dealer>, dealt: () => void): void {
    unwrap(t.rooms.apply(t.roomCode, () => ok({ ...botsPlayOn(), roomCode: t.roomCode })));
    t.autoDeal.consider(t.roomCode, WATCHING, dealt);
  }

  it("deals the next round once the pause has elapsed", () => {
    const t = dealer();
    let dealt = 0;
    watching(t, () => dealt++);

    assert.equal(t.clock.pending(), 1, "a deal is waiting");
    assert.equal(dealt, 0, "and has not happened yet");

    assert.equal(t.clock.tick(), AUTO_DEAL_MS, "the pause a scored round is left up for");

    assert.equal(dealt, 1, "the round was dealt, and published");
    const state = t.rooms.getState(t.roomCode)!;
    assert.equal(state.phase, "playing");
    assert.equal(state.roundNumber, 2);
  });

  /**
   * Every publication reconsiders, and a room is published to for reasons that have
   * nothing to do with this one — a seat going quiet, a seat being sat back down at. A
   * countdown that restarted on each of them would be a scored round nobody could get
   * past by watching it.
   */
  it("leaves a countdown already running alone", () => {
    const t = dealer();
    watching(t, () => {});
    t.autoDeal.consider(t.roomCode, WATCHING, () => {});

    assert.equal(t.clock.pending(), 1, "one countdown, not two");
  });

  it("calls the countdown off once the position no longer asks for it", () => {
    const t = dealer();
    watching(t, () => {});

    // The spectator's socket went: there is nobody left for the table to play to.
    t.autoDeal.consider(t.roomCode, new Set(), () => {});

    assert.equal(t.clock.pending(), 0, "nothing is waiting on the clock");
  });

  /**
   * The position can move under a pending countdown without anything publishing — a
   * spectator dealing it on themselves is exactly that, acked before it is broadcast.
   * The deal is refused, and refusing is the whole of the answer: there is no client at
   * fault and nothing to report, unlike a bot's illegal move (`botTurns.ts`).
   */
  it("publishes nothing when the round has been dealt on under it", () => {
    const t = dealer();
    let dealt = 0;
    watching(t, () => dealt++);

    const dealtOn = botsPlayOn({ phase: "playing" });
    unwrap(t.rooms.apply(t.roomCode, () => ok({ ...dealtOn, roomCode: t.roomCode })));
    t.clock.tick();

    assert.equal(dealt, 0, "nothing was published");
    assert.equal(t.rooms.getState(t.roomCode)!.roundNumber, 1, "and nothing was dealt");
  });

  it("forgets a room it has nothing to say about", () => {
    const t = dealer();
    t.autoDeal.consider(t.roomCode, WATCHING, () => {});

    assert.equal(t.clock.pending(), 0, "a round being played waits on nothing");
  });
});
