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
