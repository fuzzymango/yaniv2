/**
 * The entrypoint: the one place that binds a port.
 *
 * Everything interesting lives in `socketServer.ts`, which only wires handlers onto an
 * `io` instance, and `staticServer.ts`, which serves the built client (docs/adr/0003).
 * Keeping `listen` here is what lets tests and harnesses stand up their own server on an
 * ephemeral port without duplicating any handler logic — and is why this file has no
 * tests of its own: there is nothing here but composition.
 */

import { createServer } from "node:http";
import { RoomManager } from "./roomManager.ts";
import { createSocketServer } from "./socketServer.ts";
import { serveStatic } from "./staticServer.ts";

const port = Number(process.env.PORT ?? 3000);
const clientDist = new URL("../../client/dist", import.meta.url);
const serveClient = serveStatic(clientDist);

const httpServer = createServer((req, res) => {
  // socket.io attaches its own `request` listener below; requests under `/socket.io/`
  // are its to answer, and responding here first would beat it to them.
  if (req.url?.startsWith("/socket.io")) return;
  if (!serveClient(req, res)) {
    res.writeHead(404).end();
  }
});
createSocketServer(httpServer, new RoomManager());

httpServer.listen(port, () => {
  console.log(`Yaniv server listening on http://localhost:${port}`);
});
