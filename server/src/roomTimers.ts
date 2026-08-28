/**
 * The work a room has waiting on the clock, in one place and keyed by what it is for.
 *
 * The server is growing from one clock-driven behaviour to several, and the invariant
 * that matters — a room that has gone has nothing pending — is unenforceable while each
 * of them keeps its own `Map` of cancellers: closing a room would have to remember every
 * module that might be holding a timer for it, and forgetting one leaves a callback
 * firing at a code that may be issued again. Here it is one call, `cancelRoom`, and a new
 * behaviour is covered by existing as a purpose rather than by anyone remembering it.
 *
 * Setting a purpose **replaces** whatever that room held for it, which is what makes "at
 * most one pending X per room" a property of this module rather than of each caller's own
 * bookkeeping. Note the shape that buys: a caller wanting "leave the pending one alone"
 * asks `has` first, and one wanting "restart the pause" simply sets — the difference is
 * stated at the call site instead of being buried in a scheduler.
 *
 * It stays dumb on purpose. It schedules and it cancels; it is not a job queue, it does
 * not retry, it does not order or coalesce, and it never decides *whether* something
 * should be scheduled — that judgement belongs to the module that owns the behaviour, and
 * moving it here would put three unrelated policies behind one door.
 *
 * Its clock is an argument, as everything ambient in this server is (`clock.ts`), so a
 * test drives every pending timer in the process by hand from the one it built.
 */

import type { Clock } from "./clock.ts";

/**
 * What a timer is for. A closed union rather than a free string: two behaviours reaching
 * for the same key by accident would silently cancel each other, and the compiler is a
 * better place to catch that than a flaky table.
 */
export type TimerPurpose = "botTurn" | "autoDeal";

export interface RoomTimers {
  /**
   * Run `fn` for this room and purpose in `ms`, cancelling whatever that pair already
   * held. The entry is forgotten just before `fn` runs, so a callback that schedules its
   * own successor — a chain of bot turns is exactly that — sets rather than races itself.
   */
  set: (roomCode: string, purpose: TimerPurpose, ms: number, fn: () => void) => void;
  /** Is something waiting for this room and purpose? */
  has: (roomCode: string, purpose: TimerPurpose) => boolean;
  /** Call off this room's timer for one purpose. A no-op where nothing is waiting. */
  cancel: (roomCode: string, purpose: TimerPurpose) => void;
  /** Call off everything this room holds. What a room being destroyed does. */
  cancelRoom: (roomCode: string) => void;
}

export function createRoomTimers(clock: Clock): RoomTimers {
  /** Room code → purpose → the function that calls that timer off. */
  const rooms = new Map<string, Map<TimerPurpose, () => void>>();

  /**
   * Drop the entry without calling it off — what a timer that has just fired needs, since
   * `clock.ts` promises its canceller only for a timer that has *not* run and this module
   * is the one place any implementation of that contract is exercised.
   */
  function forget(roomCode: string, purpose: TimerPurpose): void {
    const purposes = rooms.get(roomCode);
    if (!purposes) return;
    purposes.delete(purpose);
    if (purposes.size === 0) rooms.delete(roomCode);
  }

  function cancel(roomCode: string, purpose: TimerPurpose): void {
    rooms.get(roomCode)?.get(purpose)?.();
    forget(roomCode, purpose);
  }

  return {
    set: (roomCode, purpose, ms, fn) => {
      cancel(roomCode, purpose);

      // A clock may fire synchronously — a test's, ticked or otherwise — in which case
      // `fn` has already run, and anything it scheduled for this same purpose is the live
      // entry. Recording the canceller unconditionally would overwrite it with one for a
      // timer that is already spent, so record only where nothing has fired.
      let fired = false;
      const off = clock.after(ms, () => {
        fired = true;
        forget(roomCode, purpose);
        fn();
      });
      if (fired) return;

      const purposes = rooms.get(roomCode) ?? new Map<TimerPurpose, () => void>();
      purposes.set(purpose, off);
      rooms.set(roomCode, purposes);
    },
    has: (roomCode, purpose) => rooms.get(roomCode)?.has(purpose) ?? false,
    cancel,
    cancelRoom: (roomCode) => {
      for (const off of rooms.get(roomCode)?.values() ?? []) off();
      rooms.delete(roomCode);
    },
  };
}
