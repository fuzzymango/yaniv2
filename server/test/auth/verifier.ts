/**
 * A `TokenVerifier` that needs no Google — the test helper `auth/verifier.ts` promises.
 *
 * A token is whatever string a test says it is: `vouchFor` registers one and the identity
 * it stands for, and every other string is a token that failed verification. So a suite
 * says outright who Google would have vouched for, and a forged token is simply one it
 * never registered.
 */

import type { TokenVerifier, VerifiedIdentity } from "../../src/auth/verifier.ts";

export interface FakeVerifier extends TokenVerifier {
  /** Make `idToken` verify as this identity. `name` defaults to absent, as Google's may be. */
  vouchFor: (idToken: string, identity: { sub: string; name?: string | null }) => void;
}

export function fakeVerifier(): FakeVerifier {
  const vouched = new Map<string, VerifiedIdentity>();

  return {
    async verify(idToken) {
      const identity = vouched.get(idToken);
      return identity ? { ...identity } : null;
    },
    vouchFor: (idToken, { sub, name = null }) => {
      vouched.set(idToken, { sub, name });
    },
  };
}
