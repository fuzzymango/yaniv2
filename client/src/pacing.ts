/**
 * Pacing: turning a burst of arrivals into something a person can watch.
 *
 * The server sends a run of bot turns as one broadcast per move, in seating order, with
 * no delay between them — deliberately, because how fast a chain reads is a question
 * about a screen and the server has none (see "Broadcasting" in CLAUDE.md). So the whole
 * chain lands within a few milliseconds, and a client that drew each one as it arrived
 * would show only the last: the table would jump from the player's own move to their next
 * turn, with everything the opponents did in between invisible.
 *
 * The rule is: the first arrival goes straight through, and anything that lands in the
 * beat behind it queues and is let go one per beat. A move of the player's own — the
 * common case by far, and the one where a delay would read as a laggy app — is a lone
 * arrival and is shown at once.
 *
 * The cost of that rule, stated plainly: a beat is armed after *every* release, so an
 * arrival landing inside the beat behind a drawn position waits out the rest of it, up to
 * `PACE_MS`. It has to be — nothing here can tell a lone arrival from the first of a chain
 * except by giving the chain a beat to show up in. What it buys is that no position is
 * ever replaced before it has been on screen long enough to read, which is the same thing
 * the pacing is for; a player who commits a move inside that window pays for it in a
 * fraction of a beat, and one who takes a moment over their hand pays nothing.
 *
 * The clock is injected rather than reached for, which is what lets a test drive the
 * queue a beat at a time instead of sitting still for seconds of real time.
 */

/**
 * How long a move stays on screen before the next one replaces it.
 *
 * Long enough to see what an opponent discarded and what it did to their hand, short
 * enough that five of them are not a wait. It is a property of reading a table rather
 * than of the rules, which is why it lives here and not in `shared/src/config.ts`.
 */
export const PACE_MS = 700;

/**
 * The one thing pacing needs from the outside world. `setTimeout` implements it as it
 * stands; a test implements it by hand.
 */
export interface Clock {
  /** Run `fn` in `ms` milliseconds; the returned function cancels it if it has not run. */
  after: (ms: number, fn: () => void) => () => void;
}

/** The browser's own clock, and the default anywhere real time is what is wanted. */
export const systemClock: Clock = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface Pacer<T> {
  /** Hand something in to be shown — now, or behind whatever is already waiting. */
  offer: (item: T) => void;
  /**
   * Drop everything still waiting and stop the clock.
   *
   * For when what is queued has stopped being worth showing at all: the room it belongs
   * to is gone, and the positions behind it would be drawn over a screen that has already
   * moved on to the main menu.
   */
  reset: () => void;
}

export function createPacer<T>(release: (item: T) => void, clock: Clock = systemClock): Pacer<T> {
  let waiting: T[] = [];
  /**
   * Whether a beat is running — the state, rather than the cancel handle, because a test
   * clock may run a timer the instant it is set and the handle is not assigned until
   * after that.
   */
  let beating = false;
  let cancel: (() => void) | null = null;

  const beat = (): void => {
    beating = false;
    const next = waiting.shift();
    // Nothing came in behind the last one, so the chain is over and the clock stops rather
    // than ticking on. What arrives next arrives to an idle queue and is drawn at once.
    if (next === undefined) return;
    release(next);
    start();
  };

  const start = (): void => {
    beating = true;
    cancel = clock.after(PACE_MS, beat);
  };

  return {
    offer: (item) => {
      if (beating) {
        waiting.push(item);
        return;
      }
      release(item);
      start();
    },

    reset: () => {
      waiting = [];
      beating = false;
      cancel?.();
      cancel = null;
    },
  };
}
