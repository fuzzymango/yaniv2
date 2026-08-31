import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoomSettings } from "@yaniv/shared";
import {
  callYaniv,
  playAgain,
  removePlayer,
  slapDown,
  startGame,
  startNextRound,
  takeTurn,
  updateSettings,
} from "../src/game.ts";
import { mulberry32 } from "../src/rng.ts";
import type { StateOptions } from "./helpers.ts";
import { allCardIds, card, expectErr, ids, makeState, unwrap } from "./helpers.ts";

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

  it("deals the room's own handSize, not the shared default", () => {
    const state = unwrap(
      startGame(
        makeState({ phase: "lobby", roundNumber: 0, settings: { handSize: 7 } }),
        "p1",
        rng(),
      ),
    );
    assert.ok(state.round);
    assert.equal(state.round.hands["p1"]!.length, 7);
    assert.equal(state.round.hands["p2"]!.length, 7);
  });

  /**
   * The seats bots fill count toward the minimum, so a lone host who asked for bots is
   * playing a real table. The check only bites once nobody — human or bot — is there to
   * play against, which `botCount`'s zero default now makes reachable. docs/adr/0006.
   */
  it("counts bot seats toward the minimum", () => {
    const withBots = makeState({
      phase: "lobby",
      players: [{ id: "p1" }, { id: "bot1", isBot: true }],
    });
    const state = unwrap(startGame(withBots, "p1", rng()));
    assert.equal(state.phase, "playing");
  });
});

describe("updateSettings", () => {
  /** Every field different from the defaults, so a partial replace would show up. */
  const CHOSEN: RoomSettings = {
    handSize: 7,
    yanivThreshold: 3,
    maxScore: 200,
    botCount: 4,
  };

  const lobby = () => makeState({ phase: "lobby", roundNumber: 0 });

  it("replaces all four fields at once", () => {
    const state = unwrap(updateSettings(lobby(), "p1", CHOSEN));

    assert.deepEqual(state.settings, CHOSEN);
  });

  it("rejects an edit by anyone but the host", () => {
    expectErr(updateSettings(lobby(), "p2", CHOSEN), "NOT_HOST");
  });

  it("rejects an edit once the match has been dealt", () => {
    for (const phase of ["playing", "roundEnd", "gameEnd"] as const) {
      expectErr(updateSettings(makeState({ phase }), "p1", CHOSEN), "WRONG_PHASE");
    }
  });

  /*
   * Nothing the real client can send — the lobby offers the valid options and nothing
   * else. These exist so an off-contract client cannot put a room into a state the rest
   * of the engine assumes away: a hand size that cannot be dealt from 54 cards, a max
   * score no one can ever bust past.
   */
  const malformed: Array<[string, unknown]> = [
    ["a hand size outside the offered set", { ...CHOSEN, handSize: 4 }],
    ["a hand size past what the deck can seat", { ...CHOSEN, handSize: 8 }],
    ["a threshold outside the offered set", { ...CHOSEN, yanivThreshold: 6 }],
    ["a max score of zero", { ...CHOSEN, maxScore: 0 }],
    ["a max score past the cap", { ...CHOSEN, maxScore: 100_001 }],
    ["a fractional max score", { ...CHOSEN, maxScore: 12.5 }],
    ["a negative bot count", { ...CHOSEN, botCount: -1 }],
    ["more bots than a room has seats for", { ...CHOSEN, botCount: 6 }],
    ["a bot count that is not a number", { ...CHOSEN, botCount: "3" }],
    ["a missing field", { handSize: 5, yanivThreshold: 7, maxScore: 100 }],
    ["nothing at all", null],
  ];

  for (const [what, settings] of malformed) {
    it(`rejects ${what}`, () => {
      expectErr(updateSettings(lobby(), "p1", settings), "INVALID_SETTINGS");
    });
  }

  /**
   * The room stores its own four fields, not the object it was handed. Anything else
   * riding along would be kept and then served back to every player by the serializer,
   * which publishes `settings` whole.
   */
  it("keeps only the four fields a room has", () => {
    const state = unwrap(
      updateSettings(lobby(), "p1", { ...CHOSEN, dealMeAces: true }),
    );

    assert.deepEqual(state.settings, CHOSEN);
  });

  it("applies none of a settings object with one bad field", () => {
    const state = lobby();
    const before = JSON.stringify(state);

    expectErr(
      updateSettings(state, "p1", { ...CHOSEN, maxScore: 0 }),
      "INVALID_SETTINGS",
    );

    assert.equal(JSON.stringify(state), before, "the three valid fields landed nowhere");
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

describe("takeTurn — opening the slapdown window", () => {
  const base = () =>
    makeState({
      hands: {
        p1: ["hearts-7", "diamonds-7", "hearts-5", "hearts-6"],
        p2: ["clubs-2"],
      },
      drawPile: ["spades-7", "hearts-10"],
      lastDiscard: ["clubs-4"],
    });

  it("opens for whoever discarded a same-rank set and drew that rank", () => {
    const after = unwrap(
      discardAndDrawFromDeck(base(), "p1", ["hearts-7", "diamonds-7"]),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.slapdown, { playerId: "p1", card: card("spades-7") });
  });

  it("stays shut after a run", () => {
    const after = unwrap(
      discardAndDrawFromDeck(base(), "p1", ["hearts-5", "hearts-6", "hearts-7"]),
    );

    assert.equal(after.phase, "playing");
    assert.equal(after.round.slapdown, null);
  });

  it("stays shut when the matching card was picked up rather than drawn", () => {
    const state = makeState({
      hands: { p1: ["hearts-7", "diamonds-7", "spades-9"], p2: ["clubs-2"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["spades-7"],
    });

    const after = unwrap(
      takeTurn(
        state,
        "p1",
        {
          discardCardIds: ["hearts-7", "diamonds-7"],
          draw: { source: "discard", cardId: "spades-7" },
        },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.equal(after.round.slapdown, null);
  });

  it("stays shut when the drawn card is a joker", () => {
    const state = makeState({
      hands: { p1: ["joker-1", "spades-9"], p2: ["clubs-2"] },
      drawPile: ["joker-2"],
      lastDiscard: ["clubs-4"],
    });

    const after = unwrap(discardAndDrawFromDeck(state, "p1", ["joker-1"]));

    assert.equal(after.phase, "playing");
    assert.equal(after.round.slapdown, null);
  });

  it("stays shut when the drawn card is of another rank", () => {
    const after = unwrap(discardAndDrawFromDeck(base(), "p1", ["hearts-5"]));

    assert.equal(after.phase, "playing");
    assert.equal(after.round.slapdown, null);
  });

  it("closes a window the previous player left open", () => {
    const state = makeState({
      hands: { p1: ["hearts-7"], p2: ["clubs-2", "spades-9"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["clubs-4"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "hearts-7" },
    });

    const after = unwrap(discardAndDrawFromDeck(state, "p2", ["clubs-2"]));

    assert.equal(after.phase, "playing");
    assert.equal(after.round.slapdown, null);
  });
});

describe("slapDown", () => {
  const open = () =>
    makeState({
      hands: { p1: ["spades-7", "clubs-9"], p2: ["clubs-2", "diamonds-3"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["hearts-7", "diamonds-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "spades-7" },
    });

  it("lays the card on the end of the set it matches and out of the hand", () => {
    const after = unwrap(slapDown(open(), "p1"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(ids(after.round.lastDiscard), [
      "hearts-7",
      "diamonds-7",
      "spades-7",
    ]);
    assert.deepEqual(ids(after.round.hands["p1"]!), ["clubs-9"]);
  });

  it("closes the window behind it, so a second slap has nothing to play", () => {
    const after = unwrap(slapDown(open(), "p1"));

    assert.equal(after.phase, "playing");
    assert.equal(after.round.slapdown, null);
    expectErr(slapDown(after, "p1"), "SLAPDOWN_NOT_AVAILABLE");
  });

  it("leaves the turn where it already was", () => {
    const after = unwrap(slapDown(open(), "p1"));

    assert.equal(after.phase, "playing");
    assert.equal(after.round.currentTurnPlayerId, "p2");
  });

  it("refuses a caller the window does not belong to", () => {
    expectErr(slapDown(open(), "p2"), "SLAPDOWN_NOT_AVAILABLE");
  });

  it("refuses when no window is open at all", () => {
    const state = makeState({
      hands: { p1: ["spades-7"], p2: ["clubs-2"] },
      lastDiscard: ["hearts-7"],
    });
    expectErr(slapDown(state, "p1"), "SLAPDOWN_NOT_AVAILABLE");
  });

  it("refuses once the round is over", () => {
    const state = makeState({
      phase: "roundEnd",
      hands: { p1: ["spades-7"], p2: ["clubs-2"] },
      lastDiscard: ["hearts-7"],
      slapdown: { playerId: "p1", cardId: "spades-7" },
    });
    expectErr(slapDown(state, "p1"), "WRONG_PHASE");
  });

  it("conserves every card in the round", () => {
    const before = open();
    const after = unwrap(slapDown(before, "p1"));
    assert.deepEqual(allCardIds(after), allCardIds(before));
  });

  it("leaves the input state untouched", () => {
    const before = open();
    const snapshot = JSON.stringify(before);
    slapDown(before, "p1");
    assert.equal(JSON.stringify(before), snapshot);
  });

  it("can empty a hand, leaving Yaniv as the only move left in it", () => {
    const state = makeState({
      hands: { p1: ["spades-7"], p2: ["clubs-2", "diamonds-3"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["hearts-7", "diamonds-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "spades-7" },
    });

    const slapped = unwrap(slapDown(state, "p1"));
    assert.equal(slapped.phase, "playing");
    assert.deepEqual(slapped.round.hands["p1"], []);

    // Round back to p1 with nothing to discard: no turn is legal, and the rules already
    // say so without a rule of slapdown's own. docs/rules.md §3.
    const p1sTurn = unwrap(discardAndDrawFromDeck(slapped, "p2", ["clubs-2"]));
    assert.equal(p1sTurn.phase, "playing");
    assert.equal(p1sTurn.round.currentTurnPlayerId, "p1");
    expectErr(
      takeTurn(p1sTurn, "p1", { discardCardIds: [], draw: { source: "deck" } }, rng()),
      "EMPTY_DISCARD_SET",
    );
    assert.equal(callYaniv(p1sTurn, "p1").ok, true);
  });

  it("buries the whole extended set once the next player has drawn from it", () => {
    const slapped = unwrap(slapDown(open(), "p1"));
    assert.equal(slapped.phase, "playing");

    const after = unwrap(
      takeTurn(
        slapped,
        "p2",
        {
          discardCardIds: ["clubs-2"],
          draw: { source: "discard", cardId: "spades-7" },
        },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    // The slapped card was pickup-eligible like every other card of a same-rank set,
    // and the two it was laid on are buried behind p2's own discard.
    assert.deepEqual(ids(after.round.hands["p2"]!), ["diamonds-3", "spades-7"]);
    assert.deepEqual(ids(after.round.buried), ["hearts-7", "diamonds-7"]);
  });
});

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

  it("closes a window the previous player left open", () => {
    const state = makeState({
      hands: { p1: ["hearts-7"], p2: ["clubs-2"] },
      lastDiscard: ["diamonds-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "hearts-7" },
    });

    const after = unwrap(callYaniv(state, "p2"));

    assert.notEqual(after.phase, "lobby");
    assert.equal(after.round?.slapdown, null);
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

describe("callYaniv — milestone reduction", () => {
  it("reduces a score landing exactly on 50", () => {
    const state = makeState({
      players: [{ id: "p1", score: 0 }, { id: "p2", score: 42 }],
      hands: { p1: ["hearts-A"], p2: ["clubs-8"] },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const p2 = after.lastRoundResult!.players.find((p) => p.playerId === "p2")!;

    assert.equal(p2.delta, 8);
    assert.equal(p2.milestoneReduction, 50);
    assert.equal(p2.scoreAfter, 0);
    assert.equal(after.players.find((p) => p.id === "p2")!.score, 0);
  });

  it("reduces a score landing on 100, not just the first multiple of 50", () => {
    const state = makeState({
      players: [{ id: "p1", score: 0 }, { id: "p2", score: 142 }],
      hands: { p1: ["hearts-A"], p2: ["clubs-8"] },
      settings: { maxScore: 200 },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const p2 = after.lastRoundResult!.players.find((p) => p.playerId === "p2")!;

    assert.equal(p2.milestoneReduction, 50);
    assert.equal(p2.scoreAfter, 100);
  });

  it("triggers nothing when a delta overshoots a multiple without landing on it", () => {
    const state = makeState({
      players: [{ id: "p1", score: 0 }, { id: "p2", score: 45 }],
      hands: { p1: ["hearts-A"], p2: ["clubs-8"] },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const p2 = after.lastRoundResult!.players.find((p) => p.playerId === "p2")!;

    assert.equal(p2.scoreAfter, 53);
    assert.equal(p2.milestoneReduction, 0);
  });

  it("does not re-trigger for a round winner already sitting on a multiple", () => {
    const state = makeState({
      players: [{ id: "p1", score: 50 }, { id: "p2", score: 10 }],
      hands: { p1: ["hearts-A"], p2: ["spades-K"] },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const p1 = after.lastRoundResult!.players.find((p) => p.playerId === "p1")!;

    assert.equal(p1.delta, 0);
    assert.equal(p1.milestoneReduction, 0);
    assert.equal(p1.scoreAfter, 50);
  });

  it("pulls a player back under maxScore when the reduced score no longer busts", () => {
    const state = makeState({
      players: [{ id: "p1", score: 0 }, { id: "p2", score: 90 }],
      hands: { p1: ["hearts-A"], p2: ["clubs-10"] },
      settings: { maxScore: 90 },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const p2 = after.lastRoundResult!.players.find((p) => p.playerId === "p2")!;

    assert.equal(p2.milestoneReduction, 50);
    assert.equal(p2.scoreAfter, 50);
    assert.equal(after.phase, "roundEnd");
    assert.equal(after.winnerIds, null);
  });

  it("still busts when the reduced score remains past maxScore", () => {
    const state = makeState({
      players: [{ id: "p1", score: 0 }, { id: "p2", score: 90 }],
      hands: { p1: ["hearts-A"], p2: ["clubs-10"] },
      settings: { maxScore: 40 },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const p2 = after.lastRoundResult!.players.find((p) => p.playerId === "p2")!;

    assert.equal(p2.milestoneReduction, 50);
    assert.equal(p2.scoreAfter, 50);
    assert.equal(after.phase, "gameEnd");
  });

  it("triggers independently for multiple players in the same round", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 0 },
        { id: "p2", score: 42 },
        { id: "p3", score: 92 },
      ],
      hands: { p1: ["hearts-A"], p2: ["clubs-8"], p3: ["diamonds-8"] },
      settings: { maxScore: 200 },
    });
    const after = unwrap(callYaniv(state, "p1"));
    const result = after.lastRoundResult!.players;
    const p2 = result.find((p) => p.playerId === "p2")!;
    const p3 = result.find((p) => p.playerId === "p3")!;

    assert.equal(p2.milestoneReduction, 50);
    assert.equal(p2.scoreAfter, 0);
    assert.equal(p3.milestoneReduction, 50);
    assert.equal(p3.scoreAfter, 50);
  });
});

/**
 * docs/rules.md §7: crossing the room's max score takes that player out of the match
 * rather than ending it, and the match ends when one player is left. A two-player table
 * is the same rule read at its smallest — the round that knocks one of them out leaves
 * exactly one, so it ends the match, which is what two players have always done.
 */
describe("callYaniv — elimination", () => {
  it("marks a player whose total passes maxScore as out, in the round they went out", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 10 },
        { id: "p2", score: 95 },
        { id: "p3", score: 20 },
      ],
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"], p3: ["clubs-3"] },
      roundNumber: 4,
    });
    const after = unwrap(callYaniv(state, "p1"));

    const p2 = after.players.find((p) => p.id === "p2")!;
    assert.equal(p2.outInRound, 4);
    assert.equal(p2.departed, false, "eliminated is not departed");
    assert.equal(p2.score, 115, "their total is frozen where it stood");
  });

  it("plays on with everybody else once somebody goes out", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 10 },
        { id: "p2", score: 95 },
        { id: "p3", score: 20 },
      ],
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"], p3: ["clubs-3"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "roundEnd", "one bust no longer ends a three-hander");
    assert.equal(after.winnerIds, null);
    assert.deepEqual(
      after.players.filter((p) => p.outInRound === null).map((p) => p.id),
      ["p1", "p3"],
    );
  });

  it("deals the next round to the survivors alone, in their seated order", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 10 },
        { id: "p2", score: 95 },
        { id: "p3", score: 20 },
      ],
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"], p3: ["clubs-3"] },
    });
    const next = unwrap(startNextRound(unwrap(callYaniv(state, "p1")), "p1", rng()));

    assert.equal(next.phase, "playing");
    assert.deepEqual(next.round.turnOrder, ["p1", "p3"]);
    assert.deepEqual(Object.keys(next.round.hands), ["p1", "p3"]);
    assert.equal(next.round.hands["p1"]!.length, 5);
    assert.equal(allCardIds(next).length, 54);
  });

  it("scores nothing further for a player already out", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 10 },
        { id: "p2", score: 115, outInRound: 2 },
        { id: "p3", score: 20 },
      ],
      hands: { p1: ["hearts-A"], p3: ["clubs-3"] },
      roundNumber: 3,
    });
    const after = unwrap(callYaniv(state, "p1"));

    const p2 = after.players.find((p) => p.id === "p2")!;
    assert.equal(p2.score, 115);
    assert.equal(p2.outInRound, 2, "the round they went out in is not rewritten");
    assert.ok(
      !after.lastRoundResult!.players.some((p) => p.playerId === "p2"),
      "a player who is out has no result in a round they did not play",
    );
  });

  it("ends the match when exactly one player is left, and that player wins", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 10 },
        { id: "p2", score: 95 },
        { id: "p3", score: 99, outInRound: null },
      ],
      // p1 calls with 1 unopposed: p2 takes 20 and goes out, p3 takes 10 and goes out.
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"], p3: ["clubs-10"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
  });

  it("wins on outlasting everyone, not on holding the lowest score", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 70 },
        { id: "p2", score: 99 },
      ],
      // p2 Assafs p1 and scores nothing; p1 takes 7 + 30 and passes 100.
      hands: { p1: ["hearts-3", "hearts-4"], p2: ["spades-2", "spades-3"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p2"], "the survivor wins, on the higher score");
    assert.equal(after.players.find((p) => p.id === "p2")!.score, 99);
    assert.equal(after.players.find((p) => p.id === "p1")!.score, 107);
  });

  it("ends a two-player match on the first player out, with no special case", () => {
    const state = makeState({
      players: [{ id: "p1", score: 10 }, { id: "p2", score: 95 }],
      hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
    assert.equal(after.players.find((p) => p.id === "p1")!.outInRound, null);
  });

  it("keeps playing at exactly 100, milestone-reduced to 50", () => {
    const state = makeState({
      players: [{ id: "p1", score: 10 }, { id: "p2", score: 90 }],
      hands: { p1: ["hearts-A"], p2: ["spades-K"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.players.find((p) => p.id === "p2")!.score, 50);
    assert.equal(after.players.find((p) => p.id === "p2")!.outInRound, null);
    assert.equal(after.phase, "roundEnd");
    assert.equal(after.winnerIds, null);
  });

  it("goes out against the room's own maxScore, not the shared default", () => {
    const state = makeState({
      players: [{ id: "p1", score: 10 }, { id: "p2", score: 15 }],
      hands: { p1: ["hearts-A"], p2: ["spades-K"] },
      settings: { maxScore: 20 },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.players.find((p) => p.id === "p2")!.score, 25);
    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
  });

  /**
   * The proof in §7 read back as a test: the round's winner scores 0 and a reduction only
   * subtracts, so whoever won the round cannot be knocked out by it — which is what makes
   * "nobody is left" unreachable and the next round's opener guaranteed.
   */
  it("never empties the match, even with everyone else already at the line", () => {
    const state = makeState({
      players: [
        { id: "p1", score: 100 },
        { id: "p2", score: 100 },
        { id: "p3", score: 100 },
      ],
      hands: { p1: ["hearts-A"], p2: ["spades-K"], p3: ["clubs-10"] },
    });
    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
  });
});

/**
 * `round.lastMove` is what makes "which exact card did they draw" answerable at all: a
 * client diffing two consecutive views cannot recover it whenever more than one card of
 * the pile was pickup-eligible, since what is left behind is only ever reported as a
 * count. One fact, overwritten by the next turn — never a log. See issue #70.
 */
describe("the last move", () => {
  const base = () =>
    makeState({
      hands: {
        p1: ["hearts-3", "spades-9", "clubs-2"],
        p2: ["diamonds-8"],
      },
      drawPile: ["spades-A", "hearts-10"],
      lastDiscard: ["hearts-4", "hearts-5", "hearts-6"],
    });

  it("records the mover and the card they took off the deck", () => {
    const after = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.lastMove, {
      playerId: "p1",
      drawSource: "deck",
      drawnCard: card("spades-A"),
    });
  });

  /**
   * The case the field exists for: a run exposes both its ends, so the two cards left on
   * the table after this pickup are indistinguishable from the one that was taken.
   */
  it("records which end of an ambiguous pile was picked up", () => {
    const after = unwrap(
      takeTurn(
        base(),
        "p1",
        {
          discardCardIds: ["hearts-3"],
          draw: { source: "discard", cardId: "hearts-6" },
        },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.lastMove, {
      playerId: "p1",
      drawSource: "discard",
      drawnCard: card("hearts-6"),
    });
  });

  it("is replaced by the next turn rather than added to", () => {
    const first = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    const second = unwrap(
      takeTurn(
        first,
        "p2",
        { discardCardIds: ["diamonds-8"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(second.phase, "playing");
    assert.deepEqual(second.round.lastMove, {
      playerId: "p2",
      drawSource: "deck",
      drawnCard: card("hearts-10"),
    });
  });

  /**
   * A slapdown is not a turn and neither is a Yaniv call a draw, so neither has a move of
   * its own to record — and clearing what is there would erase the turn a client has not
   * finished drawing yet.
   */
  it("survives a slapdown untouched", () => {
    const state = makeState({
      hands: { p1: ["spades-7", "clubs-9"], p2: ["clubs-2"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["hearts-7", "diamonds-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "spades-7" },
      lastMove: { playerId: "p1", drawSource: "deck", drawnCardId: "spades-7" },
    });

    const after = unwrap(slapDown(state, "p1"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.lastMove, {
      playerId: "p1",
      drawSource: "deck",
      drawnCard: card("spades-7"),
    });
  });

  it("survives a Yaniv call untouched", () => {
    const state = makeState({
      hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K", "spades-Q"] },
      lastMove: { playerId: "p2", drawSource: "discard", drawnCardId: "clubs-4" },
    });

    const after = unwrap(callYaniv(state, "p1"));

    assert.equal(after.phase, "roundEnd");
    assert.deepEqual(after.round.lastMove, {
      playerId: "p2",
      drawSource: "discard",
      drawnCard: card("clubs-4"),
    });
  });

  it("is empty on a freshly dealt match", () => {
    const state = unwrap(
      startGame(makeState({ phase: "lobby", roundNumber: 0 }), "p1", rng()),
    );
    assert.equal(state.phase, "playing");
    assert.equal(state.round.lastMove, null);
  });

  it("is cleared by the next round, so nothing replays over a fresh deal", () => {
    const played = unwrap(
      takeTurn(
        makeState({
          hands: { p1: ["hearts-3", "clubs-2"], p2: ["diamonds-4"] },
          drawPile: ["spades-A"],
          lastDiscard: ["hearts-6"],
        }),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    const scored = unwrap(callYaniv(played, "p2"));
    const next = unwrap(startNextRound(scored, "p1", rng()));

    assert.equal(next.phase, "playing");
    assert.equal(next.round.lastMove, null);
  });
});

/**
 * `round.lastSlapdown` is the slapdown's own fact, a sibling of `lastMove` rather than a
 * replacement: a slapped card lands somewhere on screen, and no diff of two positions says
 * whose seat it came from, since an opponent's eligibility is never on the wire. Issue #93.
 */
describe("the last slapdown", () => {
  const open = () =>
    makeState({
      hands: { p1: ["spades-7", "clubs-9"], p2: ["clubs-2", "diamonds-3"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["hearts-7", "diamonds-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "spades-7" },
      lastMove: { playerId: "p1", drawSource: "deck", drawnCardId: "spades-7" },
    });

  it("records the slapper and the card they put down", () => {
    const after = unwrap(slapDown(open(), "p1"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.lastSlapdown, {
      playerId: "p1",
      card: card("spades-7"),
    });
  });

  it("leaves the card on the discard pile and out of the hand as before", () => {
    const after = unwrap(slapDown(open(), "p1"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(ids(after.round.lastDiscard), [
      "hearts-7",
      "diamonds-7",
      "spades-7",
    ]);
    assert.deepEqual(ids(after.round.hands["p1"]!), ["clubs-9"]);
  });

  it("leaves the last move exactly as it found it", () => {
    const after = unwrap(slapDown(open(), "p1"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.lastMove, {
      playerId: "p1",
      drawSource: "deck",
      drawnCard: card("spades-7"),
    });
  });

  it("is empty until someone slaps one down", () => {
    assert.equal(open().round?.lastSlapdown ?? null, null);

    const played = unwrap(
      takeTurn(
        makeState({
          hands: { p1: ["hearts-3", "clubs-2"], p2: ["diamonds-4"] },
          drawPile: ["spades-A"],
          lastDiscard: ["hearts-6"],
        }),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    assert.equal(played.phase, "playing");
    assert.equal(played.round.lastSlapdown, null);
  });

  it("stands through the turns that follow it, to be watched for change", () => {
    const slapped = unwrap(slapDown(open(), "p1"));
    const after = unwrap(
      takeTurn(
        slapped,
        "p2",
        { discardCardIds: ["clubs-2"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.lastSlapdown, {
      playerId: "p1",
      card: card("spades-7"),
    });
  });

  it("is cleared by the next round, so nothing replays over a fresh deal", () => {
    const slapped = unwrap(slapDown(open(), "p1"));
    const scored = unwrap(callYaniv(slapped, "p2"));
    const next = unwrap(startNextRound(scored, "p1", rng()));

    assert.equal(next.phase, "playing");
    assert.equal(next.round.lastSlapdown, null);
  });

  it("is empty on a freshly dealt match", () => {
    const state = unwrap(
      startGame(makeState({ phase: "lobby", roundNumber: 0 }), "p1", rng()),
    );
    assert.equal(state.phase, "playing");
    assert.equal(state.round.lastSlapdown, null);
  });
});

/**
 * `round.moveHistory` is the log the two facts above are deliberately not: every turn and
 * every slapdown of the round, oldest first, so a player who glanced away can read back
 * what happened rather than seeing only the move that happened to be last. Issue #90.
 *
 * Written by the same two transitions and by nothing else — a Yaniv call is not a move —
 * and replaced wholesale by the deal, since round state always is.
 */
describe("the move history", () => {
  const base = () =>
    makeState({
      hands: {
        p1: ["hearts-3", "spades-9", "clubs-2"],
        p2: ["diamonds-8", "clubs-5"],
      },
      drawPile: ["spades-A", "hearts-10"],
      lastDiscard: ["hearts-4", "hearts-5", "hearts-6"],
    });

  it("records a turn: the mover, what they put down and what they took off the deck", () => {
    const after = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.moveHistory, [
      {
        kind: "turn",
        playerId: "p1",
        discarded: [card("hearts-3")],
        drawSource: "deck",
        drawnCard: card("spades-A"),
      },
    ]);
  });

  /** The discarded set as it was laid out, matching what landed on `lastDiscard`. */
  it("records the discarded set in the order it was laid out", () => {
    const after = unwrap(
      takeTurn(
        makeState({
          hands: { p1: ["clubs-4", "clubs-2", "clubs-3"], p2: ["diamonds-8"] },
          drawPile: ["spades-A"],
          lastDiscard: ["hearts-4", "hearts-5", "hearts-6"],
        }),
        "p1",
        {
          discardCardIds: ["clubs-4", "clubs-2", "clubs-3"],
          draw: { source: "discard", cardId: "hearts-6" },
        },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    const entry = after.round.moveHistory[0]!;
    assert.equal(entry.kind, "turn");
    assert.deepEqual(ids(entry.discarded), ids(after.round.lastDiscard));
    assert.deepEqual(entry.drawnCard, card("hearts-6"));
    assert.equal(entry.drawSource, "discard");
  });

  it("records a slapdown as its own entry", () => {
    const state = makeState({
      hands: { p1: ["spades-7", "clubs-9"], p2: ["clubs-2"] },
      drawPile: ["hearts-10"],
      lastDiscard: ["hearts-7", "diamonds-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "spades-7" },
      lastMove: { playerId: "p1", drawSource: "deck", drawnCardId: "spades-7" },
    });

    const after = unwrap(slapDown(state, "p1"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round.moveHistory, [
      { kind: "slapdown", playerId: "p1", card: card("spades-7") },
    ]);
  });

  it("appends in the order the moves were made, oldest first", () => {
    const first = unwrap(
      takeTurn(
        base(),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    const second = unwrap(
      takeTurn(
        first,
        "p2",
        { discardCardIds: ["diamonds-8"], draw: { source: "deck" } },
        rng(),
      ),
    );

    assert.equal(second.phase, "playing");
    assert.deepEqual(
      second.round.moveHistory.map((entry) => [entry.kind, entry.playerId]),
      [
        ["turn", "p1"],
        ["turn", "p2"],
      ],
    );
  });

  /** A slapdown lands between the turn that opened it and the one that closes it. */
  it("interleaves a slapdown with the turns around it", () => {
    const played = unwrap(
      takeTurn(
        makeState({
          hands: { p1: ["hearts-7", "clubs-9"], p2: ["clubs-2", "diamonds-3"] },
          drawPile: ["spades-7"],
          lastDiscard: ["hearts-6"],
        }),
        "p1",
        { discardCardIds: ["hearts-7"], draw: { source: "deck" } },
        rng(),
      ),
    );
    const slapped = unwrap(slapDown(played, "p1"));
    const after = unwrap(
      takeTurn(
        slapped,
        "p2",
        { discardCardIds: ["clubs-2"], draw: { source: "discard", cardId: "spades-7" } },
        rng(),
      ),
    );

    assert.equal(after.phase, "playing");
    assert.deepEqual(
      after.round.moveHistory.map((entry) => entry.kind),
      ["turn", "slapdown", "turn"],
    );
  });

  it("is left exactly as it was by a Yaniv call", () => {
    const played = unwrap(
      takeTurn(
        makeState({
          hands: { p1: ["hearts-3", "clubs-2"], p2: ["hearts-A", "hearts-2"] },
          drawPile: ["spades-A"],
          lastDiscard: ["hearts-6"],
        }),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    const scored = unwrap(callYaniv(played, "p2"));

    assert.equal(played.phase, "playing");
    assert.equal(scored.phase, "roundEnd");
    assert.deepEqual(scored.round.moveHistory, played.round.moveHistory);
  });

  it("is empty on a freshly dealt match", () => {
    const state = unwrap(
      startGame(makeState({ phase: "lobby", roundNumber: 0 }), "p1", rng()),
    );
    assert.equal(state.phase, "playing");
    assert.deepEqual(state.round.moveHistory, []);
  });

  it("is cleared by the next round, so nothing replays over a fresh deal", () => {
    const played = unwrap(
      takeTurn(
        makeState({
          hands: { p1: ["hearts-3", "clubs-2"], p2: ["diamonds-4"] },
          drawPile: ["spades-A"],
          lastDiscard: ["hearts-6"],
        }),
        "p1",
        { discardCardIds: ["hearts-3"], draw: { source: "deck" } },
        rng(),
      ),
    );
    const scored = unwrap(callYaniv(played, "p2"));
    const next = unwrap(startNextRound(scored, "p1", rng()));

    assert.equal(next.phase, "playing");
    assert.deepEqual(next.round.moveHistory, []);
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

  /**
   * The winner may have walked off between the scoring and the deal now that leaving is
   * allowed in every phase (issue #147). An opener absent from turn order would hold no
   * hand and hand on to nobody, so the deal falls back to whoever is still playing.
   */
  it("opens on a seat still in the match when the round's winner has left", () => {
    const scored = finished();
    const three = {
      ...scored,
      players: [...scored.players, { ...scored.players[0]!, id: "p3", name: "Third" }],
    };
    const gone = unwrap(removePlayer(three, "p2"));

    const next = unwrap(startNextRound(gone, "p1", rng()));

    assert.equal(next.phase, "playing");
    assert.deepEqual(next.round.turnOrder, ["p1", "p3"]);
    assert.ok(
      next.round.turnOrder.includes(next.round.currentTurnPlayerId),
      "the opener is dealt a hand",
    );
  });

  it("carries scores forward but clears the previous result", () => {
    const next = unwrap(startNextRound(finished(), "p1", rng()));
    assert.equal(next.players.find((p) => p.id === "p1")!.score, 37);
    assert.equal(next.lastRoundResult, null);
  });

  /**
   * Nobody is host once a round has been dealt (docs/adr/0012), so the deal belongs to
   * whoever is still playing: a table does not wait on one particular person.
   */
  it("is dealt by any player still in the match, not one particular seat", () => {
    const next = unwrap(startNextRound(finished(), "p2", rng()));

    assert.equal(next.phase, "playing");
    assert.equal(next.roundNumber, 2);
  });

  it("refuses a player the match has gone on without", () => {
    const scored = makeState({
      phase: "roundEnd",
      players: [
        { id: "p1", score: 105, outInRound: 1 },
        { id: "p2", score: 10 },
        { id: "p3", score: 20 },
      ],
    });

    expectErr(startNextRound(scored, "p1", rng()), "NOT_IN_MATCH");
  });

  it("refuses a player who has left the room", () => {
    const scored = makeState({
      phase: "roundEnd",
      players: [
        { id: "p1", score: 40, outInRound: 1, departed: true },
        { id: "p2", score: 10 },
        { id: "p3", score: 20 },
      ],
    });

    expectErr(startNextRound(scored, "p1", rng()), "NOT_IN_MATCH");
  });

  it("refuses a player the room has never held", () => {
    expectErr(startNextRound(finished(), "ghost", rng()), "PLAYER_NOT_FOUND");
  });

  it("rejects advancing mid-round", () => {
    expectErr(startNextRound(makeState(), "p1", rng()), "WRONG_PHASE");
  });

  /**
   * A round is opened by whoever won the last one, who is always still in the match (§7).
   * The fallback behind that is the first seat still playing rather than the host, who
   * may be out by now — a starter with no place in `turnOrder` would be dealt no hand and
   * hand the turn on to nobody.
   */
  it("never opens a round on a seat that is out of the match", () => {
    const scored = makeState({
      phase: "roundEnd",
      players: [
        { id: "p1", score: 105, outInRound: 1 },
        { id: "p2", score: 10 },
        { id: "p3", score: 20 },
      ],
    });

    const next = unwrap(startNextRound({ ...scored, lastRoundResult: null }, "p2", rng()));

    assert.equal(next.phase, "playing");
    assert.equal(next.round.currentTurnPlayerId, "p2");
    assert.deepEqual(next.round.turnOrder, ["p2", "p3"]);
  });
});

describe("playAgain", () => {
  /** A match played to a bust, which is the only position play again is offered from. */
  const finishedMatch = (
    players: NonNullable<StateOptions["players"]> = [
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

  /**
   * The one transition that rebuilds every `Player` object rather than patching one, so
   * the one most able to drop a field on the way past. A seat carried into another match
   * is the same seat, and its resume token is what says so.
   */
  it("carries every seat's resume token into the new match", () => {
    const finished = finishedMatch();
    const again = unwrap(playAgain(finished, "p1", rng()));

    assert.deepEqual(
      again.players.map((p) => p.resumeToken),
      finished.players.map((p) => p.resumeToken),
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

  /**
   * Anyone still in the room, and being knocked out of the last match is no bar: the
   * seat asking here is exactly the one this is offered to (docs/adr/0012).
   */
  it("is dealt by anyone still in the room, the match's loser included", () => {
    const finished = finishedMatch();
    assert.equal(finished.players.find((p) => p.id === "p2")!.outInRound, 7);

    const again = unwrap(playAgain(finished, "p2", rng()));

    assert.equal(again.phase, "playing");
  });

  /**
   * A bot can win a match, and a bot presses nothing — so a room whose survivor is a bot
   * would be frozen if only players still in the match could ask.
   */
  it("is dealt by a human whose match a bot won", () => {
    const finished = finishedMatch([
      { id: "p1", score: 10, isBot: true },
      { id: "p2", score: 95 },
    ]);
    assert.deepEqual(finished.winnerIds, ["p1"]);

    const again = unwrap(playAgain(finished, "p2", rng()));

    assert.equal(again.phase, "playing");
  });

  it("refuses a seat that has been given up", () => {
    const gone = unwrap(removePlayer(finishedMatch(), "p2"));

    expectErr(playAgain(gone, "p2", rng()), "PLAYER_NOT_FOUND");
  });

  it("refuses a player the room has never held", () => {
    expectErr(playAgain(finishedMatch(), "ghost", rng()), "PLAYER_NOT_FOUND");
  });

  it("rejects a restart from any phase but a finished match", () => {
    expectErr(playAgain(makeState({ phase: "lobby" }), "p1", rng()), "WRONG_PHASE");
    expectErr(playAgain(makeState({ phase: "playing" }), "p1", rng()), "WRONG_PHASE");
    expectErr(playAgain(makeState({ phase: "roundEnd" }), "p1", rng()), "WRONG_PHASE");
  });

  /** docs/rules.md §7: another match is a fresh one, so nobody carries an elimination in. */
  it("clears every elimination, putting the whole room back in the match", () => {
    const again = unwrap(playAgain(finishedMatch(), "p1", rng()));

    assert.ok(
      again.players.every((p) => p.outInRound === null),
      "the loser of the last match is playing this one",
    );
    assert.equal(again.phase, "playing");
    assert.deepEqual(again.round.turnOrder, ["p1", "p2"]);
  });

  it("leaves a seat that was given up out of the new match", () => {
    const left = unwrap(removePlayer(finishedMatch(), "p2"));
    const three = {
      ...left,
      players: [...left.players, { ...left.players[0]!, id: "p3", name: "Third" }],
    };

    const again = unwrap(playAgain(three, "p1", rng()));

    assert.equal(again.phase, "playing");
    assert.deepEqual(again.round.turnOrder, ["p1", "p3"], "the departed seat is not dealt");
    assert.equal(again.players.find((p) => p.id === "p2")!.outInRound, 0);
    assert.equal(again.players.find((p) => p.id === "p2")!.departed, true);
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

  /**
   * The other half of the rule: from the first deal a roster is append-only, so leaving
   * marks the seat rather than splicing it out — which is what lets a table it played at
   * still draw it, and its standings still list it.
   */
  it("marks the seat of a player leaving a finished match, keeping it in the roster", () => {
    const finished = makeState({
      phase: "gameEnd",
      players: [
        { id: "p1", score: 40 },
        { id: "p2", score: 105, outInRound: 6 },
      ],
      roundNumber: 6,
    });

    const after = unwrap(removePlayer(finished, "p2"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(
      after.players.map((p) => p.id),
      ["p1", "p2"],
    );
    const p2 = after.players.find((p) => p.id === "p2")!;
    assert.equal(p2.departed, true);
    assert.equal(p2.outInRound, 6, "the round they were eliminated in stands");
    assert.equal(p2.score, 105, "and the total they finished on with it");
    assert.equal(after.players[0]!.score, 40, "whoever stays keeps their standing");
  });

  /** The winner walking off: still in the match when they left, so the round is now. */
  it("takes a player still in the match out of it as of the current round", () => {
    const finished = makeState({
      phase: "gameEnd",
      players: [
        { id: "p1", score: 40 },
        { id: "p2", score: 105, outInRound: 6 },
      ],
      roundNumber: 6,
    });

    const p1 = unwrap(removePlayer(finished, "p1")).players.find((p) => p.id === "p1")!;

    assert.equal(p1.departed, true);
    assert.equal(p1.outInRound, 6);
  });

  it("rejects a seat that has already been given up", () => {
    const finished = makeState({
      phase: "gameEnd",
      players: [
        { id: "p1", score: 40 },
        { id: "p2", score: 105, outInRound: 6, departed: true },
      ],
    });

    expectErr(removePlayer(finished, "p2"), "PLAYER_NOT_FOUND");
  });

  /**
   * The host is not special about *leaving* — the seat goes the way any other does. What
   * is special is the room they leave behind: a lobby full of people must not be stranded
   * because whoever clicked create wandered off, so the role moves along the roster
   * (docs/adr/0012).
   */
  it("hands the lobby to the next remaining seat when the host leaves", () => {
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      roundNumber: 0,
    });
    assert.equal(lobby.hostId, "p1");

    const after = unwrap(removePlayer(lobby, "p1"));

    assert.deepEqual(
      after.players.map((p) => p.id),
      ["p2", "p3"],
    );
    assert.equal(after.hostId, "p2");
  });

  it("leaves the host where they are when somebody else leaves the lobby", () => {
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      roundNumber: 0,
    });

    const after = unwrap(removePlayer(lobby, "p2"));

    assert.equal(after.hostId, "p1");
  });

  /**
   * The last seat in a lobby leaving: there is nobody to hand the role to, and the room
   * itself is what has ended — which is the socket layer's to act on, not a `GameState`
   * this function could return.
   */
  it("leaves the host id alone when the lobby's last seat goes", () => {
    const alone = makeState({ phase: "lobby", players: [{ id: "p1" }], roundNumber: 0 });

    const after = unwrap(removePlayer(alone, "p1"));

    assert.deepEqual(after.players, []);
    assert.equal(after.hostId, "p1");
  });

  /**
   * The role retires at the first deal (docs/adr/0012), so there is nothing to migrate:
   * the seat is marked and `hostId` — meaningless from `playing` onward — is left as the
   * lobby last set it.
   */
  it("migrates nothing once the match has been dealt", () => {
    const finished = makeState({
      phase: "gameEnd",
      players: [{ id: "p1", score: 40 }, { id: "p2", score: 105, outInRound: 6 }],
      roundNumber: 6,
    });

    const after = unwrap(removePlayer(finished, "p1"));

    assert.equal(after.hostId, "p1");
  });

  it("rejects a player who is not seated", () => {
    expectErr(removePlayer(makeState({ phase: "lobby" }), "ghost"), "PLAYER_NOT_FOUND");
  });

  /**
   * Mid-round (issue #147). The hand goes to the buried pile rather than out of the deck:
   * the rest of the round is still played against a full pack, and a reshuffle would
   * otherwise come up short by however many cards the leaver was holding.
   */
  it("buries the hand of a player leaving mid-round, and drops them from turn order", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: {
        p1: ["hearts-3", "hearts-4"],
        p2: ["spades-5", "spades-6"],
        p3: ["diamonds-7", "diamonds-8"],
      },
      currentTurnPlayerId: "p1",
    });

    const after = unwrap(removePlayer(playing, "p2"));

    assert.equal(after.phase, "playing");
    assert.ok(after.round);
    assert.deepEqual(after.round.turnOrder, ["p1", "p3"]);
    assert.equal(after.round.hands["p2"], undefined, "no hand is held at a seat that is gone");
    assert.deepEqual(ids(after.round.buried), ["spades-5", "spades-6"]);
    assert.deepEqual(allCardIds(after), allCardIds(playing), "no card leaves the round");
  });

  /** Otherwise the table wedges on a turn belonging to somebody who is not there. */
  it("passes the turn along when the player leaving held it", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      currentTurnPlayerId: "p2",
    });

    const after = unwrap(removePlayer(playing, "p2"));

    assert.ok(after.round);
    assert.equal(after.round.currentTurnPlayerId, "p3", "the seat that was next, not the first");
  });

  it("leaves the turn where it is when it was somebody else's", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      currentTurnPlayerId: "p1",
    });

    const after = unwrap(removePlayer(playing, "p3"));

    assert.ok(after.round);
    assert.equal(after.round.currentTurnPlayerId, "p1");
  });

  /** A window is a fact about a hand, and the hand has gone with its owner (§9). */
  it("closes the slapdown window of the player leaving, and nobody else's", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: { p1: [], p2: ["spades-5"], p3: [] },
      slapdown: { playerId: "p2", cardId: "spades-5" },
      currentTurnPlayerId: "p3",
    });

    assert.equal(unwrap(removePlayer(playing, "p2")).round?.slapdown, null);
    assert.equal(unwrap(removePlayer(playing, "p1")).round?.slapdown?.playerId, "p2");
  });

  /**
   * The other half of the leaver being out as of this round: they are not in its turn
   * order, so nothing scores them for it, and the moves they did play stand.
   */
  it("scores the leaver for nothing that round, and keeps the moves they played", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      hands: { p1: ["hearts-3"], p2: ["spades-5"], p3: ["diamonds-4"] },
      moveHistory: [
        {
          kind: "turn",
          playerId: "p2",
          discardedIds: ["clubs-2"],
          drawSource: "deck",
          drawnCardId: "spades-5",
        },
      ],
      currentTurnPlayerId: "p1",
    });

    const after = unwrap(removePlayer(playing, "p2"));
    assert.equal(after.round?.moveHistory.length, 1, "their turn still happened");

    const p1Turn = unwrap(
      takeTurn(after, "p1", { discardCardIds: ["hearts-3"], draw: { source: "deck" } }, rng()),
    );
    const scored = unwrap(callYaniv(p1Turn, "p3"));

    assert.equal(
      scored.lastRoundResult!.players.find((p) => p.playerId === "p2"),
      undefined,
      "a seat that is gone is not in the round it left",
    );
    assert.equal(scored.players.find((p) => p.id === "p2")!.score, 0);
  });

  /**
   * New with issue #147: until now every exit from `playing` went through a Yaniv call.
   * A departure that leaves one player is the match over — dealing a round to a single
   * person is not a position the rules have (docs/rules.md §7).
   */
  it("ends the match when a departure leaves one player in it", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }],
      hands: { p1: ["hearts-3"], p2: ["spades-5"] },
      currentTurnPlayerId: "p1",
    });

    const after = unwrap(removePlayer(playing, "p2"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
  });

  /**
   * The one thing this new `gameEnd` does not have is a round to show, and it must not
   * find an old one: `roundResult` is sent in both revealing phases, so a stale record
   * would be drawn as *this* match's final table — hands and totals from a round that has
   * already been superseded, over seats holding something else. The invariant that saves
   * it is `dealRound`'s, which clears the last result with every deal, and this is what
   * says so out loud.
   */
  it("ends a mid-round match with no scored round to reveal", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }],
      hands: { p1: ["hearts-3"], p2: ["spades-5"] },
      roundNumber: 4,
    });

    const after = unwrap(removePlayer(playing, "p2"));

    assert.equal(after.phase, "gameEnd");
    assert.equal(after.lastRoundResult, null, "no round of this match has been scored");
  });

  it("ends a scored round's match when a departure leaves one player in it", () => {
    const scored = makeState({
      phase: "roundEnd",
      players: [{ id: "p1" }, { id: "p2" }],
      roundNumber: 3,
    });

    const after = unwrap(removePlayer(scored, "p2"));

    assert.equal(after.phase, "gameEnd");
    assert.deepEqual(after.winnerIds, ["p1"]);
  });

  it("plays on when the departure leaves more than one player in the match", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    });

    const after = unwrap(removePlayer(playing, "p2"));

    assert.equal(after.phase, "playing");
    assert.equal(after.winnerIds, null);
  });

  /** A watcher was not in the match to begin with, so their leaving ends nothing. */
  it("changes neither the round nor the match when a spectator leaves mid-round", () => {
    const playing = makeState({
      phase: "playing",
      players: [{ id: "p1" }, { id: "p2" }, { id: "p3", outInRound: 2 }],
      hands: { p1: ["hearts-3"], p2: ["spades-5"] },
      currentTurnPlayerId: "p1",
      roundNumber: 3,
    });

    const after = unwrap(removePlayer(playing, "p3"));

    assert.equal(after.phase, "playing");
    assert.deepEqual(after.round?.turnOrder, ["p1", "p2"]);
    assert.equal(after.round?.currentTurnPlayerId, "p1");
    assert.deepEqual(ids(after.round!.buried), []);
    assert.equal(
      after.players.find((p) => p.id === "p3")!.outInRound,
      2,
      "the round they were eliminated in stands",
    );
  });

  it("leaves the input state untouched", () => {
    const lobby = makeState({ phase: "lobby" });
    const before = JSON.stringify(lobby);

    unwrap(removePlayer(lobby, "p2"));

    assert.equal(JSON.stringify(lobby), before);
  });
});
