import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { serveStatic } from "../src/staticServer.ts";

describe("serveStatic", () => {
  let dir: string;
  let base: string;
  let server: ReturnType<typeof createServer>;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "static-server-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>root</title>");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log('hi')");

    const serve = serveStatic(pathToFileURL(dir));
    server = createServer((req, res) => {
      if (!serve(req, res)) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves an existing file with the right content type", async () => {
    const res = await fetch(`${base}/assets/app.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await res.text(), "console.log('hi')");
  });

  it("falls back to index.html for an unknown path", async () => {
    const res = await fetch(`${base}/lobby/ABCD`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /root/);
  });

  it("serves index.html at the root", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /root/);
  });

  it("refuses to escape root via path traversal", async () => {
    const res = await fetch(`${base}/../../etc/passwd`, { redirect: "manual" });
    // The traversal segment resolves to a path outside `dir`; the handler falls back
    // to index.html rather than serving anything from outside root.
    assert.equal(res.status, 200);
    assert.match(await res.text(), /root/);
  });

  it("leaves /socket.io requests unhandled", async () => {
    const res = await fetch(`${base}/socket.io/?EIO=4`);
    assert.equal(res.status, 404);
  });
});
