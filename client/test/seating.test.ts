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
import type { PlayerGameView } from "@yaniv/shared";
import { MAX_PLAYERS } from "@yaniv/shared";
import { ZONES, byRelativeSeat, seatZones } from "../src/seating.ts";

/** Opponents stand in as names — `seatZones` is generic and never looks inside one. */
const opponents = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `opponent-${i + 1}`);

describe("ZONES", () => {
  it("lists every zone a seating can come back with, and nothing else", () => {
    assert.deepEqual([...ZONES].sort(), Object.keys(seatZones([])).sort());
  });
});

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

describe("byRelativeSeat", () => {
  /** Only `turnOrder` and `you.id` are read — the rest of a view is never looked at. */
  const view = (turnOrder: string[], youId: string): PlayerGameView =>
    ({ turnOrder, you: { id: youId } }) as PlayerGameView;

  const seat = (id: string) => ({ id });

  it("orders a single opponent trivially", () => {
    const opponents = [seat("p2")];
    assert.deepEqual(
      [...opponents].sort(byRelativeSeat(view(["p1", "p2"], "p1"))).map((o) => o.id),
      ["p2"],
    );
  });

  it("starts from the next player to act after the viewer, wrapping round", () => {
    const turnOrder = ["p1", "p2", "p3", "p4"];
    const opponents = [seat("p4"), seat("p2"), seat("p3")];
    assert.deepEqual(
      [...opponents].sort(byRelativeSeat(view(turnOrder, "p1"))).map((o) => o.id),
      ["p2", "p3", "p4"],
    );
  });

  it("wraps the order when the viewer is not first in turnOrder", () => {
    const turnOrder = ["p1", "p2", "p3", "p4"];
    const opponents = [seat("p1"), seat("p2"), seat("p4")];
    assert.deepEqual(
      [...opponents].sort(byRelativeSeat(view(turnOrder, "p3"))).map((o) => o.id),
      ["p4", "p1", "p2"],
    );
  });

  it("orders a full six-seat room relative to the viewer", () => {
    const turnOrder = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const opponents = ["p6", "p1", "p4", "p2", "p5"].map(seat);
    assert.deepEqual(
      [...opponents].sort(byRelativeSeat(view(turnOrder, "p3"))).map((o) => o.id),
      ["p4", "p5", "p6", "p1", "p2"],
    );
  });

  it("sorts relative to the viewer whichever seat in turnOrder they hold", () => {
    const turnOrder = ["p1", "p2", "p3", "p4", "p5"];
    for (const [i, youId] of turnOrder.entries()) {
      const opponents = turnOrder.filter((id) => id !== youId).map(seat);
      const expected = [...turnOrder.slice(i + 1), ...turnOrder.slice(0, i)];
      assert.deepEqual(
        [...opponents].sort(byRelativeSeat(view(turnOrder, youId))).map((o) => o.id),
        expected,
      );
    }
  });
});
