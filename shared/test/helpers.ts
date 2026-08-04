import type { Card, Rank } from "../src/index.ts";
import { RANKS, SUITS } from "../src/index.ts";

/**
 * A fixture deck, so tests name cards by id rather than hand-building them.
 *
 * The server builds the real deck (`server/src/deck.ts`), which `shared` cannot
 * import — so this mirrors the card contract documented on `Card`: ids read
 * `hearts-K` / `joker-1`, and values follow docs/rules.md §1. Any drift from the
 * server's deck shows up immediately as a wrong hand value here.
 */
function rankToValue(rank: Rank): number {
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
