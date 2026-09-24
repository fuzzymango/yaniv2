/**
 * The account on the wire — types and nothing else (docs/adr/0021).
 *
 * Here on `views.ts`'s grounds: both clients read these shapes off the wire, so they live
 * where neither can drift from what the server sends. What stays out is everything that
 * *does* anything — verifying a Google token, minting a session, the store — which is the
 * server's alone, and would cost `shared` its dependency-freedom the moment it arrived.
 */

/**
 * What a signed-in menu draws: who you are, and the name you are known by.
 *
 * **No stat**, though the account counts one: viewing stats is out of scope for V0, so the
 * wire never carries a number, and a type is the cheapest place to make that true.
 */
export interface AccountView {
  id: string;
  displayName: string;
}

/**
 * Signed in: the account, and the session that remembers it.
 *
 * `sessionToken` is a credential, treated as a resume token is — on the wire exactly once,
 * in the ack of the event that issued it (`signIn`, or `createAccount` after it), and in
 * no view in any phase. The browser keeps it; the server keeps only its hash.
 */
export interface SignedIn {
  status: "signedIn";
  sessionToken: string;
  account: AccountView;
}

/**
 * Google vouched for this person and no account is theirs yet: the confirm-name step
 * (docs/adr/0020). `suggestedName` is the prefill — Google's `name` if it is a legal
 * display name, and empty otherwise, never a fixed default somebody would have to notice
 * and delete.
 */
export interface NameNeeded {
  status: "nameNeeded";
  suggestedName: string;
}

/** The answer to `signIn`: an account we know, or one still to be created. */
export type SignInResult = SignedIn | NameNeeded;
