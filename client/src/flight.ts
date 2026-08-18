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

import type {
  Card,
  DrawSource,
  LastMoveView,
  LastSlapdownView,
  PlayerGameView,
} from "@yaniv/shared";

/**
 * A turn, as something to show: the cards leaving a hand for the pile, and the card coming
 * back the other way.
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
export interface TurnFlight {
  readonly kind: "turn";
  readonly playerId: string;
  readonly discarded: readonly Card[];
  readonly drawSource: DrawSource;
  readonly drawnCard: Card | null;
}

/**
 * A slapdown, as something to show: one card out of a hand onto the pile, and nothing back.
 *
 * Structurally not a turn and not a narrower one — there is no draw to name, no source to
 * have drawn from and no set, since a slapdown is exactly the one card just drawn (§9). Which
 * is why it is a shape of its own under a tag, rather than a turn with its draw fields left
 * empty: "no card came back" would then be a thing to infer from absence, and a redacted deck
 * draw already reaches this module as an absent card meaning something else entirely.
 *
 * The card is never redacted — by the time the fact is written it is face up on `lastDiscard`,
 * which everyone is sent in full (ADR-0008) — so unlike a turn's draw it always has a face.
 */
export interface SlapdownFlight {
  readonly kind: "slapdown";
  readonly playerId: string;
  readonly card: Card;
}

/** Whatever the position was reached by, and there is exactly one of them per arrival. */
export type CardFlight = TurnFlight | SlapdownFlight;

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
 * Whether two last-slapdown facts are the same slap, by value for the reason above.
 *
 * Both fields, though the card alone would do it: a card is dealt once a round and can only
 * be slapped down out of the hand holding it, so two slaps cannot agree on it. Naming the
 * player as well costs nothing and says what the comparison is actually about — the same
 * person putting the same card down is the same event.
 */
const sameSlapdown = (a: LastSlapdownView, b: LastSlapdownView): boolean =>
  a.playerId === b.playerId && a.card.id === b.card.id;

/**
 * The move between the position on the screen and the position arriving, or null when
 * there is nothing to animate.
 *
 * Two facts are watched, not one: the **last move** and the **last slapdown**, which are
 * siblings on the wire precisely because a slapdown is not a turn (ADR-0007, ADR-0008). Each
 * is left standing by whatever the other records, and a broadcast carries one move (see
 * "Broadcasting" in CLAUDE.md), so at most one of the two can have changed on any arrival —
 * the turn is asked about first only because a position has to be read in some order.
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
  if (shown === null) return null;
  // A flight goes from a hand to the pile and from a pile to a hand, so both ends of it have
  // to be a round in progress. A scored round keeps both facts standing (ADR-0007, ADR-0008)
  // with nothing left on the screen to watch either happen on.
  if (shown.phase !== "playing" || arriving.phase !== "playing") return null;
  // A move happens within one round. Across a deal the cards on the screen are replaced
  // wholesale, and none of what changed is anybody's turn — a slapdown from the round before
  // included, though the deal clears that fact in any case.
  if (shown.roundNumber !== arriving.roundNumber) return null;

  // Nothing shown of a kind is news of that kind: the first turn of a round, and the first
  // slapdown, have nothing behind them to be the same as.
  const move = arriving.lastMove;
  if (move !== null && (shown.lastMove === null || !sameMove(shown.lastMove, move))) {
    return {
      kind: "turn",
      playerId: move.playerId,
      discarded: arriving.lastDiscard,
      drawSource: move.drawSource,
      drawnCard: move.drawnCard,
    };
  }

  const slap = arriving.lastSlapdown;
  if (slap !== null && (shown.lastSlapdown === null || !sameSlapdown(shown.lastSlapdown, slap))) {
    return { kind: "slapdown", playerId: slap.playerId, card: slap.card };
  }

  return null;
}
