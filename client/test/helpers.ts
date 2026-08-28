/**
 * Fixtures for the client's tests — a deck to build hands from, and a view to read a turn
 * against.
 *
 * The deck is rebuilt here from `shared`'s own ranks, suits and `rankToValue` rather than
 * imported from `server/src`, for the reason `shared/test/helpers.ts` does the same: card
 * values are a rule (docs/rules.md §1), so there is one definition and no copy that could
 * drift — but a *pure* client test has no business reaching into the server for it. Only
 * the id format is restated, and that is the contract documented on `Card`.
 */

import type { Card, PlayerGameView } from "@yaniv/shared";
import { RANKS, SUITS, rankToValue } from "@yaniv/shared";

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

/**
 * A mid-round view with the two things a turn is read against — the hand it comes from
 * and the discard it may be drawn from. Everything else is filled in plausibly, because
 * the turn module reads none of it and a test that set it would be claiming otherwise.
 *
 * The two exceptions are named: an open slapdown window, and whose turn it is — the pair
 * that go together, since a window is only ever open while somebody else is on turn.
 */
export function viewOf(
  hand: Card[],
  lastDiscard: Card[],
  overrides: { slapdownEligible?: boolean; currentTurnPlayerId?: string } = {},
): PlayerGameView {
  return {
    roomCode: "ABCD",
    phase: "playing",
    roundNumber: 1,
    hostId: "p1",
    settings: { handSize: 5, yanivThreshold: 7, maxScore: 100, botCount: 0 },
    you: {
      id: "p1",
      name: "Ada",
      score: 0,
      hand,
      outInRound: null,
      departed: false,
      slapdownEligible: overrides.slapdownEligible ?? false,
    },
    opponents: [
      { id: "p2", name: "Grace", score: 0, outInRound: null, departed: false, handSize: 5 },
    ],
    turnOrder: ["p1", "p2"],
    currentTurnPlayerId: overrides.currentTurnPlayerId ?? "p1",
    drawPileCount: 30,
    lastDiscard,
    buriedCount: 2,
    lastMove: null,
    lastSlapdown: null,
    moveHistory: [],
    roundResult: null,
    winnerIds: null,
  };
}
