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
  hashSessionToken,
  openSession,
  randomSessionToken,
} from "../../src/auth/session.ts";
import { createMemoryProfileStore, type ProfileStore } from "../../src/profiles.ts";

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
