/**
 * The display-name rule: trimmed, 1–20 characters. One rule, in one place, for every
 * name a player can be known by — the name typed at a room's front door, and an
 * account's own name (docs/adr/0019). Here rather than in the server for ADR-0002's
 * reason: a client must be able to offer exactly what the server will accept, instead
 * of discovering the rule by being refused a round trip later.
 *
 * A module of its own rather than a constant in `config.ts` and a function beside it:
 * `config.ts` says every value in it is specified in `docs/rules.md`, and this is not a
 * gameplay rule — no hand is dealt differently because of it. Splitting the limit from
 * the normaliser that enforces it would also put the rule back in two files, which is
 * the thing this module exists to undo.
 *
 * What it deliberately does not hold is the sentence a refusal is worded with. Each
 * caller writes its own, as every other refusal in the repo does: the server composes
 * its message at the `err()` site, and the browser says the one thing that helps
 * somebody looking at the field they just typed into.
 */

/** The longest a display name may be, counted after trimming. */
export const MAX_DISPLAY_NAME_LENGTH = 20;

/**
 * The name to use, or `null` when there is no usable name in what was typed.
 *
 * One answer rather than a validator plus a separate trim: a caller that asked "is this
 * legal?" and then trimmed for itself could trim differently, and the stored name would
 * stop being the one that was checked.
 */
export function normalizeDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null;
  return trimmed;
}
