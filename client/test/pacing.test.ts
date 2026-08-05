/**
 * The queue that makes a run of bot turns watchable.
 *
 * Driven on a clock the test owns, so what is asserted is the *shape* of the pacing —
 * one release now, the rest one at a time — and not how long a suite is prepared to sit
 * still for. The one thing real time comes into is the interval itself, which is asked
 * of the clock and can therefore be read off it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPacer, type Pacer } from "../src/pacing.ts";
import { testClock, type TestClock } from "./helpers.ts";

/** How long a chain may take per move and still read as one, straight off the ticket. */
const READABLE_MS = { least: 600, most: 800 };

/**
 * A pacer with time stopped in front of it, and the list of what it has let through —
 * the whole of what these tests look at.
 */
function heldPacer(): [Pacer<string>, TestClock, string[]] {
  const clock = testClock();
  clock.hold();
  const shown: string[] = [];
  return [createPacer<string>((item) => shown.push(item), clock), clock, shown];
}

describe("pacing a chain", () => {
  it("lets a lone arrival straight through", () => {
    const [pacer, , shown] = heldPacer();

    pacer.offer("a move of our own");

    assert.deepEqual(shown, ["a move of our own"], "nothing to wait behind, so no waiting");
  });

  it("holds a burst back and lets it go one at a time", () => {
    const [pacer, clock, shown] = heldPacer();

    // What five bot turns look like from here: the server sends the whole chain with no
    // delay of its own, so all of it lands before a screen has drawn any of it.
    for (const move of ["ours", "bot 1", "bot 2", "bot 3", "bot 4", "bot 5"]) {
      pacer.offer(move);
    }

    assert.deepEqual(shown, ["ours"], "the first is shown at once, the chain waits");

    const paced = clock.tick();
    assert.ok(
      paced >= READABLE_MS.least && paced <= READABLE_MS.most,
      `a move should be up long enough to read, and ${paced}ms is not that`,
    );
    assert.deepEqual(shown, ["ours", "bot 1"], "one move per beat, not the rest at once");

    for (let beat = 0; beat < 4; beat++) clock.tick();
    assert.deepEqual(shown, ["ours", "bot 1", "bot 2", "bot 3", "bot 4", "bot 5"]);
  });

  it("stops asking for beats once the chain has played out", () => {
    const [pacer, clock] = heldPacer();

    pacer.offer("ours");
    pacer.offer("bot 1");
    clock.tick();
    clock.tick();

    assert.equal(clock.pending(), 0, "an idle table is not still ticking");
  });

  it("drops what is waiting when there is no longer anywhere to show it", () => {
    const [pacer, clock, shown] = heldPacer();

    pacer.offer("ours");
    pacer.offer("bot 1");
    pacer.reset();

    assert.equal(clock.pending(), 0, "the beat stops with the queue");
    assert.deepEqual(shown, ["ours"], "the rest of the chain belongs to a room that is gone");

    // And the next thing to arrive is a lone arrival again, not one waiting behind the
    // chain that was dropped.
    pacer.offer("a room of their own");
    assert.deepEqual(shown, ["ours", "a room of their own"]);
  });
});
