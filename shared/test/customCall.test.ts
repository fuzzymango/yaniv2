/**
 * The custom-call rule, which every custom Yaniv call and custom Assaf call goes through
 * (`CONTEXT.md`, **Custom calls**): the display name's words and a little punctuation
 * besides, at most `MAX_CUSTOM_CALL_LENGTH` once upper-cased, and nothing else.
 *
 * Modelled on the display-name suite, with the one edge that rule does not have: **empty
 * after trimming is a call unset, not a call refused** — saving an empty field is how the
 * banner goes back to its own word. This module is the layer that owns that distinction,
 * so both the server and the profile read it off one answer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CUSTOM_CALL_LENGTH, normalizeCustomCall } from "../src/customCall.ts";

/** What the rule answers for a text it accepts: the call to keep. */
const kept = (customCall: string) => ({ accepted: true, customCall });

const REFUSED = { accepted: false };

describe("normalizeCustomCall", () => {
  it("keeps a call that is already fine", () => {
    assert.deepEqual(normalizeCustomCall("I WIN"), kept("I WIN"));
  });

  it("trims the whitespace around a call, and leaves the spaces inside it alone", () => {
    assert.deepEqual(normalizeCustomCall("  gotcha sucker \n"), kept("gotcha sucker"));
  });

  /*
   * Where this rule parts from the display name's: an empty field is not a bad call but no
   * call, and the answer says so rather than handing back an empty string to be stored.
   */
  describe("empty after trimming", () => {
    for (const [what, text] of [
      ["nothing at all", ""],
      ["only spaces", "   "],
      ["only whitespace of any kind", "\t \n"],
    ] as const) {
      it(`unsets the call for ${what}, rather than refusing it`, () => {
        assert.deepEqual(normalizeCustomCall(text), { accepted: true, customCall: null });
      });
    }
  });

  describe("the cap", () => {
    it("accepts a call of exactly the limit", () => {
      const call = "W".repeat(MAX_CUSTOM_CALL_LENGTH);
      assert.deepEqual(normalizeCustomCall(call), kept(call));
    });

    it("refuses one character past it", () => {
      assert.deepEqual(normalizeCustomCall("W".repeat(MAX_CUSTOM_CALL_LENGTH + 1)), REFUSED);
    });

    it("counts the length after trimming, not before", () => {
      const call = "W".repeat(MAX_CUSTOM_CALL_LENGTH);
      assert.deepEqual(normalizeCustomCall(`   ${call}   `), kept(call));
    });

    /*
     * The banner draws a call in capitals, and capitals can be longer than what was typed:
     * `ß` upper-cases to `SS`. What is capped is what is drawn, so half the limit in `ß`
     * fits and one more does not — though the typed text is well under the limit either way.
     */
    it("counts the call as the banner draws it, upper-cased", () => {
      const half = "ß".repeat(MAX_CUSTOM_CALL_LENGTH / 2);
      assert.deepEqual(normalizeCustomCall(half), kept(half));
      assert.deepEqual(normalizeCustomCall(`${half}ß`), REFUSED);
    });

    it("keeps the call as typed, not upper-cased: capitals are the banner's to apply", () => {
      assert.deepEqual(normalizeCustomCall("Not today"), kept("Not today"));
    });

    it("accepts a call of exactly the limit in another script", () => {
      const call = "ш".repeat(MAX_CUSTOM_CALL_LENGTH);
      assert.deepEqual(normalizeCustomCall(` ${call} `), kept(call));
    });
  });

  describe("what a call may be made of", () => {
    for (const mark of ["!", "?", ".", ",", "'", "-"]) {
      it(`accepts ${mark}`, () => {
        assert.deepEqual(normalizeCustomCall(`I WIN${mark}`), kept(`I WIN${mark}`));
      });
    }

    for (const [what, call] of [
      ["several marks in one call", "WHO'S NEXT?!"],
      ["a call made only of punctuation", "?!"],
      ["Hebrew", "יניב בא"],
      ["Cyrillic", "Победа"],
      ["Greek", "Νίκη!"],
      ["Han", "我赢了"],
      ["accented Latin", "Ça alors"],
      ["digits", "21 points"],
      ["a mix of scripts", "Yaniv יניב"],
    ] as const) {
      it(`accepts ${what}`, () => {
        assert.deepEqual(normalizeCustomCall(call), kept(call));
      });
    }

    /*
     * Refused, never tidied: a call with a character the rule does not allow is no call,
     * rather than the call left once that character is taken out of it.
     */
    for (const [what, call] of [
      ["an emoji", "I WIN 🃏"],
      ["an emoji on its own", "🎉"],
      ["a symbol", "I WIN $"],
      ["a heart", "I WIN ♥"],
      ["markup", "<b>WIN</b>"],
      ["an underscore", "I_WIN"],
      ["a colon", "WIN: ME"],
      ["a double inner space", "I  WIN"],
      ["a tab inside the call", "I\tWIN"],
      ["a non-breaking space inside the call", "I WIN"],
      ["a zero-width space", "I​WIN"],
      ["a zero-width joiner", "WIN‍"],
      ["a right-to-left override", "‮WIN"],
      ["a control character", "WIN\u0007"],
    ] as const) {
      it(`refuses ${what}`, () => {
        assert.deepEqual(normalizeCustomCall(call), REFUSED);
      });
    }
  });
});
