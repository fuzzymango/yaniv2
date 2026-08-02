import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseDiscard, chooseDraw, decideTurn, shouldCallYaniv } from "../scripts/bot.ts";
import { serializeStateForPlayer } from "../src/serialize.ts";
import { ids, makeState, type StateOptions } from "./helpers.ts";

/** Build the client view the bot actually decides from. */
function viewFor(options: StateOptions) {
  return serializeStateForPlayer(makeState(options), "p1");
}

describe("shouldCallYaniv", () => {
  it("calls as soon as the hand is low enough", () => {
    const view = viewFor({ hands: { p1: ["hearts-5", "spades-2"], p2: ["clubs-K"] } });
    assert.equal(shouldCallYaniv(view), true);
  });

  it("does not call above the threshold", () => {
    const view = viewFor({ hands: { p1: ["hearts-5", "spades-4"], p2: ["clubs-K"] } });
    assert.equal(shouldCallYaniv(view), false);
  });
});

describe("chooseDiscard", () => {
  it("sheds the highest-value legal set", () => {
    const view = viewFor({
      hands: { p1: ["hearts-3", "spades-K", "clubs-4"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
    });
    assert.deepEqual(ids(chooseDiscard(view)), ["spades-K"]);
  });

  it("prefers the option that also sheds more cards when value ties", () => {
    // A lone 10 and a pair of 5s both shed ten points; the pair shrinks the hand.
    const view = viewFor({
      hands: { p1: ["hearts-10", "spades-5", "clubs-5"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
    });
    assert.deepEqual(ids(chooseDiscard(view)).sort(), ["clubs-5", "spades-5"]);
  });

  it("finds a run the naive single-card view would miss", () => {
    const view = viewFor({
      hands: { p1: ["hearts-9", "hearts-10", "hearts-J", "clubs-2"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
    });
    assert.deepEqual(ids(chooseDiscard(view)).sort(), [
      "hearts-10",
      "hearts-9",
      "hearts-J",
    ]);
  });

  it("uses a wild joker when that sheds the most value", () => {
    const view = viewFor({
      hands: { p1: ["hearts-Q", "hearts-K", "joker-1", "clubs-2"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
    });
    // Q+K+joker is a legal run worth 20, beating either card alone.
    assert.deepEqual(ids(chooseDiscard(view)).sort(), [
      "hearts-K",
      "hearts-Q",
      "joker-1",
    ]);
  });

  it("always returns something for a single-card hand", () => {
    const view = viewFor({
      hands: { p1: ["hearts-3"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
    });
    assert.deepEqual(ids(chooseDiscard(view)), ["hearts-3"]);
  });
});

describe("chooseDraw", () => {
  it("takes a cheap exposed card", () => {
    const view = viewFor({
      hands: { p1: ["hearts-9", "spades-K"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-2"],
    });
    assert.deepEqual(chooseDraw(view), { source: "discard", cardId: "clubs-2" });
  });

  it("draws blind rather than taking an expensive card", () => {
    const view = viewFor({
      hands: { p1: ["hearts-9", "spades-K"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-K"],
    });
    assert.deepEqual(chooseDraw(view), { source: "deck" });
  });

  it("takes a joker, which is worth nothing and wild in runs", () => {
    const view = viewFor({
      hands: { p1: ["hearts-9", "spades-K"], p2: ["clubs-9"] },
      lastDiscard: ["joker-1"],
    });
    assert.deepEqual(chooseDraw(view), { source: "discard", cardId: "joker-1" });
  });

  it("considers only the pickup-eligible ends, never a buried card", () => {
    // The cheap 2 sits in the middle of the run and is not on offer.
    const view = viewFor({
      hands: { p1: ["hearts-9", "spades-K"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-A", "clubs-2", "clubs-3"],
    });
    assert.deepEqual(chooseDraw(view), { source: "discard", cardId: "clubs-A" });
  });

  it("draws blind when both ends are expensive", () => {
    const view = viewFor({
      hands: { p1: ["hearts-9", "spades-K"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-9", "clubs-10", "clubs-J"],
    });
    assert.deepEqual(chooseDraw(view), { source: "deck" });
  });
});

describe("decideTurn", () => {
  it("returns a yaniv call when the hand is low enough", () => {
    const view = viewFor({ hands: { p1: ["hearts-5", "spades-2"], p2: ["clubs-K"] } });
    assert.deepEqual(decideTurn(view), { type: "yaniv" });
  });

  it("returns a turn the engine can apply directly", () => {
    const view = viewFor({
      hands: { p1: ["hearts-9", "spades-K"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-2"],
    });
    const decision = decideTurn(view);

    assert.equal(decision.type, "turn");
    if (decision.type !== "turn") return;
    assert.deepEqual(decision.action.discardCardIds, ["spades-K"]);
    assert.deepEqual(decision.action.draw, { source: "discard", cardId: "clubs-2" });
  });

  it("is deterministic, which is what keeps seeded matches reproducible", () => {
    const options: StateOptions = {
      hands: { p1: ["hearts-9", "spades-K", "clubs-4"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-2"],
    };
    assert.deepEqual(decideTurn(viewFor(options)), decideTurn(viewFor(options)));
  });
});
