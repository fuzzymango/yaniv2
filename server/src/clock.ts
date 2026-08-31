/**
 * Time, injected rather than reached for — `rng.ts`'s sibling.
 *
 * Everything in this server used to resolve inside the event that triggered it, so there
 * was nothing to inject. Bot think time is the exception: a bot's turn is scheduled
 * rather than played on the spot, and a test that wants to assert a turn has *not*
 * happened yet has to own the clock it is waiting on.
 */

/**
 * The one thing scheduling needs from the outside world. `setTimeout` implements it as
 * it stands; a test implements it by hand.
 */
export interface Clock {
  /** Run `fn` in `ms` milliseconds; the returned function cancels it if it has not run. */
  after: (ms: number, fn: () => void) => () => void;
}

/**
 * Real time, and the default anywhere real time is what is wanted.
 *
 * Unreferenced, so a pending timer never keeps a process alive on its own. Everything set
 * on this clock is work a *room* has waiting — a bot's turn, a scored round dealing itself
 * on, a room being swept — and none of it is a reason for a server to stay up: the
 * listening socket is what does that, and it outlives every one of them. Without this a
 * process asked to shut down would sit out the longest grace period first.
 */
export const systemClock: Clock = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
