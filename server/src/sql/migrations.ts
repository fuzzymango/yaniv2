/**
 * The schema, as an ordered list of statements, and the function that applies whichever of
 * them have not run yet.
 *
 * Twenty lines of applier instead of a migration framework, which is a deliberate size
 * (docs/adr/0019). Adding a field to the schema means **appending a statement to
 * `MIGRATIONS` and nothing else**: never editing one that has shipped, since a statement
 * the database has already counted is never offered again, and an edit to it would only
 * ever apply to a database created after the edit. That is the whole discipline.
 *
 * Two properties this rests on, both stated rather than assumed:
 *
 * - **Applying at startup is safe because this service cannot run two copies.** Rooms live
 *   in a `Map` inside the process, so a second replica is already broken — a constraint
 *   sunk long before this folder existed. There is no advisory lock here because there is
 *   no second writer to take one against.
 * - **Postgres has transactional DDL**, so each statement and the version bump that
 *   records it land together or not at all. A failed migration leaves the count where it
 *   was, and the next boot offers the same statement again rather than the one after it.
 *
 * The version lives in a table of its own, `schema_version`, holding exactly one row: the
 * spelling was the ticket's to choose (#187), and a count of statements applied is chosen
 * over a list of names because the list *is* the order — a name would be a second thing to
 * keep in step with the array below.
 */

import type { SqlClient } from "./connect.ts";

/**
 * The version table itself, which no migration can create because every migration is
 * counted in it. Conditional and repeated on every boot: it is the one statement whose
 * "has it run?" cannot be answered by asking it.
 *
 * `id integer primary key check (id = 1)` is how the single row is enforced by the
 * database rather than by the applier's good manners — a second row is impossible, so
 * `applied` cannot be ambiguous.
 */
const VERSION_TABLE = `
  create table if not exists schema_version (
    id integer primary key check (id = 1),
    applied integer not null
  )
`;

/**
 * The schema, in the order it was built. **Append only.**
 *
 * `account` is one row per identity: its own id (a UUID minted by the server, as
 * `Player.id` already is, never anything Google issued), the display name the player is
 * known by at a table, and its stats — **plain integer columns, not an event log**
 * (docs/adr/0019), the first of them created with the table and the other five appended.
 * `created_at` is for whoever is looking at the database; nothing reads it, which is why it
 * is not on the seam.
 *
 * `credential` is a table rather than a column on `account`, and that shape is the whole
 * reason it exists: a second sign-in method can be added later without invalidating a
 * single existing account. Its primary key is `(kind, identifier)`, so one credential
 * cannot point at two accounts, and `secret` is nullable because Google's proof is a token
 * this database never sees — a leak of the row costs nothing.
 *
 * `session` records that somebody *proved who they are*, until `expires_at`, and holds
 * **only the hash** of the token that does it (docs/adr/0020). The hash is the primary key:
 * looking a session up is the one thing done with it, and the same hash twice is a defect
 * the database refuses.
 *
 * Both of the latter reference `account` **on delete cascade**. Nothing deletes an account
 * in V0, so this is the shape a restore or a future deletion path finds waiting.
 */
export const MIGRATIONS: readonly string[] = [
  `create table account (
    id uuid primary key,
    display_name text not null,
    yaniv_calls integer not null default 0,
    created_at timestamptz not null default now()
  )`,

  `create table credential (
    kind text not null,
    identifier text not null,
    account_id uuid not null references account (id) on delete cascade,
    secret text,
    created_at timestamptz not null default now(),
    primary key (kind, identifier)
  )`,

  `create table session (
    token_hash text primary key,
    account_id uuid not null references account (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,

  // The five stats beside the first (issue #209): plain columns on the row, read by eye,
  // an existing account reading zero on every one — nothing before this was recorded, so
  // nothing is backfilled.
  `alter table account
    add column calls_assafed integer not null default 0,
    add column assafs integer not null default 0,
    add column games_completed integer not null default 0,
    add column games_won integer not null default 0,
    add column slapdowns integer not null default 0`,
];

/**
 * Bring the database up to `MIGRATIONS`, and answer how many statements that took — zero
 * on every boot after the first, which is the thing worth seeing in a log.
 *
 * This is a function the folder exports and the entrypoint calls, **not a method on
 * `ProfileStore`**: the seam stays the ten methods it is, the in-memory store never learns
 * the word migration, and a failed migration stops the server from starting because it
 * throws before anything binds a port.
 */
export async function applyMigrations(sql: SqlClient): Promise<number> {
  await sql.unsafe(VERSION_TABLE);
  await sql`insert into schema_version (id, applied) values (1, 0) on conflict (id) do nothing`;

  const [row] = await sql<{ applied: number }[]>`select applied from schema_version where id = 1`;
  const applied = row?.applied ?? 0;

  let ran = 0;
  for (const [index, statement] of MIGRATIONS.entries()) {
    if (index < applied) continue;

    // The statement and the count that records it, in one transaction: `sql.unsafe` is the
    // one place in the server a query is a string rather than a tagged template, and these
    // strings are the literals above.
    await sql.begin(async (tx) => {
      await tx.unsafe(statement);
      await tx`update schema_version set applied = ${index + 1} where id = 1`;
    });
    ran += 1;
  }

  return ran;
}
