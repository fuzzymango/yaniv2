/**
 * From a Google sign-in to an account and a session — the four things a player does with
 * an account, with no transport under them (docs/adr/0021).
 *
 * Each flow is a function over `Auth` — the verifier, the store, a clock and the session
 * generator — returning a `Result`, so `socketServer.ts`'s handlers call these and hold no
 * auth logic of their own, and this file is proved by tests that open no socket.
 *
 * **Errors are values**, as everywhere else in this server: a token Google did not vouch
 * for, a session that has lapsed and a name the rule refuses are answers, and nothing here
 * throws for one. What does throw is what `result.ts` says a throw is for — the store or
 * Google unreachable, or a row that the schema's cascades say cannot be missing.
 *
 * **What arrives off the wire is `unknown`** — `updateSettings`' reasoning: a payload's type
 * is a claim by whoever sent it. A non-string is refused as the bad string it stands in
 * for, not handed to a `.trim()` or a hash to throw on, since a throw here is a defect
 * report and a malformed payload is not one.
 *
 * `signOut` is not here. Giving up a session is `endSession` of a token the socket already
 * holds, with nothing to refuse, so there is no `Result` for it to be a flow over.
 */

import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
  type AccountView,
  type SignedIn,
  type SignInResult,
} from "@yaniv/shared";
import type { Clock } from "../clock.ts";
import type { Account, AccountId, ProfileStore } from "../profiles.ts";
import { err, ok, type Result } from "../result.ts";
import { hashSessionToken, openSession, type SessionTokenGenerator } from "./session.ts";
import type { TokenVerifier, VerifiedIdentity } from "./verifier.ts";

/**
 * What every flow runs over. All four are required, on ADR-0013's grounds: a capability a
 * call site needs is one it must not be able to forget, and a defaulted generator here
 * would be a session token the wire sweep could not name.
 */
export interface Auth {
  verifier: TokenVerifier;
  store: ProfileStore;
  /** When a session is issued, and so when it lapses. */
  clock: Pick<Clock, "now">;
  newSessionToken: SessionTokenGenerator;
}

/**
 * A Google ID token, presented from the main menu. A credential we know signs straight
 * into its account; one we do not is told a name is needed, and `createAccount` is the
 * step after.
 *
 * Google's `name` goes into the suggestion and no further — it is the only thing read off
 * the token besides the `sub`, and nothing below stores it. It goes through the same
 * display-name rule an account's name does, and a name that fails it (missing, blank,
 * longer than the limit) suggests **nothing** rather than some fixed default: a prefill
 * the player never chose is one they would have to notice and delete.
 */
export async function signIn(auth: Auth, idToken: unknown): Promise<Result<SignInResult>> {
  const identity = await verify(auth, idToken);
  if (!identity) return invalidCredential();

  const known = await signInIfKnown(auth, identity.sub);
  if (known) return ok(known);

  return ok({
    status: "nameNeeded",
    suggestedName: normalizeDisplayName(identity.name ?? "") ?? "",
  });
}

/**
 * The confirm-name step: the ID token again, and the name chosen. The token is resent
 * rather than the server holding a pending `sub` for the socket, so there is no
 * half-signed-in connection to represent (docs/adr/0021); it lives an hour, which is ample.
 *
 * **A credential that already has an account is signed into it**, the name ignored. A
 * double tap, or the same step finished in two tabs, would otherwise ask the store for a
 * second account under one credential — which it throws for, correctly, being a defect at
 * its level and a race at this one. Signing in is what the player was asking for. Two
 * creations truly in flight at once can still both miss here and one of them throw; that
 * window is one round trip wide and is not worth a transaction on the seam.
 *
 * The credential is checked before the name, so a caller Google has not vouched for learns
 * nothing, not even whether their name would have been accepted.
 */
export async function createAccount(
  auth: Auth,
  idToken: unknown,
  displayName: unknown,
): Promise<Result<SignedIn>> {
  const identity = await verify(auth, idToken);
  if (!identity) return invalidCredential();

  const known = await signInIfKnown(auth, identity.sub);
  if (known) return ok(known);

  const name = displayNameFrom(displayName);
  if (name === null) return invalidName();

  // Only the `sub`, and no secret: Google's signature is the proof, and it is on a token
  // this store never sees. A leak of the row costs nothing (docs/adr/0020).
  const account = await auth.store.createAccount(name, {
    kind: "google",
    identifier: identity.sub,
    secret: null,
  });
  return ok(await signedIn(auth, account));
}

/**
 * A session token presented back, on connect. Answers with the account, **never with
 * `nameNeeded`**: a session only exists for an account that was already created, so there
 * is no name left to ask for.
 *
 * No clock: whether a session has lapsed is the store's to judge (`findSession` treats an
 * expired one as absent), so an expired token and a forged one are the same refusal.
 */
export async function resumeSession(
  auth: Auth,
  sessionToken: unknown,
): Promise<Result<{ account: AccountView }>> {
  const accountId =
    typeof sessionToken === "string"
      ? await auth.store.findSession(hashSessionToken(sessionToken))
      : null;
  if (accountId === null) return err("INVALID_SESSION", "That session is no longer valid");
  return ok({ account: toView(await requireAccount(auth, accountId)) });
}

/**
 * Change the name an account is known by. The caller is whoever the socket is signed in
 * as, which is the transport's to know; an account bound to a connection exists by
 * construction, there being no deleting one in V0, so a missing one is the store's throw.
 */
export async function renameAccount(
  auth: Auth,
  accountId: AccountId,
  displayName: unknown,
): Promise<Result<{ account: AccountView }>> {
  const name = displayNameFrom(displayName);
  if (name === null) return invalidName();

  await auth.store.renameAccount(accountId, name);
  return ok({ account: { id: accountId, displayName: name } });
}

/** Who Google says presented this, or `null` — a non-string being no token at all. */
function verify(auth: Auth, idToken: unknown): Promise<VerifiedIdentity | null> {
  return typeof idToken === "string" ? auth.verifier.verify(idToken) : Promise.resolve(null);
}

/** The display-name rule over a payload, a non-string having no usable name in it. */
function displayNameFrom(displayName: unknown): string | null {
  return typeof displayName === "string" ? normalizeDisplayName(displayName) : null;
}

/**
 * Sign into the account this Google `sub` already reaches, or `null` where it reaches none.
 * The step `signIn` and `createAccount` share, so a returning credential cannot be answered
 * two ways depending on which of them it arrived by.
 */
async function signInIfKnown(auth: Auth, sub: string): Promise<SignedIn | null> {
  const known = await auth.store.findByCredential("google", sub);
  return known ? signedIn(auth, await requireAccount(auth, known.accountId)) : null;
}

/** A fresh session for an account, and the ack that hands it over. */
async function signedIn(auth: Auth, account: Account): Promise<SignedIn> {
  const sessionToken = await openSession(
    auth.store,
    account.id,
    auth.clock.now(),
    auth.newSessionToken,
  );
  return { status: "signedIn", sessionToken, account: toView(account) };
}

/**
 * The account behind a credential or a session. Both cascade from `account`, so a row
 * pointing at an account that is not there is the store broken, not a player refused.
 */
async function requireAccount(auth: Auth, id: AccountId): Promise<Account> {
  const account = await auth.store.loadAccount(id);
  if (!account) throw new Error(`no account ${id}`);
  return account;
}

/**
 * What the wire is told about an account, picked field by field rather than spread: the
 * stat is on `Account` and must not reach a client (docs/adr/0021).
 */
function toView(account: Account): AccountView {
  return { id: account.id, displayName: account.displayName };
}

function invalidCredential<T>(): Result<T> {
  return err("INVALID_CREDENTIAL", "That Google sign-in could not be verified");
}

function invalidName<T>(): Result<T> {
  return err("INVALID_NAME", `Name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`);
}
