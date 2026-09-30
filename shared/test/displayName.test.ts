/**
 * The one display-name rule, which every name a player chooses goes through: a name
 * typed into a room's front door, and an account's own name.
 *
 * The rule itself is a few lines, so what is worth asserting is where its edges fall —
 * that trimming happens *before* the length is counted, that "empty" and "too long" are
 * one answer rather than two, since the module hands back a name or nothing, and which
 * characters are a name's: letters and digits of any script, single spaces between them,
 * and nothing else (#227).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
} from "../src/displayName.ts";

describe("normalizeDisplayName", () => {
  it("keeps a name that is already fine", () => {
    assert.equal(normalizeDisplayName("Ada"), "Ada");
  });

  it("trims the whitespace around a name", () => {
    assert.equal(normalizeDisplayName("  Ada  "), "Ada");
  });

  it("leaves the whitespace inside one alone", () => {
    assert.equal(normalizeDisplayName(" Ada Lovelace "), "Ada Lovelace");
  });

  it("refuses an empty name", () => {
    assert.equal(normalizeDisplayName(""), null);
  });

  it("refuses a name that is only whitespace", () => {
    assert.equal(normalizeDisplayName("   "), null);
  });

  it("accepts a name of exactly the limit", () => {
    const name = "x".repeat(MAX_DISPLAY_NAME_LENGTH);
    assert.equal(normalizeDisplayName(name), name);
  });

  it("refuses one character past it", () => {
    assert.equal(normalizeDisplayName("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)), null);
  });

  /*
   * The order of the two halves, which is the only way this rule can be got wrong: a
   * name that is oversized only because of the spaces around it is a legal name.
   */
  it("counts the length after trimming, not before", () => {
    const name = "x".repeat(MAX_DISPLAY_NAME_LENGTH);
    assert.equal(normalizeDisplayName(`   ${name}   `), name);
  });

  describe("what a name may be made of", () => {
    for (const [what, name] of [
      ["Hebrew", "יעקב"],
      ["accented Latin", "Zoë Ångström"],
      ["digits", "Player 42"],
      ["only digits", "007"],
      ["single spaces between several words", "Ada King of Lovelace"],
      ["a mix of scripts", "Ada אדה"],
    ] as const) {
      it(`accepts ${what}`, () => {
        assert.equal(normalizeDisplayName(name), name);
      });
    }

    /*
     * Refused, never tidied: a name with a character the rule does not allow is no name,
     * rather than the name left once that character is taken out of it. Nobody is seated
     * under a name they did not choose.
     */
    for (const [what, name] of [
      ["punctuation", "Ada."],
      ["an apostrophe", "O'Brien"],
      ["a hyphen", "Mary-Jane"],
      ["an underscore", "ada_l"],
      ["a symbol", "Ada$"],
      ["markup", "<b>Ada</b>"],
      ["an emoji", "Ada 🃏"],
      ["a double inner space", "Ada  Lovelace"],
      ["a tab inside the name", "Ada\tLovelace"],
      ["a non-breaking space inside the name", "Ada\u00a0Lovelace"],
      ["a zero-width space", "Ada\u200bLovelace"],
      ["a zero-width joiner", "Ada\u200d"],
      ["a right-to-left override", "\u202eAda"],
      ["a control character", "Ada\u0007"],
    ] as const) {
      it(`refuses ${what}`, () => {
        assert.equal(normalizeDisplayName(name), null);
      });
    }

    it("still trims the whitespace around a name before judging it", () => {
      assert.equal(normalizeDisplayName("\t Ada Lovelace \n"), "Ada Lovelace");
    });

    it("accepts a name of exactly the limit in another script", () => {
      const name = "א".repeat(MAX_DISPLAY_NAME_LENGTH);
      assert.equal(normalizeDisplayName(`  ${name}  `), name);
    });
  });
});
