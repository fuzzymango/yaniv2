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

There's no client yet, so `server/scripts/play.ts` drives the engine directly — the same
`RoomManager` and pure transitions a Socket.io layer will eventually call. It's the
easiest way to smoke test a change: run it, or skim a transcript, before writing tests.

```sh
npm run play --workspace=@yaniv/server           # play interactively against bots
npm run demo --workspace=@yaniv/server            # watch bots play a full match
npm run demo --workspace=@yaniv/server -- --seed 42 --players 4
```

**Interactive (`play`).** You're Ada, seated against bot opponents. Each turn:
discard by card number (`1` or `2 3 4`), then choose a draw source (`d` for the deck, or
the listed number to take a card off the table). Type `yaniv` instead of a discard to call
Yaniv, or `q` to quit. Illegal moves are rejected with the engine's real error codes
(`INVALID_SET`, `YANIV_THRESHOLD_NOT_MET`, ...) rather than being silently disallowed, so
you're exercising the same validation a client will hit.

**Automated (`demo`).** Two built-in bots (see `botDiscard`/`botDraw` in `play.ts`) play
out a complete match on their own and print a turn-by-turn transcript through to a winner.
Useful for eyeballing a rule change across many turns at once.

Both modes accept:

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
