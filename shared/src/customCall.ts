/**
 * The custom-call rule: what a **custom Yaniv call** or **custom Assaf call** may say
 * (`CONTEXT.md`, **Custom calls**; issue #126). The display-name rule's sibling, here for the
 * same reason that one is (ADR-0002): the server enforces it, and the profile asks it before
 * sending, so a client offers exactly what the server will accept.
 *
 * A module of its own rather than a second function in `displayName.ts`: the two rules are
 * deliberately different — a call is shouted where a name is not, so it allows a little
 * punctuation, and it may be empty — and putting them in one file would invite reading one
 * as a variant of the other's pattern.
 *
 * Like the display name it is a product rule, not an injection defence. What it is for is the
 * banner: **no emoji and no other symbols**, because an emoji keeps its own colours, and the
 * banner's colour is what says which call it was — a red banner is an Assaf whatever it says.
 * Nothing invisible, no tab and no doubled space, so what the table sees is all of what was
 * chosen. A refusal's sentence is each caller's, as for names.
 */

/** The two calls a round can turn on, and so the two an account may choose words for. */
export type Call = "yaniv" | "assaf";

/**
 * The longest a custom call may be, counted on the trimmed text **upper-cased** — the form
 * the banner draws, which can be longer than what was typed (`ß` is `SS`). The number #234's
 * prototype measured: at the banner's smallest size and three lines, 24 of the widest Latin
 * letter fit over the most cramped seat on a 360px phone. Counted in UTF-16 units, as the
 * display name is, which only ever errs towards fitting.
 */
export const MAX_CUSTOM_CALL_LENGTH = 24;

/**
 * Words of letters, digits and `! ? . , ' -`, one U+0020 space between each. The display
 * name's pattern with the punctuation added to what a word may be made of, so `I WIN!` and
 * `WHO'S NEXT?` are calls and a doubled space, a tab or a non-breaking one still is not.
 */
const CALL_PATTERN = /^[\p{L}\p{N}!?.,'-]+( [\p{L}\p{N}!?.,'-]+)*$/u;

/**
 * The rule's answer: the call to keep — `null` where the text was empty, which **unsets** it
 * and puts the banner's own word back — or refused.
 *
 * Tagged rather than a bare `string | null`, the display name's shape, because a call has
 * three answers where a name has two: kept, unset and refused. Spelling unset as `""` would
 * hand every caller an empty string to remember never to store.
 */
export type CustomCallVerdict =
  | { readonly accepted: true; readonly customCall: string | null }
  | { readonly accepted: false };

/**
 * Judge a custom call as typed. Trimming is the only tidying it does: a call with a
 * character the rule refuses is refused, never stripped into one that passes — the table
 * never hears words nobody chose.
 */
export function normalizeCustomCall(text: string): CustomCallVerdict {
  const trimmed = text.trim();
  if (trimmed === "") return { accepted: true, customCall: null };
  if (trimmed.toUpperCase().length > MAX_CUSTOM_CALL_LENGTH || !CALL_PATTERN.test(trimmed)) {
    return { accepted: false };
  }
  return { accepted: true, customCall: trimmed };
}
