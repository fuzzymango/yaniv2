import type { Card, Rank, Suit } from "@yaniv/shared";
import { RANKS, SUITS } from "@yaniv/shared";
import type { Rng } from "./rng.ts";

/** Scoring value for a rank. docs/rules.md §1. */
export function rankToValue(rank: Rank): number {
  switch (rank) {
    case "Joker":
      return 0;
    case "A":
      return 1;
    case "J":
    case "Q":
    case "K":
      return 10;
    default:
      return Number(rank);
  }
}

export function makeCard(suit: Suit, rank: Rank): Card {
  return { id: `${suit}-${rank}`, suit, rank, value: rankToValue(rank) };
}

/** A fresh, unshuffled 54-card deck: 52 standard cards plus 2 jokers. */
export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push(makeCard(suit, rank));
    }
  }
  cards.push({ id: "joker-1", suit: null, rank: "Joker", value: 0 });
  cards.push({ id: "joker-2", suit: null, rank: "Joker", value: 0 });
  return cards;
}

/** Fisher-Yates. Returns a new array; the input is not mutated. */
export function shuffle(cards: readonly Card[], rng: Rng): Card[] {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export interface Deal {
  hands: Card[][];
  /** The single card turned face up to start the discard. */
  firstDiscard: Card;
  drawPile: Card[];
}

/**
 * Deal `handSize` cards to each of `playerCount` players, then turn one card face up.
 * Throws if the deck is too small — that is a programming error, not a rule violation,
 * and cannot happen within the supported player range.
 */
export function deal(
  deck: readonly Card[],
  playerCount: number,
  handSize: number,
): Deal {
  const needed = playerCount * handSize + 1;
  if (deck.length < needed) {
    throw new Error(
      `Deck too small: need ${needed} cards for ${playerCount} players, have ${deck.length}`,
    );
  }

  const remaining = deck.slice();
  const hands: Card[][] = Array.from({ length: playerCount }, () => []);

  // Deal round-robin, as you would by hand.
  for (let round = 0; round < handSize; round++) {
    for (let p = 0; p < playerCount; p++) {
      hands[p]!.push(remaining.shift()!);
    }
  }

  const firstDiscard = remaining.shift()!;
  return { hands, firstDiscard, drawPile: remaining };
}
