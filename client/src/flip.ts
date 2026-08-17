/**
 * The arithmetic a card flight is played by: given where a card ended up and where it came
 * from, the transform that puts it back at the start.
 *
 * This is the "invert" of FLIP, and FLIP is why the animation is right without anything
 * here knowing what a hand or a pile looks like. The card is drawn where it belongs — the
 * layout has already decided that, arcs, gaps, card sizes and all — and then moved back to
 * where it was a moment ago and let go. Nothing re-derives a position the CSS already
 * computed, so a change to how a hand is laid out cannot leave the animation flying to the
 * wrong place (issue #69).
 *
 * Pure and total, like `fan.ts` and `seating.ts` beside it: two boxes in, a transform out.
 * Where the boxes come from is `CardsInFlight.tsx`'s business, and it is the only file that has to
 * touch a DOM to get them.
 */

/**
 * A rectangle on the screen, in viewport coordinates — `DOMRect`'s own shape, so one goes
 * in unchanged, and not `DOMRect` itself, so a test can write one down.
 */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How far back and how much bigger, as a transform waiting to be written out.
 *
 * One scale rather than two: a card is drawn at a fixed proportion wherever it sits
 * (`aspect-ratio` in `styles.css`), so the two axes agree by construction, and a second
 * factor off the height could only ever disagree with the first — squashing the card
 * whenever a box is measured mid-flight rather than at rest.
 */
export interface Inverted {
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
}

/**
 * The transform that carries a card from where it has landed back to where it started.
 *
 * Both boxes are top-left anchored and so is the transform it feeds (`transform-origin` in
 * `styles.css`), which is what makes this a subtraction rather than a matrix: translate the
 * corner onto the old corner, scale about it, and the two boxes coincide.
 *
 * A destination with no width is an element that has not been laid out. It scales by 1 —
 * an Infinity in a transform is a transform a browser discards entirely, which would show
 * the whole flight in a single frame rather than a card that is merely the wrong size.
 */
export function invert(from: Box, to: Box): Inverted {
  return {
    dx: from.left - to.left,
    dy: from.top - to.top,
    scale: to.width === 0 ? 1 : from.width / to.width,
  };
}

/** The same thing as CSS — the starting keyframe of a flight. */
export function transformOf({ dx, dy, scale }: Inverted): string {
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}
