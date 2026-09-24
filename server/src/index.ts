/**
 * The entrypoint: the one place that binds a port, and the one place that decides which
 * store the accounts go in.
 *
 * Everything interesting lives in `socketServer.ts`, which only wires handlers onto an
 * `io` instance, and `staticServer.ts`, which serves the built client (docs/adr/0003).
 * Keeping `listen` here is what lets tests and harnesses stand up their own server on an
 * ephemeral port without duplicating any handler logic — and is why this file has no
 * tests of its own: there is nothing here but composition.
 *
 * **There are two ways to boot, and the command says which** (docs/adr/0019):
 *
 * - `npm run serve` — reads `DATABASE_URL`, applies whatever migrations have not run, and
 *   **refuses to start** if the variable is missing or the database will not answer.
 * - `npm run serve:memory` — the in-memory store, nothing but a port, and what day-to-day
 *   local work runs on.
 *
 * **There is no fallback between them**, which is the important part: a deploy that lost
 * the variable would otherwise run on memory and quietly forget every account, in a
 * decision made *for* durability. A flag rather than a second environment variable, since
 * "which store" is a thing a person chooses when they type the command and not a property
 * of the machine they typed it on.
 *
 * Nothing below catches: a bad connection string, an unreachable database or a migration
 * that will not apply crashes the process with the driver's own diagnosis, before a port
 * is bound. That is the shape `result.ts` already gives anything that throws — a genuine
 * defect, reported to the operator and not dressed up as a rule violation.
 */

import { createServer } from "node:http";
import { createMemoryProfileStore, type ProfileStore } from "./profiles.ts";
import { RoomManager } from "./roomManager.ts";
import { createSocketServer } from "./socketServer.ts";
import { connectDatabase } from "./sql/connect.ts";
import { applyMigrations } from "./sql/migrations.ts";
import { createSqlProfileStore } from "./sql/profiles.ts";
import { serveStatic } from "./staticServer.ts";

/** The whole of the difference between the two commands. */
const useMemoryStore = process.argv.includes("--memory");

async function openProfileStore(): Promise<ProfileStore> {
  if (useMemoryStore) {
    console.log("Profiles in memory: this server forgets every account when it stops.");
    return createMemoryProfileStore();
  }

  const sql = connectDatabase();
  const applied = await applyMigrations(sql);
  console.log(
    applied === 0 ? "Schema up to date." : `Applied ${applied} migration(s) to the schema.`,
  );
  return createSqlProfileStore(sql);
}

const port = Number(process.env.PORT ?? 3000);
const clientDist = new URL("../../client/dist", import.meta.url);
const serveClient = serveStatic(clientDist);

// Before the port, deliberately: a server that will not have a store is a server that
// should never have accepted a connection.
const profiles = await openProfileStore();

const httpServer = createServer((req, res) => {
  // socket.io attaches its own `request` listener below; requests under `/socket.io/`
  // are its to answer, and responding here first would beat it to them.
  if (req.url?.startsWith("/socket.io")) return;
  if (!serveClient(req, res)) {
    res.writeHead(404).end();
  }
});
createSocketServer(httpServer, new RoomManager(), profiles);

httpServer.listen(port, () => {
  console.log(`Yaniv server listening on http://localhost:${port}`);
});
