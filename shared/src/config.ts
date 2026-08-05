/** Rule constants. Every value here is specified in docs/rules.md. */

export const HAND_SIZE = 5;

/** Shortest legal run. docs/rules.md §4. */
export const MIN_RUN_LENGTH = 3;

/**
 * A run must be anchored by at least this many non-joker cards. Two jokers plus a
 * single card do not establish a sequence. docs/rules.md §4.
 */
export const MIN_RUN_REAL_CARDS = 2;

/** Maximum hand value that permits calling Yaniv. docs/rules.md §6. */
export const YANIV_THRESHOLD = 7;

/** Added to the caller's hand value when they are Assafed. docs/rules.md §6. */
export const ASSAF_PENALTY = 30;

/** The match ends once any player's total is strictly greater than this. §7. */
export const MAX_SCORE = 100;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
