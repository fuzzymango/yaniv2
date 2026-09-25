/**
 * The session: minting a token, and what the store is left holding (docs/adr/0020).
 *
 * The security claim is the store's half. The browser keeps the raw token and the server
 * keeps only its SHA-256, so a leaked `session` table resumes nobody — and the test with
 * teeth is that the token handed out does not find the session it opened. The mutation it
 * catches is storing the raw token in `auth/session.ts`.
 *
 * Expiry is judged against wall clock by every store (`createMemoryProfileStore`), so the
 * thirty days are proved by issuing sessions just either side of thirty days ago rather
 * than by waiting for one to lapse.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SESSION_SWEEP_MS,
  endSession,
  hashSessionToken,
  openSession,
  randomSessionToken,
  startSessionSweep,
} from "../../src/auth/session.ts";
import { createMemoryProfileStore, type ProfileStore } from "../../src/profiles.ts";
import { testClock } from "../helpers.ts";

const MINUTE = 60_000;
const THIRTY_DAYS = 30 * 24 * 60 * MINUTE;

async function storeWithAccount(): Promise<{ store: ProfileStore; accountId: string }> {
  const store = createMemoryProfileStore();
  const account = await store.createAccount("Ada", {
    kind: "google",
    identifier: "sub-ada",
    secret: null,
  });
  return { store, accountId: account.id };
}

describe("hashSessionToken", () => {
  it("is SHA-256, hex-encoded", () => {
    // The FIPS 180-2 test vector for "abc".
    assert.equal(
      hashSessionToken("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("randomSessionToken", () => {
  it("draws 32 bytes, base64url-encoded, fresh every time", () => {
    const first = randomSessionToken();
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(randomSessionToken(), first);
  });
});

describe("openSession", () => {
  it("hands out the token its generator issued", async () => {
    const { store, accountId } = await storeWithAccount();
    const token = await openSession(store, accountId, Date.now(), () => "known-token");
    assert.equal(token, "known-token");
  });

  it("stores the token's hash, and only the hash", async () => {
    const { store, accountId } = await storeWithAccount();
    const token = await openSession(store, accountId, Date.now(), () => "known-token");

    assert.equal(await store.findSession(token), null, "the raw token must not find it");
    assert.equal(await store.findSession(hashSessionToken(token)), accountId);
  });

  it("lasts thirty days from issue, and not a minute more", async () => {
    const { store, accountId } = await storeWithAccount();
    const now = Date.now();

    const lapsing = await openSession(store, accountId, now - THIRTY_DAYS + MINUTE, () => "a");
    const lapsed = await openSession(store, accountId, now - THIRTY_DAYS - MINUTE, () => "b");

    assert.equal(await store.findSession(hashSessionToken(lapsing)), accountId);
    assert.equal(await store.findSession(hashSessionToken(lapsed)), null);
  });
});

describe("endSession", () => {
  it("ends the session the token opened, and no other", async () => {
    const { store, accountId } = await storeWithAccount();
    const ending = await openSession(store, accountId, Date.now(), () => "ending");
    const staying = await openSession(store, accountId, Date.now(), () => "staying");

    await endSession(store, ending);

    assert.equal(await store.findSession(hashSessionToken(ending)), null);
    assert.equal(await store.findSession(hashSessionToken(staying)), accountId);
  });

  it("is a no-op for a token with no session behind it", async () => {
    const { store } = await storeWithAccount();
    await endSession(store, "never-issued");
  });
});

/**
 * The sweep is observed through what it asks the store to do, not through the store's
 * answers: `findSession` already treats a lapsed session as absent, so a sweep that never
 * ran and one that ran are indistinguishable from outside — the difference is only the
 * rows a table keeps.
 */
describe("startSessionSweep", () => {
  /** A store that records the instant of every sweep it is asked for, and can fail one. */
  function sweepRecorder(): { store: ProfileStore; sweeps: number[]; failNext: () => void } {
    const store = createMemoryProfileStore();
    const sweeps: number[] = [];
    let failing = false;
    return {
      sweeps,
      failNext: () => {
        failing = true;
      },
      store: {
        ...store,
        async deleteExpiredSessions(now) {
          sweeps.push(now);
          if (failing) {
            failing = false;
            throw new Error("database unreachable");
          }
          await store.deleteExpiredSessions(now);
        },
      },
    };
  }

  it("sweeps at once, then every twenty-four hours on the clock it is given", async () => {
    const { store, sweeps } = sweepRecorder();
    const clock = testClock();

    startSessionSweep(store, clock);
    assert.equal(sweeps.length, 1, "swept at startup");
    assert.deepEqual(clock.delays(), [SESSION_SWEEP_MS]);
    assert.equal(SESSION_SWEEP_MS, 24 * 60 * MINUTE);

    clock.tick();
    clock.tick();
    assert.equal(sweeps.length, 3);
    assert.deepEqual(clock.delays(), [SESSION_SWEEP_MS], "always exactly one waiting");
  });

  it("stops when told to, with nothing left waiting", () => {
    const { store, sweeps } = sweepRecorder();
    const clock = testClock();

    const stop = startSessionSweep(store, clock);
    stop();

    assert.equal(clock.pending(), 0);
    assert.equal(sweeps.length, 1);
  });

  it("logs a failed sweep and keeps its schedule", async () => {
    const { store, sweeps, failNext } = sweepRecorder();
    const clock = testClock();
    const logged: unknown[] = [];
    failNext();

    startSessionSweep(store, clock, (...args) => logged.push(args));
    // The failure is the store's promise rejecting, a tick after the call.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(logged.length, 1);
    clock.tick();
    assert.equal(sweeps.length, 2, "the next day still sweeps");
  });
});
