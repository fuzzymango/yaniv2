/**
 * Where a page's credentials go so that they outlive it: the seat it can sit back down in,
 * and the account it is signed in as (docs/adr/0020).
 *
 * The session core holds both and would lose them with the tab (see `TokenStore` and
 * `AccountStore` in `session.ts`); these are the implementations that survive a reload,
 * and this is the only file in the client that knows the word `localStorage`. Handed over
 * in `main.tsx`, exactly as the socket is — the storage is injected rather than reached
 * for, which is what lets this be driven under `node:test` with no browser anywhere in it.
 *
 * Two keys and not one, because the two answer different questions and are let go of at
 * different moments: leaving a room forgets the seat and keeps the account, and only
 * signing out forgets both — which the session core does by clearing each.
 *
 * Everything here fails quietly. Storage can be off (private browsing, blocked cookies), it
 * can be full, and what is under either key can be anything at all on a shared origin —
 * none of which is news to a player: a page that cannot write a seat down simply cannot be
 * reloaded back into it, and one that cannot write an account down is a guest after a
 * reload, which is where the client stood before there was a store at all.
 *
 * `sessionStorage` would be the tighter fit for a credential that dies with the tab, and it
 * is deliberately not used: a phone that discards a backgrounded tab and rebuilds it is the
 * case the seat's store was built for, and `sessionStorage` is what such a tab comes back
 * without.
 */

import type { ResumeRequest } from "@yaniv/shared";
import type { AccountStore, TokenStore } from "./session.ts";

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

/**
 * Where the session token is written: its own key, beside the seat's rather than inside
 * it. Held as `{ sessionToken }` and not as a bare string, so that a value some other page
 * left under the key is told apart from a token by its shape — a bare string would be
 * presented to the server and refused, and the player told a sign-in they never made had
 * lapsed.
 */
export const ACCOUNT_KEY = "yaniv.account";

function isAccount(value: unknown): value is { sessionToken: string } {
  if (typeof value !== "object" || value === null) return false;
  const account = value as Record<string, unknown>;
  return typeof account.sessionToken === "string" && account.sessionToken.length > 0;
}

/**
 * One value under one key, read back only if it has the shape it was written in. What the
 * two stores have in common, which is all of it but the key and the shape.
 */
function keptUnder<T>(
  target: StorageHolder,
  key: string,
  isValid: (value: unknown) => value is T,
): { get: () => T | null; set: (value: T) => void; clear: () => void } {
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
        const written = storage()?.getItem(key);
        if (written === null || written === undefined) return null;
        const parsed: unknown = JSON.parse(written);
        // Anything else under this key was left by some other page, or by a write that did
        // not finish. A claim built from half of one is a refusal waiting to happen, and
        // the player would be told something they never had had gone.
        return isValid(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    set: (value) => {
      try {
        storage()?.setItem(key, JSON.stringify(value));
      } catch {
        // A credential that could not be written down is one this page keeps in memory
        // alone — which is what the session core does with it anyway until the tab goes.
      }
    },

    clear: () => {
      try {
        storage()?.removeItem(key);
      } catch {
        // Nothing to be done, and nothing worth saying: the credential is already
        // forgotten everywhere this client will look for it.
      }
    },
  };
}

export function seatStore(target: StorageHolder): TokenStore {
  return keptUnder(target, SEAT_KEY, isSeat);
}

export function accountStore(target: StorageHolder): AccountStore {
  const kept = keptUnder(target, ACCOUNT_KEY, isAccount);
  return {
    get: () => kept.get()?.sessionToken ?? null,
    set: (sessionToken) => kept.set({ sessionToken }),
    clear: kept.clear,
  };
}
