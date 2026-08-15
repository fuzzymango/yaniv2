/**
 * The seat a page writes down, driven with no browser in sight.
 *
 * The storage is injected, so this suite hands the store a `Map` in the shape of
 * `localStorage` and reads what was put there. A reload is two stores over one storage,
 * which is the whole of what the browser does for us and the only thing worth asserting.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResumeRequest } from "@yaniv/shared";
import { SEAT_KEY, seatStore, type SeatStorage } from "../src/tokens.ts";

const SEAT: ResumeRequest = {
  roomCode: "ABCD",
  playerId: "p1",
  resumeToken: "a-secret",
};

/** `localStorage` in as much detail as the store uses, and no more. */
function fakeStorage(seeded: Record<string, string> = {}) {
  const held = new Map(Object.entries(seeded));
  const storage: SeatStorage = {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
  return { storage, held };
}

/** A browser with storage turned off: every call throws, including the very first. */
const REFUSING: SeatStorage = {
  getItem: () => {
    throw new Error("storage is disabled");
  },
  setItem: () => {
    throw new Error("storage is disabled");
  },
  removeItem: () => {
    throw new Error("storage is disabled");
  },
};

describe("the seat a page writes down", () => {
  it("hands a stored seat to the next page that opens", () => {
    const { storage } = fakeStorage();
    seatStore({ localStorage: storage }).set(SEAT);

    // The reload: a second store over the same storage, which is all a fresh page
    // inherits from the one before it.
    assert.deepEqual(seatStore({ localStorage: storage }).get(), SEAT);
  });

  it("holds one seat under one key", () => {
    const { storage, held } = fakeStorage();
    const store = seatStore({ localStorage: storage });

    store.set(SEAT);
    store.set({ ...SEAT, roomCode: "WXYZ" });

    assert.equal(held.size, 1, "a page is at one table at a time");
    assert.equal(store.get()?.roomCode, "WXYZ", "and it is the one it sat down at last");
  });

  it("keeps nothing once the seat is given up", () => {
    const { storage, held } = fakeStorage();
    const store = seatStore({ localStorage: storage });
    store.set(SEAT);

    store.clear();

    assert.equal(store.get(), null);
    assert.equal(held.size, 0, "cleared rather than blanked, so nothing is left to parse");
  });

  it("knows of no seat when nothing was ever written down", () => {
    assert.equal(seatStore({ localStorage: fakeStorage().storage }).get(), null);
  });

  /*
   * Whatever is under that key was put there by a page, but not necessarily by this
   * version of one — a half-written value, an older shape, or something else entirely on a
   * shared origin. A claim built out of it would be refused by the server anyway, and the
   * player would be told a game they were never in had gone.
   */
  it("knows of no seat when what is written down is not one", () => {
    for (const junk of [
      "not json at all",
      "null",
      '"a string"',
      "42",
      '{"roomCode":"ABCD"}',
      '{"roomCode":"ABCD","playerId":"p1"}',
      '{"roomCode":"ABCD","playerId":"p1","resumeToken":""}',
      '{"roomCode":"ABCD","playerId":"p1","resumeToken":7}',
    ]) {
      const { storage } = fakeStorage({ [SEAT_KEY]: junk });
      assert.equal(seatStore({ localStorage: storage }).get(), null, junk);
    }
  });

  it("keeps a seat readable to itself whatever else is on the origin", () => {
    const { storage, held } = fakeStorage({ "someone-elses": "their business" });
    seatStore({ localStorage: storage }).set(SEAT);

    assert.equal(held.get("someone-elses"), "their business");
    assert.deepEqual(seatStore({ localStorage: storage }).get(), SEAT);
  });

  /*
   * Private browsing, storage disabled, or a quota already full. None of it is worth an
   * error on the screen: a page that cannot write a seat down simply cannot be reloaded
   * back into it, which is exactly where the client stood before there was a store at all.
   */
  it("carries on with no storage to write to", () => {
    const store = seatStore({ localStorage: REFUSING });

    assert.doesNotThrow(() => store.set(SEAT));
    assert.doesNotThrow(() => store.clear());
    assert.equal(store.get(), null);
  });

  it("carries on where reaching for storage is itself refused", () => {
    // Chrome with cookies blocked throws on the property access, before any method is
    // called — so the reach has to be guarded as well as the call.
    const blocked = {
      get localStorage(): SeatStorage {
        throw new Error("access is denied");
      },
    };

    const store = seatStore(blocked);
    assert.doesNotThrow(() => store.set(SEAT));
    assert.equal(store.get(), null);
  });
});
