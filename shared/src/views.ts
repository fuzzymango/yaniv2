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

/**
 * Which pile a card was drawn from. Named apart from `DrawAction`, which says the same
 * thing about a draw being *asked* for and stays a discriminated union so only its
 * `discard` half carries a card id. `opensSlapdown` keeps its own literals on purpose —
 * the rulebook owes the wire contract nothing (ADR-0002).
 */
export type DrawSource = "deck" | "discard";

/**
 * The move that just resolved — whose it was, where they drew from, and which card they
 * took. Sent so a client can show the draw happening: diffing two consecutive views
 * cannot recover which card was taken whenever more than one was pickup-eligible (a run
 * exposes both ends, a same-rank set every card), since what is left behind reaches the
 * client as `buriedCount` and nothing more.
 *
 * The discarded half of the move needs no field here: `lastDiscard` already carries
 * exactly what the mover put down.
 */
export interface LastMoveView {
  playerId: string;
  drawSource: DrawSource;
  /**
   * Null where this viewer is not entitled to know it: a card off the deck is a card of
   * the mover's hidden hand, so only the mover is told which it was. A card off the pile
   * was face up a moment before it was taken, so everyone is. `serializeStateForPlayer`
   * draws that line — the same one `SelfView.slapdownEligible` sits on.
   */
  drawnCard: Card | null;
}

/**
 * The slapdown that just resolved — whose it was and the card they put down. A sibling of
 * `LastMoveView`, not a part of it: a slapdown is not a turn and records no draw, so the
 * last move is left standing (docs/adr/0007) while this changes.
 *
 * Sent because it is not recoverable downstream either: `lastDiscard` grows by a card, but
 * nothing on the wire says whose hand that card came out of — an open window is private to
 * its holder (`SelfView.slapdownEligible`), so a client watching an opponent has no seat to
 * name. docs/adr/0008.
 *
 * Nothing here is redacted, unlike `LastMoveView.drawnCard`: by the time this is written
 * the card is face up on `lastDiscard`, which every viewer is sent in full.
 */
export interface LastSlapdownView {
  playerId: string;
  card: Card;
}

/** One player's revealed result for a finished round. */
export interface PlayerRoundResultView {
  playerId: string;
  name: string;
  hand: Card[];
  handValue: number;
  /** Points added to this player's score for the round. */
  delta: number;
  /** 0 unless a milestone reduction fired this round; `MILESTONE_REDUCTION` when it did. */
  milestoneReduction: number;
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
  /**
   * The turn that just resolved, redacted per viewer, or null when no turn has been taken
   * in this round. Unchanged by a slapdown or a Yaniv call — neither is a draw — so a
   * client watches it for changes rather than treating every arrival as fresh news.
   */
  lastMove: LastMoveView | null;
  /**
   * The slapdown that just resolved, or null before one has been made in this round.
   * Unchanged by a turn or a Yaniv call, so a client watches it for changes the same way
   * it watches `lastMove`. Told to everyone in full — see `LastSlapdownView`.
   */
  lastSlapdown: LastSlapdownView | null;

  /** Populated only in `roundEnd` and `gameEnd`, where all hands are revealed. */
  roundResult: RoundResultView | null;
  /** Populated only in `gameEnd`. Multiple ids on a tie. */
  winnerIds: string[] | null;
}
