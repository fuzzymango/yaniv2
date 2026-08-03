# yaniv2

Multiplayer [Yaniv](https://en.wikipedia.org/wiki/Yaniv_(card_game)), built top-down:
engine first, fully unit tested, then transport. TypeScript, npm workspaces. `socket.io`
is the only runtime dependency, and only the server has it — `shared/` is types and the
event contract, so it stays dependency-free for the client's sake.

## Where the rules live

**`docs/rules.md` is the single source of truth for gameplay.** Every rule maps to at
least one test. If code and `rules.md` ever disagree, `rules.md` is right and the code has
a bug.

`docs/backend-archetechture.md` is the original design sketch that kicked the project off.
It is **stale** in several places — see "Deviations from the original sketch" below. Don't
treat it as authoritative; it's kept for history.

If you're adding or changing a rule: update `docs/rules.md` first, then the code, then
tests. Don't let a rule exist only in code.

## Code structure

```
shared/     Card/view/error types + the Socket.io event contract. No logic.
server/
  src/      The engine: deck, rules, pure state transitions, serialization, rooms, bots.
  scripts/  play.ts (bots-only, in process) + playSocket.ts & cli/ (human, over a
            socket). Not shipped.
  test/     node:test suites, one file per src/ module plus integration.test.ts.
            socketServer.test.ts uses real socket.io-client connections.
```

### `shared/src/`

| File | Contents |
|---|---|
| `cards.ts` | `Card`/`Suit`/`Rank`, rank ordering, and `sortHand`/`compareCards` (display order only — see below) |
| `views.ts` | `PlayerGameView` and friends — what a client actually receives |
| `errors.ts` | `GameErrorCode` union |
| `events.ts` | `ClientToServerEvents` / `ServerToClientEvents` — the socket contract |

Imported by the server now, and will be imported by the client later, so the wire
contract can't drift between them.

### `server/src/`

| File | Contents |
|---|---|
| `state.ts` | `GameState`, `RoundState`, `Player` — the domain model |
| `config.ts` | Every rule constant (hand size, Yaniv threshold, Assaf penalty, ...), each pointing at a `docs/rules.md` section |
| `rng.ts` | `Rng` type + `mulberry32` seeded PRNG |
| `result.ts` | `Result<T>` — `{ok: true, value}` / `{ok: false, error}` |
| `deck.ts` | `createDeck`, `shuffle`, `deal` — pure functions, no class |
| `rules.ts` | `isValidSet`, `canonicalizeSet`, `legalDiscards`, `canCallYaniv`, `pickupCandidates`, `handValue` — the rulebook, used by both the engine and the bot |
| `game.ts` | `startGame`, `takeTurn`, `callYaniv`, `startNextRound` — the pure state transitions |
| `serialize.ts` | `serializeStateForPlayer` — the security boundary, explained below |
| `roomManager.ts` | `RoomManager` — owns live rooms, applies transitions, persists only on success |
| `bot.ts` | `decideTurn` and friends — a deliberately simple opponent. See "Bot architecture" below |
| `botTurns.ts` | `playBotTurns` — runs the seats the server owns until the turn returns to a human |
| `socketServer.ts` | `createSocketServer` — wires the event contract onto an `io` instance. Never calls `listen` |
| `index.ts` | The entrypoint. Binds a port and composes the above. `npm run serve` |

`bot.ts` is shipped, not a dev tool: bot opponents are part of the real game, so the
socket layer needs to call `decideTurn` in production to play a bot's turn. It decides
only from a `PlayerGameView` (the same payload a real client gets), so it is structurally
unable to see hidden hands or the draw pile.

### `server/scripts/`

Not part of the shipped engine — two smoke-test harnesses, split by what they exercise.

- **`playSocket.ts`** — `npm run play`. A human against bots, or against other humans in
  their own terminals, over a **real socket connection** to a separately running server
  (`npm run serve` first). Requires `--name`; also accepts `--url` and `--join <code>`.
  Composition only, like `index.ts`: argv, stdin/stdout and a socket, handed to `cli/`.
  - **`cli/render.ts`** — `PlayerGameView` → a printable frame. Pure.
  - **`cli/commands.ts`** — a typed line + the current view → a `Command`. Pure and
    total; bad input returns `invalid`, never throws.
  - **`cli/session.ts`** — the driver. Owns the socket, holds the loop, takes its input
    and output injected so tests can drive it. **It imports nothing from `src/` except
    types** — no `RoomManager`, no `GameState`. The moment it does, it stops being a
    test of the transport and becomes a second copy of the server.
- **`play.ts`** — `npm run demo`. Bots only, in process, no transport: drives
  `RoomManager` and the pure transitions directly. Accepts `--seed <n>` and
  `--players <n>`, and a whole match is reproducible from the seed alone — which is what
  makes it the tool for judging bot play. Keep it that way; there is deliberately no
  socket equivalent, since the server owns the rng and seats its own bots, and no client
  event asks for a seed.

The two are not redundant: `play.ts` answers "do the rules and the bot behave?", and
`playSocket.ts` answers "does the wire work?".

## Key decisions from the build

These are choices made explicitly during development, several of them deviating from
`docs/backend-archetechture.md`. Knowing *why* matters more than the fact — a future
change to any of these should re-derive the reasoning, not just flip the value.

### Turn model

A turn is **one atomic action**: `takeTurn(state, playerId, { discardCardIds, draw })`
discards a set and draws exactly one card in a single call. There is deliberately no
state where a player has discarded but not yet drawn — the original sketch split this
into `playCards` + `drawFromPile`, which would have made "can they call Yaniv mid-turn?"
an open question. Calling Yaniv (`callYaniv`) is a separate action that replaces a turn
entirely, not a mode of `takeTurn`.

### Round state is nested

`GameState.round: RoundState | null` holds everything that resets between rounds (hands,
piles, whose turn it is). Starting a round replaces this object wholesale
(`dealRound` in `game.ts`), so no field can leak from the previous round by omission.
Match-scoped data (`players[].score`, `roomCode`, `hostId`) lives one level up and
persists across rounds.

### The discard pile is two parts, not a flat array

`RoundState.lastDiscard: Card[]` is the most recent discarded set, face up; its **first
and last cards only** are pickup-eligible (`pickupCandidates` in `rules.ts`).
`RoundState.buried: Card[]` is everything discarded earlier — visible but permanently out
of play until the draw pile empties and it gets reshuffled. A flat array can't express
"only the two ends of the last discard are takeable," which is why this is two fields.

### Wildcard jokers in runs (docs/rules.md §4)

- Jokers are wild **in runs only** — never in same-rank sets (`Jk 7♠ 7♣` is not a set).
- A run needs **at least 2 real cards** to anchor it (`Jk Jk 5♥` is not a run).
- `isRun` in `rules.ts` checks this via a span test, not a walk: real cards must fit in
  a window of `cards.length` consecutive ranks
  (`max(rank) - min(rank) + 1 <= cards.length`). No wrap past King/Ace falls out for
  free, since Ace and King are 12 apart.
- **Joker placement in a laid-out run is decided by the player.** A joker that fills an
  interior gap has one possible position. A joker that *extends* the run
  (`7♥ 8♥ Jk` → could be 6-7-8 or 7-8-9) is ambiguous, and `layOutRun` resolves it from
  the order the player submitted the discard in: jokers listed before the first real
  card extend downward, the rest extend upward. This matters because it decides what
  the *next* player is offered for pickup. Overridden only at the deck boundary — a
  joker can never be placed below Ace or above King.

### Hand display order is presentation only

`sortHand`/`compareCards` in `shared/src/cards.ts` sort a hand for display: ascending by
value (jokers left, tens/faces right), tied cards broken by rank then suit then card id
(the id tie-break exists because two jokers otherwise compare fully equal and would
visibly swap places between renders). **This has zero effect on engine state** — hands in
`RoundState` stay in whatever order the engine produces them; sorting is applied only at
`serializeStateForPlayer`, which is the one place every client is guaranteed to pass
through.

### Bot architecture: "may I" vs "should I" vs "who plays it"

Split deliberately across three layers:

- **`server/src/rules.ts`** owns what's *legal* — `legalDiscards` (every valid discard
  from a hand) and `canCallYaniv` (is the hand low enough). These are rules queries, not
  bot logic, and are also usable by a future client to highlight playable cards.
- **`server/src/bot.ts`** owns *judgement* — `shouldCallYaniv`, `chooseDiscard`,
  `chooseDraw`, composed by `decideTurn`. It takes a `PlayerGameView`, never raw
  `GameState`, so it cannot cheat by construction.
- **`server/src/botTurns.ts`** owns *execution* — `playBotTurns` loops while the current
  seat is bot-controlled, applying each decision through the same transitions a human
  goes through, and calling back once per action. It knows nothing about sockets, so it
  is testable without one, and takes its decision function as an argument (defaulting to
  `decideTurn`) so a test can drive a deliberately broken bot.

The bot is intentionally weak: it calls Yaniv the instant it's legal (no regard for
opponents' hand sizes), and picks up an exposed card only by face value in isolation (no
synergy with its own hand). This is a known, accepted limitation, not a bug — improving
it is future work, not a defect to fix incidentally.

**A bot's decision being rejected by the engine is a defect, not a rule violation.**
`playBotTurns` throws when `apply` refuses a bot's own move. There is no client at fault
to report it to, and swallowing it would wedge the table on a turn nobody can take — so
it surfaces as the server bug it is. This is the one place in the server where a failed
`Result` becomes a thrown error rather than an ack.

**Which seats are bot-controlled is `Player.isBot`**, a required field on the domain
model. The engine ignores it entirely — bots move through `takeTurn`/`callYaniv` exactly
as humans do — it exists so the layer above knows whose turn it has to play. Required
rather than optional so no construction can leave a seat ambiguously controlled.

The integration test's fuzzer (`server/test/integration.test.ts`) has its **own**
separate discard/draw logic and deliberately does not import from `bot.ts` — its job is
to explore weird states via randomized draw choices, and coupling it to the real bot
would mean a smarter bot silently narrows what the fuzz test covers. It does share
`legalDiscards`, since that's a rules query, not a policy.

### Errors are values

Every rule-violating action returns a `Result<T>` (`ok: true/false`) carrying a
`GameErrorCode`, never throws. TypeScript then forces call sites to handle failure.
Anything that *does* throw (`RoomManager` code allocation exhaustion, `deal` given too
small a deck) is a genuine defect, not a rule violation — the socket layer, when it
exists, should let those propagate rather than reporting them to a player.

### Randomness is injected, never ambient

Every function needing randomness takes an explicit `Rng` argument
(`() => number`, same contract as `Math.random`). Tests use `mulberry32(seed)` so a
match, a deal, or a bug report is reproducible from its seed —
`server/test/integration.test.ts` has a test asserting two runs with the same seed
produce byte-identical final scores.

### Serialization is the security boundary

`GameState` contains every hand and the full draw pile order and **must never reach a
client**. `serializeStateForPlayer` (in `serialize.ts`) is the one function that reduces
it to a `PlayerGameView`: the viewer's own hand, opponents reduced to a `handSize`
(never an optional `hand` field — the type doesn't allow the shape that could leak),
draw pile as a count only. Hands are revealed to everyone only at `phase: 'roundEnd'` /
`'gameEnd'`, when the rules require it. Tests assert no hidden card id appears anywhere
in the serialized JSON string, and this has been mutation-tested (deliberately breaking
the serializer to confirm the leak tests actually fail).

### Player identity

`Player.id` is a **server-issued stable id**, generated at `RoomManager.createRoom` /
`joinRoom`, never a socket id. The domain model has zero transport awareness — matches
the goal of keeping the Socket.io layer thin. (The original sketch used `socket.id`
directly; that would make reconnect support a retrofit touching every fixture.)

The socket layer bridges the two with a **session bound to the connection**: on a
successful `createRoom`/`joinRoom`, `socket.data.session = { playerId, roomCode }`, and
every later handler reads identity from there. A client-supplied player id is **never**
trusted — a socket could otherwise act as any player just by saying so. The session is
one optional object rather than two optional fields, so a half-bound connection is
unrepresentable.

A connection binds **once**. A second `createRoom`/`joinRoom` on an already-bound socket
is rejected with `ALREADY_IN_ROOM` (the one error code that exists purely because there
is a transport). Silently rebinding would orphan the first player — seated in a room with
no connection able to act for them, and unrecoverable while reconnect is out of scope.

### Room lifecycle

Lobby → host calls `startGame` → `playing` → `roundEnd` after a Yaniv call → host calls
`startNextRound`, or `gameEnd` once someone busts past 100. 2–6 players. `RoomManager` is
an **in-memory `Map`** — a server restart drops every game in progress. This is a
documented, accepted limitation, not an oversight; persistence is explicitly out of scope
for now (see below).

**`startGame` fills every empty seat with bots**, so a player's whole setup is two steps:
create a room, start the game. They are never asked how many opponents they want and
never manage them. (Letting them choose is intended future work — see issue #2.) The
engine's ≥2-player minimum therefore can't be hit from the socket layer any more; it
still guards the transition itself.

`RoomManager.seatBots(state)` is **pure** — it returns a filled state and stores nothing.
The socket handler folds it into the `startGame` transition passed to `apply`, so a start
that is then rejected (by someone who is not the host, say) discards the seating along
with everything else. Seating first and checking after would fill a table off the back of
a refused call, and the next player to try that lobby would find it full. There is
deliberately **no client-callable event for adding a bot**; the shared event contract is
unchanged by bots existing.

**A disconnect removes the room outright**, unconditionally, for whichever connection
drops. This is one-directional cleanup, not the start of reconnect support: with no way
to resume a session, a room whose player has gone can never be played again, so keeping
it only leaks memory. That reasoning holds only while a room holds one human, and rooms
can now hold several (see `play --join`), so a player dropping out takes everyone else's
match down with them. Known and deliberately not fixed here — it belongs with reconnect,
which is the next thing on the out-of-scope list, not bolted onto the join flow.

### Socket layer: wiring is separate from listening

`createSocketServer(httpServer, rooms)` attaches handlers and returns the `io` instance;
it never calls `listen`. `index.ts` does that and nothing else. The split exists so tests
can stand up a real server on an ephemeral port (`listen(0)`) without duplicating handler
logic or racing for a fixed port — `test/socketServer.test.ts` drives real
`socket.io-client` connections rather than a stub of the socket API, on the grounds that
this layer's whole job *is* its wire behaviour.

The same reasoning shapes how those tests verify: server-side facts are observed through
the socket, never by asking `RoomManager`. Disconnect cleanup, for instance, is proven by
a subsequent join being rejected with `ROOM_NOT_FOUND` — the way a real client would find
out — rather than by inspecting the rooms map.

### Broadcasting: one send per socket, one broadcast per move

`broadcastState(roomCode)` loops the room's sockets and emits `serializeStateForPlayer`
per connection. Never `io.to(room).emit(state)` — raw state holds every hand and the draw
pile order (see "Serialization is the security boundary"). A wire-level test asserts that
no card id outside the viewer's own hand and the face-up discard appears anywhere in a
mid-round payload, and it has been mutation-tested by breaking the boundary on purpose.

It is **deliberately synchronous**, walking `io.sockets.adapter.rooms` rather than the
idiomatic `await io.in(room).fetchSockets()`. It has to be callable from inside a run of
bot turns, and by the time a promise resolved, the position it was meant to publish would
already have been played past.

**Each bot action gets its own broadcast.** `playBotTurns` calls back per move and each
callback publishes, so a chain of five bot turns is five updates in seating order, not
one collapsed jump to the final position — a client can replay the chain move by move.
There is **no artificial delay** between them; pacing that sequence for a human to watch
is the client's job, and a test asserts the chain resolves without pauses.

Every in-game handler shares one `act(ack, transition)` helper: identify the caller from
their session, apply, and on success ack, broadcast, then run any bot turns. A rejection
acks the error and publishes nothing, so a refused action costs the player nothing — the
turn is still theirs.

### Tooling

TypeScript runs **directly on Node 24 via native type stripping** — no build step, no
`tsx`/`ts-node`. Test runner is `node:test`; typechecking is `tsc --build` (composite
project references, `shared` → `server`). This constrains the codebase to *erasable*
TypeScript: no `enum`, no `namespace`, no parameter properties, `import type` for
type-only imports. `tsconfig.base.json` enforces this via `erasableSyntaxOnly`.

The server's `test` script uses an explicit glob
(`node --test "test/**/*.test.ts"`) rather than bare `node --test` — the bare form also
picks up `test/helpers.ts` and any stray `.d.ts` files `tsc --build` emits into
`dist/test/`, which made test counts silently depend on whether a typecheck had run.

## Explicitly out of scope (for now)

Not oversights — deferred on purpose, in this order of likely next work:

- **Reconnect.** A dropped connection ends its room, full stop (see "Room lifecycle").
  `Player` has no `connected` field at all — deliberately absent rather than
  half-built. When reconnect lands, expect a lobby-phase case (easy: drop the player,
  promote host if needed) and a mid-round case (harder: currently undecided — pausing
  on their turn vs. a timer vs. removal are all live options).
- **Starting a match with seats still open for latecomers.** Several humans can share a
  room now — each joins by code from their own terminal (`play --join`) and the host
  starts when everyone is in — but `startGame` still fills every remaining seat with
  bots, so anyone who has not joined by then is playing the next match, not this one.
- **Choosing how many opponents you want.** `startGame` always fills to six. Adding bots
  one at a time from the lobby, with its own rejections, is deferred (issue #2).
- **Persistence.** Rooms are in-memory only.
- **The client.** No React app yet; `shared/` exists specifically so the client can
  import the same types and event contract the server uses.

## Deviations from the original sketch (`docs/backend-archetechture.md`)

If you go looking for something the architecture doc describes and don't find it, it's
probably one of these:

- `Deck` is not a class — pure functions over plain arrays instead. The sketch's version
  built a `Deck`, immediately drained it into a plain array, and discarded the instance,
  leaving two sources of truth for the pile.
- `playCards`/`drawFromPile` don't exist as separate functions — see "Turn model" above.
- The discard pile isn't a flat `Card[]` — see "discard pile is two parts" above.
- Errors are a `Result` union, not `throw new Error(...)`.
- `Player.id` is not `socket.id`.
- `serializeStateForPlayer`'s output shape is `{ you, opponents }`, not a single
  `players[]` array with an optional `hand`.

## Running things

```sh
npm install
npm test                                  # all workspaces, node:test
npm run typecheck                         # tsc --build across the monorepo
npm run serve --workspace=@yaniv/server   # start the socket server (PORT, default 3000)
npm run demo --workspace=@yaniv/server    # watch bots play a full match, in process
```

`demo` accepts `-- --seed <n> --players <n>`.

Playing yourself takes two terminals, because the harness is a real client:

```sh
npm run serve --workspace=@yaniv/server              # terminal 1
npm run play --workspace=@yaniv/server -- --name Ada # terminal 2 — connects to localhost:3000
```

`play` requires `-- --name <name>` and also accepts `--url <url>` and `--join <code>`.
Without `--join` you create a room and are shown its 4-character code; everyone else
joins it from their own terminal with `-- --name <name> --join <code>`
(case-insensitive), up to six players. The host types `start` to begin, and every seat
still empty is filled with a bot.

At the prompt: `start` begins the match (host only — anyone else is told `NOT_HOST`),
`1 3` discards those cards by hand position and draws from the deck, `t1`/`t2` on the
end takes a face-up card instead (`1 3 t2`), `yaniv` calls, enter deals the next round,
`q` or Ctrl-D quits. Note that any player disconnecting still ends the room for
everyone — see "Room lifecycle".

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
