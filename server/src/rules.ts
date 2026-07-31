import type { Card, Rank } from "@yaniv/shared";
import { RANKS } from "@yaniv/shared";

/** Position of a rank in run order, Ace low. Jokers are not orderable. */
export function rankOrder(rank: Rank): number | null {
  const index = RANKS.indexOf(rank);
  return index === -1 ? null : index;
}

export function handValue(hand: readonly Card[]): number {
  return hand.reduce((total, card) => total + card.value, 0);
}

function isSameRankSet(cards: readonly Card[]): boolean {
  if (cards.length < 2) return false;
  const rank = cards[0]!.rank;
  return cards.every((c) => c.rank === rank);
}

function isRun(cards: readonly Card[]): boolean {
  if (cards.length < 3) return false;

  const suit = cards[0]!.suit;
  // Jokers have a null suit and are not wild, so they can never form a run.
  if (suit === null) return false;
  if (!cards.every((c) => c.suit === suit)) return false;

  const orders = cards.map((c) => rankOrder(c.rank));
  if (orders.some((o) => o === null)) return false;

  const sorted = (orders as number[]).slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! !== sorted[i - 1]! + 1) return false;
  }
  return true;
}

/**
 * A discard is valid if it is a single card, 2+ of the same rank, or a same-suit run
 * of 3+. docs/rules.md §4.
 */
export function isValidSet(cards: readonly Card[]): boolean {
  if (cards.length === 0) return false;
  if (cards.length === 1) return true;
  return isSameRankSet(cards) || isRun(cards);
}

/**
 * Put a validated set into the order it lies on the table, so that "first and last
 * card" is unambiguous for the next player's pickup. Runs are sorted ascending;
 * same-rank sets keep the order the player submitted. docs/rules.md §4.
 */
export function canonicalizeSet(cards: readonly Card[]): Card[] {
  if (isRun(cards)) {
    return cards
      .slice()
      .sort((a, b) => rankOrder(a.rank)! - rankOrder(b.rank)!);
  }
  return cards.slice();
}

/** The cards of a discarded set that the next player may pick up: its two ends. */
export function pickupCandidates(lastDiscard: readonly Card[]): Card[] {
  if (lastDiscard.length === 0) return [];
  if (lastDiscard.length === 1) return [lastDiscard[0]!];
  return [lastDiscard[0]!, lastDiscard[lastDiscard.length - 1]!];
}
