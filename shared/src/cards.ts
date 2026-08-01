/** The four suits. Jokers have no suit, represented as `null` on the card. */
export type Suit = "hearts" | "diamonds" | "clubs" | "spades";

export type Rank =
  | "A"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "Joker";

export interface Card {
  /** Unique per physical card: `hearts-K`, `spades-7`, `joker-1`. Single deck only. */
  id: string;
  suit: Suit | null;
  rank: Rank;
  /** Scoring value. A=1, 2-10 face, J/Q/K=10, Joker=0. See docs/rules.md §1. */
  value: number;
}

export const SUITS: readonly Suit[] = ["hearts", "diamonds", "clubs", "spades"];

/** Non-joker ranks, in run order (Ace low). */
export const RANKS: readonly Rank[] = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

/** Position of a rank in run order, Ace low. Jokers are not orderable. */
export function rankOrder(rank: Rank): number | null {
  const index = RANKS.indexOf(rank);
  return index === -1 ? null : index;
}

function suitIndex(suit: Suit | null): number {
  return suit === null ? -1 : SUITS.indexOf(suit);
}

/**
 * Display order for a hand: ascending by scoring value, so jokers (0) sit at the
 * left and the tens and face cards at the right. Cards of equal value are ordered
 * by rank, which puts 10 before J, Q, K, then by suit.
 *
 * Card id is the final tie-break, which makes this a *total* order. Without it the
 * two jokers compare equal and their rendered order would follow whatever order the
 * engine happens to hold them in — so they would appear to swap places as the hand
 * changes around them.
 *
 * This is presentation only — the engine attaches no meaning to hand order.
 */
export function compareCards(a: Card, b: Card): number {
  if (a.value !== b.value) return a.value - b.value;

  const rankA = rankOrder(a.rank) ?? -1;
  const rankB = rankOrder(b.rank) ?? -1;
  if (rankA !== rankB) return rankA - rankB;

  const suitA = suitIndex(a.suit);
  const suitB = suitIndex(b.suit);
  if (suitA !== suitB) return suitA - suitB;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A new array in display order. Does not mutate the input. */
export function sortHand(cards: readonly Card[]): Card[] {
  return [...cards].sort(compareCards);
}
