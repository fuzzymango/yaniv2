/**
 * The contract suite for `ProfileStore` — the specification of the interface, not an
 * extra beside one (docs/adr/0019). It is parameterised over a `() => ProfileStore`
 * factory and registers the in-memory store, the only implementation anything in this
 * repo runs: the day CI has a database, the Postgres store is a second entry in the
 * table below and everything under it holds both to the same answers. One thing that arm
 * needs and this one does not, learned by running it: **a fresh store is not a fresh
 * database**, so it has to clear the tables it shares with every other test — the
 * credentials and token hashes below are reused from test to test, and a primary key
 * remembers them.
 *
 * One thing this suite cannot honestly prove, named here rather than written as a skipped
 * test, because a skipped test reads as something somebody forgot:
 *
 * **`createAccount` writes two rows that land together.** Against the in-memory store the
 * account and its credential go into two maps in one synchronous body, so there is no
 * window for a half-written account to exist and nothing to observe if there were. Only a
 * store with a real transaction can be caught getting this wrong.
 *
 * One more is written anyway, for the arm it is waiting for: **concurrent `recordStats`
 * add up**. The in-memory store runs on one thread and increments in a body no `await`
 * interrupts, so two writes in flight at once are two writes in sequence and the test
 * proves only the event loop — but against Postgres it is the lost-update check, and the
 * suite is that store's specification before it is this one's.
 */

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  createMemoryProfileStore,
  NO_STATS,
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
    /**
     * A store for one test, closed however that test ends. Nothing leaks here when a
     * failed assertion would have skipped the close — the in-memory store holds nothing
     * open — but the arm this suite is built to host holds a connection pool, and an
     * open pool is exactly what keeps a `node:test` process from exiting.
     */
    function storeFor(t: TestContext): ProfileStore {
      const store = createStore();
      t.after(() => store.close());
      return store;
    }

    describe("createAccount", () => {
      it("returns an account with the name it was given and every stat at zero", async (t) => {
        const store = storeFor(t);
        const account = await store.createAccount("Ada", googleCredential("google-1"));

        assert.deepEqual(account, {
          id: account.id,
          displayName: "Ada",
          yanivCalls: 0,
          callsAssafed: 0,
          assafs: 0,
          gamesCompleted: 0,
          gamesWon: 0,
          slapdowns: 0,
        });
        assert.ok(account.id.length > 0);
      });

      it("reaches the account it created, by id and by credential", async (t) => {
        const store = storeFor(t);
        const account = await store.createAccount("Ada", googleCredential("google-1"));

        assert.deepEqual(await store.loadAccount(account.id), account);
        assert.deepEqual(await store.findByCredential("google", "google-1"), {
          accountId: account.id,
          kind: "google",
          identifier: "google-1",
          secret: null,
        });
      });

      it("gives two accounts two ids, whatever they are called", async (t) => {
        const store = storeFor(t);
        const one = await store.createAccount("Ada", googleCredential("google-1"));
        const two = await store.createAccount("Ada", googleCredential("google-2"));

        assert.notEqual(one.id, two.id);
      });

      it("refuses a credential that already belongs to an account", async (t) => {
        const store = storeFor(t);
        await store.createAccount("Ada", googleCredential("google-1"));

        await assert.rejects(() => store.createAccount("Grace", googleCredential("google-1")));
      });

      it("leaves the taken credential pointing at the account that holds it", async (t) => {
        const store = storeFor(t);
        const ada = await store.createAccount("Ada", googleCredential("google-1"));
        await assert.rejects(() => store.createAccount("Grace", googleCredential("google-1")));

        const stored = await store.findByCredential("google", "google-1");
        assert.equal(stored?.accountId, ada.id);
        assert.equal((await store.loadAccount(ada.id))?.displayName, "Ada");
      });

      // Google's credential stores no secret (docs/adr/0020) and is the only kind the
      // type admits, so this stands in for the kind that will need one: the column is on
      // the seam, and what is put in it must come back out.
      it("keeps a credential's secret where one is stored", async (t) => {
        const store = storeFor(t);
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
      });
    });

    describe("findByCredential", () => {
      it("answers null for an identifier nobody has signed in with", async (t) => {
        const store = storeFor(t);
        await store.createAccount("Ada", googleCredential("google-1"));

        assert.equal(await store.findByCredential("google", "google-2"), null);
      });
    });

    describe("loadAccount", () => {
      it("answers null for an id no account has", async (t) => {
        const store = storeFor(t);

        assert.equal(await store.loadAccount("nobody"), null);
      });

      it("answers with a copy, so a caller cannot write through it", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        const loaded = await store.loadAccount(id);
        assert.ok(loaded);
        loaded.displayName = "Grace";
        loaded.yanivCalls = 99;

        assert.deepEqual(await store.loadAccount(id), { id, displayName: "Ada", ...NO_STATS });
      });
    });

    describe("renameAccount", () => {
      it("changes the name and nothing else", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        await store.recordStats(id, { yanivCalls: 1 });

        await store.renameAccount(id, "Grace");

        assert.deepEqual(await store.loadAccount(id), {
          id,
          displayName: "Grace",
          ...NO_STATS,
          yanivCalls: 1,
        });
      });

      it("leaves the credential reaching the same account", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.renameAccount(id, "Grace");

        assert.equal((await store.findByCredential("google", "google-1"))?.accountId, id);
      });

      it("throws against an account that is not there", async (t) => {
        const store = storeFor(t);

        await assert.rejects(() => store.renameAccount("nobody", "Grace"));
      });
    });

    describe("recordStats", () => {
      it("adds the counters a delta names and leaves the rest alone", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.recordStats(id, { yanivCalls: 1, callsAssafed: 1 });
        await store.recordStats(id, { gamesCompleted: 1, gamesWon: 1, yanivCalls: 1 });

        assert.deepEqual(await store.loadAccount(id), {
          id,
          displayName: "Ada",
          yanivCalls: 2,
          callsAssafed: 1,
          assafs: 0,
          gamesCompleted: 1,
          gamesWon: 1,
          slapdowns: 0,
        });
      });

      it("adds every counter it is handed", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        const everything = {
          yanivCalls: 1,
          callsAssafed: 2,
          assafs: 3,
          gamesCompleted: 4,
          gamesWon: 5,
          slapdowns: 6,
        };

        await store.recordStats(id, everything);

        assert.deepEqual(await store.loadAccount(id), { id, displayName: "Ada", ...everything });
      });

      it("adds up writes made at once", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await Promise.all(
          Array.from({ length: 10 }, () => store.recordStats(id, { yanivCalls: 1, slapdowns: 2 })),
        );

        const account = await store.loadAccount(id);
        assert.equal(account?.yanivCalls, 10);
        assert.equal(account?.slapdowns, 20);
      });

      it("counts against the account named and no other", async (t) => {
        const store = storeFor(t);
        const ada = await store.createAccount("Ada", googleCredential("google-1"));
        const grace = await store.createAccount("Grace", googleCredential("google-2"));

        await store.recordStats(ada.id, { assafs: 1 });

        assert.equal((await store.loadAccount(ada.id))?.assafs, 1);
        assert.deepEqual(await store.loadAccount(grace.id), grace);
      });

      it("throws against an account that is not there", async (t) => {
        const store = storeFor(t);

        await assert.rejects(() => store.recordStats("nobody", { yanivCalls: 1 }));
      });
    });

    describe("sessions", () => {
      it("finds the account behind a live session", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.createSession(id, "hash-1", Date.now() + MINUTE);

        assert.equal(await store.findSession("hash-1"), id);
      });

      it("answers null for a hash no session was ever created with", async (t) => {
        const store = storeFor(t);

        assert.equal(await store.findSession("hash-1"), null);
      });

      it("tells two of one account's sessions apart", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        await store.createSession(id, "hash-1", Date.now() + MINUTE);
        await store.createSession(id, "hash-2", Date.now() + MINUTE);

        await store.deleteSession("hash-1");

        assert.equal(await store.findSession("hash-1"), null);
        assert.equal(await store.findSession("hash-2"), id);
      });

      it("answers null for a session that has expired, swept or not", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));

        await store.createSession(id, "hash-1", Date.now() - MINUTE);

        assert.equal(await store.findSession("hash-1"), null);
      });

      it("refuses a session for an account that is not there", async (t) => {
        const store = storeFor(t);

        await assert.rejects(() => store.createSession("nobody", "hash-1", Date.now() + MINUTE));
        assert.equal(await store.findSession("hash-1"), null);
      });

      it("refuses a token hash a session already has", async (t) => {
        const store = storeFor(t);
        const ada = await store.createAccount("Ada", googleCredential("google-1"));
        const grace = await store.createAccount("Grace", googleCredential("google-2"));
        await store.createSession(ada.id, "hash-1", Date.now() + MINUTE);

        await assert.rejects(() => store.createSession(grace.id, "hash-1", Date.now() + MINUTE));

        assert.equal(await store.findSession("hash-1"), ada.id);
      });

      it("takes deleting a session nobody holds in its stride", async (t) => {
        const store = storeFor(t);

        await store.deleteSession("hash-1");
      });

      it("sweeps what had expired by the instant it is given, and nothing else", async (t) => {
        const store = storeFor(t);
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
      });

      it("leaves the account a swept session belonged to alone", async (t) => {
        const store = storeFor(t);
        const { id } = await store.createAccount("Ada", googleCredential("google-1"));
        await store.createSession(id, "hash-1", Date.now() + MINUTE);

        await store.deleteExpiredSessions(Date.now() + MINUTE);

        assert.equal((await store.loadAccount(id))?.displayName, "Ada");
      });
    });

    describe("close", () => {
      it("resolves, having nothing of its own to let go of", async () => {
        await createStore().close();
      });
    });
  });
}
