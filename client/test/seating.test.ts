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
import { ZONES, revealSeats, seatZones } from "../src/seating.ts";

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

/** A scored player, cut down to the one field `revealSeats` looks at. */
const scored = (id: string) => ({ playerId: id });

describe("revealSeats", () => {
  it("seats nobody from a round with nobody in it", () => {
    assert.deepEqual(revealSeats([], "you"), {
      you: null,
      zones: { left: [], top: [], right: [] },
    });
  });

  it("takes the viewer out of the zones, since their hand is at the bottom of the screen", () => {
    assert.deepEqual(revealSeats([scored("you")], "you"), {
      you: { playerId: "you" },
      zones: { left: [], top: [], right: [] },
    });
  });

  it("deals everybody else round the three sides, in the order the round scored them", () => {
    const players = ["a", "b", "you", "c", "d"].map(scored);
    assert.deepEqual(revealSeats(players, "you"), {
      you: { playerId: "you" },
      zones: {
        left: [{ playerId: "a" }, { playerId: "d" }],
        top: [{ playerId: "b" }],
        right: [{ playerId: "c" }],
      },
    });
  });

  it("seats the whole round when the viewer is not in it, rather than dropping a seat", () => {
    // A round the viewer has no row in is a position the screen should never be reached
    // in — but a missing viewer must not cost somebody else their cards.
    const players = ["a", "b", "c"].map(scored);
    assert.deepEqual(revealSeats(players, "nobody"), {
      you: null,
      zones: {
        left: [{ playerId: "a" }],
        top: [{ playerId: "b" }],
        right: [{ playerId: "c" }],
      },
    });
  });

  it("keeps a departed player's seat, since the round's own record is all it reads", () => {
    // The whole reason this is keyed off `result.players` rather than sorted by `bySeat`:
    // a player who has given up their seat is in no `turnOrder` to be sorted against.
    const seated = revealSeats([scored("you"), scored("gone")], "you");
    assert.deepEqual(seated.zones.left, [{ playerId: "gone" }]);
  });

  it("seats a full table of six", () => {
    const players = ["you", "a", "b", "c", "d", "e"].map(scored);
    const seated = revealSeats(players, "you");
    assert.equal(seated.you?.playerId, "you");
    assert.deepEqual(
      ZONES.flatMap((zone) => seated.zones[zone].map((p) => p.playerId)).sort(),
      ["a", "b", "c", "d", "e"],
    );
  });
});
