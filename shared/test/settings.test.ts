/**
 * The seating arithmetic behind a room's bot count.
 *
 * `botSeatLimit` is what a lobby control offers and `effectiveBotCount` is what
 * `startGame` actually fills, and they are the same number asked two ways — the point of
 * docs/adr/0006's "not stored clamped" is that a stale count is read back down rather than
 * refused, so both readings have to agree about what "back down" means.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PLAYERS } from "../src/config.ts";
import type { RoomSettings } from "../src/settings.ts";
import { BOT_COUNT_LIMITS, botSeatLimit, effectiveBotCount } from "../src/settings.ts";

const SETTINGS: RoomSettings = {
  handSize: 5,
  yanivThreshold: 7,
  maxScore: 100,
  botCount: 0,
};

describe("botSeatLimit", () => {
  it("offers every seat the humans have left", () => {
    assert.equal(botSeatLimit(1), MAX_PLAYERS - 1);
    assert.equal(botSeatLimit(2), MAX_PLAYERS - 2);
  });

  it("offers nothing once the humans have filled the table", () => {
    assert.equal(botSeatLimit(MAX_PLAYERS), 0);
  });

  it("never offers a seat that does not exist, however many are counted", () => {
    assert.equal(botSeatLimit(MAX_PLAYERS + 3), 0);
  });

  it("never offers more than a settings object may name", () => {
    // A room always seats the host, so this count cannot arise — but a limit that
    // depended on that would be one `isValidSettings` could refuse.
    assert.equal(botSeatLimit(0), BOT_COUNT_LIMITS.max);
  });
});

describe("effectiveBotCount", () => {
  it("gives the host what they asked for while there is room for it", () => {
    assert.equal(effectiveBotCount({ ...SETTINGS, botCount: 3 }, 2), 3);
  });

  it("reads a stale count back down to the seats that are left", () => {
    // The case ADR-0006 exists for: the host asked for five with nobody else in the
    // room, and three more people joined. Nobody was refused; the number means less.
    assert.equal(effectiveBotCount({ ...SETTINGS, botCount: 5 }, 4), 2);
  });

  it("seats nobody at a full table, or when none were asked for", () => {
    assert.equal(effectiveBotCount({ ...SETTINGS, botCount: 5 }, MAX_PLAYERS), 0);
    assert.equal(effectiveBotCount(SETTINGS, 2), 0);
  });
});
