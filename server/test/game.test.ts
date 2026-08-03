import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callYaniv,
  playAgain,
  removePlayer,
  startGame,
  startNextRound,
  takeTurn,
} from "../src/game.ts";
import { mulberry32 } from "../src/rng.ts";
import { allCardIds, expectErr, ids, makeState, unwrap } from "./helpers.ts";

const rng = () => mulberry32(1234);

describe("startGame", () => {
  it("deals five cards each, one face-up card, and the rest as the draw pile", () => {
    const state = unwrap(
      startGame(makeState({ phase: "lobby", roundNumber: 0 }), "p1", rng()),
    );

    assert.equal(state.phase, "playing");
    assert.equal(state.roundNumber, 1);
    assert.ok(state.round);
    assert.equal(state.round.hands["p1"]!.length, 5);
    assert.equal(state.round.hands["p2"]!.length, 5);
    assert.equal(state.round.lastDiscard.length, 1);
    assert.equal(state.round.buried.length, 0);
    assert.equal(state.round.drawPile.length, 54 - 10 - 1);
  });

  it("picks the opening player at random, not always the host", () => {
    const starters = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      const state = unwrap(
        startGame(
          makeState({ phase: "lobby", roundNumber: 0 }),
          "p1",
          mulberry32(seed),
        ),
      );
      assert.equal(state.phase, "playing");
      starters.add(state.round.currentTurnPlayerId);
    }
    assert.ok(
      starters.has("p1") && starters.has("p2"),
      `expected both seats to open at least once across 100 seeds, got: ${[...starters]}`,
    );
  });

  it("puts all 54 cards into play exactly once", () => {
    const state = unwrap(
      startGame(makeState({ phase: "lobby", roundNumber: 0 }), "p1", rng()),
    );
    const all = allCardIds(state);
    assert.equal(all.length, 54);
    assert.equal(new Set(all).size, 54);
  });

  it("rejects a non-host starter", () => {
    expectErr(
      startGame(makeState({ phase: "lobby", roundNumber: 0 }), "p2", rng()),
      "NOT_HOST",
    );
  });

  it("rejects starting with fewer than two players", () => {
    const solo = makeState({ phase: "lobby", players: [{ id: "p1" }] });
    expectErr(startGame(solo, "p1", rng()), "NOT_ENOUGH_PLAYERS");
  });

  it("rejects starting a game already in progress", () => {
    expectErr(startGame(makeState({ phase: "playing" }), "p1", rng()), "WRONG_PHASE");
  });
});

describe("takeTurn — validation", () => {
  const base = () =>
    makeState({
      hands: {
        p1: ["hearts-3", "hearts-4", "hearts-5", "spades-9", "clubs-2"],
        p2: ["diamonds-8"],
      },
      drawPile: ["spades-A", "hearts-10"],
      lastDiscard: ["clubs-7"],
    });

  it("rejects a player acting out of turn", () => {
    const result = takeTurn(
      base(),
      "p2",
      { discardCardIds: ["diamonds-8"], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "NOT_YOUR_TURN");
  });

  it("rejects an unknown player", () => {
    const result = takeTurn(
      base(),
      "ghost",
      { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "PLAYER_NOT_FOUND");
  });

  it("rejects acting outside a live round", () => {
    const result = takeTurn(
      makeState({ phase: "lobby" }),
      "p1",
      { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "WRONG_PHASE");
  });

  it("rejects an empty discard", () => {
    const result = takeTurn(
      base(),
      "p1",
      { discardCardIds: [], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "EMPTY_DISCARD_SET");
  });

  it("rejects the same card listed twice", () => {
    const result = takeTurn(
      base(),
      "p1",
      { discardCardIds: ["hearts-3", "hearts-3"], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "DUPLICATE_CARDS");
  });

  it("rejects a card the player does not hold", () => {
    const result = takeTurn(
      base(),
      "p1",
      { discardCardIds: ["spades-K"], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "CARD_NOT_IN_HAND");
  });

  it("rejects an invalid combination", () => {
    const result = takeTurn(
      base(),
      "p1",
      { discardCardIds: ["hearts-3", "spades-9"], draw: { source: "deck" } },
      rng(),
    );
    expectErr(result, "INVALID_SET");
  });
});

describe("takeTurn — drawing from the deck", () => {
  const base = () =>
    makeState({
      hands: {
        p1: ["hearts-3", "hearts-4", "hearts-5", "spades-9", "clubs-2"],
        p2: ["diamonds-8"],
      },
      drawPile: ["spades-A", "hearts-10"],
      lastDiscard: ["clubs-7"],
    });

  it("swaps the discarded cards for the top card of the deck", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(state.phase, "playing");
    assert.deepEqual(ids(state.round.hands["p1"]!), [
      "hearts-4",
      "hearts-5",
      "spades-9",
      "clubs-2",
      "spades-A",
    ]);
    assert.deepEqual(ids(state.round.drawPile), ["hearts-10"]);
  });

  it("makes the discard the new pickup set and buries the old one", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(state.phase, "playing");
    assert.deepEqual(ids(state.round.lastDiscard), ["hearts-3"]);
    assert.deepEqual(ids(state.round.buried), ["clubs-7"]);
  });

  it("advances the turn", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    assert.equal(state.phase, "playing");
    assert.equal(state.round.currentTurnPlayerId, "p2");
  });

  it("wraps the turn around to the first player", () => {
    const threeHanded = makeState({
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: { p1: ["hearts-3"], p2: ["spades-2"], p3: ["clubs-4"] },
      drawPile: ["spades-A"],
      lastDiscard: ["clubs-7"],
      currentTurnPlayerId: "p3",
    });
    const state = unwrap(
      takeTurn(
        threeHanded,
        "p3",
        { discardCardIds: ["clubs-4"], draw: { source: "deck" } },
        rng(),
      ),
    );
    assert.equal(state.phase, "playing");
    assert.equal(state.round.currentTurnPlayerId, "p1");
  });

  it("shrinks a multi-card discard down to a smaller hand", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["hearts-3", "hearts-4", "hearts-5"],
          draw: { source: "deck" },
        },
        rng(),
      ),
    );
    assert.equal(state.phase, "playing");
    assert.equal(state.round.hands["p1"]!.length, 3);
  });

  it("stores a run in ascending order regardless of submitted order", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["hearts-5", "hearts-3", "hearts-4"],
          draw: { source: "deck" },
        },
        rng(),
      ),
    );
    assert.equal(state.phase, "playing");
    assert.deepEqual(ids(state.round.lastDiscard), [
      "hearts-3",
      "hearts-4",
      "hearts-5",
    ]);
  });

  it("conserves every card in the round", () => {
    const before = base();
    const after = unwrap(
      takeTurn(
        before,
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    assert.deepEqual(allCardIds(after), allCardIds(before));
  });

  it("leaves the input state untouched", () => {
    const before = base();
    const snapshot = JSON.stringify(before);
    takeTurn(
      before,
      "p1",
      { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
      rng(),
    );
    assert.equal(JSON.stringify(before), snapshot);
  });
});

describe("takeTurn — picking up from the discard", () => {
  const base = () =>
    makeState({
      hands: {
        p1: ["hearts-3", "spades-9", "clubs-2"],
        p2: ["diamonds-8"],
      },
      drawPile: ["spades-A"],
      lastDiscard: ["hearts-4", "hearts-5", "hearts-6"],
    });

  it("allows taking the first card of the set", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["clubs-2"],
          draw: { source: "discard", cardId: "hearts-4" },
        },
        rng(),
      ),
    );
    assert.equal(state.phase, "playing");
    assert.ok(ids(state.round.hands["p1"]!).includes("hearts-4"));
  });

  it("allows taking the last card of the set", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["clubs-2"],
          draw: { source: "discard", cardId: "hearts-6" },
        },
        rng(),
      ),
    );
    assert.equal(state.phase, "playing");
    assert.ok(ids(state.round.hands["p1"]!).includes("hearts-6"));
  });

  it("refuses a card buried in the middle of the set", () => {
    const result = takeTurn(
      base(),
      "p1",
      {
        discardCardIds: ["clubs-2"],
        draw: { source: "discard", cardId: "hearts-5" },
      },
      rng(),
    );
    expectErr(result, "CARD_NOT_PICKUP_ELIGIBLE");
  });

  it("refuses a card that is not in the discard at all", () => {
    const result = takeTurn(
      base(),
      "p1",
      {
        discardCardIds: ["clubs-2"],
        draw: { source: "discard", cardId: "spades-K" },
      },
      rng(),
    );
    expectErr(result, "CARD_NOT_PICKUP_ELIGIBLE");
  });

  it("buries the cards left behind and leaves the deck alone", () => {
    const state = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["clubs-2"],
          draw: { source: "discard", cardId: "hearts-4" },
        },
        rng(),
      ),
    );

    assert.equal(state.phase, "playing");
    assert.deepEqual(ids(state.round.buried), ["hearts-5", "hearts-6"]);
    assert.deepEqual(ids(state.round.lastDiscard), ["clubs-2"]);
    assert.deepEqual(ids(state.round.drawPile), ["spades-A"]);
  });

  it("refuses a pickup when there is nothing on the table", () => {
    const empty = makeState({
      hands: { p1: ["hearts-3"], p2: ["diamonds-8"] },
      drawPile: ["spades-A"],
      lastDiscard: [],
    });
    const result = takeTurn(
      empty,
      "p1",
      {
        discardCardIds: ["hearts-3"],
        draw: { source: "discard", cardId: "spades-K" },
      },
      rng(),
    );
    expectErr(result, "DISCARD_PILE_EMPTY");
  });

  it("offers the next player only this turn's discard, not the previous one", () => {
    // p1 takes hearts-4, so hearts-5 and hearts-6 become buried and unreachable.
    const afterP1 = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["clubs-2"],
          draw: { source: "discard", cardId: "hearts-4" },
        },
        rng(),
      ),
    );

    expectErr(
      takeTurn(
        afterP1,
        "p2",
        {
          discardCardIds: ["diamonds-8"],
          draw: { source: "discard", cardId: "hearts-6" },
        },
        rng(),
      ),
      "CARD_NOT_PICKUP_ELIGIBLE",
    );

    const afterP2 = unwrap(
      takeTurn(
        afterP1,
        "p2",
        {
          discardCardIds: ["diamonds-8"],
          draw: { source: "discard", cardId: "clubs-2" },
        },
        rng(),
      ),
    );
    assert.equal(afterP2.phase, "playing");
    assert.ok(ids(afterP2.round.hands["p2"]!).includes("clubs-2"));
  });

  it("conserves every card in the round", () => {
    const before = base();
    const after = unwrap(
      takeTurn(
        before,
        "p1",
        {
          discardCardIds: ["clubs-2"],
          draw: { source: "discard", cardId: "hearts-4" },
        },
        rng(),
      ),
    );
    assert.deepEqual(allCardIds(after), allCardIds(before));
  });
});

describe("takeTurn — wild jokers in runs", () => {
  const base = (hand: string[]) =>
    makeState({
      hands: { p1: hand, p2: ["diamonds-8"] },
      drawPile: ["spades-A"],
      lastDiscard: ["clubs-7"],
    });

  it("accepts a run completed by a joker and shrinks the hand", () => {
    const before = base(["hearts-7", "hearts-9", "joker-1", "spades-2"]);
    const after = unwrap(
      takeTurn(
        before,
        "p1",
        {
          discardCardIds: ["hearts-7", "hearts-9", "joker-1"],
          draw: { source: "deck" },
        },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(ids(after.round.lastDiscard), [
      "hearts-7",
      "joker-1",
      "hearts-9",
    ]);
    assert.equal(after.round.hands["p1"]!.length, 2);
    assert.deepEqual(allCardIds(after), allCardIds(before));
  });

  it("offers a joker for pickup when it sits at the end of the run", () => {
    const afterP1 = unwrap(
      takeTurn(
        base(["hearts-7", "hearts-8", "joker-1", "spades-2"]),
        "p1",
        {
          discardCardIds: ["hearts-7", "hearts-8", "joker-1"],
          draw: { source: "deck" },
        },
        rng(),
      ),
    );
    assert.equal(afterP1.phase, "playing");
    assert.deepEqual(ids(afterP1.round.lastDiscard), [
      "hearts-7",
      "hearts-8",
      "joker-1",
    ]);

    const afterP2 = unwrap(
      takeTurn(
        afterP1,
        "p2",
        {
          discardCardIds: ["diamonds-8"],
          draw: { source: "discard", cardId: "joker-1" },
        },
        rng(),
      ),
    );
    assert.equal(afterP2.phase, "playing");
    assert.ok(ids(afterP2.round.hands["p2"]!).includes("joker-1"));
  });

  it("withholds a joker that is buried inside the run", () => {
    const state = makeState({
      hands: { p1: ["hearts-3"], p2: ["diamonds-8"] },
      drawPile: ["spades-A"],
      lastDiscard: ["hearts-7", "joker-1", "hearts-9"],
    });

    expectErr(
      takeTurn(
        state,
        "p1",
        {
          discardCardIds: ["hearts-3"],
          draw: { source: "discard", cardId: "joker-1" },
        },
        rng(),
      ),
      "CARD_NOT_PICKUP_ELIGIBLE",
    );
  });

  it("honours the player's choice to extend the run downwards", () => {
    const after = unwrap(
      takeTurn(
        base(["hearts-7", "hearts-8", "joker-1", "spades-2"]),
        "p1",
        {
          // Joker listed first, so it plays as 6♥ and the 8♥ end stays exposed.
          discardCardIds: ["joker-1", "hearts-7", "hearts-8"],
          draw: { source: "deck" },
        },
        rng(),
      ),
    );
    assert.equal(after.phase, "playing");
    assert.deepEqual(ids(after.round.lastDiscard), [
      "joker-1",
      "hearts-7",
      "hearts-8",
    ]);
  });

  it("rejects a run the jokers cannot bridge", () => {
    expectErr(
      takeTurn(
        base(["hearts-5", "hearts-9", "joker-1", "spades-2"]),
        "p1",
        {
          discardCardIds: ["hearts-5", "hearts-9", "joker-1"],
          draw: { source: "deck" },
        },
        rng(),
      ),
      "INVALID_SET",
    );
  });
});

describe("takeTurn — exhausting the draw pile", () => {
  it("reshuffles the buried cards while leaving the table set in place", () => {
    const state = makeState({
      hands: { p1: ["hearts-3"], p2: ["diamonds-8"] },
      drawPile: [],
      lastDiscard: ["hearts-2"],
      buried: ["clubs-7", "clubs-8", "clubs-9"],
    });

    const after = unwrap(discardAndDrawFromDeck(state, "p1", ["hearts-3"]));

    assert.equal(after.phase, "playing");
    // Three buried cards became the new draw pile; one of them was drawn.
    assert.equal(after.round.drawPile.length, 2);
    // The set that was on the table was not shuffled in — it is buried now instead.
    assert.deepEqual(ids(after.round.buried), ["hearts-2"]);
    assert.deepEqual(allCardIds(after), allCardIds(state));
  });

  it("reports exhaustion when nothing is left to reshuffle", () => {
    const state = makeState({
      hands: { p1: ["hearts-3"], p2: ["diamonds-8"] },
      drawPile: [],
      lastDiscard: ["hearts-2"],
      buried: [],
    });
    expectErr(discardAndDrawFromDeck(state, "p1", ["hearts-3"]), "DECK_EXHAUSTED");
  });
});

function discardAndDrawFromDeck(
  state: ReturnType<typeof makeState>,
  playerId: string,
  discardCardIds: string[],
) {
  return takeTurn(
    state,
    playerId,
    { discardCardIds, draw: { source: "deck" } },
    rng(),
  );
}

describe("callYaniv — validation", () => {
  it("refuses a hand above the threshold", () => {
    const state = makeState({
      hands: { p1: ["hearts-5", "spades-4"], p2: ["clubs-2"] },
    });
    expectErr(callYaniv(state, "p1"), "YANIV_THRESHOLD_NOT_MET");
  });

  it("allows a hand exactly on the threshold", () => {
    const state = makeState({
      hands: { p1: ["hearts-5", "spades-2"], p2: ["clubs-K"] },
    });
    assert.equal(callYaniv(state, "p1").ok, true);
  });

  it("refuses a player acting out of turn", () => {
    const state = makeState({
      hands: { p1: ["hearts-5"], p2: ["clubs-2"] },
    });
    expectErr(callYaniv(state, "p2"), "NOT_YOUR_TURN");
  });

  it("refuses outside a live round", () => {
    expectErr(callYaniv(makeState({ phase: "lobby" }), "p1"), "WRONG_PHASE");
  });
});

describe("callYaniv — scoring", () => {
  it("scores the caller zero and everyone else their hand when unopposed", () => {
    const state = makeState({
      hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K", "spades-Q"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "roundEnd");
    assert.equal(after.players.find((p) => p.id === "p1")!.score, 0);
    assert.equal(after.players.find((p) => p.id === "p2")!.score, 20);
    assert.equal(after.lastRoundResult!.assaferId, null);
    assert.equal(after.lastRoundResult!.winnerId, "p1");
  });

  it("penalises the caller and zeroes the Assafer on an Assaf", () => {
    const state = makeState({
      hands: {
        p1: ["hearts-3", "hearts-4"], // 7
        p2: ["spades-2", "spades-3"], // 5
      },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.lastRoundResult!.assaferId, "p2");
    assert.equal(after.players.find((p) => p.id === "p1")!.score, 7 + 30);
    assert.equal(after.players.find((p) => p.id === "p2")!.score, 0);
    assert.equal(after.lastRoundResult!.winnerId, "p2");
  });

  it("treats an equal hand as an Assaf", () => {
    const state = makeState({
      hands: {
        p1: ["hearts-5"], // 5
        p2: ["spades-5"], // 5
      },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.lastRoundResult!.assaferId, "p2");
    assert.equal(after.players.find((p) => p.id === "p1")!.score, 35);
  });

  it("picks the lowest opponent as the Assafer", () => {
    const state = makeState({
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: {
        p1: ["hearts-3", "hearts-4"], // 7
        p2: ["spades-6"], // 6
        p3: ["clubs-4"], // 4
      },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.lastRoundResult!.assaferId, "p3");
    assert.equal(after.players.find((p) => p.id === "p2")!.score, 6);
    assert.equal(after.players.find((p) => p.id === "p3")!.score, 0);
  });

  it("breaks an Assafer tie by seat order after the caller", () => {
    const state = makeState({
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: {
        p1: ["hearts-3", "hearts-4"], // 7
        p2: ["spades-4"], // 4
        p3: ["clubs-4"], // 4
      },
      currentTurnPlayerId: "p1",
    });
    const after = unwrap(callYaniv(state, "p1"));
    assert.equal(after.lastRoundResult!.assaferId, "p2");
  });

  it("wraps the seat-order tie-break around the table", () => {
    const state = makeState({
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: {
        p1: ["spades-4"], // 4
        p2: ["clubs-4"], // 4
        p3: ["hearts-3", "hearts-4"], // 7, the caller
      },
      currentTurnPlayerId: "p3",
    });
    const after = unwrap(callYaniv(state, "p3"));
    // Walking from the seat after p3 reaches p1 before p2.
    assert.equal(after.lastRoundResult!.assaferId, "p1");
  });

  it("records every player's revealed hand and delta", () => {
    const state = makeState({
      hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K", "spades-Q"] },
    });
    const result = unwrap(callYaniv(state, "p1")).lastRoundResult!;

    const p2 = result.players.find((p) => p.playerId === "p2")!;
    assert.deepEqual(ids(p2.hand), ["spades-K", "spades-Q"]);
    assert.equal(p2.handValue, 20);
    assert.equal(p2.delta, 20);
    assert.equal(p2.scoreAfter, 20);
  });

  it("accumulates onto existing scores", () => {
    const state = makeState({
      players: [{ id: "p1", score: 12 }, { id: "p2", score: 30 }],
      hands: { p1: ["hearts-A"], p2: ["spades-9"] },
    });
    const after = unwrap(callYaniv(state, "p1"));
    assert.equal(after.players.find((p) => p.id === "p1")!.score, 12);
    assert.equal(after.players.find((p) => p.id === "p2")!.score, 39);
  });
});

describe("callYaniv — ending the match", () => {
  it("ends the match once a score passes 100", () => {
    const state = makeState({
      players: [{ id: "p1", score: 10 }, { id: "p2", score: 95 }],
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
  });

  it("keeps playing at exactly 100", () => {
    const state = makeState({
      players: [{ id: "p1", score: 10 }, { id: "p2", score: 90 }],
      hands: { p1: ["hearts-A"], p2: ["spades-K"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.players.find((p) => p.id === "p2")!.score, 100);
    assert.equal(after.phase, "roundEnd");
    assert.equal(after.winnerIds, null);
  });

  it("reports every player tied for the lowest score as a winner", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 5 },
        { id: "p2", score: 0 },
        { id: "p3", score: 95 },
      ],
      hands: { p1: ["hearts-A"], p2: ["spades-5"], p3: ["clubs-10"] },
      currentTurnPlayerId: "p1",
    });
    // p1 calls with 1 and is unopposed: p1 stays on 5, p2 takes 5 to reach 5,
    // and p3 takes 10 to bust on 105.
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual([...after.winnerIds!].sort(), ["p1", "p2"]);
  });
});

describe("startNextRound", () => {
  const finished = () => {
    const state = makeState({
      hands: { p1: ["hearts-3", "hearts-4"], p2: ["spades-2", "spades-3"] },
    });
    return unwrap(callYaniv(state, "p1")); // p2 Assafs, so p2 won the round
  };

  it("deals a fresh round and increments the round number", () => {
    const next = unwrap(startNextRound(finished(), "p1", rng()));

    assert.equal(next.phase, "playing");
    assert.equal(next.roundNumber, 2);
    assert.equal(next.round.hands["p1"]!.length, 5);
    assert.equal(next.round.buried.length, 0);
    assert.equal(allCardIds(next).length, 54);
  });

  it("gives the first turn to the previous round's winner", () => {
    const next = unwrap(startNextRound(finished(), "p1", rng()));
    assert.equal(next.phase, "playing");
    assert.equal(next.round.currentTurnPlayerId, "p2");
  });

  it("carries scores forward but clears the previous result", () => {
    const next = unwrap(startNextRound(finished(), "p1", rng()));
    assert.equal(next.players.find((p) => p.id === "p1")!.score, 37);
    assert.equal(next.lastRoundResult, null);
  });

  it("rejects a non-host", () => {
    expectErr(startNextRound(finished(), "p2", rng()), "NOT_HOST");
  });

  it("rejects advancing mid-round", () => {
    expectErr(startNextRound(makeState(), "p1", rng()), "WRONG_PHASE");
  });
});

describe("playAgain", () => {
  /** A match played to a bust, which is the only position play again is offered from. */
  const finishedMatch = (
    players = [
      { id: "p1", score: 10 },
      { id: "p2", score: 95 },
    ],
  ) => {
    const state = makeState({
      players,
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"] },
      roundNumber: 7,
    });
    // p1 calls with 1 and is unopposed; p2 takes 20 and busts past 100.
    const after = unwrap(callYaniv(state, "p1"));
    assert.equal(after.phase, "gameEnd");
    return after;
  };

  it("deals a fresh round immediately, with no stop in the lobby", () => {
    const again = unwrap(playAgain(finishedMatch(), "p1", rng()));

    assert.equal(again.phase, "playing");
    assert.equal(again.round.hands["p1"]!.length, 5);
    assert.equal(again.round.hands["p2"]!.length, 5);
    assert.equal(again.round.lastDiscard.length, 1);
    assert.equal(again.round.buried.length, 0);
    assert.equal(allCardIds(again).length, 54);
  });

  it("resets every score and the round number", () => {
    const again = unwrap(playAgain(finishedMatch(), "p1", rng()));

    assert.deepEqual(
      again.players.map((p) => p.score),
      [0, 0],
    );
    assert.equal(again.roundNumber, 1);
    assert.equal(again.lastRoundResult, null);
    assert.equal(again.winnerIds, null);
  });

  it("keeps the same room, host and seats", () => {
    const finished = finishedMatch();
    const again = unwrap(playAgain(finished, "p1", rng()));

    assert.equal(again.roomCode, finished.roomCode);
    assert.equal(again.hostId, finished.hostId);
    assert.deepEqual(
      again.players.map((p) => p.id),
      finished.players.map((p) => p.id),
    );
  });

  it("picks the opening player at random, not always the host", () => {
    const starters = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      const again = unwrap(playAgain(finishedMatch(), "p1", mulberry32(seed)));
      assert.equal(again.phase, "playing");
      starters.add(again.round.currentTurnPlayerId);
    }
    assert.ok(
      starters.has("p1") && starters.has("p2"),
      `expected both seats to open at least once across 100 seeds, got: ${[...starters]}`,
    );
  });

  it("leaves the finished match untouched", () => {
    const finished = finishedMatch();
    const before = JSON.stringify(finished);

    unwrap(playAgain(finished, "p1", rng()));

    assert.equal(JSON.stringify(finished), before);
  });

  it("rejects a non-host", () => {
    expectErr(playAgain(finishedMatch(), "p2", rng()), "NOT_HOST");
  });

  it("rejects a restart from any phase but a finished match", () => {
    expectErr(playAgain(makeState({ phase: "lobby" }), "p1", rng()), "WRONG_PHASE");
    expectErr(playAgain(makeState({ phase: "playing" }), "p1", rng()), "WRONG_PHASE");
    expectErr(playAgain(makeState({ phase: "roundEnd" }), "p1", rng()), "WRONG_PHASE");
  });

  /**
   * Seats emptied by an exit to the menu stay empty — they are never backfilled with a
   * bot — so a table can be talked down below the minimum before the host plays again.
   */
  it("rejects a restart once too few players remain", () => {
    const alone = unwrap(removePlayer(finishedMatch(), "p2"));

    expectErr(playAgain(alone, "p1", rng()), "NOT_ENOUGH_PLAYERS");
  });
});

describe("removePlayer", () => {
  it("frees the seat of a player leaving the lobby", () => {
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      roundNumber: 0,
    });

    const after = unwrap(removePlayer(lobby, "p2"));

    assert.deepEqual(
      after.players.map((p) => p.id),
      ["p1", "p3"],
    );
  });

  it("frees the seat of a player leaving a finished match", () => {
    const finished = makeState({
      phase: "gameEnd",
      players: [
        { id: "p1", score: 40 },
        { id: "p2", score: 105 },
      ],
    });

    const after = unwrap(removePlayer(finished, "p2"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(
      after.players.map((p) => p.id),
      ["p1"],
    );
    assert.equal(after.players[0]!.score, 40, "whoever stays keeps their standing");
  });

  /**
   * The host is not special here: closing the room is not a `GameState` this function
   * could return, so that branch belongs to the layer that owns rooms.
   */
  it("removes the host like anyone else", () => {
    const after = unwrap(removePlayer(makeState({ phase: "lobby" }), "p1"));

    assert.deepEqual(
      after.players.map((p) => p.id),
      ["p2"],
    );
  });

  it("rejects a player who is not seated", () => {
    expectErr(removePlayer(makeState({ phase: "lobby" }), "ghost"), "PLAYER_NOT_FOUND");
  });

  it("rejects leaving mid-match", () => {
    expectErr(removePlayer(makeState({ phase: "playing" }), "p1"), "WRONG_PHASE");
    expectErr(removePlayer(makeState({ phase: "roundEnd" }), "p1"), "WRONG_PHASE");
  });

  it("leaves the input state untouched", () => {
    const lobby = makeState({ phase: "lobby" });
    const before = JSON.stringify(lobby);

    unwrap(removePlayer(lobby, "p2"));

    assert.equal(JSON.stringify(lobby), before);
  });
});
