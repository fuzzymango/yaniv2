/**
 * Where a seat's credential goes so that it outlives the page.
 *
 * The session core holds the seat it can sit back down in, and would lose it with the tab
 * (see `TokenStore` in `session.ts`); this is the implementation that survives a reload,
 * and it is the only file in the client that knows the word `localStorage`. Handed over in
 * `main.tsx`, exactly as the socket is — the storage is injected rather than reached for,
 * which is what lets this be driven under `node:test` with no browser anywhere in it.
 *
 * Everything here fails quietly. Storage can be off (private browsing, blocked cookies), it
 * can be full, and what is under the key can be anything at all on a shared origin — none
 * of which is news to a player: a page that cannot write a seat down simply cannot be
 * reloaded back into it, which is where the client stood before there was a store at all.
 *
 * `sessionStorage` would be the tighter fit for a credential that dies with the tab, and it
 * is deliberately not used: a phone that discards a backgrounded tab and rebuilds it is the
 * case this whole ticket is about, and `sessionStorage` is what such a tab comes back
 * without.
 */

import type { ResumeRequest } from "@yaniv/shared";
import type { TokenStore } from "./session.ts";

/**
 * As much of `localStorage` as this uses. Narrower than the browser's `Storage` on purpose,
 * so a test can hand over a `Map` and a real one satisfies it.
 */
export interface SeatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** As much of `window` as this reaches for — the reach itself can throw. See below. */
export interface StorageHolder {
  readonly localStorage: SeatStorage;
}

/**
 * Where the seat is written. Namespaced, because the origin is shared with whatever else
 * is served from it, and versioned by nothing: there is one shape and a value that is not
 * it is discarded rather than migrated.
 */
export const SEAT_KEY = "yaniv.seat";

/** Whether what came back out of storage is a seat this client could actually claim. */
function isSeat(value: unknown): value is ResumeRequest {
  if (typeof value !== "object" || value === null) return false;
  const seat = value as Record<string, unknown>;
  return (
    typeof seat.roomCode === "string" &&
    seat.roomCode.length > 0 &&
    typeof seat.playerId === "string" &&
    seat.playerId.length > 0 &&
    typeof seat.resumeToken === "string" &&
    seat.resumeToken.length > 0
  );
}

export function seatStore(target: StorageHolder): TokenStore {
  /**
   * The storage, or nothing if this browser will not part with it.
   *
   * Asked for on every call rather than once: the property access itself throws in Chrome
   * with cookies blocked, and holding onto whatever it answered at construction would tie
   * the whole store to how the page happened to be configured at the moment it loaded.
   */
  const storage = (): SeatStorage | null => {
    try {
      return target.localStorage;
    } catch {
      return null;
    }
  };

  return {
    get: () => {
      try {
        const written = storage()?.getItem(SEAT_KEY);
        if (written === null || written === undefined) return null;
        const parsed: unknown = JSON.parse(written);
        // Anything else under this key was left by some other page, or by a write that did
        // not finish. A claim built from half of one is a refusal waiting to happen, and
        // the player would be told a game they were never in had gone.
        return isSeat(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    set: (seat) => {
      try {
        storage()?.setItem(SEAT_KEY, JSON.stringify(seat));
      } catch {
        // A seat that could not be written down is one this page keeps in memory alone —
        // which is what the session core does with it anyway until the tab goes.
      }
    },

    clear: () => {
      try {
        storage()?.removeItem(SEAT_KEY);
      } catch {
        // Nothing to be done, and nothing worth saying: the seat is already forgotten
        // everywhere this client will look for it.
      }
    },
  };
}
