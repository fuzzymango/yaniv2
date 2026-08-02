/**
 * A deliberately simple opponent, used by the play harness and nothing else.
 *
 * This file holds *judgement* only. Anything about what the rules permit —
 * enumerating legal discards, deciding whether a hand is low enough to call Yaniv —
 * lives in `src/rules.ts`, so the bot cannot drift away from the engine as rules
 * change. The split is "may I" (rules) versus "should I" (here).
 *
 * The bot sees a `PlayerGameView`: exactly the payload a real client receives, with
 * opponents' hands and the draw pile stripped out. It is therefore structurally
 * incapable of cheating, and doubles as a stand-in for a real client once there is a
 * socket layer to attach one to.
 */

import type { Card, DrawAction, PlayerGameView, TurnAction } from "@yaniv/shared";
import { canCallYaniv, handValue, legalDiscards, pickupCandidates } from "./rules.ts";

/**
 * Highest face value the bot will take from the table instead of drawing blind.
 *
 * The deck averages 6.3 points per card, so anything at or below this beats an
 * unknown card on value alone. It is deliberately conservative — a 4 or 5 would
 * still beat the average — because the bot cannot see its own hand when choosing
 * (see `chooseDraw`) and so cannot tell whether a card completes a set.
 */
const MAX_PICKUP_VALUE = 3;

/**
 * Weight applied to points shed, so that value dominates and card count only breaks
 * ties. Any value above the maximum hand size works; 10 is simply legible.
 */
const VALUE_WEIGHT = 10;

/** What the bot has decided to do with its turn. */
export type BotAction =
  | { type: "yaniv" }
  | { type: "turn"; action: TurnAction };

/**
 * Call Yaniv the moment it is legal.
 *
 * This is the bot's weakest judgement by some distance: it ignores how few cards an
 * opponent is holding, so it walks into Assafs that a human would see coming. The
 * obvious improvement is to weigh `view.opponents[].handSize` before committing,
 * which is why the bot takes the whole view rather than just its hand.
 */
export function shouldCallYaniv(view: PlayerGameView): boolean {
  return canCallYaniv(view.you.hand);
}

/**
 * Shed as many points as possible, preferring the option that also sheds more cards.
 *
 * Card count matters because a turn discards `k` cards and draws exactly one, so the
 * hand shrinks by `k - 1` and gets closer to a Yaniv call. Weighting keeps that
 * strictly subordinate to value: given a 10 or a pair of 5s, both shed ten points,
 * so the pair wins on length.
 */
export function chooseDiscard(view: PlayerGameView): Card[] {
  const options = legalDiscards(view.you.hand);
  const best = options.reduce<Card[] | null>(
    (winner, option) =>
      winner === null || rateDiscard(option) > rateDiscard(winner) ? option : winner,
    null,
  );

  if (best === null) {
    // Only reachable with an empty hand, which cannot happen mid-round: a turn always
    // draws a card. Fail loudly rather than through a bare reduce.
    throw new Error("No legal discard available — the hand is empty");
  }
  return best;
}

function rateDiscard(set: readonly Card[]): number {
  return handValue(set) * VALUE_WEIGHT + set.length;
}

/**
 * Take the cheaper exposed card if it is cheap enough, otherwise draw blind.
 *
 * Note what this cannot do: it never consults the bot's own hand, so it cannot take
 * a 9 because it already holds two other 9s, nor take a card that would extend a
 * run. Cards are judged in isolation, on face value. It does reliably grab jokers,
 * which are worth zero and wild in runs.
 */
export function chooseDraw(view: PlayerGameView): DrawAction {
  const cheapest = pickupCandidates(view.lastDiscard).reduce<Card | null>(
    (best, card) => (best === null || card.value < best.value ? card : best),
    null,
  );

  return cheapest !== null && cheapest.value <= MAX_PICKUP_VALUE
    ? { source: "discard", cardId: cheapest.id }
    : { source: "deck" };
}

/**
 * The bot's whole turn, as one decision the caller can apply directly.
 *
 * Callers switch on the result rather than re-deriving whether Yaniv is available,
 * which keeps the threshold rule in exactly one place.
 */
export function decideTurn(view: PlayerGameView): BotAction {
  if (shouldCallYaniv(view)) return { type: "yaniv" };

  return {
    type: "turn",
    action: {
      discardCardIds: chooseDiscard(view).map((card) => card.id),
      draw: chooseDraw(view),
    },
  };
}
