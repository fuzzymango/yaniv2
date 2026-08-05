# yaniv2

Multiplayer [Yaniv](docs/rules.md) — TypeScript, npm workspaces, no runtime dependencies.

## Layout

| Workspace | Contents |
|-----------|----------|
| `shared/` | Card types, the per-player client view, error codes, and the Socket.io event contract. Imported by the server and the client, so the wire contract can't drift. |
| `server/` | The game engine: deck, rules, pure state transitions, per-player serialization, and the room registry. |
| `client/` | The React browser client: the session core, screen components, and Socket.io connection. |

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

**Play in the browser.** The React client runs on its own dev server and talks to a
separately running backend. Start the server first:

```sh
npm run serve --workspace=@yaniv/server   # terminal 1 — PORT, default 3000
```

Then start the frontend in a second terminal:

```sh
npm run dev                               # terminal 2 — opens on http://localhost:5173
```

Open http://localhost:5173 in your browser. The frontend proxies `/socket.io` requests to
port 3000, so the client and server talk to each other automatically.

Enter a name, create a room or join one by its code, and the host starts the match — every
empty seat is filled with a bot. A turn is two taps and no button: tap cards in your hand
to choose them (chosen cards are outlined in yellow, tapped again to unchoose), then tap
either the deck or one of the two end cards of the face-up discard. That second tap is the
move — the chosen cards are discarded and the tapped card drawn, in one action. The deck
and the face-up cards do nothing until what you have chosen is a legal discard, so a move
the rules refuse is never offered in the first place.

The **Yaniv** button above your hand is the exception — the one control that is not a card.
It lights up the moment your hand is worth 7 or less and is dead until then, and pressing
it ends the round. Every hand is then turned face up on a scoreboard showing who called,
whether they were Assafed, and what the round cost each player against their new total. The
host deals the next round from there.

**Play in the terminal (`play`).** A real socket client, so it needs a server running.
Start the server first:

```sh
npm run serve --workspace=@yaniv/server   # terminal 1 — PORT, default 3000
```

Then, one or more players join in their own terminals (up to 6 total). Bare `--name`
opens an interactive main menu rather than committing to anything yet:

```sh
npm run play --workspace=@yaniv/server -- --name Ada                 # opens the main menu
npm run play --workspace=@yaniv/server -- --name Ada --create        # creates a room, shows its code
npm run play --workspace=@yaniv/server -- --name Grace --join WXYZ   # joins that room directly
```

`--name` is required — it is what everyone else at the table sees you as, so the harness
refuses to connect without one. `--join` and `--create` skip the main menu and go
straight into a room; without either, the menu offers the same two choices interactively:

| Input at the menu | Meaning |
|---|---|
| `create` | open a new room and show its code |
| `join <code>` | join the room with that code (case-insensitive) |
| `q` or `quit` | quit the application |

A bad or expired code typed at the menu shows the error and returns you to the menu to
try again, rather than ending the session.

The host (first player) types `start` once everyone has joined. Any remaining empty seats
are filled with bots. Everyone plays through to a winner. At the prompt:

| Input | Meaning |
|---|---|
| `start` | (host only) begin the match once everyone has arrived |
| `menu` | (in the lobby, or at a finished match) leave the room for the main menu |
| `1` or `2 3 4` | discard those cards by hand position, drawing from the deck |
| `1 3 t2` | the same, but take face-up card 2 off the table instead |
| `yaniv` | call Yaniv |
| enter | deal the next round, once one has ended |
| `again` | (host only, at a finished match) deal a fresh match to the same table |
| `q` or Ctrl-D | quit |

A finished match stops at the standings rather than ending the session. `again` starts
another one immediately for everyone still seated — scores back to zero, hands dealt, no
stop at a lobby — and is the host's alone; anyone else is told `NOT_HOST`, and the host is
told `NOT_ENOUGH_PLAYERS` if too few people are left to play. A seat given up stays given
up: nobody is replaced by a bot, and departed players show as `(left)` in the standings so
the final scores still add up.

Leaving with `menu` is not quitting: the connection stays up and you land back at the main
menu, free to create or join another room. It works the same way from the lobby and from a
finished match, and what it costs the rest of the table depends on who typed it — a guest
frees only their own seat and the others carry on without them, while the host leaving
closes the room for everyone, who are told why and returned to their own main menu.
Mid-match there is still no graceful exit; `q` or Ctrl-D disconnects, which ends the room
for everyone in it.

Illegal moves come back with the engine's real error codes (`INVALID_SET`,
`YANIV_THRESHOLD_NOT_MET`, ...) and cost you nothing — the turn is still yours. Every bot
move arrives as its own update, so a chain of five bot turns prints as five positions
rather than one jump. Requires `-- --name <name>`; also accepts `--url <url>`,
`--join <code>`, and `--create`. The room code is case-insensitive when joining, whether
given as a flag or typed at the main menu.

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

Disconnect/reconnect handling (dropping a connection currently ends the room for everyone),
persistence (rooms are in-memory, so a restart drops games in progress), and the polish the
browser client still wants — a chain of bot turns arrives as fast as the wire delivers it
rather than paced for a human to watch, and a dropped connection is not surfaced at all. A
match itself plays end to end in the browser now: create or join, deal, take turns, call
Yaniv, and finish on the standings with another match one tap away.
