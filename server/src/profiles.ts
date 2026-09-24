/**
 * Where a player is remembered between rooms — the seam, and the store that needs
 * nothing installed.
 *
 * A room lives in a `Map` and dies with the process, which has always been an accepted
 * cost: a match is a thing you were in the middle of. An account is not. So there is a
 * place to put what is known about a *player* rather than about a table, and this is the
 * only shape the rest of the server ever sees it through — `ProfileStore` is handed to
 * the socket layer, and nothing above this file learns what a database is. The Postgres
 * implementation arrives behind this interface without a line above it changing, which
 * is the whole point of the seam (docs/adr/0019).
 *
 * Three rules hold across every method, and each is a decision:
 *
 * - **Everything is async**, by decision rather than by implementation. The store below
 *   is synchronous to its bones and returns promises anyway: a synchronous body can be
 *   wrapped in a promise and an asynchronous one cannot be unwrapped, so the async shape
 *   is what keeps the choice of store reversible.
 * - **Absence is `null`.** No account with that id, no credential matching, no live
 *   session for that hash — those are answers to a question, not refused moves, and
 *   minting an `ACCOUNT_NOT_FOUND` into `shared`'s `GameErrorCode` would push a
 *   persistence concept into the wire contract both clients read. `Result` stays the
 *   rulebook's vocabulary.
 * - **Failure throws.** An unreachable database, a duplicate credential, a write against
 *   an account that is not there: `result.ts`'s rule already covers these — anything that
 *   throws is a defect, and the socket layer lets it propagate rather than telling a
 *   player their move was refused because Postgres is down.
 *
 * The methods are **task-shaped, not table-shaped**, and that is the load-bearing part:
 * creating an account writes two rows that must land together, so a table-shaped seam
 * (`accounts.insert`, `withTransaction`) would push atomicity across it and force every
 * implementation — this one included — to own a transaction concept. Task-shaped, the
 * transaction is entirely inside `createAccount`.
 *
 * Deliberately absent: `addCredential`. The schema must *permit* a second sign-in method
 * (docs/adr/0019); the seam need not carry one until something calls it.
 */

import { randomUUID } from "node:crypto";

/** An account's own id — a UUID, as `Player.id` already is, and never anything Google issued. */
export type AccountId = string;

/** The ways a person can prove who they are. Google is the only one V0 builds. */
export type CredentialKind = "google";

/**
 * An identity that outlives every room: the name a player is known by, and the one stat
 * V0 counts.
 *
 * No created-at, though the column exists: nothing reads it, and a field on the seam is
 * a conversion every implementation has to agree on (epoch milliseconds? a `Date`?) with
 * no caller to settle the question against. It is a column for whoever is looking at the
 * database, and it joins this type when something here asks for it.
 */
export interface Account {
  id: AccountId;
  displayName: string;
  /** Times this player has called Yaniv — the call, never the verdict (docs/adr/0023). */
  yanivCalls: number;
}

/**
 * A way of signing in, as presented when an account is created. `secret` is `null` for
 * Google, whose identifier is the `sub` and whose proof is a token this store never sees:
 * a leak of the row costs nothing. The column is there for a kind that needs one.
 */
export interface NewCredential {
  kind: CredentialKind;
  identifier: string;
  secret: string | null;
}

/** The same credential, read back with the account it belongs to. */
export interface StoredCredential extends NewCredential {
  accountId: AccountId;
}

export interface ProfileStore {
  /**
   * Create an account and the credential that reaches it, together or not at all.
   * Throws if that `(kind, identifier)` already belongs to an account — one credential
   * cannot point at two, and the caller's answer to a returning player is
   * `findByCredential`, not this.
   */
  createAccount(displayName: string, credential: NewCredential): Promise<Account>;

  /**
   * The credential stored for this `(kind, identifier)`, or `null` if nobody has signed
   * in that way. It returns the secret material rather than comparing it: verification
   * lives in one named module per kind (`auth/google.ts`, docs/adr/0020) and nowhere else.
   */
  findByCredential(kind: CredentialKind, identifier: string): Promise<StoredCredential | null>;

  /** The account with this id, or `null`. A question, so a miss is an answer. */
  loadAccount(id: AccountId): Promise<Account | null>;

  /**
   * Rename an account. Throws if there is no such account.
   *
   * The name is stored as given: `normalizeDisplayName` (`shared`) is the rule, and the
   * caller applies it, because the caller is who has an `INVALID_NAME` to answer with.
   */
  renameAccount(id: AccountId, displayName: string): Promise<void>;

  /** Count one Yaniv call. Throws if there is no such account. */
  recordYanivCall(id: AccountId): Promise<void>;

  /**
   * Record that somebody proved who they are, until `expiresAt`. The hash is the
   * session's key — only ever the hash, never the token (docs/adr/0020) — so the same
   * one twice is a defect and throws, as is a session for an account that is not there.
   */
  createSession(id: AccountId, tokenHash: string, expiresAt: number): Promise<void>;

  /**
   * Whose session this is, or `null` where there is none **or it has expired**: an
   * expired session is absent, whether or not the sweep has got to it yet, so a lapsed
   * token can never be resumed in the window before one runs.
   */
  findSession(tokenHash: string): Promise<AccountId | null>;

  /** Give up a session — signing out. A hash with no session behind it is no error. */
  deleteSession(tokenHash: string): Promise<void>;

  /** Drop every session that had expired by `now`. The sweep; runs at startup and daily. */
  deleteExpiredSessions(now: number): Promise<void>;

  /**
   * Let go of whatever the store holds open. Here it is nothing; a driver holds a
   * connection pool, and an open pool keeps a `node:test` process from exiting — the
   * hazard `systemClock`'s `unref` already guards against for timers.
   */
  close(): Promise<void>;
}

interface SessionRow {
  accountId: AccountId;
  expiresAt: number;
}

/**
 * The store that needs nothing installed — **shipped code, not a test helper**. It is
 * what `serve:memory` runs on and what every test in this repo runs against, so it lives
 * here in `src/` beside `rng.ts` and `clock.ts`, the other capabilities the server is
 * handed rather than reaches for.
 *
 * It takes no options, and in particular no id generator and no clock. A test would have
 * to reach past the `() => ProfileStore` factory the contract suite is parameterised over
 * to use either, and neither buys it anything: an id is read back off what was returned,
 * and the only instant the store decides for itself is *now* — `expiresAt` is the
 * caller's, passed in. Postgres answers that one with its own `now()`, so a clock on this
 * seam would be a concept only one implementation could honour, and an injected one here
 * would make the two stores disagree about when a session lapses.
 *
 * The consequence, for whoever mints an `expiresAt`: **expiry is judged against wall
 * clock**, in both implementations. An instant taken from a test clock that starts at
 * zero is an instant long past, and the session created with it is absent the moment it
 * is written — which is correct, and is why `deleteExpiredSessions` takes its `now` while
 * this does not: sweeping is a job run at an instant somebody chose, and expiring is not.
 */
export function createMemoryProfileStore(): ProfileStore {
  const accounts = new Map<AccountId, Account>();
  /** Keyed by `${kind}\u0000${identifier}` — the credential table's primary key. */
  const credentials = new Map<string, StoredCredential>();
  const sessions = new Map<string, SessionRow>();

  const credentialKey = (kind: CredentialKind, identifier: string): string =>
    `${kind}\u0000${identifier}`;

  /**
   * Every account handed out is a copy. Postgres answers with rows built from the wire
   * and could not do otherwise; handing out the stored object would make a caller's
   * stray mutation a silent write here and nowhere else.
   */
  const copy = (account: Account): Account => ({ ...account });

  const requireAccount = (id: AccountId): Account => {
    const account = accounts.get(id);
    if (!account) throw new Error(`no account ${id}`);
    return account;
  };

  return {
    async createAccount(displayName, credential) {
      const key = credentialKey(credential.kind, credential.identifier);
      if (credentials.has(key)) {
        throw new Error(`credential ${credential.kind}:${credential.identifier} is taken`);
      }

      const account: Account = { id: randomUUID(), displayName, yanivCalls: 0 };
      accounts.set(account.id, account);
      credentials.set(key, { ...credential, accountId: account.id });
      return copy(account);
    },

    async findByCredential(kind, identifier) {
      const stored = credentials.get(credentialKey(kind, identifier));
      return stored ? { ...stored } : null;
    },

    async loadAccount(id) {
      const account = accounts.get(id);
      return account ? copy(account) : null;
    },

    async renameAccount(id, displayName) {
      requireAccount(id).displayName = displayName;
    },

    async recordYanivCall(id) {
      requireAccount(id).yanivCalls += 1;
    },

    async createSession(id, tokenHash, expiresAt) {
      requireAccount(id);
      if (sessions.has(tokenHash)) throw new Error("session token hash is taken");
      sessions.set(tokenHash, { accountId: id, expiresAt });
    },

    async findSession(tokenHash) {
      const session = sessions.get(tokenHash);
      if (!session || session.expiresAt <= Date.now()) return null;
      return session.accountId;
    },

    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },

    async deleteExpiredSessions(now) {
      for (const [hash, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(hash);
      }
    },

    async close() {},
  };
}
