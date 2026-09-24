/**
 * The contract suite for `ProfileStore` — the specification of the interface, not an
 * extra beside one (docs/adr/0019). It is parameterised over a `() => ProfileStore`
 * factory and registers the in-memory store, the only implementation anything in this
 * repo runs: the day CI has a database, the Postgres store is a second entry in the
 * table below and everything under it holds both to the same answers.
 *
 * Two things this suite cannot honestly prove, named here rather than written as skipped
 * tests, because a skipped test reads as something somebody forgot:
 *
 * 1. **`createAccount` writes two rows that land together.** Against the in-memory store
 *    the account and its credential go into two maps in one synchronous body, so there is
 *    no window for a half-written account to exist and nothing to observe if there were.
 *    Only a store with a real transaction can be caught getting this wrong.
 * 2. **Concurrent `recordYanivCall`s add up.** The in-memory store runs on one thread and
 *    increments in a body no `await` interrupts, so two calls in flight at once are two
 *    calls in sequence. A test of it would prove the event loop works, not the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMemoryProfileStore,
  type NewCredential,
  type ProfileStore,
} from "../src/profiles.ts";

/** Every implementation this suite is run against. The second arrives with CI. */
const implementations: Array<[string, () => ProfileStore]> = [
  ["in-memory", createMemoryProfileStore],
];

/**
 * Far enough either side of now for a session's expiry to be unambiguous, with no clock
 * to inject: `expiresAt` is the caller's instant, and whether it has passed is the one
 * thing the store decides for itself (Postgres with its own `now()`, the store below with
 * `Date.now`), so the suite says "a minute ago" and "in a minute" instead.
 */
const MINUTE = 60_000;

/** A Google credential, the only kind V0 has: the `sub`, and no secret to store. */
function googleCredential(sub: string): NewCredential {
  return { kind: "google", identifier: sub, secret: null };
}

for (const [name, createStore] of implementations) {
  describe(`ProfileStore (${name})`, () => {
    describe("createAccount", () => {
      it("returns an account with the name it was given and no calls yet", async () => {
        const store = createStore();
        const account = await store.createAccount("Ada", googleCredential("google-1"));

        assert.equal(account.displayName, "Ada");
        assert.equal(account.yanivCalls, 0);
        assert.ok(account.id.length > 0);
        await store.close();
      });

      it("reaches the account it created, by id and by credential", async () => {
        const store = createStore();
        const account = await store.createAccount("Ada", googleCredential("google-1"));

        assert.deepEqual(await store.loadAccount(account.id), account);
        assert.deepEqual(await store.findByCredential("google", "google-1"), {
          accountId: account.id,
          kind: "google",
          identifier: "google-1",
          secret: null,
        });
        await store.close();
      });

      it("gives two accounts two ids, whatever they are called", async () => {
        const store = createStore();
        const one = await store.createAccount("Ada", googleCredential("google-1"));
        const two = await store.createAccount("Ada", googleCredential("google-2"));

        assert.notEqual(one.id, two.id);
        await store.close();
      });

      it("refuses a credential that already belongs to an account", async () => {
        const store = createStore();
        await store.createAccount("Ada", googleCredential("google-1"));

        await assert.rejects(() => store.createAccount("Grace", googleCredential("google-1")));
        await store.close();
      });

      it("leaves the taken credential pointing at the account that holds it", async () => {
        const store = createStore();
        const ada = await store.createAccount("Ada", googleCredential("google-1"));
        await assert.rejects(() => store.createAccount("Grace", googleCredential("google-1")));

        const stored = await store.findByCredential("google", "google-1");
        assert.equal(stored?.accountId, ada.id);
        assert.equal((await store.loadAccount(ada.id))?.displayName, "Ada");
        await store.close();
      });

      it("keeps a credential's secret where one is stored", async () => {
        const store = createStore();
        const account = await store.createAccount("Ada", {
          kind: "google",
          identifier: "google-1",
          secret: "hashed",
        });

        const stored = await store.findByCredential("google", "google-1");
        assert.deepEqual(stored, {
          accountId: account.id,
          kind: "google",
          identifier: "google-1",
          secret: "hashed",
        });
        await store.close();
      });
    });

    describe("findByCredential", () => {
      it("answers null for an identifier nobody has signed in with", async () => {
        const store = createStore();
        await store.createAccount("Ada", googleCredential("google-1"));

        assert.equal(await store.findByCredential("google", "google-2"), null);
        await store.close();
      });
    });

    describe("loadAccount", () => {
      it("answers null for an id no account has", async () => {
        const store = createStore();

        assert.equal(await store.loadAccount("nobody"), null);
        await store.close();
      });

      it("answers with a copy, so a caller cannot write through it", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        const loaded = await store.loadAccount(id);
        assert.ok(loaded);
        loaded.displayName = "Grace";
        loaded.yanivCalls = 99;

        assert.deepEqual(await store.loadAccount(id), { id, displayName: "Ada", yanivCalls: 0 });
        await store.close();
      });
    });

    describe("renameAccount", () => {
      it("changes the name and nothing else", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        await store.recordYanivCall(id);

        await store.renameAccount(id, "Grace");

        assert.deepEqual(await store.loadAccount(id), { id, displayName: "Grace", yanivCalls: 1 });
        await store.close();
      });

      it("leaves the credential reaching the same account", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.renameAccount(id, "Grace");

        assert.equal((await store.findByCredential("google", "google-1"))?.accountId, id);
        await store.close();
      });

      it("throws against an account that is not there", async () => {
        const store = createStore();

        await assert.rejects(() => store.renameAccount("nobody", "Grace"));
        await store.close();
      });
    });

    describe("recordYanivCall", () => {
      it("counts one call per write", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.recordYanivCall(id);
        await store.recordYanivCall(id);
        await store.recordYanivCall(id);

        assert.equal((await store.loadAccount(id))?.yanivCalls, 3);
        await store.close();
      });

      it("counts against the account that called and no other", async () => {
        const store = createStore();
        const ada = await store.createAccount("Ada", googleCredential("google-1"));
        const grace = await store.createAccount("Grace", googleCredential("google-2"));

        await store.recordYanivCall(ada.id);

        assert.equal((await store.loadAccount(ada.id))?.yanivCalls, 1);
        assert.equal((await store.loadAccount(grace.id))?.yanivCalls, 0);
        await store.close();
      });

      it("throws against an account that is not there", async () => {
        const store = createStore();

        await assert.rejects(() => store.recordYanivCall("nobody"));
        await store.close();
      });
    });

    describe("sessions", () => {
      it("finds the account behind a live session", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.createSession(id, "hash-1", Date.now() + MINUTE);

        assert.equal(await store.findSession("hash-1"), id);
        await store.close();
      });

      it("answers null for a hash no session was ever created with", async () => {
        const store = createStore();

        assert.equal(await store.findSession("hash-1"), null);
        await store.close();
      });

      it("tells two of one account's sessions apart", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        await store.createSession(id, "hash-1", Date.now() + MINUTE);
        await store.createSession(id, "hash-2", Date.now() + MINUTE);

        await store.deleteSession("hash-1");

        assert.equal(await store.findSession("hash-1"), null);
        assert.equal(await store.findSession("hash-2"), id);
        await store.close();
      });

      it("answers null for a session that has expired, swept or not", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.createSession(id, "hash-1", Date.now() - MINUTE);

        assert.equal(await store.findSession("hash-1"), null);
        await store.close();
      });

      it("refuses a session for an account that is not there", async () => {
        const store = createStore();

        await assert.rejects(() => store.createSession("nobody", "hash-1", Date.now() + MINUTE));
        assert.equal(await store.findSession("hash-1"), null);
        await store.close();
      });

      it("refuses a token hash a session already has", async () => {
        const store = createStore();
        const ada = await store.createAccount("Ada", googleCredential("google-1"));
        const grace = await store.createAccount("Grace", googleCredential("google-2"));
        await store.createSession(ada.id, "hash-1", Date.now() + MINUTE);

        await assert.rejects(() => store.createSession(grace.id, "hash-1", Date.now() + MINUTE));

        assert.equal(await store.findSession("hash-1"), ada.id);
        await store.close();
      });

      it("takes deleting a session nobody holds in its stride", async () => {
        const store = createStore();

        await store.deleteSession("hash-1");
        await store.close();
      });

      it("sweeps what had expired by the instant it is given, and nothing else", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        // Swept from an instant still ahead of now, so what survives is observable: a
        // session left behind by a sweep run at 1_000 would read as absent anyway, and
        // the test would pass against a sweep that did nothing at all.
        const sweepAt = Date.now() + MINUTE;
        await store.createSession(id, "long expired", Date.now() - MINUTE);
        await store.createSession(id, "expiring on the instant", sweepAt);
        await store.createSession(id, "expiring after it", sweepAt + MINUTE);

        await store.deleteExpiredSessions(sweepAt);

        assert.equal(await store.findSession("long expired"), null);
        assert.equal(await store.findSession("expiring on the instant"), null);
        assert.equal(await store.findSession("expiring after it"), id);
        await store.close();
      });

      it("leaves the account a swept session belonged to alone", async () => {
        const store = createStore();
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        await store.createSession(id, "hash-1", Date.now() + MINUTE);

        await store.deleteExpiredSessions(Date.now() + MINUTE);

        assert.equal((await store.loadAccount(id))?.displayName, "Ada");
        await store.close();
      });
    });

    describe("close", () => {
      it("resolves, having nothing of its own to let go of", async () => {
        const store = createStore();

        await store.close();
      });
    });
  });
}
