import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AUTO_DEAL_MS } from "@yaniv/server/src/config.ts";
import {
  ANNOUNCE_ENTER_MS,
  ANNOUNCE_EXIT_MS,
  ANNOUNCE_HOLD_MS,
  ANNOUNCE_LEAD_MS,
  DEAL_HOLD_MS,
  announceEnterAt,
  announceLeaveAt,
} from "../src/timing.ts";

/*
 * Nothing here checks a duration's number, or one animation's durations against each other: each
 * is tuned by eye and is a judgement, not a fact (issue #241). What is asserted is the staging
 * built on them, and where a duration would collide with something outside the animation — the
 * server's auto-deal delay, and a deal landing before an Assaf has.
 */
describe("the call announcement", () => {
  it("stages the pair: the call, then the answer to it a beat later", () => {
    assert.equal(announceEnterAt(0), 0, "the call is up at once");
    assert.equal(announceEnterAt(1), ANNOUNCE_LEAD_MS, "and the Assaf a beat behind it");
  });

  it("measures the exit from the last arrival, so both leave together", () => {
    // The whole reason a banner is told how many there are: leaving is a fact about the
    // pair, and a banner deriving it from its own place would take the call off the screen
    // while the Assaf was still being read.
    assert.equal(announceLeaveAt(1), ANNOUNCE_HOLD_MS, "a lone call is held from its arrival");
    assert.equal(
      announceLeaveAt(2),
      announceEnterAt(1) + ANNOUNCE_HOLD_MS,
      "a pair is held from the second one's",
    );
  });

  it("finishes an Assafed round comfortably inside the server's auto-deal delay", () => {
    // A table only bots are playing deals itself on ten seconds after the round is scored
    // (ADR-0014), and a watcher has to have seen the announcement well before that.
    const assafed = announceLeaveAt(2) + ANNOUNCE_EXIT_MS;
    const stood = announceLeaveAt(1) + ANNOUNCE_EXIT_MS;
    assert.ok(stood < assafed, "the reversal is the longer sequence, by its own beat");
    assert.ok(assafed < AUTO_DEAL_MS / 2, "and both are over long before the table moves on");
  });
});

/*
 * How long the deal is held back once a round is scored (issue #205), asserted only against its
 * two neighbours — the banners it must let arrive and the auto-deal it must not outlast. It may
 * cut the banners off once they are up (issue #241): a deal unmounts them, and that is accepted.
 */
describe("the deal hold", () => {
  it("outlasts both banners' arrival", () => {
    // Nobody can deal before an Assaf has landed: the second banner of an Assafed round has
    // fully arrived before the button goes live. The hold past that is not asserted — a deal
    // may cut the banners short.
    const answered = announceEnterAt(1) + ANNOUNCE_ENTER_MS;
    assert.ok(answered < DEAL_HOLD_MS);
  });

  it("is shorter than the server's auto-deal delay", () => {
    // A human in the browser is never held longer than a bots-only table waits for its
    // spectator (ADR-0014).
    assert.ok(DEAL_HOLD_MS < AUTO_DEAL_MS);
  });
});
