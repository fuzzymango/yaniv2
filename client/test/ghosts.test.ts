/**
 * What of a move is actually in the air, once the screen has been taken into account.
 *
 * The card flight's second pure seam, beside `flight.ts`'s: that module says a move happened
 * and what was in it, this one says which of it can be drawn crossing the screen, from where,
 * and which way up. The boxes are written down here rather than measured — where they come
 * from is `CardsInFlight.tsx`'s business, and the only part of this feature that needs a
 * browser at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CardFlight } from "../src/flight.ts";
import type { Box } from "../src/flip.ts";
import { DECK_BOX, ghostsFor } from "../src/ghosts.ts";
import { card, cards } from "./helpers.ts";

/** A card-shaped box: 50 wide, 70 tall, the proportion `styles.css` draws every card at. */
const box = (left: number, top: number, width = 50): Box => ({
  left,
  top,
  width,
  height: width * 1.4,
});

/** The three places a card is ever measured at on this screen. */
const HAND = box(100, 500, 60);
const PILE = box(140, 240);
const DECK = box(40, 240);

const boxes = (entries: Record<string, Box>): Map<string, Box> => new Map(Object.entries(entries));

/** The viewer's own turn: one card discarded, one drawn off the deck. */
const move = (overrides: Partial<CardFlight> = {}): CardFlight => ({
  playerId: "p1",
  discarded: cards("hearts-5"),
  drawSource: "deck",
  drawnCard: card("diamonds-4"),
  ...overrides,
});

describe("ghostsFor", () => {
  it("flies each card of a discard from where it was to where it landed", () => {
    const before = boxes({ "hearts-5": HAND, "clubs-5": box(160, 500, 60) });
    const after = boxes({ "hearts-5": PILE, "clubs-5": box(190, 240) });

    const flying = ghostsFor(
      move({ discarded: cards("hearts-5", "clubs-5"), drawnCard: null }),
      "p1",
      before,
      after,
    );

    assert.deepEqual(flying, [
      { card: card("hearts-5"), from: HAND, to: PILE, into: "pile", faceDown: false },
      {
        card: card("clubs-5"),
        from: box(160, 500, 60),
        to: box(190, 240),
        into: "pile",
        faceDown: false,
      },
    ]);
  });

  it("flies the card taken off the pile face up, from where it lay on it", () => {
    // It has been face up on the pile all along, so there is nothing to hide on the way and
    // nothing to reveal at the end: it flies as itself, back the way the discard has just gone.
    const before = boxes({ "hearts-5": HAND, "clubs-7": PILE });
    const after = boxes({ "hearts-5": PILE, "clubs-7": HAND });

    const flying = ghostsFor(
      move({ drawSource: "discard", drawnCard: card("clubs-7") }),
      "p1",
      before,
      after,
    );

    assert.deepEqual(flying.at(-1), {
      card: card("clubs-7"),
      from: PILE,
      to: HAND,
      into: "hand",
      faceDown: false,
    });
    assert.equal(flying.length, 2, "the discard goes one way and the draw comes back the other");
  });

  it("flies a card off the deck from the deck, face down the whole way", () => {
    // It has no box of its own to leave from — a moment ago it was somewhere in a pile the
    // client is only ever told the size of — so the deck is where its journey starts, and it
    // is a back until it lands, where the hand underneath it is already showing its face.
    const before = boxes({ "hearts-5": HAND, [DECK_BOX]: DECK });
    const after = boxes({ "hearts-5": PILE, "diamonds-4": HAND });

    const flying = ghostsFor(move(), "p1", before, after);

    assert.deepEqual(flying.at(-1), {
      card: card("diamonds-4"),
      from: DECK,
      to: HAND,
      into: "hand",
      faceDown: true,
    });
  });

  it("flies the discard alone where the drawn card reached this viewer with no face", () => {
    // Not a position the viewer's own move reaches — a card off the deck is redacted to
    // everyone *but* the drawer (ADR-0007) — but the answer to a card with no face is the
    // same wherever it came from: there is nothing to draw crossing the screen, and the
    // half of the move that does have cards is unaffected.
    const before = boxes({ "hearts-5": HAND });
    const after = boxes({ "hearts-5": PILE });

    assert.deepEqual(ghostsFor(move({ drawSource: "discard", drawnCard: null }), "p1", before, after), [
      { card: card("hearts-5"), from: HAND, to: PILE, into: "pile", faceDown: false },
    ]);
  });

  it("drops a card it cannot place at both ends", () => {
    // A card that was nowhere a moment ago, or has landed nowhere now, has no journey to
    // draw — so it is dropped rather than guessed at, and the position simply shows it.
    const landed = boxes({ "hearts-5": PILE });

    assert.deepEqual(ghostsFor(move({ drawnCard: null }), "p1", boxes({}), landed), []);
    assert.deepEqual(ghostsFor(move({ drawnCard: null }), "p1", landed, boxes({})), []);
  });

  it("has nothing to fly for a move that is not the viewer's own", () => {
    // An opponent's cards start from a seat rather than from a hand, which is the next
    // ticket's problem (issue #74) and not a reason to fly the wrong card off the wrong edge.
    const before = boxes({ "hearts-5": HAND });
    const after = boxes({ "hearts-5": PILE });

    assert.deepEqual(ghostsFor(move({ playerId: "p2", drawnCard: null }), "p1", before, after), []);
  });
});
