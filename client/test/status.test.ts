import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STATUS_LABEL, seatBadges, seatStatus } from "../src/status.ts";

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

/**
 * A seat as the nameplate's badge rule reads it: everything ordinary — a human, still in the
 * match, still there. `outInRound` set is a seat that has stopped playing; the server sends
 * `spectating` only for one of those that is connected and not a bot, and these fixtures
 * keep to that.
 */
const plate = (
  overrides: {
    outInRound?: number | null;
    departed?: boolean;
    connected?: boolean;
    spectating?: boolean;
    isBot?: boolean;
  } = {},
) => ({
  outInRound: overrides.outInRound ?? null,
  departed: overrides.departed ?? false,
  connected: overrides.connected ?? true,
  spectating: overrides.spectating ?? false,
  isBot: overrides.isBot ?? false,
});

const shown = { outShown: true };
const notYet = { outShown: false };

describe("seatBadges", () => {
  it("gives a human who is playing and there no badge", () => {
    assert.deepEqual(seatBadges(plate(), shown), []);
  });

  it("gives a player who has dropped mid-match Away", () => {
    assert.deepEqual(seatBadges(plate({ connected: false }), shown), ["away"]);
  });

  it("gives a bot that is playing Bot", () => {
    assert.deepEqual(seatBadges(plate({ isBot: true }), shown), ["bot"]);
  });

  it("gives a knocked-out bot Out, then Bot", () => {
    assert.deepEqual(seatBadges(plate({ isBot: true, outInRound: 3 }), shown), ["out", "bot"]);
  });

  it("gives a knocked-out player who stayed Out, then Watching", () => {
    assert.deepEqual(
      seatBadges(plate({ outInRound: 3, spectating: true }), shown),
      ["out", "watching"],
    );
  });

  it("gives a knocked-out player who dropped Out, then Away", () => {
    assert.deepEqual(
      seatBadges(plate({ outInRound: 3, connected: false }), shown),
      ["out", "away"],
    );
  });

  it("gives a player who left Left alone, whatever their connection", () => {
    assert.deepEqual(
      seatBadges(plate({ outInRound: 3, departed: true, connected: false }), shown),
      ["left"],
    );
    assert.deepEqual(seatBadges(plate({ outInRound: 3, departed: true }), shown), ["left"]);
  });

  it("gives a player who left Left alone whether or not the round is shown yet", () => {
    assert.deepEqual(seatBadges(plate({ outInRound: 3, departed: true }), notYet), ["left"]);
  });

  /**
   * The round that knocks a seat out, while a milestone count is still running: the plate
   * must not tell the end of the count before it lands (spec #280), so neither Out nor
   * Watching yet — but Away is about the connection, not the round, and shows regardless.
   */
  it("gives a seat knocked out this round neither Out nor Watching before outShown", () => {
    assert.deepEqual(seatBadges(plate({ outInRound: 3, spectating: true }), notYet), []);
  });

  it("still gives a seat knocked out this round Away before outShown if they dropped", () => {
    assert.deepEqual(seatBadges(plate({ outInRound: 3, connected: false }), notYet), ["away"]);
  });

  it("gives a bot knocked out this round only Bot before outShown", () => {
    assert.deepEqual(seatBadges(plate({ isBot: true, outInRound: 3 }), notYet), ["bot"]);
  });

  it("leaves Away and Bot alone for a seat still playing, whatever outShown says", () => {
    assert.deepEqual(seatBadges(plate({ connected: false }), notYet), ["away"]);
    assert.deepEqual(seatBadges(plate({ isBot: true }), notYet), ["bot"]);
    assert.deepEqual(seatBadges(plate(), notYet), []);
  });

  /**
   * A bot is connected always and never watching, and the server never sends it otherwise.
   * Should a seat flagged as a bot ever arrive looking dropped, watching or gone, it is
   * still drawn as a bot — the wire's `isBot` is the one fact the plate trusts about it.
   */
  it("never gives a bot Away, Watching or Left", () => {
    const odd = [
      plate({ isBot: true, connected: false }),
      plate({ isBot: true, outInRound: 2, spectating: true }),
      plate({ isBot: true, outInRound: 2, departed: true }),
    ];
    for (const seat of odd) {
      for (const gate of [shown, notYet]) {
        const badges = seatBadges(seat, gate);
        assert.ok(badges.includes("bot"));
        for (const never of ["away", "watching", "left"] as const) {
          assert.ok(!badges.includes(never), `${never} on ${JSON.stringify(seat)}`);
        }
      }
    }
  });

  it("reads a seat with no isBot at all, as the viewer's own view is, as a person", () => {
    const self = { outInRound: 3, departed: false, connected: true, spectating: true };
    assert.deepEqual(seatBadges(self, shown), ["out", "watching"]);
  });

  /** Every combination the four fields and the gate can make, not only the ones that occur. */
  it("never gives any seat more than two badges, and Left only alone", () => {
    const bools = [false, true];
    for (const outInRound of [null, 1]) {
      for (const departed of bools) {
        for (const connected of bools) {
          for (const spectating of bools) {
            for (const isBot of bools) {
              for (const outShown of bools) {
                const seat = { outInRound, departed, connected, spectating, isBot };
                const badges = seatBadges(seat, { outShown });
                const at = JSON.stringify({ ...seat, outShown });
                assert.ok(badges.length <= 2, at);
                assert.equal(new Set(badges).size, badges.length, at);
                if (badges.includes("left")) assert.deepEqual(badges, ["left"], at);
                if (departed && !isBot) assert.deepEqual(badges, ["left"], at);
                if (badges.includes("out")) assert.equal(badges[0], "out", at);
              }
            }
          }
        }
      }
    }
  });
});
