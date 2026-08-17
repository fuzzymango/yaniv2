/**
 * Whether a move just happened worth watching, and what it consisted of.
 *
 * The pure half of the card flight (issue #69): two positions in — the one on the screen
 * and the one that has just arrived — and either a description of the move between them or
 * nothing at all. It says who moved, which cards left their hand, which pile they drew
 * from, and which card they drew where this viewer is entitled to know it. It says nothing
 * about pixels, elements or timing; the layer that measures the screen and runs the
 * animation asks this module what is moving and works the rest out for itself.
 *
 * `turn.ts`'s counterpart on the way in, and total in the same way: every pair of positions
 * has an answer, and "nothing to animate" is one of them.
 */

import type { Card, DrawSource, LastMoveView, PlayerGameView } from "@yaniv/shared";

/**
 * One move, as something to show: the cards leaving a hand for the pile, and the card
 * coming back the other way.
 *
 * The discard needs no per-card provenance — every card in it came from the mover's hand,
 * which `playerId` names. `drawnCard` is null where the server withheld it (a card off the
 * deck, seen by anybody but the drawer), and that is exactly the question a renderer asks
 * to decide whether the card in flight is drawn face up or as a back. See "Last move" in
 * CONTEXT.md and ADR-0007.
 *
 * `drawSource` is the wire's word for which pile — `shared`'s, and not `turn.ts`'s
 * same-named type, which is a *tap* on one and may not be a legal draw at all. A move that
 * has resolved was legal by definition, so this end of it has nothing to qualify.
 */
export interface CardFlight {
  readonly playerId: string;
  readonly discarded: readonly Card[];
  readonly drawSource: DrawSource;
  readonly drawnCard: Card | null;
}

/**
 * Whether two last-move facts are the same move.
 *
 * By value, because they arrive as separate objects: a position is serialized afresh per
 * broadcast, so the fact that has not changed since the last one is an equal object and
 * never the same one. Comparing references would animate every arrival, a slapdown and a
 * Yaniv call included — the two broadcasts that deliberately leave the last move standing
 * (ADR-0007).
 *
 * Three fields are enough to tell one turn from the next, even though a card off the deck
 * reaches everyone but the drawer as `drawnCard: null`. Turn order rotates, so the move
 * before this one belongs to somebody else; two consecutive facts cannot agree on the
 * mover unless they are the same fact.
 */
const sameMove = (a: LastMoveView, b: LastMoveView): boolean =>
  a.playerId === b.playerId &&
  a.drawSource === b.drawSource &&
  (a.drawnCard?.id ?? null) === (b.drawnCard?.id ?? null);

/**
 * The move between the position on the screen and the position arriving, or null when
 * there is nothing to animate.
 *
 * `shown` is null where there is no position to have moved from: a page that has just come
 * up, or a player who has this moment been shown a room. Whatever move was last at that
 * table is one they were not there for. A seat claimed back is the same case and is answered
 * before it gets here — `session.ts` publishes that position with nothing in flight, since
 * the ack of a claim is not a move arriving.
 */
export function flightFrom(
  shown: PlayerGameView | null,
  arriving: PlayerGameView,
): CardFlight | null {
  const move = arriving.lastMove;
  if (shown === null || move === null) return null;
  // A flight goes from a hand to the pile and from a pile to a hand, so both ends of it have
  // to be a round in progress. A scored round keeps the last move standing (ADR-0007) with
  // nothing left on the screen to watch it happen on.
  if (shown.phase !== "playing" || arriving.phase !== "playing") return null;
  // A move happens within one round. Across a deal the cards on the screen are replaced
  // wholesale, and none of what changed is anybody's turn.
  if (shown.roundNumber !== arriving.roundNumber) return null;
  if (shown.lastMove !== null && sameMove(shown.lastMove, move)) return null;

  return {
    playerId: move.playerId,
    discarded: arriving.lastDiscard,
    drawSource: move.drawSource,
    drawnCard: move.drawnCard,
  };
}
