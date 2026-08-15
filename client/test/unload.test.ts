/**
 * The warning a player gets for closing the tab on a live match.
 *
 * Pure, and driven against a stand-in for both sides: a session that publishes whatever a
 * test wants it to, and a window that records what was registered on it. `beforeunload` is
 * one of the few browser behaviours that cannot be provoked from a script at all — a real
 * browser will not let a page fire it — so what is worth testing is the registration and
 * nothing else: it is on while the room would be destroyed by leaving, and off otherwise.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Phase } from "@yaniv/shared";
import type { SessionSnapshot } from "../src/session.ts";
import type { UnloadEvent, UnloadTarget } from "../src/unload.ts";
import { guardUnload } from "../src/unload.ts";
import { cards, viewOf } from "./helpers.ts";

/** A window that remembers what is listening on it, and can set it off. */
function fakeWindow() {
  const listeners = new Set<(event: UnloadEvent) => void>();

  const target: UnloadTarget = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };

  return {
    target,
    listening: () => listeners.size,
    /** Close the tab, and answer whether anything asked the browser to think again. */
    unload: () => {
      let prevented = false;
      const event: UnloadEvent = {
        preventDefault: () => {
          prevented = true;
        },
        returnValue: undefined,
      };
      for (const listener of listeners) listener(event);
      return { prevented, returnValue: event.returnValue };
    },
  };
}

/** A snapshot of a session sitting in the phase named, or on the main menu for null. */
function snapshotOf(phase: Phase | null, connected = true): SessionSnapshot {
  return {
    view: phase === null ? null : { ...viewOf(cards("hearts-7"), []), phase },
    error: null,
    notice: null,
    busy: false,
    connected,
    resuming: false,
    selection: [],
  };
}

/** The read half of a session, which is all the guard is given and all it needs. */
function fakeSession(phase: Phase | null) {
  let snapshot = snapshotOf(phase);
  const listeners = new Set<() => void>();

  const publish = (next: SessionSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    /** Move the session on, the way an arriving position does. */
    moveTo: (next: Phase | null) => publish(snapshotOf(next)),
    /**
     * Take the socket away and leave the position where it was, which is exactly what the
     * session core does — there is nothing to replace it with until a socket comes back.
     */
    drop: () => publish({ ...snapshot, connected: false }),
    watchers: () => listeners.size,
  };
}

describe("warning before the tab closes", () => {
  it("warns while a round is being played", () => {
    const window = fakeWindow();
    guardUnload(fakeSession("playing"), window.target);

    assert.equal(window.listening(), 1);
  });

  it("warns on a scored round too, because the match is not over", () => {
    const window = fakeWindow();
    guardUnload(fakeSession("roundEnd"), window.target);

    assert.equal(window.listening(), 1);
  });

  it("says nothing where leaving costs nothing", () => {
    // The main menu, the lobby and a finished match: the three positions a player is
    // allowed to walk away from, two of them with a control on the screen that does it.
    for (const phase of [null, "lobby", "gameEnd"] as const) {
      const window = fakeWindow();
      guardUnload(fakeSession(phase), window.target);

      assert.equal(window.listening(), 0, `${phase ?? "the main menu"} needs no warning`);
    }
  });

  it("starts warning when the cards come out, and stops when the match ends", () => {
    const window = fakeWindow();
    const session = fakeSession("lobby");
    guardUnload(session, window.target);

    session.moveTo("playing");
    assert.equal(window.listening(), 1, "the room is now one a reload would destroy");

    session.moveTo("gameEnd");
    assert.equal(window.listening(), 0, "and the match it would have destroyed is over");
  });

  it("stops warning once the connection has gone", () => {
    const window = fakeWindow();
    const session = fakeSession("playing");
    guardUnload(session, window.target);

    session.drop();

    // The room was destroyed the moment the socket dropped, so the table still on the
    // screen is a match that is already lost. Arguing about closing the tab on it would be
    // arguing about nothing — and the player is looking at the disconnected screen anyway.
    assert.equal(window.listening(), 0);
  });

  it("registers once however many positions arrive", () => {
    const window = fakeWindow();
    const session = fakeSession("playing");
    guardUnload(session, window.target);

    // Every tap of a card publishes a snapshot, and a match is hundreds of them.
    session.moveTo("playing");
    session.moveTo("playing");

    assert.equal(window.listening(), 1);
  });

  it("asks the browser to think again", () => {
    const window = fakeWindow();
    guardUnload(fakeSession("playing"), window.target);

    const { prevented, returnValue } = window.unload();
    assert.equal(prevented, true, "the modern way of asking");
    // Older browsers ignore preventDefault and look at this instead. Its value is never
    // shown — every browser insists on its own words — so anything truthy will do.
    assert.ok(returnValue, "and the way the rest of them still want to be asked");
  });

  it("leaves nothing behind when it is taken down", () => {
    const window = fakeWindow();
    const session = fakeSession("playing");

    guardUnload(session, window.target)();

    assert.equal(window.listening(), 0, "no warning about a session nobody is watching");
    assert.equal(session.watchers(), 0, "and nothing left subscribed to it");
  });
});
