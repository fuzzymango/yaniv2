import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STATUS_LABEL, seatStatus } from "../src/status.ts";

/**
 * A seat as the wire describes it, with everything ordinary — still playing, still there.
 *
 * Only the three fields the rule reads: being out is what *puts* a seat in one of these
 * states, and `spectating` and `departed` are how it arrives here already answered.
 */
const seat = (
  overrides: { departed?: boolean; connected?: boolean; spectating?: boolean } = {},
) => ({
  departed: overrides.departed ?? false,
  connected: overrides.connected ?? true,
  spectating: overrides.spectating ?? false,
});

describe("seatStatus", () => {
  it("says nothing about a player who is playing and there", () => {
    assert.equal(seatStatus(seat()), null);
  });

  it("says a player who has dropped is away", () => {
    assert.equal(seatStatus(seat({ connected: false })), "away");
  });

  it("says a player who gave the seat up has left", () => {
    assert.equal(seatStatus(seat({ departed: true, connected: false })), "left");
  });

  it("says an eliminated player who stayed is watching", () => {
    assert.equal(seatStatus(seat({ spectating: true })), "watching");
  });

  /**
   * The priority, which is the whole of this module: left beats away beats watching. A
   * player who has gone for good is not somebody to wait for, however their socket ended;
   * a player who is merely away might yet come back, and saying "watching" of somebody who
   * is not there is the one thing this slot must never do.
   */
  it("says left of a departed seat whose player is somehow still connected", () => {
    assert.equal(seatStatus(seat({ departed: true, connected: true })), "left");
  });

  it("says away rather than watching of an eliminated player who dropped", () => {
    // `spectating` already answers false for a seat nobody is behind — the server derives
    // it that way — so this is belt and braces about which marker wins.
    assert.equal(seatStatus(seat({ connected: false, spectating: false })), "away");
  });

  /**
   * A bot: connected, because there is no socket for it to lose, and never watching. It is
   * the only seat that reads as ordinary in every phase, which is what makes an empty slot
   * mean "this is a bot" (issue #146).
   */
  it("says nothing at all about a bot, in the match or out of it", () => {
    // Both shapes a bot's seat arrives in: the server sends it connected and never
    // spectating, whether it is still playing or was knocked out three rounds ago.
    assert.equal(seatStatus(seat()), null);
    assert.equal(seatStatus(seat({ connected: true, spectating: false })), null);
  });

  it("has a word for each of the three", () => {
    assert.deepEqual(Object.keys(STATUS_LABEL).sort(), ["away", "left", "watching"]);
    for (const word of Object.values(STATUS_LABEL)) {
      assert.ok(word.length > 0);
    }
  });
});
