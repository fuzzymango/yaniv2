import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AUTO_DEAL_MS } from "@yaniv/server/src/config.ts";
import {
  ANNOUNCE_ENTER_MS,
  ANNOUNCE_EXIT_MS,
  ANNOUNCE_LEAD_MS,
  ANNOUNCE_MS,
  FLIGHT_MS,
  announceEnterAt,
  announceLeaveAt,
  SHAKE_MS,
  SLAP_MS,
} from "../src/timing.ts";

/*
 * The one thing worth asserting about a set of durations: that each is still a fraction of
 * the one above it. Nothing here checks a number — a tuned value is a judgement and not a
 * fact — but a constant that stopped being derived would go unnoticed until somebody changed
 * the flight and only half the table sped up (issue #95).
 */
describe("the timing chain", () => {
  it("makes a slapdown sharper than an ordinary discard", () => {
    assert.ok(SLAP_MS < FLIGHT_MS);
  });

  it("derives the slap from the flight", () => {
    assert.equal(SLAP_MS, FLIGHT_MS / 2);
  });

  it("derives the shake from the slap, and keeps it the shorter of the two", () => {
    assert.equal(SHAKE_MS, (SLAP_MS * 2) / 3);
    assert.ok(SHAKE_MS < SLAP_MS);
  });

  it("has the whole chain move when the flight does", () => {
    // The derivations above written out once more as ratios of the top of the chain, so a
    // constant quietly pinned to a number of its own fails here as well as in its own test.
    assert.equal(SLAP_MS / FLIGHT_MS, 0.5);
    assert.equal(SHAKE_MS / FLIGHT_MS, 1 / 3);
  });
});

/*
 * The second chain, and the one thing worth asserting about it beyond its own derivations:
 * that it is *not* the first one's (issue #156). A constant quietly re-hung off `FLIGHT_MS`
 * would look tidier and would mean speeding up the cards drained the tension out of an
 * Assaf — see the comment on `ANNOUNCE_MS` and docs/adr/0018.
 */
describe("the announcement chain", () => {
  it("derives the lead, the entrance and the exit from the hold", () => {
    assert.equal(ANNOUNCE_LEAD_MS, ANNOUNCE_MS / 2);
    assert.equal(ANNOUNCE_ENTER_MS, ANNOUNCE_MS / 3);
    assert.equal(ANNOUNCE_EXIT_MS, ANNOUNCE_MS / 2);
  });

  it("has a banner arrive faster than the pair leaves", () => {
    assert.ok(ANNOUNCE_ENTER_MS < ANNOUNCE_EXIT_MS);
  });

  it("keeps the Assaf's beat inside the hold rather than after it", () => {
    assert.ok(ANNOUNCE_LEAD_MS < ANNOUNCE_MS);
    assert.ok(ANNOUNCE_ENTER_MS <= ANNOUNCE_LEAD_MS, "the call is up before the answer starts");
  });

  it("keeps the two chains independent", () => {
    // Not "the numbers differ" — they may well coincide — but that the announcement's links
    // are still fractions of their own root and of nothing in the chain above. Written out
    // as ratios so a link quietly re-pinned to `FLIGHT_MS` fails here rather than being
    // noticed the day somebody speeds the cards up.
    assert.equal(ANNOUNCE_LEAD_MS / ANNOUNCE_MS, 0.5);
    assert.equal(ANNOUNCE_ENTER_MS / ANNOUNCE_MS, 1 / 3);
    assert.equal(ANNOUNCE_EXIT_MS / ANNOUNCE_MS, 0.5);
  });

  it("stages the pair: the call, then the answer to it a beat later", () => {
    assert.equal(announceEnterAt(0), 0, "the call is up at once");
    assert.equal(announceEnterAt(1), ANNOUNCE_LEAD_MS, "and the Assaf a beat behind it");
  });

  it("measures the exit from the last arrival, so both leave together", () => {
    // The whole reason a banner is told how many there are: leaving is a fact about the
    // pair, and a banner deriving it from its own place would take the call off the screen
    // while the Assaf was still being read.
    assert.equal(announceLeaveAt(1), ANNOUNCE_MS, "a lone call is held from its arrival");
    assert.equal(
      announceLeaveAt(2),
      announceEnterAt(1) + ANNOUNCE_MS,
      "a pair is held from the second one's",
    );
  });

  it("finishes an Assafed round comfortably inside the server's auto-deal delay", () => {
    // The bound on this root, as `BOT_THINK_MS` is the bound on the flight's: a table only
    // bots are playing deals itself on ten seconds after the round is scored (ADR-0014),
    // and a watcher has to have seen the announcement well before that.
    const assafed = announceLeaveAt(2) + ANNOUNCE_EXIT_MS;
    const stood = announceLeaveAt(1) + ANNOUNCE_EXIT_MS;
    assert.ok(stood < assafed, "the reversal is the longer sequence, by its own beat");
    assert.ok(assafed < AUTO_DEAL_MS / 2, "and both are over long before the table moves on");
  });
});
