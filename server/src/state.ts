import type { Card, DrawSource, RoomSettings } from "@yaniv/shared";
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
   * The secret that proves a fresh connection is entitled to this seat. Issued from a
   * CSPRNG when the seat is created and fixed for the life of the room — never rotated,
   * never regenerated, which is why `updatePlayer` below cannot patch it.
   *
   * A credential, so it is a secret of the same class as a hidden hand and kept the same
   * way: `serializeStateForPlayer` never places it in any view, in any phase. Bots hold
   * one too — nothing reconnects on their behalf, but a required field is what makes an
   * uncredentialed seat unrepresentable, exactly as `isBot` does for control.
   */
  resumeToken: string;
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
 * An open slapdown window: the card `playerId` has just drawn and may put straight back
 * down, out of turn, until the next player acts. docs/rules.md §9.
 *
 * One object rather than two nullable fields, so "a card is slappable but by nobody" is
 * not a state anything has to consider.
 */
export interface SlapdownWindow {
  playerId: string;
  card: Card;
}

/**
 * The turn that just resolved: whose it was, where they drew from, and the card they
 * drew. Written by `takeTurn` and by nothing else — a slapdown and a Yaniv call are not
 * draws, so they leave whatever is here alone.
 *
 * Fully populated, unlike `LastMoveView`: the redaction of `drawnCard` is a fact about a
 * viewer, so it belongs to `serializeStateForPlayer` and not to the domain model.
 *
 * Exactly one move, overwritten by the next, never a log — see the "Out of Scope" note on
 * issue #69.
 */
export interface LastMove {
  playerId: string;
  drawSource: DrawSource;
  drawnCard: Card;
}

/**
 * The slapdown that just resolved: whose it was and the card they put down. Written by
 * `slapDown` and by nothing else.
 *
 * A sibling of `LastMove` rather than a part of it — a slapdown is not a turn (ADR-0005)
 * and records no draw, so the last move stays exactly as it was. It is a separate fact
 * because it is one nothing downstream can recover: `lastDiscard` grows by a card, but
 * whose hand it came out of is never on the wire, an open window being private to its
 * holder. docs/adr/0008.
 *
 * Same shape as `SlapdownWindow` and deliberately not the same type: one says a card may
 * still go down, the other that one already has.
 */
export interface LastSlapdown {
  playerId: string;
  card: Card;
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
  /**
   * The slapdown left open by the turn that just resolved, or null. Belongs to the
   * player *before* the current one — a slapdown does not consume a turn, so the turn
   * has already moved on by the time this is readable.
   */
  slapdown: SlapdownWindow | null;
  /**
   * The turn that just resolved, or null before the round's first one. Kept because it is
   * not recoverable from the rest of this state: once a card leaves the pile for a hand,
   * nothing a client can see says which of the pickup-eligible ones it was.
   */
  lastMove: LastMove | null;
  /**
   * The slapdown that just resolved, or null before the round's first one. Overwritten by
   * the next slapdown and left alone by everything else, so a client watches it for change
   * exactly as it watches `lastMove`.
   */
  lastSlapdown: LastSlapdown | null;
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
  /** 0 unless a milestone reduction fired this round; `MILESTONE_REDUCTION` when it did. */
  milestoneReduction: number;
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
  /**
   * Host-chosen, seeded with `shared`'s rule constants as defaults at `createRoom`
   * (except `botCount`, which defaults to zero — see docs/adr/0006). Editable only from
   * the lobby, by the host, via `updateSettings`; the first deal locks it for the life of
   * the room.
   */
  settings: RoomSettings;
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

/**
 * Returns a new players array with one player's fields patched. Neither the id nor the
 * resume token is patchable: both are issued once, at the seat's creation, and a
 * transition that could rewrite either would be a seat quietly becoming a different one.
 */
export function updatePlayer(
  players: Player[],
  playerId: string,
  patch: Partial<Omit<Player, "id" | "resumeToken">>,
): Player[] {
  return players.map((p) => (p.id === playerId ? { ...p, ...patch } : p));
}
