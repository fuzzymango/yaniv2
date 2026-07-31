/** Rule constants. Every value here is specified in docs/rules.md. */

export const HAND_SIZE = 5;

/** Maximum hand value that permits calling Yaniv. docs/rules.md §6. */
export const YANIV_THRESHOLD = 7;

/** Added to the caller's hand value when they are Assafed. docs/rules.md §6. */
export const ASSAF_PENALTY = 30;

/** The match ends once any player's total is strictly greater than this. §7. */
export const MAX_SCORE = 100;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export const ROOM_CODE_LENGTH = 4;

/** Room code alphabet, with visually ambiguous characters (O/0, I/1) removed. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
