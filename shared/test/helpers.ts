import type { Card } from "../src/cards.ts";
import { RANKS, SUITS, rankToValue } from "../src/cards.ts";

/**
 * A fixture deck, so tests name cards by id rather than hand-building them.
 *
 * `shared` cannot import the server's `createDeck`, so this builds the same 54 cards
 * from the same `rankToValue` the server's deck uses — card values are a rule
 * (docs/rules.md §1), so there is one definition, not a copy that could drift. Only
 * the id format is restated here, and that is the contract documented on `Card`.
 */
const BY_ID = new Map<string, Card>();
for (const suit of SUITS) {
  for (const rank of RANKS) {
    BY_ID.set(`${suit}-${rank}`, {
      id: `${suit}-${rank}`,
      suit,
      rank,
      value: rankToValue(rank),
    });
  }
}
BY_ID.set("joker-1", { id: "joker-1", suit: null, rank: "Joker", value: 0 });
BY_ID.set("joker-2", { id: "joker-2", suit: null, rank: "Joker", value: 0 });

/** Look up a card by id, so tests never hand-build inconsistent cards. */
export function card(id: string): Card {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown card id: ${id}`);
  return found;
}

export function cards(...ids: string[]): Card[] {
  return ids.map(card);
}

export function ids(list: readonly Card[]): string[] {
  return list.map((c) => c.id);
}
