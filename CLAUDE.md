# yaniv2

Every line here is read at the start of every session. A line earns its place only if it changes
what an agent does; reasoning, history and feature detail go in `docs/` (see "Where to look").

## Project

Multiplayer [Yaniv](docs/rules.md), TypeScript in npm workspaces: `shared/` (types, the socket
contract and the rulebook, dependency-free), `server/` (the engine, rooms, bots, a Socket.io
server, accounts in Postgres behind `server/src/sql/`, Google sign-in in `server/src/auth/`) and
`client/` (Vite + React, with a framework-free session core). Node 24 runs the TypeScript
directly — no build step for the server or tests. The server has three runtime dependencies:
`socket.io`, `postgres` and `google-auth-library`.

## Commands

```sh
npm test                                         # every workspace, node:test
npm run typecheck                                # tsc --build across the monorepo
node --test server/test/rooms.test.ts            # one suite
npm run serve:memory --workspace=@yaniv/server   # the server, accounts held in memory
npm run serve --workspace=@yaniv/server          # the same against DATABASE_URL; no fallback
npm run dev                                      # the browser client (Vite)
npm run play --workspace=@yaniv/server           # the terminal client
npm run demo --workspace=@yaniv/server           # bots-only match in process, --seed to replay
```

`dev` and `play` are clients of a separately running server: start `serve:memory` in a second
terminal first. Every command and flag is in `README.md`.

## Code Style

- **Erasable TypeScript only** — no `enum`, `namespace` or parameter properties; `import type` for
  types (`erasableSyntaxOnly`). Node strips the types, so anything that needs compiling breaks.
- **Errors are values.** A rule violation returns a `Result<T>` carrying a `GameErrorCode`; a
  `throw` means a defect, and the socket layer lets it propagate.
- **Randomness and time are injected.** Anything random takes an `Rng` (`() => number`); tests
  seed `mulberry32` so a deal replays exactly. Anything timed takes a clock, defaulting to real time.
- **Client components:** a file *exports* one component (private helper components beside it are
  fine), in a folder named for its screen — `main-menu/`, `lobby/`, `table/`, `game-end/`,
  `connection/`, `settings/`, `shared/`. Entrypoints, pure modules and `styles.css` sit flat at
  the `client/src` root. No barrel `index.ts`. `table/Seat.tsx` is the one file exporting several
  components, and its header says why.
- **Tests:** `node:test`, one suite per module in the workspace's `test/`; each workspace's `test`
  script names an explicit glob. The socket layer is tested over real `socket.io-client`
  connections; what a room does over time is tested through `Rooms` over the recording port
  (`server/test/recordingPort.ts`), with no socket.

## Guardrails

Each of these is a security hole or a live bug when missed, and none is visible from inside the
one file you are editing. The reasoning is in `docs/architecture.md`.

1. **Rules first.** `docs/rules.md` is the source of truth for gameplay: if code disagrees, the
   code is wrong. Change `rules.md` first, then the code, then the tests.
2. **`GameState` never reaches a client.** `serializeStateForPlayer` (`server/src/serialize.ts`)
   is the only way out. Hands, the draw-pile order, `resumeToken` and session tokens never appear
   in a view; the boundary is mutation-tested, so extend those tests when you touch it.
3. **Identity comes from the connection, never the payload** — `socket.data.seat` and
   `socket.data.account`. A player id a client sends is never trusted.
4. **Import boundaries.** `shared/src` imports nothing, Node builtins included. `client/src`
   imports only `@yaniv/shared`, never `server/src`. `server/scripts/playSocket.ts` and
   `server/scripts/cli/` import only types from `server/src`. `postgres` is imported only by
   `server/src/sql/connect.ts`, `google-auth-library` only by `server/src/auth/google.ts`, and SQL
   lives only in `server/src/sql/`.
5. **The socket layer reaches a room only through `Rooms`** (`server/src/rooms.ts`). Applying a
   transition any other way skips the publication, the stats and the bot turns behind it.
6. **The roster is append-only.** A departed or eliminated player stays in `players`, so every
   count or loop over it asks `inMatch` (`server/src/state.ts`) — a missed one is a live bug,
   not a type error.
7. **Transitions are pure** — they take a state and return a new one; nothing mutates in place.
8. **Migrations are append-only.** Add a statement to `server/src/sql/migrations.ts`; never edit
   a shipped one. No test runs `server/src/sql/`, so a mistake there is found by booting `serve`.
9. **Bots see only a `PlayerGameView`**, the payload a real client gets. The integration fuzzer
   never imports `bot.ts`.
10. **Client logic lives in `session.ts` or a pure module beside it**, never in `useSession` or a
    component — components are not tested.
11. **Known gaps are deliberate.** The bot's weak play and everything under "Deferred on purpose"
    at the end of `docs/architecture.md` are choices. Don't fix them as a side effect of other
    work; raise them.

## Where to look

- `docs/rules.md` — gameplay, the source of truth. Read before touching a rule; change it first.
- `docs/architecture.md` — why the code is shaped this way. Update a section when you change what
  it describes.
- `docs/code-map.md` — every file in the four source trees. Read before adding a module; add its
  row when you do.
- `docs/adr/` — one decision each, numbered. A new decision gets the next number; changing an old
  one amends it in place.
- `CONTEXT.md` — the domain vocabulary. Use its terms; add one when you coin it.
- `docs/client-table.md` and `docs/client-session.md` — the felt, and the session core and wire
  behind it. Read before changing either; update them with it.
- `docs/backend-archetechture.md` — the original design sketch, stale, kept for history only.
- `README.md` — commands and navigation for humans. Update it when a command or flag changes;
  keep it high-level.
- `CLAUDE.md` — this file. Edit it when you judge an agent would work better for it, by the test
  at the top.

## Agent skills

- **Issue tracker** — GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
