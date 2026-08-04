import type { Card } from "@yaniv/shared";
import type { Result } from "./result.ts";

/**
 * Match-scoped player record. Note there is no hand here — hands are round-scoped and
 * live in `RoundState`, so starting a new round cannot leave a stale one behind.
 *
 * `id` is a server-issued stable id, never a socket id: the domain model has no
 * awareness of transport.
 */
export interface Player {
  id: string;
  name: string;
  score: number;
  /**
   * Whether the server plays this seat itself. Required rather than optional so a seat
   * can never be ambiguously controlled — every construction has to say which it is.
   *
   * The engine ignores this entirely: bots take turns through exactly the same
   * transitions a human does. It exists so the layer above can tell whose turn it has
   * to play on their behalf.
   */
  isBot: boolean;
}

/**
 * Everything that resets between rounds. Replacing this whole object is the only way a
 * round begins, which is what makes "forgot to clear a field" unrepresentable.
 */
export interface RoundState {
  /** playerId -> hand. Keys always match the match's player ids. */
  hands: Record<string, Card[]>;
  drawPile: Card[];
  /**
   * The most recently discarded set. Only its first and last cards may be picked up,
   * which is why this is a distinct field and not the tail of a flat array.
   */
  lastDiscard: Card[];
  /** Previously discarded cards, out of play. Reshuffled when the draw pile empties. */
  buried: Card[];
  currentTurnPlayerId: string;
  /** Seating order, fixed for the whole match. */
  turnOrder: string[];
}

export interface PlayerRoundResult {
  playerId: string;
  /**
   * Copied in when the round is scored rather than looked up later. A finished round is
   * a record of who played it, and a seat can be given up once the match ends — after
   * which the roster no longer has a name to resolve.
   */
  name: string;
  hand: Card[];
  handValue: number;
  delta: number;
  scoreAfter: number;
}

export interface RoundResult {
  roundNumber: number;
  callerId: string;
  assaferId: string | null;
  /** Starts the next round. The Assafer if there was one, else the caller. */
  winnerId: string;
  players: PlayerRoundResult[];
}

/**
 * Fields that don't vary by phase. `lastRoundResult` and `winnerIds` live here rather
 * than on one variant of the union below: `lastRoundResult` stays populated through the
 * next `playing` round (not just at `roundEnd`), and `winnerIds` is only ever non-null at
 * `gameEnd` — neither cleanly gates on the lobby/active split, so each keeps its own
 * nullability, narrowed by its own checks where read.
 */
export interface GameStateBase {
  roomCode: string;
  hostId: string;
  players: Player[];
  roundNumber: number;
  /** Null until a round has finished. */
  lastRoundResult: RoundResult | null;
  /** Null until `gameEnd`. Multiple ids on a tie for lowest score. */
  winnerIds: string[] | null;
}

/** A room before its first round: players may join, there is nothing to play yet. */
export interface GameStateLobby extends GameStateBase {
  phase: "lobby";
  round: null;
}

/**
 * A room with a dealt round. Spans `playing`, `roundEnd`, and `gameEnd` — the latter two
 * still hold the just-finished round's hands and piles, revealed face up, until the host
 * deals the next one or the match ends. "Active" names the round being populated, not "a
 * turn is currently being taken." See `CONTEXT.md`.
 */
export interface GameStateActive extends GameStateBase {
  phase: "playing" | "roundEnd" | "gameEnd";
  round: RoundState;
}

/**
 * The server's complete view of one room. Contains every hand and the full draw pile
 * order — it must never be sent to a client. Use `serializeStateForPlayer`.
 *
 * A discriminated union on `phase`: `round` is `null` in `lobby` and a populated
 * `RoundState` in every other phase, so narrowing on `phase` gives `round` its correct
 * type for free, with no `!` assertion or `??` fallback needed downstream.
 */
export type GameState = GameStateLobby | GameStateActive;

/** Shorthand for the return type of every state transition. */
export type ActionResult = Result<GameState>;

export function getPlayer(state: GameState, playerId: string): Player | undefined {
  return state.players.find((p) => p.id === playerId);
}

/** Returns a new players array with one player's fields patched. */
export function updatePlayer(
  players: Player[],
  playerId: string,
  patch: Partial<Omit<Player, "id">>,
): Player[] {
  return players.map((p) => (p.id === playerId ? { ...p, ...patch } : p));
}
