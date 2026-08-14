/**
 * The seating module: which side of the table an opponent is drawn on.
 *
 * Pure and total, like `turn.ts` and `settings.ts` — every case here asserts on a return
 * value, with no browser and no rendering anywhere near it. `seatZones` is the whole of
 * the layout rule the live table and the round-end reveal share, so it is tested at every
 * table size the room allows (2–6 players, i.e. 1–5 opponents) rather than at the four
 * seats the design was drawn for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PLAYERS } from "@yaniv/shared";
import { seatZones } from "../src/seating.ts";

/** Opponents stand in as names — `seatZones` is generic and never looks inside one. */
const opponents = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `opponent-${i + 1}`);

describe("seatZones", () => {
  it("seats nobody at a heads-up table, and still offers all three zones", () => {
    assert.deepEqual(seatZones([]), { left: [], top: [], right: [] });
  });

  it("puts a lone opponent on the left", () => {
    assert.deepEqual(seatZones(opponents(1)), {
      left: ["opponent-1"],
      top: [],
      right: [],
    });
  });

  it("puts the second opponent on top", () => {
    assert.deepEqual(seatZones(opponents(2)), {
      left: ["opponent-1"],
      top: ["opponent-2"],
      right: [],
    });
  });

  it("fills all three zones before doubling any of them", () => {
    assert.deepEqual(seatZones(opponents(3)), {
      left: ["opponent-1"],
      top: ["opponent-2"],
      right: ["opponent-3"],
    });
  });

  it("doubles left first, behind the opponent already sitting there", () => {
    assert.deepEqual(seatZones(opponents(4)), {
      left: ["opponent-1", "opponent-4"],
      top: ["opponent-2"],
      right: ["opponent-3"],
    });
  });

  it("doubles top second, at a full table", () => {
    assert.deepEqual(seatZones(opponents(5)), {
      left: ["opponent-1", "opponent-4"],
      top: ["opponent-2", "opponent-5"],
      right: ["opponent-3"],
    });
  });

  it("never doubles right, since the player cap is what stops it", () => {
    const rightSeats = Array.from(
      { length: MAX_PLAYERS },
      (_, n) => seatZones(opponents(n)).right.length,
    );
    assert.deepEqual(rightSeats, [0, 0, 0, 1, 1, 1]);
  });

  it("zones whatever it is given, since a revealed hand is not a live opponent", () => {
    const hands = [{ playerId: "a" }, { playerId: "b" }];
    assert.deepEqual(seatZones(hands), {
      left: [{ playerId: "a" }],
      top: [{ playerId: "b" }],
      right: [],
    });
  });
});
