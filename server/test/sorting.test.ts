import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortHand } from "@yaniv/shared";
import { cards, ids } from "./helpers.ts";

describe("sortHand", () => {
  it("puts jokers at the far left and face cards at the far right", () => {
    const hand = sortHand(cards("spades-K", "hearts-5", "joker-1", "clubs-A"));
    assert.deepEqual(ids(hand), ["joker-1", "clubs-A", "hearts-5", "spades-K"]);
  });

  it("orders by scoring value", () => {
    const hand = sortHand(cards("hearts-9", "clubs-2", "diamonds-7", "spades-4"));
    assert.deepEqual(ids(hand), ["clubs-2", "spades-4", "diamonds-7", "hearts-9"]);
  });

  it("places the ten before the face cards despite equal value", () => {
    const hand = sortHand(cards("spades-K", "hearts-J", "clubs-10", "diamonds-Q"));
    assert.deepEqual(ids(hand), [
      "clubs-10",
      "hearts-J",
      "diamonds-Q",
      "spades-K",
    ]);
  });

  it("keeps both jokers together at the left", () => {
    const hand = sortHand(cards("spades-3", "joker-2", "hearts-K", "joker-1"));
    assert.deepEqual(ids(hand).slice(0, 2), ["joker-1", "joker-2"]);
  });

  it("orders the two jokers identically whichever way round they arrive", () => {
    // They tie on value, rank and suit, so only the id tie-break keeps them from
    // swapping places as the rest of the hand changes.
    assert.deepEqual(
      ids(sortHand(cards("joker-2", "joker-1"))),
      ids(sortHand(cards("joker-1", "joker-2"))),
    );
  });

  it("breaks ties between equal ranks by suit, so order is stable", () => {
    const forward = sortHand(cards("spades-7", "hearts-7", "clubs-7"));
    const reversed = sortHand(cards("clubs-7", "hearts-7", "spades-7"));
    assert.deepEqual(ids(forward), ids(reversed));
  });

  it("does not mutate its input", () => {
    const hand = cards("spades-K", "clubs-A");
    sortHand(hand);
    assert.deepEqual(ids(hand), ["spades-K", "clubs-A"]);
  });

  it("handles an empty hand", () => {
    assert.deepEqual(sortHand([]), []);
  });

  it("sorts a full 5-card hand end to end", () => {
    const hand = sortHand(
      cards("hearts-Q", "joker-1", "spades-10", "diamonds-A", "clubs-6"),
    );
    assert.deepEqual(ids(hand), [
      "joker-1",
      "diamonds-A",
      "clubs-6",
      "spades-10",
      "hearts-Q",
    ]);
  });
});
