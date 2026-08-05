# yaniv2

Multiplayer [Yaniv](https://en.wikipedia.org/wiki/Yaniv_(card_game)), built top-down:
engine first, fully unit tested, then transport. TypeScript, npm workspaces. `socket.io`
is the only runtime dependency, and only the server has it — `shared/` is types, the event
contract and the rulebook, so it stays dependency-free for the client's sake.

# behavior rules
This section bullet points specific behavior patterns that you should follow when working in this repository. Do not modify this section.

- **keep `README.md` and `CLAUDE.md` updated** - after implementing code changes, review the contents of `CLAUDE.md` and README.md and ensure they're kept up to date and relevant with the current state of the codebase. For example, if you add or modify an `npm run ...` command, ensure that the `README.md` is amended to reflect this change. Developers will look at `README.md` often and we don't want to have false/stale information present. The catch to ths is, we don't want `README.md` to become bloated with information so only maintain the high-level information necessary for navigating this project.  

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
shared/
  src/      Card/view/error types, the Socket.io event contract, and the rulebook
            (rules.ts + the rule constants). Pure and dependency-free.
  test/     node:test suites for the logic that lives here.
server/
  src/      The engine: deck, pure state transitions, serialization, rooms, bots.
  scripts/  play.ts (bots-only, in process) + playSocket.ts & cli/ (human, over a
            socket). Not shipped.
  test/     node:test suites, one file per src/ module plus integration.test.ts.
            socketServer.test.ts uses real socket.io-client connections.
client/
  src/      The browser client: the framework-free session core, plus one React
            component per screen. Vite + React.
  test/     node:test suites driving the session core over a real socket server.
```

### `shared/src/`

| File | Contents |
|---|---|
| `cards.ts` | `Card`/`Suit`/`Rank`, rank ordering, `rankToValue` (the scoring table, `docs/rules.md` §1), and `sortHand`/`compareCards` (display order only — see below) |
| `views.ts` | `PlayerGameView` and friends — what a client actually receives |
| `errors.ts` | `GameErrorCode` union |
| `events.ts` | `ClientToServerEvents` / `ServerToClientEvents` — the socket contract |
| `rules.ts` | `isValidSet`, `canonicalizeSet`, `legalDiscards`, `canCallYaniv`, `pickupCandidates`, `handValue` — the rulebook, used by the engine, the bot and (later) the client |
| `config.ts` | Every rule constant (`HAND_SIZE`, `YANIV_THRESHOLD`, `ASSAF_PENALTY`, `MAX_SCORE`, `MIN_RUN_LENGTH`, `MIN_RUN_REAL_CARDS`, `MIN_PLAYERS`, `MAX_PLAYERS`), each pointing at a `docs/rules.md` section |
| `standings.ts` | `standings` — a finished match's final table, lowest score first, including whoever has left since. Read by both clients |

Imported by the server and the client, so the wire contract can't drift between them. The
rulebook is here rather than in `server/src` for the same reason: a client must offer
exactly the moves the server will accept, and it cannot reach into `server/src` to find
out. `standings` is here on the same grounds — the browser and the terminal harness both
have to say who won, and a match that is over cannot be allowed to finish two different
ways depending on which client is looking. Every function is pure over values the wire
already carries, so this costs `shared` none of its dependency-freedom. See
`docs/adr/0002`.

### `server/src/`

| File | Contents |
|---|---|
| `state.ts` | `GameState`, `RoundState`, `Player` — the domain model |
| `config.ts` | The operational constants only — `BOT_NAMES` and `ROOM_CODE_*`. The rule constants live in `shared` |
| `rng.ts` | `Rng` type + `mulberry32` seeded PRNG |
| `result.ts` | `Result<T>` — `{ok: true, value}` / `{ok: false, error}` |
| `deck.ts` | `createDeck`, `shuffle`, `deal` — pure functions, no class |
| `game.ts` | `startGame`, `takeTurn`, `callYaniv`, `startNextRound`, `playAgain`, `removePlayer` — the pure state transitions |
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
  (`npm run serve` first). Requires `--name`; also accepts `--url`, `--join <code>`, and
  `--create`. Bare `--name` (neither `--join` nor `--create`) opens an interactive main
  menu — `create` / `join <code>` / `q`/`quit` — rather than silently creating a room.
  Composition only, like `index.ts`: argv, stdin/stdout and a socket, handed to `cli/`.
  - **`cli/render.ts`** — `PlayerGameView` → a printable frame, plus the one screen that
    isn't a view: the main menu, rendered before any room exists. Pure. The final
    standings are everyone the round result names, not just whoever is still seated:
    a player who left after the match ended is listed from that record and marked
    `(left)`. Dropping the row instead would take a departed winner's mark off the
    board with them.
  - **`cli/commands.ts`** — a typed line + the current view → a `Command`, and a
    separate `parseMainMenuCommand` for the view-less main menu. Both pure and total;
    bad input returns `invalid`, never throws.
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

### `client/src/`

A third client of the same contract, alongside the two harnesses — not a replacement for
either. It imports `@yaniv/shared` and nothing from `server/src`.

| File | Contents |
|---|---|
| `main.tsx` | The entrypoint. Opens the socket and mounts `App`, and nothing else — `server/src/index.ts`'s counterpart |
| `session.ts` | The session core: owns the socket, exposes a `SessionSnapshot` and the intents. Framework-free, so `node:test` can drive it |
| `turn.ts` | What a tap means: `toggleSelection`, `retainSelection`, `isLegalSelection`, `isLegalCall`, `takeableIds`, `turnFrom`. Pure and total — `scripts/cli/commands.ts`'s counterpart |
| `pacing.ts` | `createPacer` and the `Clock` it takes — the queue that spaces a run of bot turns out into moves a person can watch. Injected clock, so tests drive it a beat at a time |
| `seating.ts` | `bySeat` — the `turnOrder` comparator every screen that lists players sorts by |
| `unload.ts` | `guardUnload` — the `beforeunload` warning, on while a round is live and off otherwise. Injected target, so it is driven under `node:test` with no browser |
| `useSession.ts` | `useSyncExternalStore` over the above, and deliberately nothing else |
| `App.tsx` | Which screen: no connection comes first, then no view is the main menu, then everything else is a function of `view.phase` |
| `MainMenu.tsx` | Name, create, join by code — the one screen with no view behind it |
| `Lobby.tsx` | `phase: 'lobby'` — the code, who is seated, start (host only), leave |
| `Table.tsx` | `phase: 'playing'` — the hand, the deck, the discard, a turn as two taps, and the Yaniv call |
| `RoundEnd.tsx` | `phase: 'roundEnd'` — every hand face up, who called, whether they were Assafed, and what the round cost each player |
| `GameEnd.tsx` | `phase: 'gameEnd'` — the final standings lowest-first, who won, play again (host only), and leaving |
| `Disconnected.tsx` | No socket — the second screen with no view behind it. One screen for a connection that went and one that never arrived, since neither leaves anything to tap |
| `PlayingCard.tsx` | One card, drawn in CSS. Presentational only — it does not know what a card means where it sits |
| `Room.tsx` | The fallback for a `roundEnd` with no result behind it — a position the wire type allows and the server does not produce |
| `styles.css` | Mobile-first. Cards are drawn in CSS — no image assets |

See "The client's session core" below for what the split buys.

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
and last cards only** are pickup-eligible (`pickupCandidates` in `shared/src/rules.ts`).
`RoundState.buried: Card[]` is everything discarded earlier — visible but permanently out
of play until the draw pile empties and it gets reshuffled. A flat array can't express
"only the two ends of the last discard are takeable," which is why this is two fields.

### Wildcard jokers in runs (docs/rules.md §4)

- Jokers are wild **in runs only** — never in same-rank sets (`Jk 7♠ 7♣` is not a set).
- A run needs **at least 2 real cards** to anchor it (`Jk Jk 5♥` is not a run).
- `isRun` in `shared/src/rules.ts` checks this via a span test, not a walk: real cards fit in
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

- **`shared/src/rules.ts`** owns what's *legal* — `legalDiscards` (every valid discard
  from a hand) and `canCallYaniv` (is the hand low enough). These are rules queries, not
  bot logic, which is why they sit in `shared`, where a client can reach them to
  highlight playable cards.
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

**A finished round names its own players.** `PlayerRoundResult` carries a `name` copied
in when the round is scored, and the serializer uses that rather than looking the id up
in `players`. The duplication is deliberate: a seat can be given up once the match ends
(`exitToMenu`), and a round result is the record of who played it — resolving names
against the live roster left a departed player nameless on everyone else's scoreboard,
with no way for a client to recover the name it was never sent.

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

### Leaving a room without dropping the connection

`exitToMenu` is the one exit that is not a disconnect, and `playAgain` is the one way out
of `gameEnd` other than closing the room. Both are allowed only where the table is not
mid-round — the lobby and `gameEnd` — for the same reason mid-match leaving is out of
scope: a hand and a turn order the round is still being played against.

Who invokes `exitToMenu` decides what it costs everyone else, and the caller does not get
to choose: **a non-host frees only their own seat** (the room plays on for whoever
remains, who are told by `playerLeft` and then handed the shrunk roster), while **the host
closes the room outright** (everyone else gets `roomClosed(reason)` — there is no longer a
state to publish, so this is the last thing they hear about that room). Identical in both
phases, deliberately: "a non-host leaving a finished match ends it, since the match is
over anyway" was the plausible drift, and one rule for both was chosen instead.

The split across layers mirrors bot seating. `removePlayer` in `game.ts` is a pure
transition that filters a player out; "the room must be destroyed" is not a `GameState` it
could return, so that branch lives in `socketServer.ts`, where rooms and connections are
owned — which is also why the `exitToMenu` handler is not `act()`-shaped.

Leaving **clears `socket.data.session` and calls `socket.leave(roomCode)`**. Clearing the
session is what stops `ALREADY_IN_ROOM` meaning "for the life of this connection": a
sessionless socket is indistinguishable from a fresh one, so the same connection can go
straight into another room. It also keeps the departing socket out of the next broadcast,
which `broadcastState` skips it from — the serializer would refuse to build a view for a
player no longer seated. The `leave` keeps a socket from lingering in a Socket.io room
whose code a later room could be issued.

**`playAgain` seats no bots**, unlike `startGame`: a seat given up stays given up, so a
table that has shrunk below two is turned away with `NOT_ENOUGH_PLAYERS` rather than
quietly refilled. Reaching that over the wire takes a table that was six humans to begin
with — `startGame` only fills seats nobody is in, and a bot never leaves — so five of them
exiting is the one way a host is left with nobody to play against.

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

### The turn is two taps, and draw targets are inert until legal

A turn on the client is never a button — it is built from two taps. Tapping a card in
hand adds it to an ordered **selection** (`CONTEXT.md`'s **Selection**); tapping a draw
target — the deck, or one of the two takeable ends of the last discard — commits it: the
selection is discarded and the tapped card drawn, in the same action. This mirrors the
server's atomic `takeTurn` (see "Turn model" above) rather than splitting discard and draw
into two client-side steps the engine has no matching state for — a "discard" button
followed by a "draw" button would imply a moment in between that does not exist.

Draw targets stay inert — untappable — until the current selection is a legal discard
(`isValidSet`, from `@yaniv/shared`'s rulebook). This is the reason the rulebook moved to
`shared/` at all (ADR-0002): without it on the client, an illegal set could only be caught
by sending it and being told no, which is exactly the silent-round-trip cost "A tap the
rules do not permit..." below describes. `client/src/turn.ts` is the pure module this
lives in — `turnFrom` takes a selection, the current view and the tapped source, and
returns a `TurnAction` or `null`; alongside it, `isLegalSelection`, `isLegalCall` and
`takeableIds` are what decide which controls light up. It is the client's analogue of
`scripts/cli/commands.ts`: pure, total and never throwing on nonsense — nothing here
reaches a socket, and nothing here knows whose turn it is, since turn order is the
server's alone and comes back as a `GameError`, exactly as it does for the CLI.

### The client's session core

The browser client's logic lives in `client/src/session.ts`, a plain module outside React
that owns the socket and exposes exactly two things: a `SessionSnapshot` to read and a set
of intents to call. `useSession` subscribes to it with `useSyncExternalStore` and holds no
logic — **if that hook ever grows a branch, the branch is in the wrong place.** The point
is testability: the session core is driven under `node:test` against a real socket server,
with no browser, no jsdom and no React test dependencies. Components are not tested at
all, which is a consequence of that split rather than a gap: if a component held behaviour
worth testing on its own, that behaviour would be in the wrong place and belongs in the
session core instead.

Snapshots are **replaced wholesale, never mutated** — `useSyncExternalStore` compares by
identity, so a mutated object would leave React rendering a position that has already
moved on.

Five fields, and each answers a different question:

- **`view`** — the position, or `null`. Null *is* the main menu: the one screen that is
  not a function of `view.phase`, because before a room exists there is nothing for the
  server to have sent. See `docs/adr/0004`.
- **`error`** — a `GameError`, i.e. something the player asked for and was refused, or one
  the server pushed as `errorMessage`. Cleared the moment they try again, because a refused
  action costs them nothing.
- **`notice`** — news about the room that is *not* a refusal: `roomClosed`, and a
  connection that dropped and took its room with it. Separate from `error` precisely
  because there is no action to blame and nothing to retry, and because it arrives while
  the player is sitting still.
- **`connected`** — whether there is a socket to play over. See "A session that loses its
  socket" below.
- **`selection`** — the cards tapped for the next turn, by id, in tap order. It lives here
  rather than in a component because it is a fact that has to survive views arriving
  underneath it: a card that leaves the hand leaves the selection with it, which is
  `retainSelection` applied to every broadcast of a position still being played. That same
  filter is what empties it after a committed turn — the cards it named have just been
  discarded. A broadcast of any *other* phase empties it outright rather than filtering it:
  a scored round has no move to make from it, and a card id is the same string in every
  round of a match (the deck is rebuilt, not shuffled on), so a choice carried across a
  deal would come back chosen over whatever card inherited its id.

**`busy` locks on emit, and settles two different ways.** Entering or leaving a room
settles on the **ack**: entry has been broadcast before it is acked, and a departing
connection is published to no longer. So do dealing the next round and dealing another
match, which produce a position rather than moving within one. A **move settles on a
strictly newer position** — that is a turn, or the Yaniv call that replaces one, both sent
through the same `play` helper, which keeps the CLI's `Position { view, version }` /
`actedOn` watermark in the session core. The server acks an in-game action *before* it
broadcasts the result, so controls released on the ack would come back to life over a
position still showing the mover's own turn and their discarded cards in hand. A rejected move is the exception and
releases at once: nothing was published, so no newer position is coming, and the turn is
still theirs.

The ordering trap is worth stating plainly: the first snapshot carrying a view after
entering a room is one the player still cannot act from. Tests wait on
`view !== null && !busy` rather than on the view alone.

**Positions are drawn on a clock, not on arrival.** A run of bot turns lands as one
broadcast per move within a few milliseconds of itself (see "Broadcasting" above), so a
session that published each on arrival would show only the last — the table jumping from
the player's own move to their next turn with everything in between invisible. `pacing.ts`
queues them instead: **the first arrival goes straight through, and anything landing in the
beat behind it is let go one per `PACE_MS` (700ms)**. A move of the player's own is a lone
arrival and is therefore never delayed, which is the whole reason the rule is "first one
free" rather than "one every beat". The queue is phase-blind: any burst is spaced, a lobby
filling up as much as a chain of bot turns. A round that a bot's Yaniv ends is *why* —
the scored position is the last link of the chain, and pacing only `playing` would skip
straight past the move that ended it.

The accepted cost is stated in `pacing.ts` and worth repeating: a beat is armed after
every release, so a position landing inside the beat behind a drawn one waits out the rest
of it — up to `PACE_MS`, and with `busy` still held if it is the player's own move.
Nothing in a queue can tell a lone arrival from the first of a chain except by giving the
chain a beat to appear in. What it buys is that no position is replaced before it has been
readable for a beat, which is the whole point.

Two things fall out of the queue and are worth keeping straight:

- **The watermark counts arrivals, not drawings.** A queued position carries the `version`
  it *landed* on, and `busy` releases on drawing one newer than the move. Counting
  drawings would let a position that was already in flight when the move went out pass for
  an answer to it.
- **A room that has gone takes its queue with it.** `roomClosed` and a successful
  `exitToMenu` both `reset` the pacer; otherwise the next beat would draw a table the
  player has already left back over the main menu.

The clock is injected (`systemClock` by default) so the queue is driven a beat at a time
under `node:test`. Every other client suite passes a clock that runs each beat the instant
it is asked for, which is the same behaviour those suites had before pacing existed.

**A tap the rules do not permit sends nothing and says nothing.** `turnFrom` answers with
`null`, `commitTurn` returns, and no error is published — the screen should not have
offered a target that lands there, and a player who found a dead one has asked for nothing
and been refused nothing. `callYaniv` is the same shape: `isLegalCall` says no, the intent
returns, the inert control that was tapped anyway has asked for nothing. **What is legal
about the cards** — a discard being a set, a hand being low enough to call on — is the whole
of what the client applies ahead of the server, and it applies it out of the same rulebook
(ADR-0002), because a silent round trip to be told no is 50–200ms of nothing that a touch
screen makes indistinguishable from a tap that did not register. Turn order and everything
else the server owns are offered, sent, and answered with a `GameError`.

**Leaving is the one action answered by the ack alone.** Everything else is confirmed by
the broadcast behind it, but the server stops publishing to a connection that has left, so
`exitToMenu` clears the view itself. The client is never told which of the two outcomes it
got — a freed seat or a closed room — and does not need to be; either way it is out. That
is the server's decision (see "Leaving a room without dropping the connection").

**A rejection that lands after the room has gone is swallowed, not shown.** Two players
leaving at once is the case: the host's exit closes the room and drops everyone's session,
so a guest's in-flight action acks `PLAYER_NOT_FOUND` — about a room that no longer
exists. They are already on the menu being told why, and a red error blaming them on top
would be exactly what "a refused action costs the player nothing" rules out. The session
therefore drops an error whenever `view` is already null.

**An `errorMessage` shows where a rejected ack does, is dropped where one is dropped, and
does not touch `busy`.** It is the same news to a player — something that might have
happened did not — so it lands in `error` and is drawn by whichever screen is up, and it
goes by the rule above when `view` is null: an error with no room to be about is one
nothing on the main menu can explain and nothing there can act on. Unlike an ack it is
nobody's answer, so it releases no lock: whatever is in flight still is, and letting go on
news that answers none of it would put a second copy of that action on the wire. Nothing in
the server sends one today; the handler exists because the contract does, and the client's
suite is what pushes one.

**`playerJoined`/`playerLeft` are deliberately unhandled.** The roster arrives right
behind each of them as a fresh view, and a screen that re-renders in place shows a seat
filling or emptying by itself. The CLI needs those nudges only because its frames scroll
away from each other.

**The client never enforces a rule the server owns.** Showing the start control to the
host alone is a courtesy so a guest is not hunting for a button that was never theirs; the
rule is `NOT_HOST`, and the server is what says it. Refusing an empty name locally is the
one exception, and only because the server enforces the same rule — it is the client
declining to offer a move it knows will be refused, not a rule of its own.

### A session that loses its socket

**`connected` is asked about before the view is.** A dropped socket makes every control on
every screen a lie, whatever the last position drawn still shows, so `App` renders
`Disconnected.tsx` above everything — the second screen that is not a function of
`view.phase`. It starts `true`, before the socket has finished connecting: socket.io buffers
what is emitted before then, and a page that announced a lost connection for the first
moment of every load would be crying wolf.

**A drop takes its room with it, and the session says so once there is a screen to say it
on.** `disconnect` resets the pacer, drops the watermark and releases `busy` — nothing is in
flight over a socket that is not there — but leaves the view alone, since there is nothing
to replace it with and the disconnected screen is over the top of it anyway. The *reconnect*
is what clears it: the socket comes back with a new identity the server has never heard of,
and the room it was in was destroyed when the old one dropped (ADR-0004), so the honest
place to put the player is the main menu with a `notice` saying where the table went. A drop
at the menu costs nothing and says nothing.

**A connection that never arrived is the same screen.** `connect_error` is treated the way
`disconnect` is, because the two are indistinguishable to whoever is looking at them: taps
buffered into a socket that has reached nothing is the same dead screen. Only the first of a
run of failed retries is news.

**The `beforeunload` warning is registered while a round is live and not otherwise**
(`unload.ts`). A reload drops the socket and so destroys the room for everyone in it, which
is worth an argument at `playing` and `roundEnd` — and not worth one at the main menu, the
lobby or a finished match, where a control on the screen already does exactly that.
`connected` is part of the same question rather than a separate one: a dropped connection's
room was destroyed when it dropped, so the table still on the screen is a match that is
already lost, and arguing over the tab is arguing over nothing. It is
added and removed rather than left listening and deciding when it fires, because a page with
a `beforeunload` listener is held out of the back/forward cache either way. The target is
injected, so it is the one global the client touches and `main.tsx` is the only place that
hands one over. Whether the warning actually appears is the browser's call, not the page's —
a tab the player has never interacted with is closed without argument, and the wording is
always the browser's own.

### Tooling

TypeScript runs **directly on Node 24 via native type stripping** — no build step, no
`tsx`/`ts-node`. Test runner is `node:test`; typechecking is `tsc --build` (composite
project references, `shared` → `server`). This constrains the codebase to *erasable*
TypeScript: no `enum`, no `namespace`, no parameter properties, `import type` for
type-only imports. `tsconfig.base.json` enforces this via `erasableSyntaxOnly`.

Both workspaces have a `test` script, and the root `npm test` runs them with
`--workspaces --if-present`. Each uses an explicit glob (`node --test
"test/**/*.test.ts"`) rather than bare `node --test` — the bare form also picks up
`test/helpers.ts` and any stray `.d.ts` files `tsc --build` emits into `dist/test/`,
which made test counts silently depend on whether a typecheck had run.

**`shared`'s tests are a separate tsconfig project** (`shared/tsconfig.test.json`),
unlike the server's, which includes `test/` in the one project. The suites need
`node:test`, and `types` is per-project, so folding them in would grant `shared/src` the
Node types too — and dependency-freedom would hold only by everyone remembering it.
Split, `shared/src` importing a Node builtin is a typecheck error.

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
- **Deployment.** The engine, bots, rooms, the socket contract and the browser client all
  work end to end from a checkout, but nothing is deployed — running either half means a
  checkout, Node 24, and `npm run serve` / `npm run dev` in separate terminals. ADR-0003
  records the plan (one Railway service, the game server serving the client's static
  files) and ADR-0004 the order it's deferred behind: client, then reconnect, then deploy.
- **Disambiguating a joker that extends a run.** The browser client sends the selection in
  tap order, so tap order decides where the joker sits (`docs/rules.md` §4) — which is
  invisible on the screen. An accepted wart, and a deliberate one: a step that asked the
  player which end they meant is deferred.

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
npm run dev                               # the browser client on :5173, socket proxied
```

`demo` accepts `-- --seed <n> --players <n>`.

The browser client also takes two terminals, and for the same reason the CLI does — it
talks to a separately running server. `npm run dev` proxies `/socket.io` to port 3000, so
the client is same-origin in development and needs no CORS (docs/adr/0003):

```sh
npm run serve --workspace=@yaniv/server   # terminal 1
npm run dev                               # terminal 2 — open http://localhost:5173
```

Playing yourself in a terminal takes two terminals too, because the harness is a real
client:

```sh
npm run serve --workspace=@yaniv/server              # terminal 1
npm run play --workspace=@yaniv/server -- --name Ada # terminal 2 — connects to localhost:3000
```

`play` requires `-- --name <name>` and also accepts `--url <url>`, `--join <code>`, and
`--create`. Three ways to enter:

- `-- --name Ada` alone opens an interactive main menu — `create` a room, `join <CODE>`
  one by code, or `q`/`quit` to exit. A bad or expired code typed here shows the error
  and returns to the menu rather than ending the session.
- `-- --name Ada --create` creates a room immediately and shows its 4-character code —
  the same outcome the bare main menu's `create` gives you, without the extra prompt.
- `-- --name Grace --join <code>` (case-insensitive) joins that room immediately.

Everyone else joins by code, up to six players. The host types `start` to begin, and
every seat still empty is filled with a bot.

At the prompt: `start` begins the match (host only — anyone else is told `NOT_HOST`),
`menu` leaves the room for the main menu without dropping the connection (a guest frees
their seat; the host closes the room, and everyone else is told why and returned to their
own menu), `1 3` discards those cards by hand position and draws from the deck, `t1`/`t2`
on the end takes a face-up card instead (`1 3 t2`), `yaniv` calls, enter deals the next
round, `q` or Ctrl-D quits. A finished match stops at the standings rather than ending the
session: `again` deals a fresh one to the same table (host only) and `menu` leaves, the
same way it does from the lobby. Note that any player disconnecting still ends the room
for everyone — see "Room lifecycle".

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
