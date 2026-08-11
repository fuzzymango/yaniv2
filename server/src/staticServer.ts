/**
 * The static half of docs/adr/0003: serving the built client from the same origin and
 * port as the socket server, hand-rolled rather than pulling in a web framework so
 * `socket.io` remains the only runtime dependency.
 *
 * Every request not under `/socket.io/` is served from `root`: a file that exists there
 * is sent as-is, and anything else falls back to `index.html` (the SPA has one page and
 * no client-side routes today, but a direct load of any path should still render it
 * rather than 404).
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream";
}

/**
 * Resolves a request path to a file under `root`, refusing anything `path.normalize`
 * would still leave outside it — `..` segments included, however the URL encoded them.
 */
function resolveWithin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const resolved = path.normalize(path.join(root, decoded));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * `root` is a `file://` URL rather than a path so callers can pass `import.meta.url`
 * relative paths (`new URL("../../client/dist", import.meta.url)`) without a manual
 * `fileURLToPath` at every call site.
 */
export function serveStatic(root: URL) {
  const rootPath = fileURLToPath(root);
  const indexPath = path.join(rootPath, "index.html");

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (!req.url || req.url.startsWith("/socket.io")) return false;

    const requested = resolveWithin(rootPath, req.url);
    const filePath =
      requested && existsSync(requested) && statSync(requested).isFile() ? requested : indexPath;

    if (!existsSync(filePath)) return false;

    res.writeHead(200, { "Content-Type": contentType(filePath) });
    if (req.method === "HEAD") {
      res.end();
    } else {
      createReadStream(filePath).pipe(res);
    }
    return true;
  };
}
