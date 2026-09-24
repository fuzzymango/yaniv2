/**
 * Time, injected rather than reached for — `rng.ts`'s sibling.
 *
 * Everything in this server used to resolve inside the event that triggered it, so there
 * was nothing to inject. Bot think time is the exception: a bot's turn is scheduled
 * rather than played on the spot, and a test that wants to assert a turn has *not*
 * happened yet has to own the clock it is waiting on.
 */

/**
 * The two things time is asked for: to run something later, and to say what instant it is.
 * `setTimeout` and `Date.now` implement it as they stand; a test implements it by hand.
 *
 * `now` arrived with the session (docs/adr/0020), the first thing here that writes an
 * instant down rather than waiting one out: a session expires thirty days from when it was
 * issued, and a test proving that has to be able to say when "issued" was.
 */
export interface Clock {
  /** Run `fn` in `ms` milliseconds; the returned function cancels it if it has not run. */
  after: (ms: number, fn: () => void) => () => void;
  /** The current instant, in epoch milliseconds — `Date.now`'s contract. */
  now: () => number;
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
  now: () => Date.now(),
};
