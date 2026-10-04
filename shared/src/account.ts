/**
 * The account on the wire — types and nothing else (docs/adr/0021).
 *
 * Here on `views.ts`'s grounds: both clients read these shapes off the wire, so they live
 * where neither can drift from what the server sends. What stays out is everything that
 * *does* anything — verifying a Google token, minting a session, the store — which is the
 * server's alone, and would cost `shared` its dependency-freedom the moment it arrived.
 */

/**
 * What a signed-in menu draws: who you are, the name you are known by, and the words your
 * seat will shout.
 *
 * **No stat**, though the account counts six: every ack carrying one of these is answered
 * at the main menu or on the way into it, never after a match, so a number here would be
 * stale by the time a profile showed it. Stats are read on their own, fresh, by
 * `loadStats` (docs/adr/0026), and a type is the cheapest place to keep them off this one.
 *
 * The **custom calls** are safe here where a stat is not: they change only through the
 * profile, which the main menu alone opens, so none can move behind a view of this. `null`
 * is unset — the banner's own word — and never an empty string. Named *custom* always, so
 * neither is read as the `yanivCalls` stat (`CONTEXT.md`, **Custom calls**).
 */
export interface AccountView {
  id: string;
  displayName: string;
  customYanivCall: string | null;
  customAssafCall: string | null;
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

/**
 * An account's six counters, each only ever going up (`CONTEXT.md`'s **Stats**). Only what
 * cannot be worked out from the others is kept: a call that stood is a Yaniv call not
 * Assafed, and a loss is a game completed and not won.
 *
 * Here rather than in the server's store so the store and the wire share one list: the
 * store counts them, `loadStats` answers them, and a profile draws them (docs/adr/0026).
 */
export interface Stats {
  /** Times this player has called Yaniv — the call, never the verdict (docs/adr/0023). */
  yanivCalls: number;
  /** Of those calls, the ones that were Assafed. */
  callsAssafed: number;
  /** Rounds this player was the Assafer — the one player `docs/rules.md` §6 names. */
  assafs: number;
  /** Matches played to their end from this seat: eliminated from, or won. */
  gamesCompleted: number;
  /** Matches won. */
  gamesWon: number;
  /** Slapdowns made. */
  slapdowns: number;
}
