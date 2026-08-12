import type { GameError } from "./errors.ts";
import type { PlayerGameView } from "./views.ts";

/** Where the single drawn card comes from. See docs/rules.md §3. */
export type DrawAction =
  | { source: "deck" }
  | { source: "discard"; cardId: string };

/** A whole turn: discard a set, then draw one card. Indivisible. */
export interface TurnAction {
  discardCardIds: string[];
  draw: DrawAction;
}

/** Standard ack callback shape for request/response events. */
export type Ack<T> = (
  result: { ok: true; value: T } | { ok: false; error: GameError },
) => void;

export interface ClientToServerEvents {
  createRoom: (playerName: string, ack: Ack<{ roomCode: string; playerId: string }>) => void;
  joinRoom: (
    roomCode: string,
    playerName: string,
    ack: Ack<{ playerId: string }>,
  ) => void;
  startGame: (ack: Ack<null>) => void;
  takeTurn: (action: TurnAction, ack: Ack<null>) => void;
  callYaniv: (ack: Ack<null>) => void;
  /**
   * Put the card just drawn straight back down, out of turn, while the window the last
   * turn opened is still open. docs/rules.md §9.
   *
   * No payload: a player draws exactly one card per turn, so the server already knows
   * which card this is about — and taking one on trust would let a caller name any card
   * they liked. Losing the race to the next player's turn is answered with
   * `SLAPDOWN_NOT_AVAILABLE`, the same as never having had a window at all.
   */
  slapDown: (ack: Ack<null>) => void;
  startNextRound: (ack: Ack<null>) => void;
  /** Host only, from a finished match: another match for the same table, dealt at once. */
  playAgain: (ack: Ack<null>) => void;
  /**
   * Leave the room, from the lobby or a finished match. What that costs the rest of the
   * table is the server's decision, not the caller's: a non-host frees their own seat,
   * the host closes the room. See CONTEXT.md.
   */
  exitToMenu: (ack: Ack<null>) => void;
}

export interface ServerToClientEvents {
  /** Sent per-socket, never broadcast raw — each player gets their own view. */
  gameStateUpdate: (view: PlayerGameView) => void;
  playerJoined: (playerName: string) => void;
  playerLeft: (playerName: string) => void;
  /**
   * The room is gone and this connection is no longer in it. Distinct from a state
   * update because there is no longer a state to publish — it is the last thing a
   * player hears about that room.
   */
  roomClosed: (reason: string) => void;
  errorMessage: (error: GameError) => void;
}
