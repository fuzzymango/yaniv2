/**
 * What of a move is in the air: the cards of it the screen can account for at both ends,
 * where each begins and ends, and which way up it flies.
 *
 * The middle of the card flight (issue #69), between `flight.ts` — which says a move happened
 * and what was in it — and `CardsInFlight.tsx`, which measures the screen and runs the
 * animation. Boxes in, cards in the air out: nothing here touches an element, a clock or a
 * preference, so every question with an answer is asked of a module a test can drive with no
 * DOM near it.
 *
 * Total in the same way `flight.ts` is: every move has an answer, and "nothing to watch" is
 * one of them.
 */

import type { Card } from "@yaniv/shared";
import type { CardFlight, SlapdownFlight, TurnFlight } from "./flight.ts";
import type { Box } from "./flip.ts";

/**
 * The deck's own name among the measured boxes.
 *
 * Every card a flight moves is normally found by its own id. A card off the deck has none to
 * be found by: a moment ago it was somewhere in a pile the client is only ever told the size
 * of, so the deck itself is where its journey starts — measured off the one element on the
 * table that stands for it (`data-flight-box` in `Table.tsx`). A place a card can leave and
 * never land in, and a name no card can answer to, since every card id carries a suit or a
 * joker (`Card` in `shared`).
 */
export const DECK_BOX = "deck";

/**
 * A seat's own name among the measured boxes — the deck's counterpart at the other end of the
 * table, and for the same reason.
 *
 * A hand that is not the viewer's own reaches the screen as a count and is drawn as a fan of
 * backs (`CardFan` in `Seat.tsx`), so no card in it has a box of its own: a card an opponent
 * discards was nowhere findable a moment ago, and one they draw is nowhere findable now. The
 * seat stands in at whichever end is theirs. One box per seat and not per card, because a
 * hand held there is one place however many cards are in it.
 *
 * Prefixed so it cannot be read as a card: no card id carries a colon (`Card` in `shared`),
 * and no player id can turn one of these into `DECK_BOX`.
 */
export const seatBox = (playerId: string): string => `seat:${playerId}`;

/**
 * Which of the places a move moves cards between a card is arriving at.
 *
 * It is what a landing place is left empty *by*, and it has to be said rather than assumed
 * from the card, because one card can be in two places at once for as long as a flight
 * lasts: a slapdown inside a flight puts the card still flying into the hand onto the
 * pile, and the place it has actually reached must not be blanked out waiting for it.
 *
 * A `seat` is the one landing that nothing waits at. An opponent's hand is a fan of backs
 * standing for a count the position has already settled, so there is no card sitting at the
 * end of that journey to be drawn twice — and a back too few for the length of a flight
 * would misstate the count the label beside it states in words.
 */
export type Landing = "hand" | "pile" | "seat";

/** One card in the air: what it is, where it was, where it is going, and how it is drawn. */
export interface Ghost {
  /**
   * What it answers to among the ghosts, and what its landing place is looked up by: the
   * card's own id, or — for a card nobody may see — the seat it is flying to, there being at
   * most one such card in a move.
   */
  readonly id: string;
  /**
   * The face to draw, or null for a back.
   *
   * Null is a card off the **deck**, whoever drew it: it was face down where it started, and
   * it turns over nowhere — the drawer's own hand is already showing it where it lands, and
   * anybody else's never will, the wire having redacted it (ADR-0007). A card off the discard
   * pile has been public all along and flies as itself, into a hand or into a seat alike.
   */
  readonly face: Card | null;
  readonly from: Box;
  readonly to: Box;
  readonly into: Landing;
}

/**
 * One card, if the screen can say where it started and where it stopped; nothing if it
 * cannot. A card that was nowhere a moment ago, or has landed nowhere now, has no flight to
 * draw and is dropped rather than guessed at.
 */
const flown = (
  ghost: Omit<Ghost, "from" | "to">,
  from: Box | undefined,
  to: Box | undefined,
): Ghost[] => (from === undefined || to === undefined ? [] : [{ ...ghost, from, to }]);

/**
 * A card discarded: out of wherever the mover's cards are held, onto its own place on the
 * pile, face up because that is what a pile is.
 *
 * The one journey a turn and a slapdown have in common, which is why it is written once — a
 * slapdown is a discard made out of turn, and it lands where every other discard does.
 * `heldAt` is the box it left, and the whole of what "whose move it is" decides here: the
 * card's own place for the viewer's hand, and the seat for a hand nobody else can see.
 */
const ontoPile = (
  card: Card,
  heldAt: string,
  before: ReadonlyMap<string, Box>,
  after: ReadonlyMap<string, Box>,
): Ghost[] =>
  flown({ id: card.id, face: card, into: "pile" }, before.get(heldAt), after.get(card.id));

/**
 * The cards of a move, on their way to where the position already has them.
 *
 * `before` is where everything was at the last render and `after` where it is now — the two
 * halves of FLIP, keyed by card id and, for the deck and every seat, by the names above.
 *
 * Whose move it is decides only which boxes are asked for, never what flies (issue #74): the
 * viewer's own cards leave their hand and come back to it, and everybody else's leave their
 * seat and come back to it. What is *shown* is the server's business and is passed through
 * untouched — a card the wire redacted has no face here either.
 *
 * *What kind* of move it is is asked of the tag and never of which fields are filled in: a
 * turn and a slapdown are different journeys, not one journey with a piece missing.
 */
export function ghostsFor(
  flight: CardFlight,
  viewerId: string,
  before: ReadonlyMap<string, Box>,
  after: ReadonlyMap<string, Box>,
): Ghost[] {
  return flight.kind === "turn"
    ? ghostsOfTurn(flight, viewerId, before, after)
    : ghostsOfSlapdown(flight, viewerId, before, after);
}

/**
 * A slapdown: one card, one way, and nothing coming back.
 *
 * It is the discard above and no more of it, journey for journey — hence the shared `ontoPile`
 * rather than a second reading of the same boxes. The deck is the one place it never touches
 * at either end: the card was drawn on the turn before this one, and that draw has already
 * been watched.
 *
 * The card always has a face. Nothing about a slapdown is redacted (ADR-0008) — it is face up
 * on the pile by the time the fact naming it is written.
 */
function ghostsOfSlapdown(
  flight: SlapdownFlight,
  viewerId: string,
  before: ReadonlyMap<string, Box>,
  after: ReadonlyMap<string, Box>,
): Ghost[] {
  const mine = flight.playerId === viewerId;
  const card = flight.card;
  return ontoPile(card, mine ? card.id : seatBox(flight.playerId), before, after);
}

/** A turn: a set out of a hand onto the pile, and one card back the other way. */
function ghostsOfTurn(
  flight: TurnFlight,
  viewerId: string,
  before: ReadonlyMap<string, Box>,
  after: ReadonlyMap<string, Box>,
): Ghost[] {
  const mine = flight.playerId === viewerId;
  const seat = seatBox(flight.playerId);

  const discarded = flight.discarded.flatMap((card) =>
    ontoPile(card, mine ? card.id : seat, before, after),
  );

  // Where it came from is also how it is drawn, and for the same reason: a card off the pile
  // was face up in a place of its own a moment ago, and a card off the deck was neither.
  const drawn = flight.drawnCard;
  const fromDeck = flight.drawSource === "deck";
  /** Where the drawn card is, if this viewer has been told which card it is at all. */
  const boxOfDrawn = (boxes: ReadonlyMap<string, Box>): Box | undefined =>
    drawn === null ? undefined : boxes.get(drawn.id);

  return [
    ...discarded,
    ...flown(
      { id: drawn?.id ?? seat, face: fromDeck ? null : drawn, into: mine ? "hand" : "seat" },
      fromDeck ? before.get(DECK_BOX) : boxOfDrawn(before),
      mine ? boxOfDrawn(after) : after.get(seat),
    ),
  ];
}
