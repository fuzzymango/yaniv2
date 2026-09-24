/**
 * The four auth flows, over a fake verifier, the in-memory store and a test clock — no
 * socket, no Google (docs/adr/0021).
 *
 * Everything is observed through the flows themselves: a session is proved to exist by
 * resuming it, an account by signing back into it. The store is only reached into where
 * the flows have no way to say the thing asserted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAccount,
  renameAccount,
  resumeSession,
  signIn,
  type Auth,
} from "../../src/auth/flows.ts";
import { createMemoryProfileStore } from "../../src/profiles.ts";
import { SESSION_TOKEN_MARK, expectErr, markedSessionTokens, unwrap } from "../helpers.ts";
import { fakeVerifier, type FakeVerifier } from "./verifier.ts";

/** The session tokens `markedSessionTokens` issues, in order. */
const FIRST_SESSION = `${SESSION_TOKEN_MARK}1`;
const SECOND_SESSION = `${SESSION_TOKEN_MARK}2`;

const MINUTE = 60_000;
const THIRTY_DAYS = 30 * 24 * 60 * MINUTE;

/**
 * Flows over a fresh store, with the clock reading `now` — wall time unless a test says
 * otherwise, since the store judges expiry against the wall (`createMemoryProfileStore`).
 */
function setup(
  now: () => number = Date.now,
): { auth: Auth; google: FakeVerifier } {
  const google = fakeVerifier();
  return {
    google,
    auth: {
      verifier: google,
      store: createMemoryProfileStore(),
      clock: { now },
      newSessionToken: markedSessionTokens(),
    },
  };
}

describe("signIn", () => {
  it("refuses a token Google did not vouch for", async () => {
    const { auth } = setup();
    expectErr(await signIn(auth, "forged"), "INVALID_CREDENTIAL");
  });

  it("asks a stranger for a name, suggesting Google's", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "  Ada Lovelace " });

    assert.deepEqual(unwrap(await signIn(auth, "id-ada")), {
      status: "nameNeeded",
      suggestedName: "Ada Lovelace",
    });
  });

  it("suggests nothing where Google's name is missing or not a legal display name", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-nameless", { sub: "sub-nameless" });
    google.vouchFor("id-blank", { sub: "sub-blank", name: "   " });
    google.vouchFor("id-long", { sub: "sub-long", name: "Augusta Ada King, Countess of Lovelace" });

    for (const idToken of ["id-nameless", "id-blank", "id-long"]) {
      assert.deepEqual(unwrap(await signIn(auth, idToken)), {
        status: "nameNeeded",
        suggestedName: "",
      });
    }
  });

  it("signs a known credential back into its account, with a fresh session", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const created = unwrap(await createAccount(auth, "id-ada", "Ada"));

    assert.deepEqual(unwrap(await signIn(auth, "id-ada")), {
      status: "signedIn",
      sessionToken: SECOND_SESSION,
      account: created.account,
    });
  });
});

describe("createAccount", () => {
  it("creates the account under the name chosen, trimmed, and signs it in", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });

    const created = unwrap(await createAccount(auth, "id-ada", "  Ada "));

    assert.equal(created.status, "signedIn");
    assert.equal(created.sessionToken, FIRST_SESSION);
    assert.equal(created.account.displayName, "Ada");
    assert.deepEqual(Object.keys(created.account).sort(), ["displayName", "id"]);
  });

  it("stores the credential as Google's sub, with no secret", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const created = unwrap(await createAccount(auth, "id-ada", "Ada"));

    assert.deepEqual(await auth.store.findByCredential("google", "sub-ada"), {
      kind: "google",
      identifier: "sub-ada",
      secret: null,
      accountId: created.account.id,
    });
  });

  it("refuses a token Google did not vouch for", async () => {
    const { auth } = setup();
    expectErr(await createAccount(auth, "forged", "Ada"), "INVALID_CREDENTIAL");
  });

  it("refuses a name the display-name rule does not allow, and creates nothing", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });

    expectErr(await createAccount(auth, "id-ada", "   "), "INVALID_NAME");
    expectErr(await createAccount(auth, "id-ada", "x".repeat(21)), "INVALID_NAME");

    assert.equal(unwrap(await signIn(auth, "id-ada")).status, "nameNeeded");
  });

  it("answers a credential that already has an account by signing into it, name unchanged", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const first = unwrap(await createAccount(auth, "id-ada", "Ada"));

    const again = unwrap(await createAccount(auth, "id-ada", "Someone Else"));

    assert.deepEqual(again, {
      status: "signedIn",
      sessionToken: SECOND_SESSION,
      account: first.account,
    });
  });
});

describe("resumeSession", () => {
  it("answers the account behind any session it issued", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const created = unwrap(await createAccount(auth, "id-ada", "Ada"));
    const signedBackIn = unwrap(await signIn(auth, "id-ada"));
    assert.equal(signedBackIn.status, "signedIn");

    for (const token of [created.sessionToken, signedBackIn.sessionToken]) {
      assert.deepEqual(unwrap(await resumeSession(auth, token)), { account: created.account });
    }
  });

  it("refuses a token it never issued", async () => {
    const { auth } = setup();
    expectErr(await resumeSession(auth, `${SESSION_TOKEN_MARK}1`), "INVALID_SESSION");
  });

  it("refuses a session issued more than thirty days ago", async () => {
    const { auth, google } = setup(() => Date.now() - THIRTY_DAYS - MINUTE);
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const created = unwrap(await createAccount(auth, "id-ada", "Ada"));

    expectErr(await resumeSession(auth, created.sessionToken), "INVALID_SESSION");
  });
});

describe("renameAccount", () => {
  it("renames the account, trimmed, for every session it has", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const created = unwrap(await createAccount(auth, "id-ada", "Ada"));
    const renamed = { id: created.account.id, displayName: "Countess" };

    assert.deepEqual(unwrap(await renameAccount(auth, created.account.id, " Countess ")), {
      account: renamed,
    });
    assert.deepEqual(unwrap(await resumeSession(auth, created.sessionToken)), {
      account: renamed,
    });
  });

  it("refuses a name the display-name rule does not allow, and keeps the old one", async () => {
    const { auth, google } = setup();
    google.vouchFor("id-ada", { sub: "sub-ada", name: "Ada Lovelace" });
    const created = unwrap(await createAccount(auth, "id-ada", "Ada"));

    expectErr(await renameAccount(auth, created.account.id, ""), "INVALID_NAME");
    expectErr(await renameAccount(auth, created.account.id, "x".repeat(21)), "INVALID_NAME");

    assert.deepEqual(unwrap(await resumeSession(auth, created.sessionToken)), {
      account: created.account,
    });
  });
});
