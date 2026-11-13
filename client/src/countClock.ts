/**
 * The one clock a milestone count is read by (spec #280): how far into the count it is, as a
 * store a seat subscribes to rather than as state the table holds.
 *
 * **Why a store, and not the table's own state.** A count is two seconds of frames. Held in
 * `Table`'s state, every frame re-rendered the whole table — every seat, the cascades, the
 * scorecard — and every one of those renders also ran `useCardFlight`'s measurement, which reads
 * the rect of every card on the table. Only the counting seats' lines change from frame to
 * frame, so only they subscribe (`useSyncExternalStore`), and the table re-renders twice a count:
 * when it is latched, and when it lands (`onLanded`), the moment the namecards' red ring may show.
 *
 * Still **one clock for the table**, not one per seat: six seats can count at once, and they
 * count off the same frames.
 *
 * Framework-free and handed its frames (`FrameSource`), so it is driven under `node:test` by a
 * fake and in the browser by `requestAnimationFrame`. It knows nothing of seats or labels:
 * `milestone.ts` says what a moment of the count looks like.
 */

import { MILESTONE_COUNT_MS } from "./timing.ts";

/** Where frames come from: `requestAnimationFrame` and its cancel, or a test's hand. */
export interface FrameSource {
  readonly request: (callback: (now: number) => void) => number;
  readonly cancel: (handle: number) => void;
}

/** What a seat reads: the elapsed time, and a way to hear it change. */
export interface CountClock {
  /** Register a listener for every frame, returning the call that removes it. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * How far into the count it is, in ms. 0 until the first frame, which may read a hair below 0
   * (a frame is stamped at its start, which can be before the moment the count was latched) —
   * `countFrame` and `ringFrame` read either as the count's first moment.
   */
  readonly elapsed: () => number;
  /**
   * Run the clock on `frames` until the count lands, then call `onLanded` once and stop. Returns
   * the call that stops it early, cancelling the frame it has pending: no frame callback outlives
   * whoever ran it. Running it again after a stop carries on from where it was.
   */
  readonly run: (frames: FrameSource, onLanded: () => void) => () => void;
}

/** A clock for a count latched at `startedAt`, on the same timeline as the frames it will run on. */
export function countClock(startedAt: number): CountClock {
  let elapsed = 0;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    elapsed: () => elapsed,
    run(frames, onLanded) {
      let pending: number | null = frames.request(function tick(now) {
        elapsed = now - startedAt;
        for (const listener of listeners) listener();
        if (elapsed < MILESTONE_COUNT_MS) {
          pending = frames.request(tick);
        } else {
          pending = null;
          onLanded();
        }
      });
      return () => {
        if (pending !== null) frames.cancel(pending);
        pending = null;
      };
    },
  };
}
