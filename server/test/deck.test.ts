import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDeck, deal, shuffle } from "../src/deck.ts";
import { mulberry32 } from "../src/rng.ts";
import { ids } from "./helpers.ts";

describe("createDeck", () => {
  it("builds 54 cards with unique ids", () => {
    const deck = createDeck();
    assert.equal(deck.length, 54);
    assert.equal(new Set(ids(deck)).size, 54);
  });

  it("has 13 cards per suit and 2 jokers", () => {
    const deck = createDeck();
    for (const suit of ["hearts", "diamonds", "clubs", "spades"]) {
      assert.equal(deck.filter((c) => c.suit === suit).length, 13);
    }
    assert.equal(deck.filter((c) => c.rank === "Joker").length, 2);
    assert.equal(deck.filter((c) => c.suit === null).length, 2);
  });

  it("uses readable suit-rank ids", () => {
    const deck = createDeck();
    assert.ok(deck.some((c) => c.id === "hearts-K"));
    assert.ok(deck.some((c) => c.id === "joker-1"));
    assert.ok(deck.some((c) => c.id === "joker-2"));
  });
});

describe("shuffle", () => {
  it("does not mutate the input", () => {
    const deck = createDeck();
    const before = ids(deck);
    shuffle(deck, mulberry32(1));
    assert.deepEqual(ids(deck), before);
  });

  it("preserves the exact set of cards", () => {
    const deck = createDeck();
    const shuffled = shuffle(deck, mulberry32(7));
    assert.deepEqual(ids(shuffled).sort(), ids(deck).sort());
  });

  it("is reproducible for a given seed", () => {
    const deck = createDeck();
    assert.deepEqual(
      ids(shuffle(deck, mulberry32(42))),
      ids(shuffle(deck, mulberry32(42))),
    );
  });

  it("produces different orders for different seeds", () => {
    const deck = createDeck();
    assert.notDeepEqual(
      ids(shuffle(deck, mulberry32(1))),
      ids(shuffle(deck, mulberry32(2))),
    );
  });

  it("actually reorders the deck", () => {
    const deck = createDeck();
    assert.notDeepEqual(ids(shuffle(deck, mulberry32(3))), ids(deck));
  });
});

describe("deal", () => {
  it("gives each player a full hand plus one face-up card", () => {
    const deck = shuffle(createDeck(), mulberry32(5));
    const result = deal(deck, 4, 5);

    assert.equal(result.hands.length, 4);
    for (const hand of result.hands) assert.equal(hand.length, 5);
    assert.ok(result.firstDiscard);
    assert.equal(result.drawPile.length, 54 - 4 * 5 - 1);
  });

  it("conserves every card exactly once", () => {
    const deck = shuffle(createDeck(), mulberry32(9));
    const result = deal(deck, 6, 5);
    const seen = [
      ...result.hands.flat(),
      result.firstDiscard,
      ...result.drawPile,
    ];
    assert.equal(seen.length, 54);
    assert.deepEqual(ids(seen).sort(), ids(deck).sort());
  });

  it("deals round-robin rather than in contiguous blocks", () => {
    const deck = createDeck();
    const result = deal(deck, 2, 5);
    // First two cards off an unshuffled deck go to different players.
    assert.equal(result.hands[0]![0]!.id, deck[0]!.id);
    assert.equal(result.hands[1]![0]!.id, deck[1]!.id);
  });

  it("throws when the deck cannot cover the deal", () => {
    assert.throws(() => deal(createDeck().slice(0, 10), 4, 5), /Deck too small/);
  });
});
