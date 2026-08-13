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
  /** This connection already represents a seated player. Transport-only. */
  | "ALREADY_IN_ROOM"
  | "PLAYER_NOT_FOUND"
  | "NOT_HOST"
  | "NOT_ENOUGH_PLAYERS"
  // room settings
  /**
   * A settings object with a field outside its range or enum, or not a settings object at
   * all. One code for all four fields: the lobby offers only valid values, so this is
   * defense against an off-contract client rather than a validation message anyone reads.
   */
  | "INVALID_SETTINGS"
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
  | "YANIV_THRESHOLD_NOT_MET"
  // slapdown
  /**
   * No window open for this caller: it never opened, they have already slapped, or the
   * next player took their turn first.
   */
  | "SLAPDOWN_NOT_AVAILABLE";

export interface GameError {
  code: GameErrorCode;
  message: string;
}
