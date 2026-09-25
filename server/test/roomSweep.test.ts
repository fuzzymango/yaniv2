/**
 * Dropping a room nobody is in any more.
 *
 * Two questions, kept apart here exactly as the module keeps them: what a position *says*
 * about being unattended (`unattended`, pure over a state and who is connected), and what
 * the room then has waiting on the clock (`consider`, over a real room and a clock this
 * suite drives by hand).
 *
 * States are written into a live room rather than played for, as `autoDeal.test.ts` does:
 * who is a bot, who has left and who is connected is the entire subject, so all three are
 * stated outright rather than fished for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROOM_SWEEP_MS } from "../src/config.ts";
import { ok } from "../src/result.ts";
import { RoomManager } from "../src/roomManager.ts";
import { createRoomSweeper, unattended } from "../src/roomSweep.ts";
import { createRoomTimers } from "../src/roomTimers.ts";
import { mulberry32 } from "../src/rng.ts";
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

/** A human at a table of bots — the room the whole behaviour is about. */
const HUMAN_AND_BOTS: StateOptions = {
  players: [
    { id: "human" },
    { id: "bot-1", isBot: true },
    { id: "bot-2", isBot: true },
  ],
  hands: { human: ["hearts-K"], "bot-1": ["clubs-9"], "bot-2": ["hearts-9"] },
};

const WATCHING = new Set(["human"]);

describe("unattended", () => {
  it("is false while a human is connected", () => {
    assert.equal(unattended(makeState(HUMAN_AND_BOTS), WATCHING), false);
  });

  it("is true once the last human's connection has gone", () => {
    assert.equal(unattended(makeState(HUMAN_AND_BOTS), new Set()), true);
  });

  /** A bot is never who a room is for: it never leaves, and never asks for anything. */
  it("is true for a table of nothing but bots", () => {
    const state = makeState({
      players: [
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
      hands: { "bot-1": ["clubs-9"], "bot-2": ["hearts-9"] },
    });

    assert.equal(unattended(state, new Set(["bot-1", "bot-2"])), true);
  });

  /** A seat that has been given up is nobody's, whatever is still holding its id. */
  it("is true where the only human has left the room", () => {
    const state = makeState({
      players: [
        { id: "human", outInRound: 1, departed: true },
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
      hands: { "bot-1": ["clubs-9"], "bot-2": ["hearts-9"] },
    });

    assert.equal(unattended(state, WATCHING), true);
  });

  /**
   * A human knocked out of the match still holds their seat and is still watching the
   * table. Out of the match is not out of the room.
   */
  it("is false for a spectator who is still there", () => {
    const state = makeState({
      phase: "roundEnd",
      players: [
        { id: "human", outInRound: 1 },
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
      hands: { "bot-1": ["clubs-9"], "bot-2": ["hearts-9"] },
    });

    assert.equal(unattended(state, WATCHING), false);
  });

  it("is false in a lobby somebody is sitting in", () => {
    const state = makeState({ phase: "lobby", players: [{ id: "human" }] });
    assert.equal(unattended(state, WATCHING), false);
  });

  it("is true in a lobby whose host has gone", () => {
    const state = makeState({ phase: "lobby", players: [{ id: "human" }] });
    assert.equal(unattended(state, new Set()), true);
  });
});

describe("the room sweeper", () => {
  function sweeper(options: StateOptions = HUMAN_AND_BOTS) {
    const clock = testClock();
    const timers = createRoomTimers(clock);
    const { rooms, roomCode } = room(options);
    return { clock, timers, rooms, roomCode, sweep: createRoomSweeper(rooms, timers) };
  }

  it("waits on nothing while a human is connected", () => {
    const t = sweeper();
    t.sweep.consider(t.roomCode, WATCHING, () => {});

    assert.equal(t.clock.pending(), 0);
  });

  it("sweeps the room once the grace period has elapsed", () => {
    const t = sweeper();
    let swept = 0;
    t.sweep.consider(t.roomCode, new Set(), () => swept++);

    assert.equal(t.clock.pending(), 1, "a sweep is waiting");
    assert.equal(swept, 0, "and the room is still standing");

    assert.equal(t.clock.tick(), ROOM_SWEEP_MS, "the grace a dropped human is given");
    assert.equal(swept, 1, "the room was swept");
  });

  /**
   * A room with nobody in it goes on publishing — its bots play the match out to an empty
   * table for as long as the grace lasts. A sweep restarted by each of those would be a
   * countdown that never finished, which is the whole leak this exists to close.
   */
  it("leaves a grace period already running alone", () => {
    const t = sweeper();
    t.sweep.consider(t.roomCode, new Set(), () => {});
    t.sweep.consider(t.roomCode, new Set(), () => {});

    assert.equal(t.clock.pending(), 1, "one countdown, not two");
  });

  /** A reload is a disconnect, and the connection coming back is the whole answer to it. */
  it("calls the sweep off once somebody is back", () => {
    const t = sweeper();
    let swept = 0;
    t.sweep.consider(t.roomCode, new Set(), () => swept++);

    t.sweep.consider(t.roomCode, WATCHING, () => swept++);

    assert.equal(t.clock.pending(), 0, "nothing is waiting on the clock");
    assert.equal(swept, 0, "and nothing was swept");
  });

  it("has nothing to say about a room that has already gone", () => {
    const t = sweeper();
    t.rooms.removeRoom(t.roomCode);
    t.sweep.consider(t.roomCode, new Set(), () => {});

    assert.equal(t.clock.pending(), 0);
  });
});
