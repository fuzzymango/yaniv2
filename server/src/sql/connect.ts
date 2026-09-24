/**
 * The connection — and **the only file in this repository that imports `postgres`**.
 *
 * That is the point of it. The driver is a real dependency with a real cost, and keeping
 * every mention of it in one short file means the whole cost is visible by opening one
 * file, and swapping it for another driver is a rewrite of this folder rather than a
 * search of the tree (docs/adr/0019). Nothing above `sql/` imports it, and nothing inside
 * `sql/` needs to: the client's type travels as `SqlClient` from here.
 *
 * `postgres` (porsager) rather than `pg`: zero dependencies, and a query API that is a
 * tagged template, so parameterisation is the only shape available and there is no
 * string-concatenation path to reach for — worth more than a lint rule on tables that
 * hold credential material. The one escape hatch, `sql.unsafe`, is used in exactly one
 * place, `migrations.ts`, over statements written in this repository.
 */

import postgres from "postgres";

/**
 * A connected client, as the rest of `sql/` sees it. The alias is what keeps the import
 * above unique: `migrations.ts` and `profiles.ts` are handed a client and never build one,
 * so neither has a reason to name the package.
 */
export type SqlClient = postgres.Sql;

/**
 * Build the client `npm run serve` runs on, or throw.
 *
 * **There is no fallback to the in-memory store, by decision**: a production deploy that
 * lost this variable would otherwise run on memory and quietly forget every account, in a
 * decision made *for* durability. Local work is met by a word rather than an environment
 * — `npm run serve:memory` — which is why the message below names it.
 *
 * Connecting is lazy in this driver: what this call proves is that a string exists, and
 * the first query proves the database is reachable. That first query is the migration
 * pass, which runs before the port is bound and throws where it cannot connect, so
 * "refuses to start without a *working* database" is satisfied without a ping of its own.
 *
 * Everything else about the connection — the host, the credentials, SSL mode — is in the
 * string, so there is no second thing here to keep in step with the environment, and the
 * variable is read here rather than passed in for the same reason: `DATABASE_URL` is the
 * one name for it, and a parameter would be a second way to say where the database is with
 * nobody to say it.
 */
export function connectDatabase(): SqlClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. `npm run serve` needs a database and does not fall back " +
        "to memory; `npm run serve:memory` is the one that needs nothing but a port.",
    );
  }

  return postgres(url, {
    /**
     * Notices are dropped. The only DDL this server runs is the migration list, a
     * statement that fails there throws rather than notices, and the one notice a healthy
     * boot does produce says the version table it asked for conditionally was already
     * there — which is what a second boot is supposed to find. **That is the condition**:
     * the day anything here runs a statement whose warnings are worth reading, this is the
     * line to take out.
     */
    onnotice: () => {},
  });
}
