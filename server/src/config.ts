/**
 * Operational constants — the ones about running a server, not about playing Yaniv.
 *
 * The rule constants live in `@yaniv/shared` alongside `rules.ts`, so a client can
 * answer a rules question without asking the server. See docs/adr/0002.
 */

/**
 * Names for the server-played seats, taken in order. Every one reads as a bot, so a
 * player can never mistake one for another human at the table. Long enough to fill a
 * table alongside a single human — see MAX_PLAYERS.
 */
export const BOT_NAMES = [
  "Grace (bot)",
  "Alan (bot)",
  "Edsger (bot)",
  "Barbara (bot)",
  "Tony (bot)",
];

export const ROOM_CODE_LENGTH = 4;

/** Room code alphabet, with visually ambiguous characters (O/0, I/1) removed. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
