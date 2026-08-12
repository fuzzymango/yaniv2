/**
 * Resolving the seats the server plays itself.
 *
 * Scenarios are pinned by writing an exact state into a real room, rather than dealing
 * and hoping: whose turn it is and what they are holding is the entire subject here, so
 * both need to be stated outright.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { playBotTurns, type DecideTurn } from "../src/botTurns.ts";
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

describe("playBotTurns", () => {
  it("plays the turn when it belongs to a bot", () => {
    const { rooms, roomCode } = room({
      players: [{ id: "human" }, { id: "bot", isBot: true }],
      hands: { human: ["hearts-K", "spades-K"], bot: ["clubs-9", "spades-Q"] },
      drawPile: ["diamonds-2", "diamonds-3"],
      lastDiscard: ["hearts-4"],
      currentTurnPlayerId: "bot",
    });

    playBotTurns(rooms, roomCode, () => {});

    const state = rooms.getState(roomCode)!;
    assert.equal(state.phase, "playing");
    const round = state.round;
    assert.equal(round.currentTurnPlayerId, "human", "the turn came back to the human");
    assert.equal(round.hands["bot"]!.length, 2, "the bot discarded one and drew one");
  });

  /**
   * The chain has to be reported move by move. A client showing a table of bots needs
   * to replay what each one did in turn; a single update at the end would only ever
   * show the final position.
   */
  it("plays every consecutive bot turn, reporting each one separately in order", () => {
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
    playBotTurns(rooms, roomCode, (playerId) => played.push(playerId));

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

    const played: string[] = [];
    playBotTurns(rooms, roomCode, (playerId) => played.push(playerId));

    const state = rooms.getState(roomCode)!;
    assert.deepEqual(played, ["bot"]);
    assert.equal(state.phase, "roundEnd");
    assert.equal(state.lastRoundResult!.callerId, "bot");
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

    const played: string[] = [];
    playBotTurns(rooms, roomCode, (playerId) => played.push(playerId));

    assert.deepEqual(played, []);
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

    playBotTurns(rooms, roomCode, () => {});

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

    assert.throws(
      () => playBotTurns(rooms, roomCode, () => {}, brokenBot),
      /CARD_NOT_IN_HAND/,
    );
  });
});
