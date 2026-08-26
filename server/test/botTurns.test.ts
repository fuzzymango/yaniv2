/**
 * Resolving the seats the server plays itself.
 *
 * Scenarios are pinned by writing an exact state into a real room, rather than dealing
 * and hoping: whose turn it is and what they are holding is the entire subject here, so
 * both need to be stated outright.
 *
 * One turn at a time, which is the shape the module now has: the pause each one waits out
 * first, and the chain that walks from one to the next, belong to the bot turn runner and
 * are asserted where a client can see them — over the wire, in `socketServer.test.ts`. A
 * chain is written out here as the loop it is, since walking consecutive bot seats is what
 * each call has to leave possible.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { playBotTurn, type DecideTurn } from "../src/botTurns.ts";
import { ok } from "../src/result.ts";
import { RoomManager } from "../src/roomManager.ts";
import { mulberry32 } from "../src/rng.ts";
import { ids, makeState, unwrap, type StateOptions } from "./helpers.ts";

/** A live room holding exactly the state described, under its real room code. */
function room(options: StateOptions): { rooms: RoomManager; roomCode: string } {
  const rooms = new RoomManager({
    rng: mulberry32(11),
    newRoomRng: () => mulberry32(22),
  });
  const { roomCode } = unwrap(rooms.createRoom("Ada"));
  unwrap(rooms.apply(roomCode, () => ok({ ...makeState(options), roomCode })));
  return { rooms, roomCode };
}

describe("playBotTurn", () => {
  it("plays the turn when it belongs to a bot", () => {
    const { rooms, roomCode } = room({
      players: [{ id: "human" }, { id: "bot", isBot: true }],
      hands: { human: ["hearts-K", "spades-K"], bot: ["clubs-9", "spades-Q"] },
      drawPile: ["diamonds-2", "diamonds-3"],
      lastDiscard: ["hearts-4"],
      currentTurnPlayerId: "bot",
    });

    assert.equal(playBotTurn(rooms, roomCode), "bot", "the bot is who played");

    const state = rooms.getState(roomCode)!;
    assert.equal(state.phase, "playing");
    const round = state.round;
    assert.equal(round.currentTurnPlayerId, "human", "the turn came back to the human");
    assert.equal(round.hands["bot"]!.length, 2, "the bot discarded one and drew one");
  });

  /**
   * A move at a time is what the runner has to be able to walk: it plays one turn, waits
   * out another think time, and asks again. Each call has to name the seat it played, in
   * seating order, and stop of its own accord once the turn reaches the human.
   */
  it("names each consecutive bot seat in turn, and stops at the human", () => {
    const { rooms, roomCode } = room({
      players: [
        { id: "human" },
        { id: "bot-1", isBot: true },
        { id: "bot-2", isBot: true },
      ],
      hands: {
        human: ["hearts-K", "spades-K"],
        "bot-1": ["clubs-9", "spades-Q"],
        "bot-2": ["hearts-9", "clubs-Q"],
      },
      drawPile: ["diamonds-2", "diamonds-3", "diamonds-5"],
      lastDiscard: ["hearts-4"],
      currentTurnPlayerId: "bot-1",
    });

    const played: string[] = [];
    for (;;) {
      const playerId = playBotTurn(rooms, roomCode);
      if (playerId === null) break;
      played.push(playerId);
    }

    assert.deepEqual(played, ["bot-1", "bot-2"]);
    const state = rooms.getState(roomCode)!;
    assert.equal(state.phase, "playing");
    assert.equal(state.round.currentTurnPlayerId, "human");
  });

  it("calls Yaniv for a bot holding a low enough hand, ending the round", () => {
    const { rooms, roomCode } = room({
      players: [{ id: "human" }, { id: "bot", isBot: true }],
      hands: { human: ["hearts-K", "spades-K"], bot: ["hearts-2", "clubs-3"] },
      drawPile: ["diamonds-2"],
      lastDiscard: ["hearts-4"],
      currentTurnPlayerId: "bot",
    });

    assert.equal(playBotTurn(rooms, roomCode), "bot");

    const state = rooms.getState(roomCode)!;
    assert.equal(state.phase, "roundEnd");
    assert.equal(state.lastRoundResult!.callerId, "bot");
    assert.equal(
      playBotTurn(rooms, roomCode),
      null,
      "a scored round leaves nothing to chain on to",
    );
  });

  it("does nothing at all when the turn belongs to a human", () => {
    const { rooms, roomCode } = room({
      players: [{ id: "human" }, { id: "bot", isBot: true }],
      hands: { human: ["hearts-K", "spades-K"], bot: ["clubs-9", "spades-Q"] },
      drawPile: ["diamonds-2"],
      lastDiscard: ["hearts-4"],
      currentTurnPlayerId: "human",
    });
    const before = rooms.getState(roomCode);

    assert.equal(playBotTurn(rooms, roomCode), null);
    assert.equal(rooms.getState(roomCode), before, "the state was left untouched");
  });

  /**
   * Bots do not slap down, and that is a deferral rather than an oversight (ADR-0005):
   * shedding a card for free has no downside, so a bot that reasoned about it would
   * always take it. Pinned here so the day one starts, this test is what says so.
   *
   * The scenario is engineered so the real bot's own judgement opens the window: the
   * queen is its best discard by value, the exposed king is too expensive to take, and
   * the card waiting on the deck matches the rank it just put down.
   */
  it("leaves a bot's own slapdown window open rather than playing it", () => {
    const { rooms, roomCode } = room({
      players: [{ id: "human" }, { id: "bot", isBot: true }],
      hands: { human: ["hearts-K", "spades-K"], bot: ["spades-Q", "clubs-3"] },
      drawPile: ["hearts-Q", "diamonds-2"],
      lastDiscard: ["hearts-K"],
      currentTurnPlayerId: "bot",
    });

    playBotTurn(rooms, roomCode);

    const state = rooms.getState(roomCode)!;
    assert.equal(state.phase, "playing");
    const round = state.round;
    assert.equal(
      round.slapdown?.playerId,
      "bot",
      "the fixture should have opened a window for the bot",
    );
    assert.equal(round.slapdown?.card.id, "hearts-Q");
    assert.deepEqual(
      ids(round.hands["bot"]!),
      ["clubs-3", "hearts-Q"],
      "the drawn queen is still in the bot's hand",
    );
    assert.deepEqual(ids(round.lastDiscard), ["spades-Q"], "and not on the pile");
  });

  /**
   * A bot's decision being illegal is a bug in the bot, not a player doing something
   * they were not allowed to. Swallowing it would leave the table wedged on a turn
   * nobody can take; reporting it to a client would blame them for the server's fault.
   */
  it("throws when the engine rejects a bot's own decision", () => {
    const { rooms, roomCode } = room({
      players: [{ id: "human" }, { id: "bot", isBot: true }],
      hands: { human: ["hearts-K", "spades-K"], bot: ["clubs-9", "spades-Q"] },
      drawPile: ["diamonds-2"],
      lastDiscard: ["hearts-4"],
      currentTurnPlayerId: "bot",
    });

    const brokenBot: DecideTurn = () => ({
      type: "turn",
      // A card the bot is not holding — the engine will refuse it.
      action: { discardCardIds: ["spades-A"], draw: { source: "deck" } },
    });

    assert.throws(() => playBotTurn(rooms, roomCode, brokenBot), /CARD_NOT_IN_HAND/);
  });
});
