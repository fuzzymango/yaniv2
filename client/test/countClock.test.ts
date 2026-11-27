/**
 * The milestone count's one clock (spec #280), run on frames handed in by hand.
 *
 * What it owes the table: every subscriber hears every frame and nobody else is asked to
 * re-render; it stops itself once the count lands, saying so exactly once; and stopping it
 * leaves no frame pending — no callback outlives the table that ran it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FrameSource } from "../src/countClock.ts";
import { countClock } from "../src/countClock.ts";
import { MILESTONE_COUNT_MS } from "../src/timing.ts";

/** Frames that fire only when the test says, at the moment it names. */
const handFrames = () => {
  const pending = new Map<number, (now: number) => void>();
  let next = 1;
  const frames: FrameSource = {
    request: (callback) => {
      pending.set(next, callback);
      return next++;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  };
  /** Fire every frame pending now, stamped `now`, as the browser fires a frame's callbacks. */
  const fire = (now: number) => {
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback(now);
  };
  return { frames, fire, pending: () => pending.size };
};

describe("countClock", () => {
  it("reads as the count's first moment before any frame", () => {
    assert.equal(countClock(1000).elapsed(), 0);
  });

  it("reads each frame's time since the latch", () => {
    const { frames, fire } = handFrames();
    const clock = countClock(1000);
    clock.run(frames, () => {});
    fire(1016);
    assert.equal(clock.elapsed(), 16);
    fire(1500);
    assert.equal(clock.elapsed(), 500);
  });

  it("reads a frame stamped before the latch as before the count, not after it", () => {
    const { frames, fire } = handFrames();
    const clock = countClock(1000);
    clock.run(frames, () => {});
    fire(996);
    assert.equal(clock.elapsed(), -4);
  });

  it("tells every subscriber of every frame, and stops telling one that has left", () => {
    const { frames, fire } = handFrames();
    const clock = countClock(0);
    const heard = { a: 0, b: 0 };
    clock.subscribe(() => (heard.a += 1));
    const leave = clock.subscribe(() => (heard.b += 1));
    clock.run(frames, () => {});
    fire(16);
    leave();
    fire(32);
    assert.deepEqual(heard, { a: 2, b: 1 });
  });

  it("runs until the count lands, then says so once and asks for no more frames", () => {
    const { frames, fire, pending } = handFrames();
    const clock = countClock(0);
    let landings = 0;
    clock.run(frames, () => (landings += 1));
    fire(MILESTONE_COUNT_MS - 1);
    assert.equal(landings, 0);
    assert.equal(pending(), 1, "still counting");
    fire(MILESTONE_COUNT_MS);
    assert.equal(landings, 1);
    assert.equal(pending(), 0, "nothing left to run");
    assert.equal(clock.elapsed(), MILESTONE_COUNT_MS);
  });

  it("tells its subscribers of the landing frame before it says it has landed", () => {
    // So the lines read the landed frame in the same render the namecards learn of it.
    const { frames, fire } = handFrames();
    const clock = countClock(0);
    const order: string[] = [];
    clock.subscribe(() => order.push(`frame ${clock.elapsed()}`));
    clock.run(frames, () => order.push("landed"));
    fire(MILESTONE_COUNT_MS + 5);
    assert.deepEqual(order, [`frame ${MILESTONE_COUNT_MS + 5}`, "landed"]);
  });

  it("leaves no frame pending once stopped, and is never heard from again", () => {
    const { frames, fire, pending } = handFrames();
    const clock = countClock(0);
    let heard = 0;
    let landings = 0;
    clock.subscribe(() => (heard += 1));
    const stop = clock.run(frames, () => (landings += 1));
    fire(16);
    stop();
    assert.equal(pending(), 0);
    fire(MILESTONE_COUNT_MS);
    assert.equal(heard, 1);
    assert.equal(landings, 0);
  });

  it("can be stopped after it has landed, at no cost", () => {
    const { frames, fire, pending } = handFrames();
    const stop = countClock(0).run(frames, () => {});
    fire(MILESTONE_COUNT_MS);
    stop();
    assert.equal(pending(), 0);
  });

  it("carries on from where it was when run again after a stop", () => {
    // An effect run, cleaned up and run again — React's development double-run.
    const { frames, fire } = handFrames();
    const clock = countClock(0);
    clock.run(frames, () => {})();
    let landings = 0;
    clock.run(frames, () => (landings += 1));
    fire(800);
    assert.equal(clock.elapsed(), 800);
    fire(MILESTONE_COUNT_MS);
    assert.equal(landings, 1);
  });
});
