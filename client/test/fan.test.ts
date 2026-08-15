/**
 * The fan module: the geometry of an opponent's hand held face down at their seat.
 *
 * Pure and total, like `seating.ts` next to it — the angles and the box they need are
 * numbers, so they are asserted as numbers rather than looked at in a browser. The one
 * property worth more than any single number is the last block here: the box a seat
 * reserves has to contain every card in the fan, because a card tip escaping it is a
 * card tip drawn over the label below (issue #58).
 *
 * Distances are in card widths throughout, the same unit `--card-w` gives the CSS, so
 * nothing here has to know how wide a card is on the screen it lands on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CARD_HEIGHT,
  FAN_MAX_SPREAD_DEG,
  FAN_RADIUS,
  FAN_STEP_DEG,
  ZONE_ROTATION,
  fanAngles,
  fanFootprint,
  fanOverhang,
} from "../src/fan.ts";

/** The four corners of the `i`th card, in card widths, around a hinge at the origin. */
function cardCorners(angleDeg: number): { x: number; y: number }[] {
  const t = (angleDeg * Math.PI) / 180;
  const corners = [];
  for (const x of [-0.5, 0.5]) {
    for (const y of [FAN_RADIUS, FAN_RADIUS + CARD_HEIGHT]) {
      // Clockwise, matching CSS's positive rotation, in a y-up frame.
      corners.push({ x: x * Math.cos(t) + y * Math.sin(t), y: -x * Math.sin(t) + y * Math.cos(t) });
    }
  }
  return corners;
}

/** How far the fan opens, end to end. */
const spread = (angles: number[]) => Math.max(...angles) - Math.min(...angles);

/** Where the fan sits relative to its hinge: zero when it is square on it. */
const lean = (angles: number[]) => Math.max(...angles) + Math.min(...angles);

describe("fanAngles", () => {
  it("fans nothing when there is nothing to fan", () => {
    assert.deepEqual(fanAngles(0), []);
  });

  it("leaves a single card upright, since there is nothing to spread it against", () => {
    assert.deepEqual(fanAngles(1), [0]);
  });

  it("gives one angle per card", () => {
    for (let n = 1; n <= 12; n++) {
      assert.equal(fanAngles(n).length, n, `${n} cards`);
    }
  });

  it("spreads symmetrically about the middle, so the fan sits square on its hinge", () => {
    for (let n = 2; n <= 12; n++) {
      assert.ok(Math.abs(lean(fanAngles(n))) < 1e-9, `${n} cards: ${fanAngles(n)}`);
    }
  });

  it("runs one way round, so cards overlap in the order they are drawn", () => {
    const angles = fanAngles(6);
    const rising = angles.reduce(
      (climbed, angle, i) => climbed && (i === 0 || angle > (angles.at(i - 1) ?? 0)),
      true,
    );
    assert.ok(rising, `${angles}`);
  });

  it("opens a step wider per card while there is room for it", () => {
    assert.ok(Math.abs(spread(fanAngles(3)) - 3 * FAN_STEP_DEG) < 1e-9);
    assert.ok(Math.abs(spread(fanAngles(5)) - 5 * FAN_STEP_DEG) < 1e-9);
  });

  it("stops widening at the cap, so a big hand crowds rather than wrapping round the seat", () => {
    for (const n of [8, 12, 30]) {
      assert.ok(spread(fanAngles(n)) <= FAN_MAX_SPREAD_DEG + 1e-9, `${n} cards`);
    }
    assert.ok(Math.abs(spread(fanAngles(30)) - FAN_MAX_SPREAD_DEG) < 1e-9);
  });
});

describe("ZONE_ROTATION", () => {
  it("turns the top seat's fan upside down, to open toward the felt below it", () => {
    assert.equal(ZONE_ROTATION.top, 180);
  });

  it("mirrors left and right, each opening inward off its own edge", () => {
    assert.equal(ZONE_ROTATION.left + ZONE_ROTATION.right, 0);
    assert.equal(ZONE_ROTATION.left, 90);
  });
});

describe("fanFootprint", () => {
  it("reserves nothing for a seat with no cards", () => {
    assert.deepEqual(fanFootprint(0, "top"), { width: 0, height: 0 });
  });

  it("is one card wide and a card-plus-hinge deep for a single card", () => {
    const box = fanFootprint(1, "top");
    assert.ok(Math.abs(box.width - 1) < 1e-9, `${box.width}`);
    assert.ok(Math.abs(box.height - (FAN_RADIUS + CARD_HEIGHT)) < 1e-9, `${box.height}`);
  });

  it("turns on its side for the seats whose fans are turned on their side", () => {
    for (const n of [1, 5, 7]) {
      const top = fanFootprint(n, "top");
      assert.deepEqual(fanFootprint(n, "left"), { width: top.height, height: top.width });
      assert.deepEqual(fanFootprint(n, "right"), { width: top.height, height: top.width });
    }
  });

  it("grows wider as a hand grows, and never narrower", () => {
    let previous = 0;
    for (let n = 1; n <= 12; n++) {
      const { width } = fanFootprint(n, "top");
      assert.ok(width >= previous, `${n} cards: ${width} after ${previous}`);
      previous = width;
    }
  });

  it("contains every corner of every card, so no tip is drawn outside its own seat", () => {
    for (let n = 1; n <= 12; n++) {
      const box = fanFootprint(n, "top");
      for (const angle of fanAngles(n)) {
        for (const corner of cardCorners(angle)) {
          assert.ok(
            Math.abs(corner.x) <= box.width / 2 + 1e-9,
            `${n} cards, ${angle}deg: x ${corner.x} outside ${box.width}`,
          );
          assert.ok(
            corner.y >= -1e-9 && corner.y <= box.height + 1e-9,
            `${n} cards, ${angle}deg: y ${corner.y} outside ${box.height}`,
          );
        }
      }
    }
  });

  it("stays inside the arc's reach, so a seat reserves no space it could not use", () => {
    // No card can be further from the hinge than its own far corner, whatever it is
    // turned by — so neither side of the box can exceed that reach either side of it.
    const reach = Math.hypot(0.5, FAN_RADIUS + CARD_HEIGHT);
    for (let n = 1; n <= 12; n++) {
      const box = fanFootprint(n, "top");
      assert.ok(box.width / 2 <= reach + 1e-9, `${n} cards: ${box.width} wide`);
      assert.ok(box.height <= reach + 1e-9, `${n} cards: ${box.height} deep`);
    }
  });
});

describe("fanOverhang", () => {
  it("pushes nothing off the edge for a seat with no cards", () => {
    assert.equal(fanOverhang(0), 0);
  });

  it("leaves most of the fan on screen, and still pushes a real part of it off", () => {
    for (let n = 1; n <= 12; n++) {
      // The fan's depth, which a seat turned on its side wears as its width.
      const depth = fanFootprint(n, "top").height;
      const shown = depth - fanOverhang(n);
      // More than half showing — a fan cut back to its tips read as too little of a hand
      // to watch (issue #58) — but never the whole of it, or five seats' worth would not
      // fit round a phone's felt at all.
      assert.ok(shown > depth / 2, `${n} cards: only ${shown} of ${depth} on screen`);
      assert.ok(shown < depth * 0.75, `${n} cards: ${shown} of ${depth} on screen`);
    }
  });

  it("barely moves as a hand does, so a seat's cards do not slide about as cards leave it", () => {
    // A fan deepens hardly at all with more cards — it widens — so the push off the edge
    // is near enough the same at every hand size, which is what stops a seat shifting
    // outward on a discard and back on a pickup.
    const pushes = Array.from({ length: 7 }, (_, i) => fanOverhang(i + 1));
    const drift = Math.max(...pushes) - Math.min(...pushes);
    assert.ok(drift < 0.1, `${drift} card widths across ${pushes}`);
  });
});
