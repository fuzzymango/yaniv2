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
import type { SlapdownFlight, TurnFlight } from "../src/flight.ts";
import type { Box } from "../src/flip.ts";
import { DECK_BOX, ghostsFor, seatBox } from "../src/ghosts.ts";
import { card, cards } from "./helpers.ts";

/** A card-shaped box: 50 wide, 70 tall, the proportion `styles.css` draws every card at. */
const box = (left: number, top: number, width = 50): Box => ({
  left,
  top,
  width,
  height: width * 1.4,
});

/** The four places a card is ever measured at on this screen. */
const HAND = box(100, 500, 60);
const PILE = box(140, 240);
const DECK = box(40, 240);
/** Somebody else's hand, which is one box however many cards are held in it. */
const SEAT = box(0, 300, 40);

const boxes = (entries: Record<string, Box>): Map<string, Box> => new Map(Object.entries(entries));

/** The viewer's own turn: one card discarded, one drawn off the deck. */
const move = (overrides: Partial<TurnFlight> = {}): TurnFlight => ({
  kind: "turn",
  playerId: "p1",
  discarded: cards("hearts-5"),
  drawSource: "deck",
  drawnCard: card("diamonds-4"),
  ...overrides,
});

/** The same turn taken by the player sitting opposite, whose hand nobody else can see. */
const theirs = (overrides: Partial<TurnFlight> = {}): TurnFlight =>
  move({ playerId: "p2", drawnCard: null, ...overrides });

/** The viewer's own slapdown: one card out of their hand onto the pile, and nothing back. */
const slap = (overrides: Partial<SlapdownFlight> = {}): SlapdownFlight => ({
  kind: "slapdown",
  playerId: "p1",
  card: card("hearts-5"),
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
      { id: "hearts-5", face: card("hearts-5"), from: HAND, to: PILE, into: "pile" },
      {
        id: "clubs-5",
        face: card("clubs-5"),
        from: box(160, 500, 60),
        to: box(190, 240),
        into: "pile",
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
      id: "clubs-7",
      face: card("clubs-7"),
      from: PILE,
      to: HAND,
      into: "hand",
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
      id: "diamonds-4",
      face: null,
      from: DECK,
      to: HAND,
      into: "hand",
    });
  });

  it("flies the discard alone where the drawn card reached this viewer with no face", () => {
    // Not a position the viewer's own move reaches — a card off the deck is redacted to
    // everyone *but* the drawer (ADR-0007) — but a card with no face and no pile to have
    // come off has nowhere to start, and the half of the move that does have cards is
    // unaffected.
    const before = boxes({ "hearts-5": HAND });
    const after = boxes({ "hearts-5": PILE });

    assert.deepEqual(
      ghostsFor(move({ drawSource: "discard", drawnCard: null }), "p1", before, after),
      [{ id: "hearts-5", face: card("hearts-5"), from: HAND, to: PILE, into: "pile" }],
    );
  });

  it("drops a card it cannot place at both ends", () => {
    // A card that was nowhere a moment ago, or has landed nowhere now, has no journey to
    // draw — so it is dropped rather than guessed at, and the position simply shows it.
    const landed = boxes({ "hearts-5": PILE });

    assert.deepEqual(ghostsFor(move({ drawnCard: null }), "p1", boxes({}), landed), []);
    assert.deepEqual(ghostsFor(move({ drawnCard: null }), "p1", landed, boxes({})), []);
  });

  describe("somebody else's move", () => {
    it("flies their discard out of their seat onto the pile", () => {
      // The cards were in a hand nobody else can see, so there is no box of their own for
      // them to leave from: the seat they were held at is where they set off from, exactly
      // as the deck is for a card that was in the draw pile.
      const before = boxes({ [seatBox("p2")]: SEAT, [DECK_BOX]: DECK });
      const after = boxes({ "hearts-5": PILE, "clubs-5": box(190, 240), [seatBox("p2")]: SEAT });

      const flying = ghostsFor(
        theirs({ discarded: cards("hearts-5", "clubs-5") }),
        "p1",
        before,
        after,
      );

      assert.deepEqual(flying.slice(0, 2), [
        { id: "hearts-5", face: card("hearts-5"), from: SEAT, to: PILE, into: "pile" },
        {
          id: "clubs-5",
          face: card("clubs-5"),
          from: SEAT,
          to: box(190, 240),
          into: "pile",
        },
      ]);
    });

    it("flies a card they took off the deck into their seat, with no face at either end", () => {
      // The one card in this feature that is nobody's to see: it was face down in the draw
      // pile and is a card of a hidden hand now, so it crosses the table as a back and is
      // named by the seat it is flying to rather than by a card id nothing here has.
      const before = boxes({ [seatBox("p2")]: SEAT, [DECK_BOX]: DECK });
      const after = boxes({ "hearts-5": PILE, [seatBox("p2")]: SEAT });

      assert.deepEqual(ghostsFor(theirs(), "p1", before, after).at(-1), {
        id: seatBox("p2"),
        face: null,
        from: DECK,
        to: SEAT,
        into: "seat",
      });
    });

    it("flies the exact card they took off the pile, from where that card lay", () => {
      // Which card it was is the server's fact and not a guess off what is left of the pile
      // (ADR-0007), so a pile exposing two takeable cards flies the one actually taken —
      // face up, since it has been face up all along.
      const before = boxes({
        [seatBox("p2")]: SEAT,
        "clubs-7": PILE,
        "clubs-9": box(200, 240),
      });
      const after = boxes({ "hearts-5": PILE, [seatBox("p2")]: SEAT });

      assert.deepEqual(
        ghostsFor(theirs({ drawSource: "discard", drawnCard: card("clubs-9") }), "p1", before, after)
          .at(-1),
        {
          id: "clubs-9",
          face: card("clubs-9"),
          from: box(200, 240),
          to: SEAT,
          into: "seat",
        },
      );
    });

    it("drops the lot when their seat is nowhere on the screen", () => {
      // A seat that has not been drawn — a player who has just left, a screen mid-render —
      // is a journey with one end missing, at both ends of the move.
      const before = boxes({ [DECK_BOX]: DECK, "clubs-7": PILE });
      const after = boxes({ "hearts-5": PILE });

      assert.deepEqual(ghostsFor(theirs(), "p1", before, after), []);
      assert.deepEqual(
        ghostsFor(theirs({ drawSource: "discard", drawnCard: card("clubs-7") }), "p1", before, after),
        [],
      );
    });
  });

  describe("a slapdown", () => {
    it("flies the viewer's own card out of their hand onto the pile", () => {
      // One card, one way: nothing is drawn for it to come back the other way, and the deck
      // is not a place a slapdown touches at either end.
      const before = boxes({ "hearts-5": HAND, [DECK_BOX]: DECK });
      const after = boxes({ "hearts-5": PILE, [DECK_BOX]: DECK });

      assert.deepEqual(ghostsFor(slap(), "p1", before, after), [
        { id: "hearts-5", face: card("hearts-5"), from: HAND, to: PILE, into: "pile" },
      ]);
    });

    it("flies somebody else's out of their seat, face up the whole way", () => {
      // Their hand is a fan of backs standing for a count, so the seat is where the card sets
      // off from — and the card itself is no secret, being the one they have just put face up
      // on the pile (ADR-0008).
      const before = boxes({ [seatBox("p2")]: SEAT });
      const after = boxes({ "hearts-5": PILE, [seatBox("p2")]: SEAT });

      assert.deepEqual(ghostsFor(slap({ playerId: "p2" }), "p1", before, after), [
        { id: "hearts-5", face: card("hearts-5"), from: SEAT, to: PILE, into: "pile" },
      ]);
    });

    it("drops a card it cannot place at both ends", () => {
      // The same rule a turn's cards are held to: a seat that has not been drawn, or a card
      // the pile has not landed yet, is a journey with one end missing.
      const landed = boxes({ "hearts-5": PILE });

      assert.deepEqual(ghostsFor(slap(), "p1", boxes({}), landed), []);
      assert.deepEqual(ghostsFor(slap(), "p1", landed, boxes({})), []);
      assert.deepEqual(ghostsFor(slap({ playerId: "p2" }), "p1", boxes({}), landed), []);
    });
  });
});
