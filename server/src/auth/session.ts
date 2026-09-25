/**
 * The session: our own token, which outlasts Google's (docs/adr/0020).
 *
 * A Google ID token lives an hour, so something must remember that a player proved who they
 * are. Google decides *who*; this only remembers *that they proved it*. On sign-in a CSPRNG
 * token is minted, its **SHA-256** goes into the store and the raw token goes to the
 * browser — so a leaked `session` table resumes nobody, and a random token needs no slow
 * KDF to make that true, having nothing guessable to protect.
 *
 * **This is the one place the hash is computed.** A second copy that hashed differently —
 * another encoding, a trimmed input — would be a session nobody could ever resume, found by
 * nobody until a player was signed out for it.
 *
 * Minting sits behind an injectable generator, `Player.resumeToken`'s shape, for two
 * reasons: a test can name the token it expects back, and a test sweeping the wire for one
 * has a mark to look for — without it the security assertion cannot be written at all.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { AccountId, ProfileStore } from "../profiles.ts";

/**
 * How long a session lasts: **thirty days, fixed from issue**. No sliding renewal — that
 * would be a write on every connect for no gain — so day 31 is one tap on the button again.
 */
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bytes behind a session token — the resume token's size, and for its reason: a
 * credential, sized to be unguessable rather than typeable.
 */
const SESSION_TOKEN_BYTES = 32;

/** Where a session token comes from. The default is a CSPRNG; a test issues its own. */
export type SessionTokenGenerator = () => string;

export const randomSessionToken: SessionTokenGenerator = () =>
  randomBytes(SESSION_TOKEN_BYTES).toString("base64url");

/** What the store keys a session by. Every lookup of a presented token goes through here. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Open a session for `accountId`, issued at `issuedAt`, and answer the raw token — the
 * caller's to hand to the browser once, in an ack, and never to keep.
 */
export async function openSession(
  store: ProfileStore,
  accountId: AccountId,
  issuedAt: number,
  newToken: SessionTokenGenerator,
): Promise<string> {
  const token = newToken();
  await store.createSession(accountId, hashSessionToken(token), issuedAt + SESSION_LIFETIME_MS);
  return token;
}

/**
 * Give a session up: the store forgets it, and the token that opened it resumes nobody
 * from here on — signing out. A token with no session behind it is nothing to refuse.
 */
export async function endSession(store: ProfileStore, token: string): Promise<void> {
  await store.deleteSession(hashSessionToken(token));
}

/** How often lapsed sessions are cleared out of the store: daily. */
export const SESSION_SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Clear out lapsed sessions now and every `SESSION_SWEEP_MS` after, until the returned
 * function is called. Started by `index.ts` and nothing else.
 *
 * **Housekeeping, not a rule**: `findSession` already treats a lapsed session as absent,
 * so a sweep that never ran costs a table its rows and nobody their sign-in. That is what
 * the two choices below rest on.
 *
 * - **On the injected clock**, and not in `roomTimers.ts`: that registry is per room and
 *   keyed by what a room has waiting, and this is the whole server's. Real time is
 *   `systemClock`, unref'd, so a pending sweep never keeps a process alive.
 * - **A failed sweep is logged, never thrown.** The store throws when the database is
 *   down (docs/adr/0019), and an unhandled rejection from a timer would take every match
 *   in progress down with it — for a delete the next day's sweep does just as well.
 *   The reasoning docs/adr/0023 gives the Yaniv-call write, applied to housekeeping.
 */
export function startSessionSweep(
  store: ProfileStore,
  clock: Clock,
  log: (...args: unknown[]) => void = console.error,
): () => void {
  let cancel = () => {};

  function sweep(): void {
    store
      .deleteExpiredSessions(clock.now())
      .catch((error: unknown) => log("Sweeping expired sessions failed:", error));
    cancel = clock.after(SESSION_SWEEP_MS, sweep);
  }

  sweep();
  return () => cancel();
}
