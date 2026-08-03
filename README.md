# yaniv2

Multiplayer [Yaniv](docs/rules.md) — TypeScript, npm workspaces, no runtime dependencies.

## Layout

| Workspace | Contents |
|-----------|----------|
| `shared/` | Card types, the per-player client view, error codes, and the Socket.io event contract. Imported by the server and (later) the client, so the wire contract can't drift. |
| `server/` | The game engine: deck, rules, pure state transitions, per-player serialization, and the room registry. |

`docs/rules.md` is the source of truth for gameplay. `docs/backend-archetechture.md` is the
original design sketch — where the two disagree, the code and `rules.md` are current.

## Running

```sh
npm install
npm test          # all workspaces
npm run typecheck # tsc --build across the monorepo
```

TypeScript runs directly on Node 24 via native type stripping — there is no build step and
no test-runner dependency. This constrains the codebase to *erasable* TypeScript: no
`enum`, no `namespace`, no parameter properties, and type-only imports written as
`import type`.

## Playing

There's no client yet, but there are two terminal harnesses. They answer different
questions, so neither replaces the other.

**Play a match yourself (`play`).** A real socket client, so it needs a server running.
Two terminals:

```sh
npm run serve --workspace=@yaniv/server   # terminal 1 — PORT, default 3000
npm run play --workspace=@yaniv/server    # terminal 2
```

You create a room, the server fills the empty seats with bots, and you play through to a
winner. At the prompt:

| Input | Meaning |
|---|---|
| `1` or `2 3 4` | discard those cards by hand position, drawing from the deck |
| `1 3 t2` | the same, but take face-up card 2 off the table instead |
| `yaniv` | call Yaniv |
| enter | deal the next round, once one has ended |
| `q` or Ctrl-D | quit |

Illegal moves come back with the engine's real error codes (`INVALID_SET`,
`YANIV_THRESHOLD_NOT_MET`, ...) and cost you nothing — the turn is still yours. Every bot
move arrives as its own update, so a chain of five bot turns prints as five positions
rather than one jump. Accepts `-- --url <url> --name <name>`.

Because it talks to the server the way a browser will, it doubles as a worked reference
for the connection flow the eventual client has to implement.

**Watch the bots (`demo`).** In process, no transport — drives `RoomManager` and the pure
transitions directly, printing a turn-by-turn transcript through to a winner. This is the
one to reach for when judging a rule change or bot behaviour across many turns.

```sh
npm run demo --workspace=@yaniv/server
npm run demo --workspace=@yaniv/server -- --seed 42 --players 4
```

- `--seed <n>` — fixes the shuffle. The same seed always deals and plays out identically,
  which is what makes an odd game reproducible: rerun with the seed from a bug report and
  you get the exact same hands back.
- `--players <n>` — table size, 2–6 (default 3).

## Design notes

- **Pure transitions.** `startGame`, `takeTurn`, `callYaniv`, and `startNextRound` take a
  state and return a new one. Nothing mutates in place.
- **A turn is atomic.** Discarding and drawing are one indivisible action, so there is no
  state where a player has discarded but not yet drawn.
- **Rounds are nested.** Round-scoped data lives in `GameState.round`; starting a round
  replaces that object wholesale, so no field can survive from the previous round.
- **Seeded randomness.** Every function needing randomness takes an `Rng` argument. Tests
  seed it and replay exact deals; a reported bug can be reproduced from its seed.
- **Errors are values.** Rule violations come back as `Result` failures carrying a
  `GameErrorCode`. Anything that *throws* is a genuine defect.
- **Serialization is the security boundary.** `GameState` holds every hand and the draw
  pile order, and must never be sent to a client. `serializeStateForPlayer` builds a
  per-viewer view; tests assert no hidden card id appears in the serialized payload.

## Not yet built

Socket.io transport, disconnect/reconnect handling, persistence (rooms are in-memory, so a
restart drops games in progress), and the React client.
