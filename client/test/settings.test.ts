/**
 * The settings module: what a typed field says, and whether the room has caught up.
 *
 * `turn.ts`'s counterpart for the one screen that edits the room rather than plays it —
 * pure and total, so every case below asserts on a return value. A number field is the
 * only place in this client where a player can type something that is not a move, so
 * "nonsense in, nothing out" is the normal case here too.
 *
 * What a room may be set to is not asked here: `botSeatLimit`, `isValidSettings` and the
 * option sets are `@yaniv/shared`'s, and `shared/test/settings.test.ts` covers them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoomSettings } from "@yaniv/shared";
import { sameSettings, wholeNumber } from "../src/settings.ts";

const SETTINGS: RoomSettings = {
  handSize: 5,
  yanivThreshold: 7,
  maxScore: 100,
  botCount: 0,
};

describe("wholeNumber", () => {
  it("reads a number that has been typed out", () => {
    assert.equal(wholeNumber("250"), 250);
  });

  it("ignores the spaces around it", () => {
    assert.equal(wholeNumber("  250  "), 250);
  });

  it("refuses a field with nothing in it", () => {
    assert.equal(wholeNumber(""), null);
    assert.equal(wholeNumber("   "), null);
  });

  it("refuses anything that is not a number", () => {
    assert.equal(wholeNumber("abc"), null);
    assert.equal(wholeNumber("12abc"), null);
  });

  it("refuses a number that is not whole, since a round is scored in points", () => {
    assert.equal(wholeNumber("2.5"), null);
  });

  it("refuses a number with no end to it", () => {
    assert.equal(wholeNumber("Infinity"), null);
  });

  it("reads a number the room would refuse, and leaves refusing it to the rulebook", () => {
    assert.equal(wholeNumber("999999"), 999999);
    assert.equal(wholeNumber("-100"), -100);
  });
});

describe("sameSettings", () => {
  it("is true for a room that says what was asked of it", () => {
    assert.equal(sameSettings(SETTINGS, { ...SETTINGS }), true);
  });

  it("is false when any one of the four differs", () => {
    assert.equal(sameSettings(SETTINGS, { ...SETTINGS, handSize: 6 }), false);
    assert.equal(sameSettings(SETTINGS, { ...SETTINGS, yanivThreshold: 11 }), false);
    assert.equal(sameSettings(SETTINGS, { ...SETTINGS, maxScore: 250 }), false);
    assert.equal(sameSettings(SETTINGS, { ...SETTINGS, botCount: 3 }), false);
  });
});
