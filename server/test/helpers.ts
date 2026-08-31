import assert from "node:assert/strict";
import type {
  Card,
  DrawSource,
  GameErrorCode,
  Phase,
  PlayerGameView,
  PlayingSelfView,
  RoomSettings,
} from "@yaniv/shared";
import { HAND_SIZE, MAX_SCORE, YANIV_THRESHOLD } from "@yaniv/shared";
import type { Clock } from "../src/clock.ts";
import { createDeck } from "../src/deck.ts";
import type { Result } from "../src/result.ts";
import type { GameState, GameStateActive, Player, RoundState } from "../src/state.ts";
import { inMatch } from "../src/state.ts";

const DEFAULT_SETTINGS: RoomSettings = {
  handSize: HAND_SIZE,
  yanivThreshold: YANIV_THRESHOLD,
  maxScore: MAX_SCORE,
  botCount: 0,
};

const BY_ID = new Map(createDeck().map((c) => [c.id, c]));

/**
 * Prefix every resume token a test hands out shares. A token is a credential, so the
 * assertion worth making is that no substring of one reaches a client — this is what a
 * leak test greps a serialized payload for.
 */
export const RESUME_TOKEN_MARK = "resume-token-for-";

/**
 * A `newResumeToken` for a `RoomManager` under test: real seats, marked tokens. The real
 * generator is a CSPRNG whose output no test could name, so a suite proving a token never
 * reaches a client issues its own recognizable ones instead.
 */
export function markedResumeTokens(): () => string {
  let issued = 0;
  return () => `${RESUME_TOKEN_MARK}${++issued}`;
}

/** Look up a real card by id, so tests never hand-build inconsistent cards. */
export function card(id: string): Card {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown card id: ${id}`);
  return found;
}

export function cards(...ids: string[]): Card[] {
  return ids.map(card);
}

/** One logged move for `makeState`, mirroring `MoveHistoryEntry` with ids for cards. */
export type MoveHistorySpec =
  | {
      kind: "turn";
      playerId: string;
      discardedIds: string[];
      drawSource: DrawSource;
      drawnCardId: string;
    }
  | { kind: "slapdown"; playerId: string; cardId: string };

export interface StateOptions {
  phase?: Phase;
  players?: Array<{
    id: string;
    name?: string;
    score?: number;
    isBot?: boolean;
    /** The round they went out in. Omitted means still in the match. */
    outInRound?: number | null;
    /** They gave their seat up. Implies `outInRound` — set both to pin a left seat down. */
    departed?: boolean;
  }>;
  /** playerId -> card ids. */
  hands?: Record<string, string[]>;
  drawPile?: string[];
  lastDiscard?: string[];
  buried?: string[];
  currentTurnPlayerId?: string;
  roundNumber?: number;
  /** An open slapdown window, named by whose it is and which card id it holds. */
  slapdown?: { playerId: string; cardId: string };
  /** A move already recorded on the round, named by its drawn card's id. */
  lastMove?: { playerId: string; drawSource: DrawSource; drawnCardId: string };
  /** A slapdown already recorded on the round, named by whose it was and its card id. */
  lastSlapdown?: { playerId: string; cardId: string };
  /** Moves already logged on the round, oldest first, named by their cards' ids. */
  moveHistory?: MoveHistorySpec[];
  settings?: Partial<RoomSettings>;
}

/** Build an exact game state, bypassing the deal, so a scenario can be pinned down. */
export function makeState(options: StateOptions = {}): GameState {
  const specs = options.players ?? [{ id: "p1" }, { id: "p2" }];
  const players: Player[] = specs.map((p, i) => ({
    id: p.id,
    name: p.name ?? `Player ${i + 1}`,
    score: p.score ?? 0,
    isBot: p.isBot ?? false,
    outInRound: p.outInRound ?? null,
    departed: p.departed ?? false,
    // Derived from the id rather than random, so a leak test can name the exact string
    // it expects never to see. `RESUME_TOKEN_MARK` is what identifies one on the wire.
    resumeToken: `${RESUME_TOKEN_MARK}${p.id}`,
  }));
  // Only the seats still in the match are dealt to and take turns — the roster keeps
  // whoever has gone out, in the place they were sitting. docs/rules.md §7.
  const turnOrder = players.filter(inMatch).map((p) => p.id);
  const phase = options.phase ?? "playing";

  const base = {
    roomCode: "TEST",
    // The roster's first seat, not turn order's: a host who has gone out is still the host.
    hostId: players[0]!.id,
    players,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
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
    lastMove: options.lastMove
      ? {
          playerId: options.lastMove.playerId,
          drawSource: options.lastMove.drawSource,
          drawnCard: card(options.lastMove.drawnCardId),
        }
      : null,
    lastSlapdown: options.lastSlapdown
      ? {
          playerId: options.lastSlapdown.playerId,
          card: card(options.lastSlapdown.cardId),
        }
      : null,
    moveHistory: (options.moveHistory ?? []).map((entry) =>
      entry.kind === "turn"
        ? {
            kind: "turn" as const,
            playerId: entry.playerId,
            discarded: cards(...entry.discardedIds),
            drawSource: entry.drawSource,
            drawnCard: card(entry.drawnCardId),
          }
        : {
            kind: "slapdown" as const,
            playerId: entry.playerId,
            card: card(entry.cardId),
          },
    ),
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

/**
 * The viewer's own view, narrowed to the variant that holds a hand.
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
 * answer `isSlapdownTarget` gives the browser client.
 */
export function slapdownOpen(view: PlayerGameView): boolean {
  return !view.you.spectating && view.you.slapdownEligible;
}

/**
 * A clock a test drives by hand, so bot think time is asserted without waiting out
 * seconds of it.
 *
 * Everything set on it waits, which is the whole point: a suite can assert a bot's turn
 * has *not* happened as precisely as it asserts that it has. A suite about anything else
 * switches think time off instead of taking one of these.
 */
export interface TestClock extends Clock {
  /** How many timers are waiting. */
  pending: () => number;
  /** The delay each waiting timer asked for, longest-waiting first. */
  delays: () => number[];
  /** Run the timer that has been waiting longest, and answer the delay it asked for. */
  tick: () => number;
  /**
   * Run the longest-waiting timer that asked for exactly `ms`.
   *
   * A room can have several kinds of work pending at once — a bot mid-think, a scored
   * round dealing itself on, the room's own grace period — and a test about one of them
   * has to be able to fire that one. The interval is what names it: each behaviour has
   * its own constant, so `tickAt(ROOM_SWEEP_MS)` says which timer it means and fails
   * loudly rather than silently running somebody else's.
   */
  tickAt: (ms: number) => void;
}

export function testClock(): TestClock {
  const waiting: { ms: number; run: () => void }[] = [];

  function runAt(at: number): void {
    const [timer] = waiting.splice(at, 1);
    timer!.run();
  }

  return {
    after: (ms, run) => {
      const timer = { ms, run };
      waiting.push(timer);
      return () => {
        const at = waiting.indexOf(timer);
        if (at !== -1) waiting.splice(at, 1);
      };
    },
    pending: () => waiting.length,
    delays: () => waiting.map((timer) => timer.ms),
    tick: () => {
      const timer = waiting[0];
      if (!timer) throw new Error("nothing is waiting on the clock");
      runAt(0);
      return timer.ms;
    },
    tickAt: (ms) => {
      const at = waiting.findIndex((timer) => timer.ms === ms);
      if (at === -1) {
        throw new Error(`no timer waiting ${ms}ms (waiting: ${waiting.map((t) => t.ms)})`);
      }
      runAt(at);
    },
  };
}
