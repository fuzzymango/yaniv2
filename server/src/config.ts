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

/**
 * **Bot think time**: how long a bot waits before taking its turn, uniform across bots
 * and every turn alike.
 *
 * Long enough that a human who has just drawn a matching card can see the slapdown
 * window and win it over a round trip, short enough that a lap of five bots is a rhythm
 * rather than a wait. A property of this server rather than of a room — not a setting,
 * not on the wire, not locked at the first deal — which is why it sits here with the
 * other operational constants and not with the rules in `@yaniv/shared`.
 */
export const BOT_THINK_MS = 1500;

export const ROOM_CODE_LENGTH = 4;

/** Room code alphabet, with visually ambiguous characters (O/0, I/1) removed. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
