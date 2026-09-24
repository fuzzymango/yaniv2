/**
 * The seam between "somebody says Google vouches for them" and "Google does".
 *
 * Verification happens in one named module and nowhere else (docs/adr/0020) —
 * `auth/google.ts`, which is also the only file that imports `google-auth-library`. Every
 * other file sees a token checked through this interface, which is the `Rng`/`Clock` move
 * applied to the one collaborator no test can reach: Google.
 *
 * **The fake lives in `server/test/auth/verifier.ts`**, not beside this: nothing shipped
 * would call it. The CLI never signs in, and the browser draws no button when Google's
 * script fails to load, so `serve:memory` runs the real verifier against the in-memory
 * store (docs/adr/0021).
 */

/**
 * What a verified token says about who presented it, cut down to what an account needs.
 *
 * `sub` is the identity — Google's own "unique among all Google Accounts and never
 * reused" — and never the email, which can change hands. `name` is a suggestion for the
 * confirm-name step and nothing more: it is never stored, never logged, and `NewCredential`
 * has no field it could be written into. Missing where the token has none.
 *
 * No email, no picture, no expiry: nothing here would read them, and a field that is not
 * here cannot be persisted by accident.
 */
export interface VerifiedIdentity {
  sub: string;
  name: string | null;
}

export interface TokenVerifier {
  /**
   * Who this ID token identifies, or `null` when it is not one Google issued for this app
   * — a bad signature, the wrong audience or issuer, expired, not a token at all. That is
   * an answer about the token, and the flow above turns it into `INVALID_CREDENTIAL`.
   *
   * **Throws when it cannot answer** — Google's certificates unreachable — which is an
   * outage and not a verdict, `ProfileStore`'s rule: a player is never told their
   * credential was bad because a network was down.
   */
  verify(idToken: string): Promise<VerifiedIdentity | null>;
}
