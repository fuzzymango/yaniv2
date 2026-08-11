import assert from "node:assert/strict";
import type { Card, GameErrorCode, Phase } from "@yaniv/shared";
import { createDeck } from "../src/deck.ts";
import type { Result } from "../src/result.ts";
import type { GameState, GameStateActive, Player, RoundState } from "../src/state.ts";

const BY_ID = new Map(createDeck().map((c) => [c.id, c]));

/** Look up a real card by id, so tests never hand-build inconsistent cards. */
export function card(id: string): Card {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown card id: ${id}`);
  return found;
}

export function cards(...ids: string[]): Card[] {
  return ids.map(card);
}

export interface StateOptions {
  phase?: Phase;
  players?: Array<{ id: string; name?: string; score?: number; isBot?: boolean }>;
  /** playerId -> card ids. */
  hands?: Record<string, string[]>;
  drawPile?: string[];
  lastDiscard?: string[];
  buried?: string[];
  currentTurnPlayerId?: string;
  roundNumber?: number;
  /** An open slapdown window, named by whose it is and which card id it holds. */
  slapdown?: { playerId: string; cardId: string };
}

/** Build an exact game state, bypassing the deal, so a scenario can be pinned down. */
export function makeState(options: StateOptions = {}): GameState {
  const specs = options.players ?? [{ id: "p1" }, { id: "p2" }];
  const players: Player[] = specs.map((p, i) => ({
    id: p.id,
    name: p.name ?? `Player ${i + 1}`,
    score: p.score ?? 0,
    isBot: p.isBot ?? false,
  }));
  const turnOrder = players.map((p) => p.id);
  const phase = options.phase ?? "playing";

  const base = {
    roomCode: "TEST",
    hostId: turnOrder[0]!,
    players,
    roundNumber: options.roundNumber ?? 1,
    lastRoundResult: null,
    winnerIds: null,
  };

  if (phase === "lobby") {
    return { ...base, phase, round: null };
  }

  const hands: Record<string, Card[]> = {};
  for (const id of turnOrder) {
    hands[id] = cards(...(options.hands?.[id] ?? []));
  }
  const round: RoundState = {
    hands,
    drawPile: cards(...(options.drawPile ?? [])),
    lastDiscard: cards(...(options.lastDiscard ?? [])),
    buried: cards(...(options.buried ?? [])),
    currentTurnPlayerId: options.currentTurnPlayerId ?? turnOrder[0]!,
    turnOrder,
    slapdown: options.slapdown
      ? { playerId: options.slapdown.playerId, card: card(options.slapdown.cardId) }
      : null,
  };

  const active: GameStateActive = { ...base, phase, round };
  return active;
}

/** Every card id currently in the round, sorted. Used for conservation invariants. */
export function allCardIds(state: GameState): string[] {
  const round = state.round;
  if (!round) return [];
  return [
    ...Object.values(round.hands).flat(),
    ...round.drawPile,
    ...round.lastDiscard,
    ...round.buried,
  ]
    .map((c) => c.id)
    .sort();
}

export function unwrap<T>(result: Result<T>): T {
  assert.ok(
    result.ok,
    `expected ok, got ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`,
  );
  return result.value;
}

export function expectErr<T>(result: Result<T>, code: GameErrorCode): void {
  assert.equal(result.ok, false, `expected error ${code}, got ok`);
  if (!result.ok) assert.equal(result.error.code, code);
}

export function ids(list: readonly Card[]): string[] {
  return list.map((c) => c.id);
}
