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

/** A running total landing exactly on a multiple of this triggers a reduction. §7. */
export const MILESTONE_INTERVAL = 50;

/** Subtracted from a score that lands exactly on a `MILESTONE_INTERVAL` multiple. §7. */
export const MILESTONE_REDUCTION = 50;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/**
 * The one exception to this file's first line: a wire-contract fact, not a rule. The OAuth
 * client both halves must agree on — the browser's Google button asks for tokens issued
 * to it, and the server refuses any whose `aud` is anything else — so one value, read by
 * both, and they cannot disagree. Public by design and committed rather than an
 * environment variable (docs/adr/0020); issued in #183.
 */
export const GOOGLE_CLIENT_ID =
  "444012542750-lrv168q5sk0qpt03vgbsk7vqjg8orh5o.apps.googleusercontent.com";
