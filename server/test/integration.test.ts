import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card, DrawAction } from "@yaniv/shared";
import { canCallYaniv, handValue, legalDiscards } from "@yaniv/shared";
import { callYaniv, startGame, startNextRound, takeTurn } from "../src/game.ts";
import { RoomManager } from "../src/roomManager.ts";
import { serializeStateForPlayer } from "../src/serialize.ts";
import type { GameState, GameStateActive } from "../src/state.ts";
import { mulberry32 } from "../src/rng.ts";
import { unwrap } from "./helpers.ts";

/** Every card the round is holding, across hands, deck and both discard areas. */
function roundCards(state: GameState): Card[] {
  const round = state.round;
  if (!round) return [];
  return [
    ...Object.values(round.hands).flat(),
    ...round.drawPile,
    ...round.lastDiscard,
    ...round.buried,
  ];
}

function assertInvariants(state: GameState): asserts state is GameStateActive {
  const all = roundCards(state);
  assert.equal(all.length, 54, "cards went missing or were duplicated");
  assert.equal(new Set(all.map((c) => c.id)).size, 54, "duplicate card id in play");

  assert.equal(state.phase, "playing");
  const round = state.round;
  for (const playerId of round.turnOrder) {
    assert.ok(round.hands[playerId]!.length > 0, `${playerId} has an empty hand`);
  }
  assert.ok(round.lastDiscard.length > 0, "nothing face up to pick up from");
  assert.ok(
    round.turnOrder.includes(round.currentTurnPlayerId),
    "current player is not seated",
  );
}

/**
 * A driver, not a player. This deliberately does *not* use src/bot.ts: its job is
 * to push the engine through as many odd states as possible, and coupling it to the
 * real bot would mean any improvement there silently shrinks what this test explores.
 * It shares only `legalDiscards`, which is a rules query rather than a policy.
 */
function chooseDiscard(hand: readonly Card[]): Card[] {
  const options = legalDiscards(hand);
  assert.ok(options.length > 0, "a non-empty hand always has a legal discard");
  return options.reduce((best, option) => {
    const score = (set: Card[]) => handValue(set) * 10 + set.length;
    return score(option) > score(best) ? option : best;
  });
}

/** Play a whole match with seeded randomness, checking invariants at every turn. */
function playMatch(seed: number): { final: GameState; turns: number } {
  let playerCounter = 0;
  const rooms = new RoomManager({
    rng: mulberry32(seed),
    newPlayerId: () => `p${++playerCounter}`,
    newRoomRng: () => mulberry32(seed + 1),
  });

  const { roomCode } = unwrap(rooms.createRoom("Ada"));
  unwrap(rooms.joinRoom(roomCode, "Grace"));
  unwrap(rooms.joinRoom(roomCode, "Alan"));
  unwrap(rooms.apply(roomCode, (s, rng) => startGame(s, s.hostId, rng)));

  const coin = mulberry32(seed + 2);
  let turns = 0;

  for (let step = 0; step < 20000; step++) {
    const state = rooms.getState(roomCode)!;

    if (state.phase === "gameEnd") return { final: state, turns };
    if (state.phase === "roundEnd") {
      unwrap(rooms.apply(roomCode, (s, rng) => startNextRound(s, s.hostId, rng)));
      continue;
    }

    assertInvariants(state);

    const round = state.round;
    const playerId = round.currentTurnPlayerId;
    const hand = round.hands[playerId]!;

    if (canCallYaniv(hand, state.settings.yanivThreshold)) {
      unwrap(rooms.apply(roomCode, (s) => callYaniv(s, playerId)));
      continue;
    }

    const discard = chooseDiscard(hand);
    // Half the time try the discard pile, which exercises the pickup rules.
    const draw: DrawAction =
      coin() < 0.5
        ? { source: "discard", cardId: round.lastDiscard[0]!.id }
        : { source: "deck" };

    unwrap(
      rooms.apply(roomCode, (s, rng) =>
        takeTurn(s, playerId, { discardCardIds: discard.map((c) => c.id), draw }, rng),
      ),
    );
    turns++;
  }

  throw new Error("match did not finish within the step budget");
}

describe("full match simulation", () => {
  for (const seed of [1, 7, 99, 2024, 31337]) {
    it(`plays a complete three-player match to a winner (seed ${seed})`, () => {
      const { final, turns } = playMatch(seed);

      assert.equal(final.phase, "gameEnd");
      assert.ok(turns > 0, "match ended without a single turn");
      assert.ok(final.roundNumber >= 1);

      assert.ok(final.winnerIds && final.winnerIds.length > 0);
      const lowest = Math.min(...final.players.map((p) => p.score));
      for (const id of final.winnerIds) {
        assert.equal(final.players.find((p) => p.id === id)!.score, lowest);
      }
      assert.ok(
        final.players.some((p) => p.score > 100),
        "match ended without anyone busting",
      );
    });
  }

  it("is reproducible from its seed", () => {
    const a = playMatch(2024);
    const b = playMatch(2024);
    assert.deepEqual(
      a.final.players.map((p) => p.score),
      b.final.players.map((p) => p.score),
    );
    assert.equal(a.turns, b.turns);
  });

  it("never leaks a hidden card to any player at any point of a match", () => {
    let playerCounter = 0;
    const rooms = new RoomManager({
      rng: mulberry32(555),
      newPlayerId: () => `p${++playerCounter}`,
      newRoomRng: () => mulberry32(556),
    });
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    unwrap(rooms.joinRoom(roomCode, "Grace"));
    unwrap(rooms.apply(roomCode, (s, rng) => startGame(s, s.hostId, rng)));

    for (let step = 0; step < 40; step++) {
      const state = rooms.getState(roomCode)!;
      if (state.phase !== "playing") break;

      for (const viewer of state.players) {
        const wire = JSON.stringify(serializeStateForPlayer(state, viewer.id));
        const visible = new Set([
          ...state.round.hands[viewer.id]!.map((c) => c.id),
          ...state.round.lastDiscard.map((c) => c.id),
        ]);
        const hidden = [
          ...state.players
            .filter((p) => p.id !== viewer.id)
            .flatMap((p) => state.round.hands[p.id]!),
          ...state.round.drawPile,
        ];
        for (const card of hidden) {
          if (visible.has(card.id)) continue;
          assert.ok(
            !wire.includes(card.id),
            `${viewer.id} could see ${card.id} on step ${step}`,
          );
        }
      }

      const round = state.round;
      const playerId = round.currentTurnPlayerId;
      const hand = round.hands[playerId]!;
      if (canCallYaniv(hand, state.settings.yanivThreshold)) break;

      const discard = chooseDiscard(hand);
      unwrap(
        rooms.apply(roomCode, (s, rng) =>
          takeTurn(
            s,
            playerId,
            {
              discardCardIds: discard.map((c) => c.id),
              draw: { source: "deck" },
            },
            rng,
          ),
        ),
      );
    }
  });
});
