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
