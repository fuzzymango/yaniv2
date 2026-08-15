/**
 * The arithmetic behind a card flight: the step that takes a card sitting where it landed
 * and says where it came from.
 *
 * The one part of the animation with a right answer, so the one part asserted here. Where
 * the boxes come from is a browser's business — the module takes two boxes and knows
 * nothing else — which is what makes it testable at all under `node:test`, with no DOM
 * anywhere near it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Box } from "../src/flip.ts";
import { invert, transformOf } from "../src/flip.ts";

/** A card-shaped box: 50 wide, 70 tall, the proportion `styles.css` draws every card at. */
const box = (left: number, top: number, width = 50): Box => ({
  left,
  top,
  width,
  height: width * 1.4,
});

describe("invert", () => {
  it("asks for nothing where a card landed where it already was", () => {
    assert.deepEqual(invert(box(10, 20), box(10, 20)), { dx: 0, dy: 0, scale: 1 });
  });

  it("moves the landed card back to where it came from", () => {
    const inverted = invert(box(10, 300), box(120, 40));

    assert.deepEqual(inverted, { dx: -110, dy: 260, scale: 1 });
  });

  it("scales the landed card back up to the size it left at", () => {
    // A hand card is drawn wider than one on the felt, so a discard shrinks as it lands.
    const { scale } = invert(box(0, 0, 60), box(0, 0, 40));

    assert.equal(scale, 1.5);
  });

  it("scales both axes together, whatever the boxes say", () => {
    // A card keeps its proportion wherever it is drawn (`aspect-ratio` in `styles.css`), so
    // there is one scale and it comes off the width. A box measured mid-animation can be
    // any shape at all, and a second scale off its height would squash the card to match.
    const { scale } = invert({ left: 0, top: 0, width: 60, height: 999 }, box(0, 0, 30));

    assert.equal(scale, 2);
  });

  it("asks for no scaling where there is nothing to scale against", () => {
    // A box with no width is an element that has not been laid out. Dividing by it would
    // put an Infinity in a transform, which a browser drops on the floor along with the
    // rest of the property — so the card would jump the whole flight in one frame.
    assert.equal(invert(box(0, 0, 50), box(0, 0, 0)).scale, 1);
    assert.equal(invert(box(0, 0, 0), box(0, 0, 50)).scale, 0);
  });
});

describe("transformOf", () => {
  it("writes the move and the size as one transform", () => {
    assert.equal(
      transformOf({ dx: -110, dy: 260, scale: 1.5 }),
      "translate(-110px, 260px) scale(1.5)",
    );
  });

  it("writes a card that has not moved as a transform all the same", () => {
    // The starting keyframe of a flight that begins where it ends is still a keyframe: the
    // animation is between two transforms, and one of them being the identity is not a
    // reason for the string to be a different shape.
    assert.equal(transformOf({ dx: 0, dy: 0, scale: 1 }), "translate(0px, 0px) scale(1)");
  });
});
