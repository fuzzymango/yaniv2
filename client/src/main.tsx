/**
 * The entrypoint: composition and nothing else, the way `server/src/index.ts` is.
 *
 * The socket is opened here and handed to the session, which is the only thing that
 * ever touches it. `io()` with no URL connects to the page's own origin — in
 * development the Vite dev server proxies `/socket.io` to the game server, and in
 * production one service serves both (docs/adr/0003), so there is no address to
 * configure on either side.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import { App } from "./App.tsx";
import { createSession } from "./session.ts";
import "./styles.css";

// Created outside React, so a remount — StrictMode's double render, or any later one —
// cannot open a second connection and orphan the seat held by the first.
const session = createSession(io());

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing its root element");

createRoot(root).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
