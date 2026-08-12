/**
 * The turn module: what a tap means.
 *
 * The browser's counterpart to `server/scripts/cli/commands.test.ts` — a selection and a
 * tapped source in, a `TurnAction` or nothing out. Pure and total, so every case below
 * asserts on a return value and none of them expects a throw: nonsense is the normal
 * case for a finger on a phone, not an exceptional one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { YANIV_THRESHOLD, canCallYaniv, handValue, pickupCandidates } from "@yaniv/shared";
import {
  isLegalCall,
  isLegalSelection,
  isSlapdownTarget,
  retainSelection,
  takeableIds,
  toggleSelection,
  turnFrom,
} from "../src/turn.ts";
import { cards, ids, viewOf } from "./helpers.ts";

const HAND = cards("hearts-7", "hearts-8", "hearts-9", "spades-7", "joker-1");

describe("toggleSelection", () => {
  it("adds a tapped card to the end, so tap order is submit order", () => {
    assert.deepEqual(toggleSelection(["hearts-9"], "hearts-7"), ["hearts-9", "hearts-7"]);
  });

  it("removes a card tapped a second time, leaving the rest in order", () => {
    assert.deepEqual(
      toggleSelection(["hearts-9", "hearts-7", "spades-7"], "hearts-7"),
      ["hearts-9", "spades-7"],
    );
  });

  it("starts a selection from nothing", () => {
    assert.deepEqual(toggleSelection([], "joker-1"), ["joker-1"]);
  });
});

describe("retainSelection", () => {
  it("keeps the cards still in hand, in the order they were tapped", () => {
    assert.deepEqual(
      retainSelection(["hearts-9", "hearts-7"], HAND),
      ["hearts-9", "hearts-7"],
    );
  });

  it("drops a card that has left the hand", () => {
    const afterDiscarding = cards("hearts-8", "spades-7", "joker-1");
    assert.deepEqual(retainSelection(["hearts-9", "hearts-8"], afterDiscarding), [
      "hearts-8",
    ]);
  });

  it("empties a selection whose cards have all gone", () => {
    assert.deepEqual(retainSelection(["hearts-9", "hearts-7"], cards("clubs-2")), []);
  });
});

describe("isLegalSelection", () => {
  it("offers nothing for an empty selection", () => {
    assert.equal(isLegalSelection([], HAND), false);
  });

  it("accepts a single card", () => {
    assert.equal(isLegalSelection(["hearts-9"], HAND), true);
  });

  it("accepts a pair of the same rank", () => {
    assert.equal(isLegalSelection(["hearts-7", "spades-7"], HAND), true);
  });

  it("accepts a same-suit run", () => {
    assert.equal(isLegalSelection(["hearts-7", "hearts-8", "hearts-9"], HAND), true);
  });

  it("rejects two unrelated cards", () => {
    assert.equal(isLegalSelection(["hearts-8", "spades-7"], HAND), false);
  });

  it("rejects a card that is not in the hand", () => {
    assert.equal(isLegalSelection(["clubs-K"], HAND), false);
  });

  it("rejects the same card twice", () => {
    // Tapping cannot produce this, but the module is total: a repeated id would read
    // as a pair of equal ranks and be sent as a legal discard the server then refuses.
    assert.equal(isLegalSelection(["hearts-7", "hearts-7"], HAND), false);
  });
});

describe("isLegalCall", () => {
  it("offers the call on a hand worth exactly the threshold", () => {
    const hand = cards("hearts-4", "spades-3");
    assert.equal(handValue(hand), YANIV_THRESHOLD, "the boundary, not near it");
    assert.equal(isLegalCall(hand), true);
  });

  it("offers the call on a hand under the threshold", () => {
    assert.equal(isLegalCall(cards("joker-1", "clubs-A")), true);
  });

  it("withholds it on a hand one point over", () => {
    const hand = cards("hearts-4", "spades-4");
    assert.equal(handValue(hand), YANIV_THRESHOLD + 1);
    assert.equal(isLegalCall(hand), false);
  });

  it("withholds it on a freshly dealt hand", () => {
    assert.equal(isLegalCall(HAND), false);
  });

  it("answers exactly what the rulebook does, so the control is never one the server refuses", () => {
    for (const hand of [HAND, cards("hearts-4", "spades-3"), cards("joker-1")]) {
      assert.equal(isLegalCall(hand), canCallYaniv(hand));
    }
  });
});

describe("takeableIds", () => {
  it("offers both ends of a multi-card discard and neither middle", () => {
    const discard = cards("clubs-4", "clubs-5", "clubs-6", "clubs-7");
    assert.deepEqual([...takeableIds(discard)].sort(), ["clubs-4", "clubs-7"]);
  });

  it("offers the one card of a single-card discard once", () => {
    assert.deepEqual([...takeableIds(cards("clubs-4"))], ["clubs-4"]);
  });

  it("offers nothing when nothing is face up", () => {
    assert.deepEqual([...takeableIds([])], []);
  });

  it("offers exactly what the rulebook does, never a pickup the server would refuse", () => {
    const discard = cards("clubs-4", "clubs-5", "clubs-6");
    assert.deepEqual([...takeableIds(discard)], ids(pickupCandidates(discard)));
  });
});

/**
 * The one target on this screen that is not a card: the pile as a whole, tapped to put
 * the just-drawn card straight back on it (docs/rules.md §9).
 *
 * Unlike every other question in this module it is not asked of the rulebook — the
 * cards a window is open over are the server's alone, and `slapdownEligible` is its
 * answer. What is left here is that the screen and the session ask it in one place, so
 * a pile that flashes and a tap that sends cannot come apart.
 */
describe("isSlapdownTarget", () => {
  it("offers the pile while a window of the viewer's own is open", () => {
    const view = viewOf(HAND, cards("clubs-4"), { slapdownEligible: true });
    assert.equal(isSlapdownTarget(view.you), true);
  });

  it("offers nothing when there is no window", () => {
    assert.equal(isSlapdownTarget(viewOf(HAND, cards("clubs-4")).you), false);
  });

  /**
   * A window belongs to the player *before* the current one, so the turn having moved on
   * is the normal case and never a reason to withhold the target. This is the one place
   * that could plausibly have grown a turn check, and must not.
   */
  it("offers it off turn, which is the only time it is ever open", () => {
    const view = viewOf(HAND, cards("clubs-4"), {
      slapdownEligible: true,
      currentTurnPlayerId: "p2",
    });
    assert.equal(isSlapdownTarget(view.you), true);
  });
});

describe("turnFrom", () => {
  const view = viewOf(HAND, cards("clubs-4", "clubs-5", "clubs-6"));

  it("preserves tap order into discardCardIds", () => {
    // The same three cards in the order they were tapped, not in rank order: a joker
    // extending a run takes its position from where the player put it (docs/rules.md §4).
    const action = turnFrom(["hearts-9", "hearts-8", "hearts-7"], view, { kind: "deck" });
    assert.deepEqual(action?.discardCardIds, ["hearts-9", "hearts-8", "hearts-7"]);
  });

  it("draws from the deck when the deck was tapped", () => {
    const action = turnFrom(["hearts-9"], view, { kind: "deck" });
    assert.deepEqual(action?.draw, { source: "deck" });
  });

  it("draws the tapped face-up card when it is an end of the discard", () => {
    const action = turnFrom(["hearts-9"], view, { kind: "discard", cardId: "clubs-6" });
    assert.deepEqual(action?.draw, { source: "discard", cardId: "clubs-6" });
  });

  it("offers no turn for a buried middle card", () => {
    assert.equal(turnFrom(["hearts-9"], view, { kind: "discard", cardId: "clubs-5" }), null);
  });

  it("offers no turn for a card that is not on the table at all", () => {
    assert.equal(turnFrom(["hearts-9"], view, { kind: "discard", cardId: "spades-2" }), null);
  });

  it("offers no turn for an illegal selection, whichever source is tapped", () => {
    const selection = ["hearts-8", "spades-7"];
    assert.equal(turnFrom(selection, view, { kind: "deck" }), null);
    assert.equal(turnFrom(selection, view, { kind: "discard", cardId: "clubs-6" }), null);
  });

  it("offers no turn for an empty selection", () => {
    assert.equal(turnFrom([], view, { kind: "deck" }), null);
  });

  it("offers no turn for a card that is not in the hand", () => {
    assert.equal(turnFrom(["clubs-K"], view, { kind: "deck" }), null);
  });

  it("offers no pickup when nothing is face up", () => {
    const bare = viewOf(HAND, []);
    assert.equal(turnFrom(["hearts-9"], bare, { kind: "discard", cardId: "clubs-6" }), null);
    // The deck is still there, so the turn itself is not what was refused.
    assert.notEqual(turnFrom(["hearts-9"], bare, { kind: "deck" }), null);
  });
});
