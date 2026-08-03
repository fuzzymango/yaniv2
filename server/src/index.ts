/**
 * The entrypoint: the one place that binds a port.
 *
 * Everything interesting lives in `socketServer.ts`, which only wires handlers onto an
 * `io` instance. Keeping `listen` here is what lets tests and harnesses stand up their
 * own server on an ephemeral port without duplicating any handler logic — and is why
 * this file has no tests of its own: there is nothing here but composition.
 */

import { createServer } from "node:http";
import { RoomManager } from "./roomManager.ts";
import { createSocketServer } from "./socketServer.ts";

const port = Number(process.env.PORT ?? 3000);

const httpServer = createServer();
createSocketServer(httpServer, new RoomManager());

httpServer.listen(port, () => {
  console.log(`Yaniv server listening on http://localhost:${port}`);
});
