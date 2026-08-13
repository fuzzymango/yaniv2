/**
 * The two questions a settings form asks that are about the form rather than the room.
 *
 * `turn.ts`'s counterpart for the lobby: pure, total, and reaching no socket. Everything
 * about what a room *may* be set to belongs to `@yaniv/shared` and is asked of it there —
 * the option sets, the seats a bot count has left (`botSeatLimit`), and whether an object
 * is settings at all (`isValidSettings`) — for the reason ADR-0002 gives for the rulebook:
 * a lobby has to offer exactly what the server accepts, and two lists would be two chances
 * to disagree.
 *
 * What is left here is what only a screen has: text somebody is part-way through typing,
 * and whether the room has caught up with what was asked of it.
 */

import type { RoomSettings } from "@yaniv/shared";

/**
 * A typed field as the whole number it says, or null when it does not say one — empty,
 * half-typed, not a number, or not a whole one.
 *
 * Deliberately says nothing about whether the number is a score a room would accept:
 * that is `isValidSettings`' answer and asking it twice is how the two come apart. Null
 * is not an error to show anybody — it is a field nobody finished.
 */
export function wholeNumber(typed: string): number | null {
  const text = typed.trim();
  if (text.length === 0) return null;

  const value = Number(text);
  return Number.isInteger(value) ? value : null;
}

/**
 * Whether two sets of choices are the same choices.
 *
 * What an editor asks "has the room caught up with me yet?" with. Field by field rather
 * than by identity, because the two are never the same object: one was built from a tap
 * and the other came off the wire.
 */
export function sameSettings(a: RoomSettings, b: RoomSettings): boolean {
  return (
    a.handSize === b.handSize &&
    a.yanivThreshold === b.yanivThreshold &&
    a.maxScore === b.maxScore &&
    a.botCount === b.botCount
  );
}
