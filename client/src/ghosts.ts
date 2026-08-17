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
import type { CardFlight } from "./flight.ts";
import type { Box } from "./flip.ts";

/**
 * The deck's own name among the measured boxes.
 *
 * Every other box a flight uses belongs to a card and is found by that card's id. A card off
 * the deck has none: a moment ago it was somewhere in a pile the client is only ever told the
 * size of, so the deck itself is where its journey starts — measured off the one element on
 * the table that stands for it (`data-flight-box` in `Table.tsx`). A place a card can leave
 * and never land in, and a name no card can answer to, since every card id carries a suit or
 * a joker (`Card` in `shared`).
 */
export const DECK_BOX = "deck";

/**
 * Which of the two places a move moves cards between a card is arriving at.
 *
 * It is what a landing place is left empty *by*, and it has to be said rather than assumed
 * from the card, because one card can be in both places at once for as long as a flight
 * lasts: a slapdown inside `FLIGHT_MS` puts the card still flying into the hand onto the
 * pile, and the place it has actually reached must not be blanked out waiting for it.
 */
export type Landing = "hand" | "pile";

/** One card in the air: which card, where it was, where it is going, and how it is drawn. */
export interface Ghost {
  readonly card: Card;
  readonly from: Box;
  readonly to: Box;
  readonly into: Landing;
  /**
   * Drawn as a back rather than as its face, for the whole journey. A card off the deck was
   * face down where it started and is a hand card where it lands, and it turns over at
   * neither end: it arrives and the position underneath it is already showing its face.
   */
  readonly faceDown: boolean;
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
 * The cards of a move, on their way to where the position already has them.
 *
 * `before` is where everything was at the last render and `after` where it is now — the two
 * halves of FLIP, keyed by card id and, for the deck, by `DECK_BOX`. A move by anybody but the
 * viewer has nothing to fly: an opponent's cards start from a seat rather than from a hand,
 * which is a later ticket's business (issue #74) and not a reason to fly the wrong card off
 * the wrong edge.
 */
export function ghostsFor(
  flight: CardFlight,
  viewerId: string,
  before: ReadonlyMap<string, Box>,
  after: ReadonlyMap<string, Box>,
): Ghost[] {
  if (flight.playerId !== viewerId) return [];

  const discarded = flight.discarded.flatMap((card) =>
    flown({ card, into: "pile", faceDown: false }, before.get(card.id), after.get(card.id)),
  );

  const drawn = flight.drawnCard;
  if (drawn === null) return discarded;

  // Where it came from is also how it is drawn, and for the same reason: a card off the pile
  // was face up in a place of its own a moment ago, and a card off the deck was neither.
  const fromDeck = flight.drawSource === "deck";
  const from = before.get(fromDeck ? DECK_BOX : drawn.id);

  return [
    ...discarded,
    ...flown({ card: drawn, into: "hand", faceDown: fromDeck }, from, after.get(drawn.id)),
  ];
}
