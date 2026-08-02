/**
 * Every way a client request can be legitimately rejected. Shared so the client can
 * branch on a code rather than parse English prose.
 *
 * These are *expected* outcomes, not defects. Genuine bugs still throw.
 */
export type GameErrorCode =
  // room / membership
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "INVALID_NAME"
  | "PLAYER_NOT_FOUND"
  | "NOT_HOST"
  | "NOT_ENOUGH_PLAYERS"
  // phase / turn
  | "WRONG_PHASE"
  | "NOT_YOUR_TURN"
  // discarding
  | "EMPTY_DISCARD_SET"
  | "DUPLICATE_CARDS"
  | "CARD_NOT_IN_HAND"
  | "INVALID_SET"
  // drawing
  | "DISCARD_PILE_EMPTY"
  | "CARD_NOT_PICKUP_ELIGIBLE"
  | "DECK_EXHAUSTED"
  // yaniv
  | "YANIV_THRESHOLD_NOT_MET";

export interface GameError {
  code: GameErrorCode;
  message: string;
}
