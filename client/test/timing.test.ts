import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { FLIGHT_MS, SHAKE_MS, SLAP_MS } from "../src/timing.ts";
import { PACE_MS } from "../src/pacing.ts";

/*
 * The one thing worth asserting about a set of durations: that each is still a fraction of
 * the one above it. Nothing here checks a number — a tuned value is a judgement and not a
 * fact — but a constant that stopped being derived would go unnoticed until somebody changed
 * the beat and only half the table sped up (issue #95).
 */
describe("the timing chain", () => {
  it("keeps a flight comfortably inside the beat a position is drawn on", () => {
    assert.ok(FLIGHT_MS * 2 < PACE_MS);
  });

  it("makes a slapdown sharper than an ordinary discard", () => {
    assert.ok(SLAP_MS < FLIGHT_MS);
  });

  it("derives the slap from the flight", () => {
    assert.equal(SLAP_MS, FLIGHT_MS / 2);
  });

  it("derives the shake from the slap, and keeps it the shorter of the two", () => {
    assert.equal(SHAKE_MS, (SLAP_MS * 2) / 3);
    assert.ok(SHAKE_MS < SLAP_MS);
  });

  it("has the whole chain move when the flight does", () => {
    // The derivations above written out once more as ratios of the top of the chain, so a
    // constant quietly pinned to a number of its own fails here as well as in its own test.
    assert.equal(SLAP_MS / FLIGHT_MS, 0.5);
    assert.equal(SHAKE_MS / FLIGHT_MS, 1 / 3);
  });
});
