import type { Card } from "./cards.ts";
import { RANKS, rankOrder } from "./cards.ts";
import {
  MIN_RUN_LENGTH,
  MIN_RUN_REAL_CARDS,
  YANIV_THRESHOLD,
} from "./config.ts";

const HIGHEST_RANK_INDEX = RANKS.length - 1;

/** Split a set into its real cards (ascending by rank) and its jokers. */
function partition(cards: readonly Card[]): { reals: Card[]; jokers: Card[] } {
  const reals = cards
    .filter((c) => c.suit !== null)
    .sort((a, b) => rankOrder(a.rank)! - rankOrder(b.rank)!);
  const jokers = cards.filter((c) => c.suit === null);
  return { reals, jokers };
}

export function handValue(hand: readonly Card[]): number {
  return hand.reduce((total, card) => total + card.value, 0);
}

function isSameRankSet(cards: readonly Card[]): boolean {
  if (cards.length < 2) return false;
  const rank = cards[0]!.rank;
  return cards.every((c) => c.rank === rank);
}

/**
 * A run is 3+ cards of one suit in consecutive rank order, where a joker may stand
 * in for any missing card. docs/rules.md §4.
 *
 * The test is a span check rather than a walk: the real cards must all fit inside a
 * window of `cards.length` consecutive ranks, and whatever positions they leave
 * empty are exactly the ones the jokers fill. That is equivalent to counting gaps —
 * `gaps = (max - min + 1) - reals.length` and `jokers = length - reals.length`, so
 * `gaps <= jokers` reduces to `max - min + 1 <= length` — but it needs no iteration
 * and does not depend on jokers happening to sort before the real cards.
 *
 * Runs cannot wrap past the king: A and K are 12 apart, so any set containing both
 * has a span far wider than a hand can cover.
 */
function isRun(cards: readonly Card[]): boolean {
  if (cards.length < MIN_RUN_LENGTH) return false;

  const { reals } = partition(cards);
  if (reals.length < MIN_RUN_REAL_CARDS) return false;

  const suit = reals[0]!.suit;
  if (!reals.every((c) => c.suit === suit)) return false;

  const ranks = reals.map((c) => rankOrder(c.rank)!);
  // One deck means a suit cannot repeat a rank, but a duplicate would silently
  // shrink the span and let an invalid set through, so reject it explicitly.
  if (new Set(ranks).size !== ranks.length) return false;

  const span = Math.max(...ranks) - Math.min(...ranks) + 1;
  return span <= cards.length;
}

/**
 * A discard is valid if it is a single card, 2+ of the same rank, or a same-suit run
 * of 3+ in which jokers may stand in for missing cards. Jokers are wild in runs
 * only — they do not complete a same-rank set. docs/rules.md §4.
 */
export function isValidSet(cards: readonly Card[]): boolean {
  if (cards.length === 0) return false;
  if (cards.length === 1) return true;
  return isSameRankSet(cards) || isRun(cards);
}

/**
 * Lay a validated run out in rank order, deciding where each joker sits.
 *
 * A joker filling an interior gap has only one possible position. A joker that
 * extends the run is ambiguous — `7♥ 8♥ Jk` could be 6-7-8 or 7-8-9 — so the
 * player's own ordering settles it: jokers they placed before their first real card
 * extend downwards, the rest extend upwards. This matters because only the two end
 * cards of a discard can be picked up, so the choice decides what the next player
 * is offered.
 *
 * The player's preference is overridden only where the run would fall off the end
 * of the deck: a joker cannot sit below the ace or above the king.
 */
function layOutRun(cards: readonly Card[]): Card[] {
  const { reals, jokers } = partition(cards);
  if (jokers.length === 0) return reals;

  const ranks = reals.map((c) => rankOrder(c.rank)!);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);

  const interior = max - min + 1 - reals.length;
  const extending = jokers.length - interior;

  // Everything before the first real card is, by definition, a joker.
  const laidLow = cards.findIndex((c) => c.suit !== null);

  let low = Math.min(laidLow, extending, min);
  const highRoom = HIGHEST_RANK_INDEX - max;
  if (extending - low > highRoom) low = extending - highRoom;

  const queue = jokers.slice();
  const out: Card[] = [];
  for (let i = 0; i < low; i++) out.push(queue.shift()!);
  for (let rank = min; rank <= max; rank++) {
    out.push(reals.find((c) => rankOrder(c.rank)! === rank) ?? queue.shift()!);
  }
  out.push(...queue);
  return out;
}

/**
 * Put a validated set into the order it lies on the table, so that "first and last
 * card" is unambiguous for the next player's pickup. Runs are laid out in rank
 * order; same-rank sets keep the order the player submitted. docs/rules.md §4.
 */
export function canonicalizeSet(cards: readonly Card[]): Card[] {
  return isRun(cards) ? layOutRun(cards) : cards.slice();
}

/**
 * Every discard the rules permit from a hand, as subsets of it.
 *
 * Enumerates all non-empty subsets and asks `isValidSet` about each, so it stays
 * correct automatically as the rules change. That is exponential in hand size, which
 * is only acceptable because Yaniv caps hands at five cards — 31 combinations.
 *
 * A non-empty hand always yields at least one option, since a lone card is always a
 * legal discard. Useful beyond the bot: a client can call this to highlight which
 * cards are playable right now.
 */
export function legalDiscards(hand: readonly Card[]): Card[][] {
  const found: Card[][] = [];
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const subset = hand.filter((_, i) => (mask & (1 << i)) !== 0);
    if (isValidSet(subset)) found.push(subset);
  }
  return found;
}

/**
 * Whether a hand is low enough to call Yaniv. docs/rules.md §6.
 *
 * This is the rule — "may I" — and deliberately says nothing about whether calling
 * is a good idea, which is a player's or a bot's judgement.
 */
export function canCallYaniv(hand: readonly Card[]): boolean {
  return handValue(hand) <= YANIV_THRESHOLD;
}

/**
 * The cards of a discarded set that the next player may pick up. A same-rank set
 * exposes every card; a run exposes only its two ends. docs/rules.md §5.
 */
export function pickupCandidates(lastDiscard: readonly Card[]): Card[] {
  if (lastDiscard.length === 0) return [];
  if (lastDiscard.length === 1) return [lastDiscard[0]!];
  if (isSameRankSet(lastDiscard)) return lastDiscard.slice();
  return [lastDiscard[0]!, lastDiscard[lastDiscard.length - 1]!];
}

/**
 * Whether a just-resolved turn opens a slapdown window for the player who took it —
 * the brief chance to put the card they just drew straight back down. docs/rules.md §9.
 *
 * Four things have to hold at once: the discard was a same-rank set or a lone card
 * (never a run, which has no single rank to match), the draw came off the deck (never a
 * pickup, since the mechanic exists to reward the blind draw), the drawn card shares the
 * discard's rank, and it is not a joker. Jokers are excluded outright rather than by the
 * rank test: two jokers *are* a same-rank set, so a joker drawn after one would otherwise
 * qualify, and shedding a card already worth nothing is a move with no point to it.
 *
 * A rules query in the same family as `pickupCandidates`, and here for the same reason —
 * a client has to know the window is open to offer it, without a round trip to find out.
 * It takes the draw's source rather than the `DrawAction` carrying it, so the rulebook
 * stays a function of cards alone and owes the wire contract nothing (ADR-0002).
 */
export function opensSlapdown(
  discarded: readonly Card[],
  drawSource: "deck" | "discard",
  drawnCard: Card,
): boolean {
  const oneRank = discarded.length === 1 || isSameRankSet(discarded);
  if (!oneRank) return false;
  if (drawSource !== "deck") return false;
  if (drawnCard.suit === null) return false;
  return drawnCard.rank === discarded[0]!.rank;
}
