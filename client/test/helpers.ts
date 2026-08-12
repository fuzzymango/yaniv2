/**
 * Fixtures for the client's tests — a deck to build hands from, and a clock to drive the
 * pacing with.
 *
 * The deck is rebuilt here from `shared`'s own ranks, suits and `rankToValue` rather than
 * imported from `server/src`, for the reason `shared/test/helpers.ts` does the same: card
 * values are a rule (docs/rules.md §1), so there is one definition and no copy that could
 * drift — but a *pure* client test has no business reaching into the server for it. Only
 * the id format is restated, and that is the contract documented on `Card`.
 */

import type { Card, PlayerGameView } from "@yaniv/shared";
import { RANKS, SUITS, rankToValue } from "@yaniv/shared";
import type { Clock } from "../src/pacing.ts";

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
 * A clock a test drives by hand, so pacing is asserted without waiting in real time.
 *
 * It starts *unheld*, running every timer the moment it is set: a session on one of these
 * behaves exactly as it did before there was any pacing, which is what every suite that
 * is about something else wants. `hold` is what makes it a clock to watch — from then on
 * nothing runs until `tick` is called, and `pending` says whether anything is waiting.
 */
export interface TestClock extends Clock {
  hold: () => void;
  /** Run the timer that has been waiting longest, and answer the delay it asked for. */
  tick: () => number;
  pending: () => number;
}

export function testClock(): TestClock {
  let held = false;
  const waiting: { ms: number; run: () => void }[] = [];

  return {
    after: (ms, run) => {
      if (!held) {
        run();
        return () => {};
      }
      const timer = { ms, run };
      waiting.push(timer);
      return () => {
        const at = waiting.indexOf(timer);
        if (at !== -1) waiting.splice(at, 1);
      };
    },
    hold: () => {
      held = true;
    },
    pending: () => waiting.length,
    tick: () => {
      const timer = waiting.shift();
      if (!timer) throw new Error("nothing is waiting on the clock");
      timer.run();
      return timer.ms;
    },
  };
}

/**
 * A mid-round view with the two things a turn is read against — the hand it comes from
 * and the discard it may be drawn from. Everything else is filled in plausibly, because
 * the turn module reads none of it and a test that set it would be claiming otherwise.
 */
export function viewOf(hand: Card[], lastDiscard: Card[]): PlayerGameView {
  return {
    roomCode: "ABCD",
    phase: "playing",
    roundNumber: 1,
    hostId: "p1",
    you: { id: "p1", name: "Ada", score: 0, hand, slapdownEligible: false },
    opponents: [{ id: "p2", name: "Grace", score: 0, handSize: 5 }],
    turnOrder: ["p1", "p2"],
    currentTurnPlayerId: "p1",
    drawPileCount: 30,
    lastDiscard,
    buriedCount: 2,
    roundResult: null,
    winnerIds: null,
  };
}
