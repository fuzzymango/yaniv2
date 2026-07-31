import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeSet,
  handValue,
  isValidSet,
  pickupCandidates,
  rankOrder,
} from "../src/rules.ts";
import { cards, ids } from "./helpers.ts";

describe("handValue", () => {
  it("sums card values", () => {
    assert.equal(handValue(cards("hearts-A", "hearts-5", "spades-K")), 16);
  });

  it("counts an empty hand as zero", () => {
    assert.equal(handValue([]), 0);
  });

  it("counts jokers as zero", () => {
    assert.equal(handValue(cards("joker-1", "joker-2", "clubs-3")), 3);
  });
});

describe("rankOrder", () => {
  it("orders ace low and king high", () => {
    assert.equal(rankOrder("A"), 0);
    assert.equal(rankOrder("K"), 12);
  });

  it("has no ordering for jokers", () => {
    assert.equal(rankOrder("Joker"), null);
  });
});

describe("isValidSet", () => {
  it("rejects an empty discard", () => {
    assert.equal(isValidSet([]), false);
  });

  it("accepts any single card", () => {
    assert.equal(isValidSet(cards("hearts-7")), true);
    assert.equal(isValidSet(cards("joker-1")), true);
  });

  describe("same-rank sets", () => {
    it("accepts a pair", () => {
      assert.equal(isValidSet(cards("hearts-7", "spades-7")), true);
    });

    it("accepts four of a kind", () => {
      assert.equal(
        isValidSet(cards("hearts-7", "spades-7", "clubs-7", "diamonds-7")),
        true,
      );
    });

    it("rejects mismatched ranks", () => {
      assert.equal(isValidSet(cards("hearts-7", "spades-8")), false);
    });

    it("accepts two jokers as a pair", () => {
      assert.equal(isValidSet(cards("joker-1", "joker-2")), true);
    });

    it("rejects a joker paired with a real card", () => {
      assert.equal(isValidSet(cards("joker-1", "hearts-K")), false);
    });
  });

  describe("runs", () => {
    it("accepts three consecutive cards of one suit", () => {
      assert.equal(isValidSet(cards("hearts-4", "hearts-5", "hearts-6")), true);
    });

    it("accepts a run given out of order", () => {
      assert.equal(isValidSet(cards("hearts-6", "hearts-4", "hearts-5")), true);
    });

    it("rejects a two-card run", () => {
      assert.equal(isValidSet(cards("hearts-4", "hearts-5")), false);
    });

    it("rejects mixed suits", () => {
      assert.equal(isValidSet(cards("hearts-4", "spades-5", "hearts-6")), false);
    });

    it("rejects non-consecutive ranks", () => {
      assert.equal(isValidSet(cards("hearts-4", "hearts-5", "hearts-7")), false);
    });

    it("accepts an ace-low run", () => {
      assert.equal(isValidSet(cards("clubs-A", "clubs-2", "clubs-3")), true);
    });

    it("rejects a run wrapping past the king", () => {
      assert.equal(isValidSet(cards("clubs-Q", "clubs-K", "clubs-A")), false);
    });

    it("rejects a joker inside a run, since jokers are not wild", () => {
      assert.equal(isValidSet(cards("hearts-4", "joker-1", "hearts-6")), false);
    });
  });
});

describe("canonicalizeSet", () => {
  it("sorts a run into ascending order so the ends are unambiguous", () => {
    const result = canonicalizeSet(cards("hearts-6", "hearts-4", "hearts-5"));
    assert.deepEqual(ids(result), ["hearts-4", "hearts-5", "hearts-6"]);
  });

  it("places an ace at the low end of a run", () => {
    const result = canonicalizeSet(cards("clubs-3", "clubs-A", "clubs-2"));
    assert.deepEqual(ids(result), ["clubs-A", "clubs-2", "clubs-3"]);
  });

  it("preserves the submitted order of a same-rank set", () => {
    const result = canonicalizeSet(cards("spades-7", "hearts-7", "clubs-7"));
    assert.deepEqual(ids(result), ["spades-7", "hearts-7", "clubs-7"]);
  });

  it("does not mutate its input", () => {
    const input = cards("hearts-6", "hearts-4", "hearts-5");
    canonicalizeSet(input);
    assert.deepEqual(ids(input), ["hearts-6", "hearts-4", "hearts-5"]);
  });
});

describe("pickupCandidates", () => {
  it("offers nothing from an empty pile", () => {
    assert.deepEqual(pickupCandidates([]), []);
  });

  it("offers the only card of a single-card discard", () => {
    assert.deepEqual(ids(pickupCandidates(cards("hearts-9"))), ["hearts-9"]);
  });

  it("offers only the two ends of a longer set", () => {
    const discard = cards("hearts-4", "hearts-5", "hearts-6", "hearts-7");
    assert.deepEqual(ids(pickupCandidates(discard)), ["hearts-4", "hearts-7"]);
  });
});
