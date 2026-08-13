import type { Card } from "./cards.ts";
import type { RoomSettings } from "./settings.ts";

export type Phase = "lobby" | "playing" | "roundEnd" | "gameEnd";

/** The viewing player. Always includes their own hand. */
export interface SelfView {
  id: string;
  name: string;
  score: number;
  /** Empty during `lobby`, when no round is dealt. */
  hand: Card[];
  /**
   * Whether this player has an open slapdown window right now — the card they just drew
   * may go straight back down on the set it matches. docs/rules.md §9.
   *
   * Lives here rather than anywhere else in `PlayerGameView` because it is private: it
   * says the holder drew a rank they had just discarded, which nothing else on the wire
   * reveals. `OpponentView` has no such field to populate, by construction.
   */
  slapdownEligible: boolean;
}

/**
 * Everyone else. Deliberately has no `hand` field at all — not an optional one — so
 * there is no shape where an opponent's cards could be populated by accident.
 */
export interface OpponentView {
  id: string;
  name: string;
  score: number;
  handSize: number;
}

/** One player's revealed result for a finished round. */
export interface PlayerRoundResultView {
  playerId: string;
  name: string;
  hand: Card[];
  handValue: number;
  /** Points added to this player's score for the round. */
  delta: number;
  scoreAfter: number;
}

export interface RoundResultView {
  roundNumber: number;
  callerId: string;
  /** Null when the Yaniv call succeeded unopposed. */
  assaferId: string | null;
  /** Who starts the next round: the Assafer if there was one, else the caller. */
  winnerId: string;
  players: PlayerRoundResultView[];
}

/**
 * What a single client receives. Built by `serializeStateForPlayer` — the server's
 * `GameState` must never be sent directly. See docs/rules.md and the architecture doc.
 */
export interface PlayerGameView {
  roomCode: string;
  phase: Phase;
  roundNumber: number;
  hostId: string;
  /**
   * The room's live settings — present in every phase, not just `lobby`. Load-bearing
   * for a client's own pre-turn legality check (`isLegalCall`), not just display: a
   * hardcoded threshold would silently diverge from a room started with a non-default
   * one. docs/adr/0006.
   */
  settings: RoomSettings;

  you: SelfView;
  opponents: OpponentView[];
  /** Seating order by player id, including the viewer. */
  turnOrder: string[];

  /** Null outside an active round. */
  currentTurnPlayerId: string | null;
  /** Count only — the draw pile's contents and order are never sent. */
  drawPileCount: number;
  /** The last discarded set, face up. Its first and last cards are pickup-eligible. */
  lastDiscard: Card[];
  /** Face-up but out of play. Count only, to keep payloads small. */
  buriedCount: number;

  /** Populated only in `roundEnd` and `gameEnd`, where all hands are revealed. */
  roundResult: RoundResultView | null;
  /** Populated only in `gameEnd`. Multiple ids on a tie. */
  winnerIds: string[] | null;
}
