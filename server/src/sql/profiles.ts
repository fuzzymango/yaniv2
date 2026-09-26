/**
 * `ProfileStore` over Postgres — the implementation the deployed server runs on.
 *
 * It **takes a client as an argument** rather than making one: building the connection is
 * `connect.ts`'s job and is done once at boot, and a store that opened its own would make
 * "how many pools does this process hold?" a question about how many stores were
 * constructed. Everything the seam promises is promised here in the same words
 * (`profiles.ts` is the specification): absence is `null`, failure throws, and
 * `createAccount`'s two rows land together — here, in a real transaction, which is the one
 * thing the in-memory store cannot honestly prove (docs/adr/0019).
 *
 * **No test in this repository executes a line of it.** `npm test` stays one self-contained
 * command with no database, so a wrong column name or a malformed template is found by
 * booting the server — an accepted V0 cost, whose named fix is CI with a `postgres` service
 * and the second registration in `test/profiles.test.ts` that turns the contract suite on
 * this file. Every query below is therefore written to be read against that suite.
 *
 * Rows are mapped to the seam's types by hand, every field name written down, rather than
 * with the driver's `transform: postgres.camel`: a global rename would live in `connect.ts`,
 * the one file that is about the driver rather than about accounts, and a silent renaming
 * of every column in every query is a worse thing to debug than a mapping function.
 */

import { randomUUID } from "node:crypto";
import {
  NO_STATS,
  type Account,
  type AccountId,
  type CredentialKind,
  type NewCredential,
  type ProfileStore,
  type StoredCredential,
} from "../profiles.ts";
import type { SqlClient } from "./connect.ts";

interface AccountRow {
  id: string;
  display_name: string;
  yaniv_calls: number;
  calls_assafed: number;
  assafs: number;
  games_completed: number;
  games_won: number;
  slapdowns: number;
}

/**
 * `kind` is `text` in the database and this store is its only writer, so it reads back as
 * the union it was written from.
 */
interface CredentialRow {
  kind: CredentialKind;
  identifier: string;
  account_id: string;
  secret: string | null;
}

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  displayName: row.display_name,
  yanivCalls: row.yaniv_calls,
  callsAssafed: row.calls_assafed,
  assafs: row.assafs,
  gamesCompleted: row.games_completed,
  gamesWon: row.games_won,
  slapdowns: row.slapdowns,
});

/**
 * Whether an id could name a row at all.
 *
 * `account.id` is a `uuid` column, so an id that is not one is a value Postgres *refuses*
 * rather than fails to find — and `loadAccount` is a question, whose honest answer to a
 * malformed id is the same as to a well-formed stranger: nobody. That is not this file's
 * invention: `test/profiles.test.ts` asks any store for `loadAccount("nobody")` and expects
 * `null`, and without this the two implementations would answer it differently. The two
 * writes take no such guard, absence being a throw for them either way.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A write against an account that is not there, which the seam says throws. `returning id`
 * rather than the driver's row count: an update that matched nothing is the same fact in a
 * shape every query here already reads. The memory store's `requireAccount` is this one's
 * sibling, and says the same words.
 */
const requireUpdated = (updated: readonly unknown[], id: AccountId): void => {
  if (updated.length === 0) throw new Error(`no account ${id}`);
};

export function createSqlProfileStore(sql: SqlClient): ProfileStore {
  // Every method's types come from `ProfileStore` above, as the memory store's do: two
  // implementations of one interface, read side by side.
  return {
    async createAccount(displayName, credential) {
      /**
       * The id is minted here rather than by a column default, for the reason
       * `Player.id` already is: it is the server's to issue, and a default would make
       * reading it back the only way to learn it.
       *
       * Both inserts in one transaction, so a credential already spoken for — the primary
       * key refuses it — takes the account row down with it and leaves no account nobody
       * can sign in to. The caller's answer to a returning player is `findByCredential`.
       */
      // Every stat is left to its column's default of zero, which is what `NO_STATS` says.
      const account: Account = { id: randomUUID(), displayName, ...NO_STATS };

      await sql.begin(async (tx) => {
        await tx`
          insert into account (id, display_name) values (${account.id}, ${account.displayName})
        `;
        await tx`
          insert into credential (kind, identifier, account_id, secret)
          values (${credential.kind}, ${credential.identifier}, ${account.id}, ${credential.secret})
        `;
      });

      return account;
    },

    async findByCredential(kind, identifier) {
      const [row] = await sql<CredentialRow[]>`
        select kind, identifier, account_id, secret from credential
        where kind = ${kind} and identifier = ${identifier}
      `;
      if (!row) return null;

      return {
        kind: row.kind,
        identifier: row.identifier,
        accountId: row.account_id,
        secret: row.secret,
      };
    },

    async loadAccount(id) {
      if (!UUID.test(id)) return null;

      const [row] = await sql<AccountRow[]>`
        select id, display_name, yaniv_calls, calls_assafed, assafs, games_completed,
          games_won, slapdowns
        from account where id = ${id}
      `;
      return row ? toAccount(row) : null;
    },

    async renameAccount(id, displayName) {
      // The name is stored as given: `normalizeDisplayName` is the rule and the caller
      // applies it, being who has an `INVALID_NAME` to answer with.
      const updated = await sql`
        update account set display_name = ${displayName} where id = ${id} returning id
      `;
      requireUpdated(updated, id);
    },

    async recordStats(id, delta) {
      // Incremented in the database rather than read, added to and written back: two writes
      // at once are then two increments, with no lost update and no transaction to hold.
      // Every column in one statement, a counter the delta leaves out adding zero, so the
      // query is one fixed template rather than a string built from whatever was named.
      const updated = await sql`
        update account set
          yaniv_calls = yaniv_calls + ${delta.yanivCalls ?? 0},
          calls_assafed = calls_assafed + ${delta.callsAssafed ?? 0},
          assafs = assafs + ${delta.assafs ?? 0},
          games_completed = games_completed + ${delta.gamesCompleted ?? 0},
          games_won = games_won + ${delta.gamesWon ?? 0},
          slapdowns = slapdowns + ${delta.slapdowns ?? 0}
        where id = ${id}
        returning id
      `;
      requireUpdated(updated, id);
    },

    async createSession(id, tokenHash, expiresAt) {
      // Both failures the seam names are the database's own: no such account is the foreign
      // key, and the same hash twice is the primary key. Neither is checked first, which
      // would be a race as well as a second query.
      await sql`
        insert into session (token_hash, account_id, expires_at)
        values (${tokenHash}, ${id}, ${new Date(expiresAt)})
      `;
    },

    async findSession(tokenHash) {
      // Expiry is judged in the query, against the database's own `now()`: an expired
      // session is absent whether or not the daily sweep has reached it yet, so a lapsed
      // token can never be resumed in the window before one runs.
      const [row] = await sql<{ account_id: string }[]>`
        select account_id from session where token_hash = ${tokenHash} and expires_at > now()
      `;
      return row?.account_id ?? null;
    },

    async deleteSession(tokenHash) {
      await sql`delete from session where token_hash = ${tokenHash}`;
    },

    async deleteExpiredSessions(now) {
      // The sweep's instant is the caller's, unlike `findSession`'s: sweeping is a job run
      // at a moment somebody chose, and expiring is not.
      await sql`delete from session where expires_at <= ${new Date(now)}`;
    },

    async close() {
      // What `close` is on the seam *for*: an open pool keeps a process from exiting, the
      // hazard `systemClock`'s `unref` already guards against for timers.
      await sql.end();
    },
  };
}
