/**
 * The one display-name rule, which every name a player can be known by goes through:
 * a name typed into a room's front door today, an account's own name tomorrow.
 *
 * The rule itself is two lines, so what is worth asserting is where its edges fall —
 * that trimming happens *before* the length is counted, and that "empty" and "too long"
 * are one answer rather than two, since the module hands back a name or nothing.
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
});
