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

import type { Card, PlayerGameView, PlayingSelfView } from "@yaniv/shared";
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
 * The viewer's own view, narrowed to the variant that holds a hand.
 *
 * A deliberate copy of `server/test/helpers.ts`'s, as the deck above is: a client test has
 * no business importing the server's fixtures, and both are three lines over a wire type
 * they share. What either could drift into is a shape `@yaniv/shared` would reject.
 *
 * `SelfView` is tagged by whether its owner is still in the match (issue #143), and a
 * spectator's has no `hand` and no `slapdownEligible` to read. Every suite that asks for
 * either is about a player still playing, so the narrowing is a fixture concern rather
 * than something each assertion should restate — and a scenario that drifted into
 * spectating fails here, by name, instead of at a confusing assertion downstream.
 */
export function playingSelf(view: PlayerGameView): PlayingSelfView {
  if (view.you.spectating) {
    throw new Error(`expected ${view.you.id} to still be in the match, not spectating`);
  }
  return view.you;
}

/**
 * Whether this viewer holds an open slapdown window — the total question, over either
 * shape of self view.
 *
 * `playingSelf` is for a scenario that has pinned a player down as still playing; this is
 * for the suites that scan every position a seat was sent, across matches a player may
 * have been knocked out of along the way. A watcher holds no window, which is the same
 * answer `isSlapdownTarget` gives the screen.
 */
export function slapdownOpen(view: PlayerGameView): boolean {
  return !view.you.spectating && view.you.slapdownEligible;
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
      accountId: null,
      spectating: false,
      hand,
      outInRound: null,
      departed: false,
      connected: true,
      slapdownEligible: overrides.slapdownEligible ?? false,
    },
    opponents: [
      {
        id: "p2",
        name: "Grace",
        score: 0,
        accountId: null,
        outInRound: null,
        departed: false,
        connected: true,
        spectating: false,
        handSize: 5,
      },
    ],
    seating: ["p1", "p2"],
    turnOrder: ["p1", "p2"],
    currentTurnPlayerId: overrides.currentTurnPlayerId ?? "p1",
    drawPileCount: 30,
    lastDiscard,
    buriedCount: 2,
    lastMove: null,
    lastSlapdown: null,
    moveHistory: [],
    scorecard: [],
    roundResult: null,
    winnerIds: null,
  };
}

/**
 * The same mid-round position, seen by somebody the match has gone on without: the table
 * entire, and a self view with no hand in it at all (issue #143).
 *
 * A separate fixture rather than an override on `viewOf`, because the difference is the
 * shape and not a field — a spectator has no hand to pass in.
 */
export function spectatorViewOf(lastDiscard: Card[]): PlayerGameView {
  const view = viewOf([], lastDiscard, { currentTurnPlayerId: "p2" });
  return {
    ...view,
    you: {
      id: "p1",
      name: "Ada",
      score: 104,
      accountId: null,
      spectating: true,
      outInRound: 3,
      departed: false,
      connected: true,
    },
    turnOrder: ["p2"],
  };
}
