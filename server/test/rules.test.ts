import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RANKS } from "@yaniv/shared";
import {
  canCallYaniv,
  canonicalizeSet,
  handValue,
  isValidSet,
  legalDiscards,
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

    it("rejects a run whose gap is wider than the jokers can cover", () => {
      // 5..9 needs three fillers, only one joker supplied.
      assert.equal(isValidSet(cards("hearts-5", "hearts-9", "joker-1")), false);
    });
  });

  describe("runs with wild jokers", () => {
    it("lets a joker fill an interior gap", () => {
      assert.equal(isValidSet(cards("hearts-4", "joker-1", "hearts-6")), true);
    });

    it("lets a joker extend a run at either end", () => {
      assert.equal(isValidSet(cards("hearts-7", "hearts-8", "joker-1")), true);
      assert.equal(isValidSet(cards("joker-1", "hearts-7", "hearts-8")), true);
    });

    it("accepts a joker alongside two already-consecutive cards", () => {
      assert.equal(isValidSet(cards("hearts-10", "joker-1", "hearts-J")), true);
    });

    it("lets both jokers fill two separate gaps", () => {
      assert.equal(
        isValidSet(cards("hearts-5", "hearts-8", "joker-1", "joker-2")),
        true,
      );
    });

    it("ignores the joker's lack of suit when checking the suit match", () => {
      assert.equal(isValidSet(cards("hearts-7", "spades-8", "joker-1")), false);
    });

    it("still refuses to wrap past the king", () => {
      assert.equal(isValidSet(cards("hearts-A", "hearts-K", "joker-1")), false);
      assert.equal(
        isValidSet(cards("hearts-Q", "hearts-K", "joker-1", "hearts-A")),
        false,
      );
    });

    it("requires two real cards to anchor the run", () => {
      assert.equal(isValidSet(cards("joker-1", "joker-2", "hearts-5")), false);
    });

    it("does not make a joker wild in a same-rank set", () => {
      assert.equal(isValidSet(cards("hearts-7", "spades-7", "joker-1")), false);
    });

    it("still rejects a joker with a single card, which is too short for a run", () => {
      assert.equal(isValidSet(cards("joker-1", "hearts-K")), false);
    });

    it("accepts a run of jokers plus reals at full hand size", () => {
      assert.equal(
        isValidSet(cards("hearts-4", "joker-1", "hearts-6", "joker-2", "hearts-8")),
        true,
      );
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

  describe("placing wild jokers", () => {
    it("seats a joker in the interior gap it fills", () => {
      const result = canonicalizeSet(cards("hearts-9", "joker-1", "hearts-7"));
      assert.deepEqual(ids(result), ["hearts-7", "joker-1", "hearts-9"]);
    });

    it("seats both jokers in the two gaps they fill", () => {
      const result = canonicalizeSet(
        cards("hearts-8", "joker-1", "hearts-5", "joker-2"),
      );
      assert.deepEqual(ids(result), [
        "hearts-5",
        "joker-1",
        "joker-2",
        "hearts-8",
      ]);
    });

    it("extends upwards when the player laid the joker after their cards", () => {
      const result = canonicalizeSet(cards("hearts-7", "hearts-8", "joker-1"));
      assert.deepEqual(ids(result), ["hearts-7", "hearts-8", "joker-1"]);
    });

    it("extends downwards when the player laid the joker first", () => {
      const result = canonicalizeSet(cards("joker-1", "hearts-7", "hearts-8"));
      assert.deepEqual(ids(result), ["joker-1", "hearts-7", "hearts-8"]);
    });

    it("puts one joker at each end when the player laid one on each side", () => {
      const result = canonicalizeSet(
        cards("joker-1", "hearts-7", "hearts-8", "joker-2"),
      );
      assert.deepEqual(ids(result), [
        "joker-1",
        "hearts-7",
        "hearts-8",
        "joker-2",
      ]);
    });

    it("forces a joker low when there is no rank above the king", () => {
      const result = canonicalizeSet(cards("hearts-Q", "hearts-K", "joker-1"));
      assert.deepEqual(ids(result), ["joker-1", "hearts-Q", "hearts-K"]);
    });

    it("forces a joker high when there is no rank below the ace", () => {
      const result = canonicalizeSet(cards("joker-1", "hearts-A", "hearts-2"));
      assert.deepEqual(ids(result), ["hearts-A", "hearts-2", "joker-1"]);
    });

    it("keeps a joker pair in submitted order, since it is not a run", () => {
      assert.deepEqual(ids(canonicalizeSet(cards("joker-2", "joker-1"))), [
        "joker-2",
        "joker-1",
      ]);
    });

    it("returns every submitted card exactly once", () => {
      const input = cards("joker-1", "hearts-7", "hearts-8", "joker-2");
      const result = canonicalizeSet(input);
      assert.equal(result.length, input.length);
      assert.deepEqual([...ids(result)].sort(), [...ids(input)].sort());
    });
  });
});

describe("canonicalizeSet — exhaustive run layout check", () => {
  /** Every combination of `size` cards from `pool`. */
  function* combinations<T>(pool: readonly T[], size: number): Generator<T[]> {
    if (size === 0) return yield [];
    for (let i = 0; i <= pool.length - size; i++) {
      for (const rest of combinations(pool.slice(i + 1), size - 1)) {
        yield [pool[i]!, ...rest];
      }
    }
  }

  it("lays out every legal run in the deck without losing or moving a card", () => {
    const pool = cards(
      ...RANKS.map((r) => `hearts-${r}`),
      "spades-5",
      "spades-6",
      "spades-7",
      "joker-1",
      "joker-2",
    );

    let runsChecked = 0;
    for (const size of [3, 4, 5]) {
      for (const combo of combinations(pool, size)) {
        if (!isValidSet(combo)) continue;
        const laid = canonicalizeSet(combo);
        const label = ids(combo).join(",");

        assert.equal(laid.length, combo.length, `length changed for ${label}`);
        assert.ok(
          laid.every((c) => c !== undefined),
          `undefined slot in ${label}`,
        );
        assert.deepEqual(
          [...ids(laid)].sort(),
          [...ids(combo)].sort(),
          `cards changed for ${label}`,
        );

        // Same-rank sets are left alone; only runs get laid out.
        const reals = laid.filter((c) => c.suit !== null);
        if (reals.length < 2) continue;
        const firstRealIndex = laid.findIndex((c) => c.suit !== null);
        const firstRank = rankOrder(laid[firstRealIndex]!.rank);
        if (firstRank === null) continue;
        if (reals.every((c) => c.rank === reals[0]!.rank)) continue;

        // Each real card must sit exactly as far along as its rank implies, which
        // means the jokers occupy precisely the missing positions.
        laid.forEach((card, index) => {
          if (card.suit === null) return;
          assert.equal(
            rankOrder(card.rank)! - firstRank,
            index - firstRealIndex,
            `${label} laid out as ${ids(laid).join(",")} is not consecutive`,
          );
        });

        // The implied run must fit inside the deck at both ends.
        const start = firstRank - firstRealIndex;
        assert.ok(start >= 0, `${label} runs below the ace`);
        assert.ok(
          start + laid.length - 1 <= RANKS.length - 1,
          `${label} runs above the king`,
        );
        runsChecked++;
      }
    }

    assert.ok(runsChecked > 200, `expected many runs, only checked ${runsChecked}`);
  });
});

describe("legalDiscards", () => {
  it("offers nothing from an empty hand", () => {
    assert.deepEqual(legalDiscards([]), []);
  });

  it("offers the single card of a one-card hand", () => {
    const options = legalDiscards(cards("hearts-7"));
    assert.equal(options.length, 1);
    assert.deepEqual(ids(options[0]!), ["hearts-7"]);
  });

  it("offers every card individually plus any combinations", () => {
    // 5♥ 5♠ K♦: three singles plus the pair.
    const options = legalDiscards(cards("hearts-5", "spades-5", "diamonds-K"));
    const rendered = options.map((o) => ids(o).join("+")).sort();
    assert.deepEqual(rendered, [
      "diamonds-K",
      "hearts-5",
      "hearts-5+spades-5",
      "spades-5",
    ]);
  });

  it("finds runs, including ones a joker completes", () => {
    const options = legalDiscards(cards("hearts-7", "hearts-8", "joker-1"));
    const rendered = options.map((o) => ids(o).join("+"));
    assert.ok(rendered.includes("hearts-7+hearts-8+joker-1"));
  });

  it("never offers an illegal combination", () => {
    const hand = cards("hearts-7", "spades-8", "diamonds-2", "clubs-K", "joker-1");
    for (const option of legalDiscards(hand)) {
      assert.ok(isValidSet(option), `offered an invalid set: ${ids(option).join("+")}`);
    }
  });

  it("always gives a non-empty hand at least one option", () => {
    const hand = cards("hearts-7", "spades-2", "diamonds-K", "clubs-4", "joker-1");
    for (let size = 1; size <= hand.length; size++) {
      assert.ok(legalDiscards(hand.slice(0, size)).length > 0, `empty at size ${size}`);
    }
  });
});

describe("canCallYaniv", () => {
  it("permits a hand at or below the threshold", () => {
    assert.equal(canCallYaniv(cards("hearts-5", "spades-2")), true);
    assert.equal(canCallYaniv(cards("hearts-A")), true);
    assert.equal(canCallYaniv([]), true);
  });

  it("refuses a hand above the threshold", () => {
    assert.equal(canCallYaniv(cards("hearts-5", "spades-3")), false);
    assert.equal(canCallYaniv(cards("hearts-K")), false);
  });

  it("counts jokers as free", () => {
    assert.equal(canCallYaniv(cards("joker-1", "joker-2", "hearts-7")), true);
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
