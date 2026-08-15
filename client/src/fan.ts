/**
 * The shape of a hand held at a seat: how far each card is turned, which way the whole
 * fan faces, and how much room it takes up.
 *
 * Geometry only — nothing here knows what a card is, whose hand it is, or whether it is
 * face up. It answers three questions the seat layout cannot ask CSS: how a fan spreads,
 * which way it points from each zone, and what box it needs. `seating.ts` says *where* an
 * opponent sits; this says what their cards look like sitting there.
 *
 * **Two shapes, not one.** A hand in play is the arc (`fanAngles` and below), and a hand
 * revealed at the end of a round is a straight cascade (`cascadeOffset` and below). Both
 * are hands at seats and both answer the same three questions, which is why they are here
 * together; they differ because a fan of backs is a *gesture* at a hand and a revealed one
 * has to be read card by card, and an arc overlaps faces in a way that is hard to scan
 * (issue #56's variant D verdict, issue #60).
 *
 * **Every distance is in card widths**, the unit `--card-w` already gives the stylesheet,
 * so a fan scales with the cards inside it and this module never learns a pixel. Angles
 * are degrees, clockwise, the way CSS `rotate()` reads them.
 *
 * The fan is a rigid rotation about its **hinge** — the point the cards' inner edges are
 * gathered at. `ZONE_ROTATION` turns that whole assembly so the hinge sits toward the
 * screen edge and the open, spread edge arcs toward the felt, which is the orientation
 * the prototype settled on (issue #56, variant D). A seat's label is not part of the
 * assembly and never turns with it: it is read from where the local player is sitting,
 * whichever edge the cards are against.
 */

import type { Zone } from "./seating.ts";

/** How much wider the fan opens per card, while it is still under the cap. */
export const FAN_STEP_DEG = 11;

/**
 * As wide as a fan ever opens. Past this the cards crowd together instead, because a fan
 * that kept widening would eventually curl round the seat and hide its own label — and a
 * hand only ever grows by one card a turn, so the crowding is gradual.
 */
export const FAN_MAX_SPREAD_DEG = 70;

/** How far a card's inner edge sits from the hinge — the hole in the middle of the arc. */
export const FAN_RADIUS = 0.6;

/**
 * What fraction of a fan is pushed off its screen edge — so a bit over a third of it is
 * hidden, and the rest, the part nearest the felt, is on screen.
 *
 * Five seats' worth of full fans do not fit round a phone's felt, and shrinking them to
 * make them fit is what made the prototype's small variant read as cramped (issue #56).
 * A hand held at a real table is part-hidden by whoever is holding it, so a player never
 * sees all of it anyway, and the count it carries is said in words on the label regardless.
 *
 * The fraction is flat, at every hand size and every viewport: cutting a fan back to its
 * tips left too little of a hand to watch (issue #58), and the cost of the wider fan is
 * that six players on a narrow phone sit close — verified clear, but not by much, and
 * deliberately not engineered around with per-count or per-width scaling.
 */
export const FAN_HIDDEN = 0.37;

/** How tall a card is, from the `aspect-ratio: 5 / 7` the stylesheet draws it at. */
export const CARD_HEIGHT = 7 / 5;

/**
 * The strip of a card its rank and suit sit in, measured in from the edge a cascade
 * advances away from — what has to stay uncovered for a card under another one to still
 * say what it is. Not to be read as a position in a hand, which is what `i` is below.
 *
 * Read off the stylesheet like `CARD_HEIGHT` is: the rank is set at `0.4` of a card
 * (`.card__rank`), a two-digit ten runs a shade wider than that, and the cascade's own
 * rules (`.cascade--*`) inset the pair a little and pull them onto the edge in question.
 * Here rather than only in the CSS because it is what `CASCADE_STEP` is chosen against,
 * and a step under it leaves a hand of blank card behind one readable face.
 */
export const CARD_INDEX_STRIP = 0.48;

/**
 * How far each card of a revealed hand is stepped past the one before it, in card widths.
 *
 * Wide enough to clear `CARD_INDEX_STRIP`, so every covered card still shows its rank and
 * suit, and narrower than a card either way, so a hand is still a stack rather than a row
 * laid out — six of them are on the screen at once and five laid flat do not fit round a
 * phone. The same distance on both axes: a top seat and a side seat are the same hand.
 */
export const CASCADE_STEP = 0.5;

/** Which way a cascade runs: down a seat at the side of the felt, across one at the top. */
export type CascadeAxis = "vertical" | "horizontal";

/**
 * The axis a revealed hand cascades along at each zone.
 *
 * It follows the zone's own shape rather than the felt's middle: `.table-zone--left` and
 * `--right` are already columns and `--top` is already a row, so a cascade running the
 * other way would grow across the table instead of along the edge the seat sits on, and
 * two seats sharing a zone would collide. `ZONE_ROTATION`'s counterpart for the shape
 * that never rotates.
 */
export const ZONE_CASCADE: Record<Zone, CascadeAxis> = {
  left: "vertical",
  top: "horizontal",
  right: "vertical",
};

/**
 * How far the `i`th card of a revealed hand is pushed along the cascade's axis, in card
 * widths — the first where the box starts, each one a step past the last.
 *
 * Per card rather than per hand, unlike `fanAngles`: an arc's angles depend on how many
 * cards are in it, and a cascade's offsets do not, so a card can be placed knowing only
 * where it comes in the hand.
 */
export function cascadeOffset(i: number): number {
  return i * CASCADE_STEP;
}

/**
 * The box a seat has to reserve for a revealed hand of `n` cards, in card widths.
 *
 * The same job `fanFootprint` does for the arc, and for the same reason: the cards are
 * placed with transforms, which cost no layout space at all, so without a box sized off
 * the offsets themselves the label below would sit under the first card and the rest of
 * the hand would be drawn straight over it (issue #58).
 *
 * A cascade grows along one axis only, so the other stays a single card.
 */
export function cascadeFootprint(
  n: number,
  axis: CascadeAxis,
): { width: number; height: number } {
  if (n <= 0) return { width: 0, height: 0 };
  const run = cascadeOffset(n - 1);
  return axis === "vertical"
    ? { width: 1, height: CARD_HEIGHT + run }
    : { width: 1 + run, height: CARD_HEIGHT };
}

/**
 * Degrees the fan at each zone is turned by, hinge toward the screen edge and open edge
 * toward the felt: the left seat's cards spread rightward into the table, the right
 * seat's leftward, and the top seat's downward. Left and right are exact mirrors, which
 * is the whole of "the table looks like a table" — a fan opening off the edge instead
 * reads as a hand held by nobody.
 */
export const ZONE_ROTATION: Record<Zone, number> = {
  left: 90,
  top: 180,
  right: -90,
};

/**
 * The angle of each of `n` cards, in the order they are drawn, from the middle outward:
 * negative first, zero if the count is odd, positive last. A lone card stays upright.
 */
export function fanAngles(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const spread = Math.min(FAN_MAX_SPREAD_DEG, n * FAN_STEP_DEG);
  const step = spread / (n - 1);
  return Array.from({ length: n }, (_, i) => -spread / 2 + step * i);
}

/** A card's four corners, in card widths, about a hinge at the origin with y up. */
function cardCorners(angleDeg: number): { x: number; y: number }[] {
  const t = (angleDeg * Math.PI) / 180;
  const corners: { x: number; y: number }[] = [];
  for (const x of [-0.5, 0.5]) {
    for (const y of [FAN_RADIUS, FAN_RADIUS + CARD_HEIGHT]) {
      corners.push({
        x: x * Math.cos(t) + y * Math.sin(t),
        y: -x * Math.sin(t) + y * Math.cos(t),
      });
    }
  }
  return corners;
}

/**
 * The box a seat has to reserve for a fan of `n` cards at `zone`, in card widths — wide
 * enough for the outermost card's outermost corner and deep enough for its tip, after the
 * zone's rotation.
 *
 * This exists because the fan is drawn with transforms, and a transform costs no layout
 * space at all: without a reserved box the label below would sit under the fan's *hinge*
 * rather than under its cards, and the arc's tips would be drawn straight across it —
 * which is exactly the rough edge the prototype left behind (issue #58). Sizing the box
 * from the same angles the cards are drawn at is what makes that unrepresentable rather
 * than a number to keep nudging.
 *
 * A hinge at the origin puts the whole fan above it and symmetric about it, so `width` is
 * measured either side of the hinge and `height` outward from it. Turning the fan a
 * quarter turn turns its box with it, which is why left and right come back on their side.
 */
export function fanFootprint(n: number, zone: Zone): { width: number; height: number } {
  const { across, deep } = fanBox(n);
  return zone === "top" ? { width: across, height: deep } : { width: deep, height: across };
}

/**
 * How far a fan of `n` cards is pushed outward, past its own edge of the screen, in card
 * widths — measured along the fan's depth, away from the felt.
 *
 * No zone to ask about: it is the same fan at every seat and so the same distance, and
 * which *direction* that is is the seat's business rather than this module's.
 *
 * What is fixed is the *fraction* of the fan left showing, not a number of pixels — but
 * the depth it is taken from barely moves with the hand, since a card's own length
 * dominates it and the arc only widens. So a seat holding seven hangs off its edge by
 * about as much as one holding two, and the cards stay where a player last saw them
 * instead of sliding outward every time somebody discards.
 */
export function fanOverhang(n: number): number {
  return FAN_HIDDEN * fanBox(n).deep;
}

/**
 * The fan's own extent about its hinge, before any zone turns it: `across` either side of
 * the hinge, `deep` out from it, in card widths.
 */
function fanBox(n: number): { across: number; deep: number } {
  if (n <= 0) return { across: 0, deep: 0 };
  const corners = fanAngles(n).flatMap(cardCorners);
  return {
    across: Math.max(...corners.map((corner) => Math.abs(corner.x))) * 2,
    deep: Math.max(...corners.map((corner) => corner.y)),
  };
}
