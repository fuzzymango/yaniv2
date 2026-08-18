/**
 * The score module: what a seat's label says once a round has been scored.
 *
 * Pure and total, like `fan.ts` and `seating.ts` beside it — a string in, asserted as a
 * string. The one property worth more than any single case is the sign: a round that added
 * nothing has to read as a round, not as a second copy of the total (issue #78).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreLabel } from "../src/score.ts";

describe("scoreLabel", () => {
  it("leads with the total, since that is what says where a player stands", () => {
    assert.ok(scoreLabel(32, 21).startsWith("32"));
  });

  it("says what the round added, alongside the total it made", () => {
    assert.equal(scoreLabel(32, 21), "32 pts (+21)");
  });

  it("signs a round that added nothing, so it cannot be read as a second total", () => {
    assert.equal(scoreLabel(32, 0), "32 pts (+0)");
    assert.notEqual(scoreLabel(0, 0), "0 pts (0)");
  });

  it("carries a negative round's own sign rather than adding one", () => {
    assert.equal(scoreLabel(18, -12), "18 pts (-12)");
  });

  it("says the same thing about the same round wherever it is read", () => {
    // One function for every seat's label and for the viewer's own footer, so a player
    // cannot be told two different things about one round depending on where they sit.
    const rounds: [number, number][] = [
      [0, 0],
      [7, 7],
      [104, 30],
      [50, -50],
    ];
    for (const [score, delta] of rounds) {
      assert.equal(scoreLabel(score, delta), scoreLabel(score, delta));
      assert.ok(scoreLabel(score, delta).includes(`${score}`));
    }
  });
});
