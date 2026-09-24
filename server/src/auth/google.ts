/**
 * The real `TokenVerifier`: Google's own library, checking Google's own signature.
 *
 * **The only file that imports `google-auth-library`** (docs/adr/0021), so the whole cost
 * of the dependency is visible by opening this one, as `sql/connect.ts` is for `postgres`.
 * It was chosen over forty lines on `node:crypto` for one reason: the place where a silent
 * mistake is an account takeover is the place to take the vendor's maintained cert
 * rotation and claim checks — signature against Google's published keys, `iss`, `aud`,
 * `exp` (docs/adr/0020). Composed in `index.ts` beside the store.
 *
 * No test executes this file; no test can reach Google. `test/auth/verifier.ts` is what
 * every suite verifies with, and a real sign-in is what proves this one.
 */

import { OAuth2Client } from "google-auth-library";
import type { TokenVerifier } from "./verifier.ts";

/**
 * A verifier that accepts only ID tokens Google issued to `clientId` — `GOOGLE_CLIENT_ID`
 * in production, the one value the browser's button asks for tokens under.
 */
export function googleVerifier(clientId: string): TokenVerifier {
  const client = new OAuth2Client();

  return {
    async verify(idToken) {
      // Google's keys first, and outside the catch below. The library reports a token it
      // rejects and keys it could not fetch the same way — both a thrown `Error` — and
      // they are different answers: one is about the token, the other is an outage, and a
      // player must never be told their sign-in was bad because Google was unreachable.
      // Fetched keys are cached for as long as Google says, so the check below reuses
      // them rather than asking twice.
      await client.getFederatedSignonCertsAsync();

      let payload;
      try {
        payload = (await client.verifyIdToken({ idToken, audience: clientId })).getPayload();
      } catch {
        return null;
      }
      if (!payload?.sub) return null;

      return { sub: payload.sub, name: payload.name ?? null };
    },
  };
}
