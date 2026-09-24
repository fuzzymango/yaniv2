# yaniv2

Multiplayer [Yaniv](https://en.wikipedia.org/wiki/Yaniv_(card_game)), built top-down:
engine first, fully unit tested, then transport. TypeScript, npm workspaces. The server has
two runtime dependencies and nothing else does — `socket.io`, and `postgres` for the profile
store (`docs/adr/0019`, which records that a dependency-free profile store was not reachable).
`shared/` is types, the event contract and the rulebook, so it stays dependency-free for the
client's sake.

# behavior rules
This section bullet points specific behavior patterns that you should follow when working in this repository. Do not modify this section.

- **keep `README.md` and `CLAUDE.md` updated** - after implementing code changes, review the contents of `CLAUDE.md` and README.md and ensure they're kept up to date and relevant with the current state of the codebase. For example, if you add or modify an `npm run ...` command, ensure that the `README.md` is amended to reflect this change. Developers will look at `README.md` often and we don't want to have false/stale information present. The catch to ths is, we don't want `README.md` to become bloated with information so only maintain the high-level information necessary for navigating this project. The `CLAUDE.md` file should be no more than 700 lines. If the document exeeds 700 lines, compact it by:

- **Trim non-universal instructions:** Remove details Claude can easily discover by inspecting your file tree or code patterns.
- **Delete redundant history:** Purge old to-do lists, outdated implementation notes, and completed session logs.
- **Use sub-file references:** Move specific architectural breakdowns or deep-dive documentation into external files (ADRs or `README.md`) and reference them lightly instead of pasting text inline.

## Where the rules live

**`docs/rules.md` is the single source of truth for gameplay.** Every rule maps to at least one
test; if code and `rules.md` disagree, `rules.md` is right and the code has a bug. Adding or
changing a rule goes `docs/rules.md` first, then the code, then tests — never let a rule exist
only in code. `docs/backend-archetechture.md` is the original design sketch, **stale** in
several places, kept for history only: what it describes and you cannot find is one of the
deviations listed at the top of that file, each with its reasoning below.

The rest of `docs/`, in the order you are likely to want it: `code-map.md` (every file in the
four source trees), `adr/` (one decision each, numbered), `client-table.md` (the felt) and
`client-session.md` (the wire behind it). `CONTEXT.md` at the root is the domain vocabulary.

## Code structure

Four trees: `shared/src` (types, the socket contract and the rulebook, dependency-free),
`server/src` (the engine — deck, pure transitions, serialization, rooms, bots — the
profile store's seam, and `sql/` behind it),
`server/scripts` (two smoke-test harnesses, not shipped) and `client/src` (Vite + React: a
framework-free session core, plus components foldered by screen). Every workspace has a `test/`
of `node:test` suites beside its `src/`: one file per module, plus the server's
`integration.test.ts` fuzzer, and the socket-driven suites on both sides.

**Every file, with what is in it and the decision behind it, is tabulated in
`docs/code-map.md`** — read that before adding a module, and add its row when you do. What
holds across the trees, and is not discoverable by reading one file:

- **`shared/` is imported by the server and both clients**, so the wire contract cannot drift
  between them. The rulebook lives there for the same reason — a client must offer exactly the
  moves the server will accept (`docs/adr/0002`) — as does `standings`, a finished match not
  being allowed to end two ways depending on who is looking, and `displayName.ts`, the one
  trimmed-1–20 rule every name a player can be known by goes through. Every function there is
  pure over values the wire already carries, so this costs `shared` none of its
  dependency-freedom.
- **`profiles.ts` is a seam, and its in-memory store is shipped code** (`docs/adr/0019`): the
  one shape anything above it sees a remembered player through, so no file but the SQL
  implementation behind it learns what a database is. The memory store is not a test double —
  it is what a server told to run without a database runs on — which is why it sits in `src/`
  and why `test/profiles.test.ts` is parameterised over a `() => ProfileStore` factory rather
  than written against it: that suite is the interface's specification, and the second
  registration is the Postgres arm.
- **`server/src/sql/` is the only folder that knows SQL, and one file in it is the only file
  that imports `postgres`** — `connect.ts`, so the whole cost of the driver is visible by
  opening it, and the client's type travels to the other two as `SqlClient`. `migrations.ts`
  is an ordered list of statements and the applier that runs whichever a `schema_version` row
  says have not run: **append a statement, never edit a shipped one**, safe at startup only
  because this service cannot run two replicas. `profiles.ts` beside it implements the seam
  over a client it is *handed*. **No test in the repo executes a line of the folder**
  (`docs/adr/0019`) — a wrong column name is found by booting, and CI with a `postgres`
  service is the named fix.
- **`bot.ts` is shipped, not a dev tool**, and decides only from a `PlayerGameView` — the same
  payload a real client gets — so it cannot see hidden hands or the draw pile.
- **`server/scripts/` imports nothing from `src/` except types.** Reaching for `RoomManager`
  would make `playSocket.ts` a second server rather than a transport test. `play.ts` is the
  in-process bots-only harness, reproducible from a `--seed`, which is what makes it the tool
  for judging bot play.
- **`client/src` imports `@yaniv/shared` and nothing from `server/src`** — a third client of the
  same contract, alongside the two harnesses.
- **One exported component per file, in a folder named after the screen or feature it serves**
  (`main-menu/`, `lobby/`, `table/`, `game-end/`, `connection/`, `settings/`, and `shared/` for
  chrome no one screen owns). Entrypoints, pure logic modules and `styles.css` stay flat at the
  root. **No barrel `index.ts`** anywhere. Two exemptions and only these: private single-use
  render helpers stay inline with their one component (`table/MoveHistory.tsx`), and two
  exported components share a file only where splitting them would lose an invariant, the
  file's own header saying which (`table/Seat.tsx` is the one).

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

**Slapdown does not reopen this.** `slapDown` (docs/rules.md §9) is not a turn and not a
mode of one: `takeTurn` records the window it opened (`round.slapdown`, per `opensSlapdown` in
the shared rulebook) and hands the turn on as usual, and slapping the card down only shrinks a
hand, extends `lastDiscard` and records `round.lastSlapdown` — `currentTurnPlayerId` never
moves. The window closes on the slap or on the next player's `takeTurn`/`callYaniv`; both
assign `round.slapdown` outright rather than merging, so a stale window cannot survive a
turn. No lock and no timer — ADR-0005.

The wire keeps that shape: a payload-free `slapDown` (the server already knows which card is
meant) through the same `act()` helper as `takeTurn`, `SLAPDOWN_NOT_AVAILABLE` for whoever
loses the race, and eligibility on `SelfView` alone. Both clients offer it; no bot slaps down
for itself, per ADR-0005 — what it costs, not a defect.

### Round state is nested

`GameState.round: RoundState | null` holds everything that resets between rounds (hands, piles,
whose turn it is, and now `turnOrder`), and starting a round replaces it wholesale
(`dealRound`), so no field can leak from the previous round by omission. Match-scoped data
(`players[].score`, `roomCode`, `hostId`) lives one level up and persists across rounds.

### Going out, and the roster that outlives it

Crossing the room's `maxScore` when a round is scored takes that player **out of the match**,
not the match away from everybody (docs/rules.md §7): play goes on, shorter round by shorter
round, until one player is left — and that player wins, whatever they are holding.
`winnerIds` keeps its list shape and is always length one.

**`Player.outInRound: number | null`** is the one fact about out-ness, with no boolean beside
it to disagree; *why* is derived — **eliminated** is out with a score past the limit, **left**
is out with **`Player.departed`** — and the two are disjoint by the rules, not by convention.
From the first deal the **roster is append-only**: leaving marks a seat rather than splicing it
out, which is what makes "out, and gone" representable. In the lobby it still splices, there
being no match record for a seat to be part of yet — `docs/adr/0016`.

Membership in `players` therefore no longer means membership in the match, and every seat count
and map over it asks `inMatch` (`state.ts`): `dealRound`, `randomOpener`, the minimum to start,
`seatBots`, the serializer's `turnOrder`. A missed one is a live bug, not a type error — the
riskiest part of the change, and not the rule. `playAgain` is the deliberate exception: it
counts the seats that are still somebody's, so last match's losers are in the next one.

### The discard pile is two parts, not a flat array

`RoundState.lastDiscard: Card[]` is the most recent discarded set, face up, and what may be
taken from it depends on its shape (`pickupCandidates`): a run exposes **only its two ends**, a
same-rank set of any length **every card**, having no sequence for a middle position to protect.
A slapdown extends that same array, so a slapped card is takeable like the set it joined.
`RoundState.buried: Card[]` is everything discarded earlier — out of play until the draw pile
empties and it is reshuffled. A flat array cannot express "only part of this is takeable".

### Wildcard jokers in runs (docs/rules.md §4)

- Jokers are wild **in runs only** — never in same-rank sets (`Jk 7♠ 7♣` is not a set) — and a
  run needs **at least 2 real cards** to anchor it (`Jk Jk 5♥` is not a run).
- `isRun` in `shared/src/rules.ts` checks this with a span test rather than a walk, which is
  also what makes no-wrap-past-King/Ace fall out for free.
- **Joker placement in a laid-out run is decided by the player**, because it decides what the
  *next* player is offered for pickup. An interior gap has one possible position; a joker that
  *extends* the run (`7♥ 8♥ Jk` → 6-7-8 or 7-8-9) is ambiguous, and `layOutRun` resolves it from
  the submitted order — jokers before the first real card extend downward, the rest upward,
  overridden only at the deck boundary.

### Bot architecture: "may I" vs "should I" vs "who plays it"

Split deliberately across three layers:

- **`shared/src/rules.ts`** owns what's *legal* — `legalDiscards`, `canCallYaniv`. Rules
  queries, not bot logic, which is why they sit in `shared`, where a client can reach them to
  highlight playable cards.
- **`server/src/bot.ts`** owns *judgement* — `shouldCallYaniv`, `chooseDiscard`, `chooseDraw`,
  composed by `decideTurn`. It takes a `PlayerGameView`, never raw `GameState`, so it cannot
  cheat by construction.
- **`server/src/botTurns.ts`** owns *execution* — `playBotTurn` applies one bot's decision
  through the same transitions a human goes through, and the runner around it schedules each
  turn a think time apart. It knows nothing about sockets, so it is testable without one, and
  takes its clock and its decision function as arguments (real time and `decideTurn` by
  default) so a test can drive a deliberately broken bot.

The bot is intentionally weak: it calls Yaniv the instant it is legal, and judges an exposed
card by face value. A known limitation — future work, not a defect to fix here.

**A bot's decision being rejected by the engine is a defect, not a rule violation.**
`playBotTurn` throws when `apply` refuses a bot's own move — there is no client at fault to
report it to, and swallowing it would wedge the table — the one place in the server where a
failed `Result` becomes a thrown error rather than an ack. (The auto-deal's own refusal is
not that shape: it is a race it can lose, and losing means having done nothing, docs/adr/0014.)

**Which seats are bot-controlled is `Player.isBot`**, required rather than optional so no
construction can leave a seat ambiguously controlled. The engine ignores it entirely — bots move
through `takeTurn`/`callYaniv` exactly as humans do — it exists so the layer above knows whose
turn it has to play, which table has only bots left in the match (`autoDeal.ts`) and which room
has nobody in it a bot is not (`roomSweep.ts`).

The integration fuzzer has its **own** discard/draw logic and deliberately does not import from
`bot.ts`, which would let a smarter bot silently narrow what it covers — it shares
`legalDiscards` alone, a rules query rather than a policy.

### Errors are values

Every rule-violating action returns a `Result<T>` carrying a `GameErrorCode` and never throws,
so TypeScript forces call sites to handle failure. Anything that *does* throw (`RoomManager`
code exhaustion, `deal` given too small a deck) is a genuine defect, and the socket layer lets
it propagate rather than reporting it to a player.

### Randomness is injected, never ambient

Every function needing randomness takes an explicit `Rng` argument (`() => number`, same
contract as `Math.random`). Tests use `mulberry32(seed)` so a match, a deal or a bug report is
reproducible from its seed — the integration suite asserts two runs of one seed agree exactly.

### Serialization is the security boundary

`GameState` contains every hand and the full draw pile order and **must never reach a client**.
`serializeStateForPlayer` is the one function that reduces it to a `PlayerGameView`: the
viewer's own hand, opponents reduced to a `handSize` (never an optional `hand` — the type
disallows the leaky shape), draw pile as a count only, and every seat's standing sent whole to
everyone, being public either way. Hands are revealed only at `phase: 'roundEnd'`/`'gameEnd'`.
Tests assert no hidden card id reaches a payload, mutation-tested by breaking it on purpose.

**A spectator's payload is an active player's minus a hand, never plus anything** (issue #143).
`SelfView` is tagged by `spectating`, derived in `state.ts` as out, not departed, not a bot and
connected — so no layer above needs a special case for one, `autoDeal.ts` included — and the
spectating variant has no `hand` and no `slapdownEligible` at all, on `OpponentView`'s principle:
being knocked out must not make a player an oracle for a friend still playing. Mutation-tested.

**Who is connected is an argument, not a field** (docs/adr/0013). `serializeStateForPlayer`
takes the set of player ids with a live socket, which `broadcastState` reads off the room's
sockets once per publication; the viewer and every bot are connected by construction. Required
rather than defaulted, so a publishing call site cannot forget — the two with no transport under
them (a bot deciding, `scripts/play.ts`) pass `NO_CONNECTIONS`. No stored flag can go stale.

**The last move is sent with its drawn card redacted** — off the face-up discard to everyone,
off the deck to the mover alone (docs/adr/0007) — **`lastSlapdown` is its unredacted sibling**
(0008), **`moveHistory` the log neither is**, redacted per entry (0010), and the **scorecard**
redacted nowhere and sent whole in every phase (0017).

**A finished round names its own players.** `PlayerRoundResult` carries a `name` copied in when
the round is scored, and the serializer uses that rather than the id's entry in `players`
(#78): the record says *what* to draw at a seat, never which seat.

### Player identity

`Player.id` is a **server-issued stable id**, generated at `RoomManager.createRoom`/`joinRoom`,
never a socket id: the domain model has zero transport awareness, which is what let
`resumeSeat` rebind a seat to a second socket without touching a fixture.

The socket layer bridges the two with a **session bound to the connection**: on a successful
`createRoom`/`joinRoom`, `socket.data.session = { playerId, roomCode }`, and every later
handler reads identity from there. A client-supplied player id is **never** trusted — a
socket could otherwise act as any player just by saying so. The session is one optional
object rather than two optional fields, so a half-bound connection is unrepresentable.

A connection binds **once**. A second `createRoom`/`joinRoom`/`resumeSeat` on an already-bound
socket is rejected with `ALREADY_IN_ROOM` (the one error code that exists purely because there
is a transport): silently rebinding would orphan the first player, seated in a room with no
connection able to act for them.

Beside the id, every seat is issued a **`Player.resumeToken`** at creation: a CSPRNG secret
behind an injectable `newResumeToken`, fixed for the life of the room — hence `updatePlayer`
cannot patch it and no transition may reissue one (asserted over every state a match passes
through). It is the credential a seat is resumed with, treated as a hidden hand is: **never in
a view, in any phase**, mutation-tested at the serializer and the wire. It reaches its owner in
one place, the ack of the event that seated them.

### Room lifecycle

Lobby → host calls `startGame` → `playing` → `roundEnd` after a Yaniv call → any player still in
the match calls `startNextRound` (or the server deals it where only bots are left playing,
docs/adr/0014), or `gameEnd` once one player is left — by a scoring or a departure (#147). 2–6
players, held in `RoomManager`'s **in-memory `Map`**.

**`startGame` fills up to `settings.botCount` empty seats with bots**, reevaluated against the
room's current human count at read time rather than a stored, possibly-stale number
(`effectiveBotCount`, docs/adr/0006). `botCount` defaults to **zero**, which is what gives
`MIN_PLAYERS` teeth: the check counts every seat, bots included, so a lone host who asked for
none is turned away. `RoomManager.seatBots` is **pure** and the handler folds it into the
transition, so a start that is then rejected discards the seating with everything else.

**The host edits all four settings from the lobby and nowhere else** (`updateSettings`,
docs/adr/0006): the whole object at once, never a patch, so a room never plays under half of
one set of choices and half of another. Refused outside `lobby` (`WRONG_PHASE`), by anyone but
the host (`NOT_HOST`), and for a field outside its range or enum (`INVALID_SETTINGS`) — the
payload staying `unknown` until `isValidSettings` says otherwise, its wire type being a claim
by whoever sent it and the guard living in `shared` on the rulebook's grounds (ADR-0002). The
first deal locks the lot; `playAgain` never returns to the lobby.

**A disconnect costs the room nothing, and is told to it anyway.** The `disconnect` handler
**mutates nothing** — the seat, the player and the room are left as they were — and republishes
the room, the only way whoever is left learns a seat has gone quiet (docs/adr/0013), and what
starts the room's grace period (docs/adr/0015). Whoever dropped comes back through
**`resumeSeat({ roomCode, playerId, resumeToken })`**: session rebound, room rejoined, the
position answered in the ack and the room published to behind it. A wrong token, an unknown
player and a seat given up share `INVALID_RESUME_TOKEN`, or a room code would be a way of
fishing for the seats behind it. One live connection per seat: a resume disconnects whatever
socket still held it.

### The host owns the lobby, and leaving costs nobody else anything

**The host is the lobby's and nothing else** (docs/adr/0012): the one seat that may edit the
settings and deal the first round, `NOT_HOST` to anyone else, and the role **migrates to the
next seat** when a host leaves the lobby — `hostId` is the one mutable field of a match, and
`removePlayer` in the lobby the one writer. From `playing` onward nobody is host and `hostId`
is sent null. Two eligibility rules replace it: **`startNextRound` is any player still in the
match** (`NOT_IN_MATCH` otherwise), **`playAgain` is anyone still in the room**, spectators
included, since the one player left at `gameEnd` may be a bot and a bot asks for nothing.

**`closeRoom` is gone**, and with it `roomClosed`: no player can end anybody else's game.
`exitToMenu` is the only way out, allowed **from every phase** (#147), and **it means the same
thing whoever invokes it**: their own seat and nobody else's, told by `playerLeft` and then the
roster with that seat spliced out (lobby) or marked (once a match exists). A room ends when its
last seat leaves (`abandoned` → `destroyRoom`, which also cancels its timers), or a minute
after the last human's connection went (`roomSweep.ts`, below).

**Leaving mid-round takes the leaver out of the round, not the round away from the table**
(`withdrawFromRound`, docs/rules.md §7): their hand is **buried** so the pack is still whole
for a reshuffle, they come out of `turnOrder`, the turn moves on if it was theirs, and their
slapdown window closes. The moves they already played stay in the history — those happened —
and they are scored for nothing that round, being no longer in its turn order. Two things
follow above the transition: a **departure can end the match**, `gameEnd` being reachable
without a scored round behind it and so with no reveal under the standings; and the exit
handler **runs bot turns** on its way out, the same tail `act()` has, since a turn handed on
by a departure may land on a bot exactly as one handed on by a move does. `startNextRound`
opens on the first seat still playing where the round's winner has since left.

The exit is not `act()`-shaped: `removePlayer` is a pure transition and "the room must be
destroyed" is no `GameState` it could return, so that branch lives in `socketServer.ts`, which
**clears `socket.data.session`** (or `ALREADY_IN_ROOM` would mean "for the life of this
connection") **and calls `socket.leave(roomCode)`**, keeping it out of the next broadcast.

**`playAgain` seats no bots**, unlike `startGame`: a seat given up stays given up, so a table
that has shrunk below two is turned away with `NOT_ENOUGH_PLAYERS`. It does clear every
**elimination**, so the last match's losers are in the new one — a departed seat stays out.

### Socket layer: wiring is separate from listening

`createSocketServer(httpServer, rooms, profiles, options?)` attaches handlers and returns the
`io` instance; it never calls `listen`, and `index.ts` does that and nothing else. The
`ProfileStore` is a **required** argument rather than a defaulted one, on ADR-0013's grounds: a
call site needing a capability must not be able to forget it, and a server that composed itself
a store nobody chose would put the accounts wherever the default went. The split exists
so tests can stand up a real server on an ephemeral port (`listen(0)`) without duplicating
handler logic — `socketServer.test.ts` drives real `socket.io-client` connections rather than a
stub, this layer's whole job *being* its wire behaviour, and observes server-side facts through
the socket rather than by asking `RoomManager`. `options` carries the clock every room timer is
set on and the bot think time, both defaulted, so production construction is unchanged.

### There are two ways to boot, and the command says which

`index.ts` is the one place that binds a port and the one place that decides where accounts go
(`docs/adr/0019`). **`npm run serve`** reads `DATABASE_URL`, applies pending migrations and
**refuses to start** without a working database; **`npm run serve:memory`** runs the in-memory
store on nothing but a port, and is what local work uses. **There is no fallback between them** —
a deploy that lost the variable would otherwise run on memory and quietly forget every account,
in a decision made *for* durability — and it is a flag rather than a second environment variable,
because which store to use is something a person chooses when they type the command. Nothing
catches on the way in: a missing variable, an unreachable database or a migration that will not
apply crashes the process before a port is bound, which is what `result.ts` already says a thrown
error is for.

### Broadcasting: one send per socket, one broadcast per move

`broadcastState(roomCode)` loops the room's sockets and emits `serializeStateForPlayer` per
connection — the same walk that yields the connected player-id set every view of that one
position is built with (docs/adr/0013), and the one place the room's auto-deal and its sweep
are reconsidered (below). Never `io.to(room).emit(state)`: raw state holds every hand and the
draw pile order, and a wire-level test asserts no card id outside the viewer's own hand and
the face-up discard reaches a mid-round payload.

It is **deliberately synchronous**, walking `io.sockets.adapter.rooms` rather than
`await io.in(room).fetchSockets()`: it must publish the position that stood when it was called,
being called from a bot's timer and from handlers racing one. **Each bot action gets its own
broadcast**, **spaced out by the server**: five bot turns are five updates in turn order, one
every `BOT_THINK_MS` (below) — the rhythm is a fact about when the moves *happen*.

Every in-game handler shares one `act(ack, transition)` helper: identify the caller from their
session, apply, and on success ack, broadcast, then run any bot turns. A rejection acks the
error and publishes nothing, so a refused action costs the player nothing.

### Bots think before they move

A bot's turn is **scheduled, not played in the tick that handed it over**: the runner in
`botTurns.ts` waits out `BOT_THINK_MS` (1500ms) — every bot and every turn alike — then decides
from the position in front of it. Two things follow as one fact: a table of bots reads as a game
being played, and **a human can win the slapdown window their own turn opened** (ADR-0005) —
there is no window timer, only the pause the next bot takes. **At most one pending run per
room**, the registry's doing: every per-room timer is set on `roomTimers.ts`, so closing a
room is `cancelRoom`, naming no behaviour.

### A table only bots are playing deals itself on

Only a player still in the match may deal the next round (docs/adr/0012), leaving a spectator
whose match went on without them watching a round no bot will ever advance. So the server deals
it, `AUTO_DEAL_MS` (10s) after `roundEnd`, on three conditions each of which is a rule: that
phase and not `gameEnd`, **every seat still in the match a bot**, **somebody `spectating`** it.
Pure judgement (`autoDealSeat`), reconsidered on every publication. `docs/adr/0014`.

### And a room nobody is in is swept

The other way a room ends, and the one nobody takes deliberately (#150): **unattended** — no
seat held by a connected human, bots and departed seats counted out — for `ROOM_SWEEP_MS` (60s),
and it is destroyed with everything it had waiting. **Not on the drop**: a seat is resumable
precisely so a reload costs nothing, so the returning connection cancels the pause by
publishing. The auto-deal's shape exactly, plus one ask at the far end against the live
sockets. A minute of bots playing to nobody is the accepted cost. `docs/adr/0015`.

### The turn is two taps, and draw targets are inert until legal

A turn on the client is never a button — it is built from two taps. Tapping a card in hand adds
it to an ordered **selection** (`CONTEXT.md`'s **Selection**); tapping a draw target — the deck,
or a takeable end of the last discard — commits it, discarding the selection and drawing the
tapped card in one action, mirroring the server's atomic `takeTurn` (above). A "discard" button
then a "draw" button would imply a moment in between the engine has no state for.

Draw targets stay inert — untappable — until the current selection is a legal discard
(`isValidSet`, from `@yaniv/shared`'s rulebook). This is the reason the rulebook moved to
`shared/` at all (ADR-0002): without it on the client, an illegal set could only be caught by
sending it and being told no — a silent round trip that on a touch screen reads as a tap that
did not register. `client/src/turn.ts` is the pure module this lives in: `turnFrom` takes a
selection, the view and the tapped source and returns a `TurnAction` or `null`, and
`isLegalSelection`/`isLegalCall`/`takeableIds` decide which controls light up. It knows nothing
of whose turn it is — turn order is the server's alone, and comes back as a `GameError`.

An open slapdown window suspends all of it: `Table.tsx` draws the pile as one flashing control
instead of a row of draw targets, because a tap has to mean one thing. It is also the one
question the rulebook cannot answer — a window is about a card off a pile the server never
sends — so `isSlapdownTarget` reads the wire's own answer, and answers `false` for a spectator.

### The table is seated, and the scored round is the same table

Opponents are drawn round three sides of the felt (`seatZones`): fans of face-down backs while
the round is played, the same seats cascaded face up once it is scored, and the same again with
the standings floating over them once the match is. **One screen, not three** (issues #78,
#130): `Table.tsx` renders every phase off one placement (`byRelativeSeat` off the live roster)
and one reserved box per seat (`seatFootprint`).

**A move is watched crossing that table, not merely published onto it** (issues #69, #72-#74).
The session says *what* moved (`flight.ts`), `ghosts.ts` which of it the screen can draw and
which way up, and `CardsInFlight.tsx` measures where and closes the difference (FLIP,
`flip.ts`). Every move flies both ways, whoever took it, with the wire's redaction passed
through, and **a slapdown flies as its own shape** (#95). Nothing waits on a flight, reduced
motion skips it, and it is scoped to `playing`. A spectator watches that same table with a bar
where their hand was (#143); an out seat keeps its place on the felt, darkened (#144).

**The match's record is held up in front of that table** (#154, docs/adr/0017): the scorecard,
opened from a button in the viewer's own name bar — rounds down, the roster's seats across,
running totals in the cells, three colours saying what happened, and a blank where a seat was
already out. Offered while a round is played or scored, watchers included; not once the match
is over, the standings answering it over the very bar the button would sit in.

**And the call that ended the round is announced over the seat that made it** (#124, #156,
docs/adr/0018): `YANIV` in yellow, `ASSAF` in red a beat later, both faded out together. A one-shot
like the flight, keyed on the scorecard growing so no republish replays it, on a second timing root
deliberately not the flight's, in the two colours the scorecard now speaks. Every decision behind
the geometry, the flight, the banner, the bar and the dim is in **`docs/client-table.md`** and the
ADRs; the code is `fan.ts`, `score.ts`, `seating.ts`, `table/`.

### Settings are edited in one place and shown in another

The lobby is the only screen with the four controls (`SettingsEditor.tsx`, host only) and the
only one showing the values inline; the three in-match screens carry one icon that opens a
modal (`SettingsDialog.tsx`), because a room's numbers are worth a tap when somebody asks and
worth nothing standing over a hand being played. Both read-only listings are one component,
so a value cannot be worded two ways.

**The editor keeps the last settings it sent until the room says the same thing back**
(`sameSettings`). An edit is acked as soon as the server has it, and the position behind it
arrives separately — so a second tap read off the screen would send the first one's change
still undone in it, and hand size 6 would snap back to 5 a moment after the host asked for it.
That draft stays in the component, as does whether the modal is open: a form half-filled in is
no use outside the screen holding it.

### The client's session core

The browser client's logic lives in `client/src/session.ts`, a plain module outside React that
owns the socket and exposes exactly two things: a `SessionSnapshot` to read and a set of intents
to call. `useSession` subscribes with `useSyncExternalStore` and holds no logic — **if that hook
ever grows a branch, the branch is in the wrong place.** The point is testability: the core is
driven under `node:test` against a real socket server, with no browser, no jsdom and no React
test dependencies. Components are not tested at all, a consequence of that split rather than a
gap — behaviour worth testing belongs in the session core or in one of the pure modules beside
it, which `docs/code-map.md` names.

Snapshots are **replaced wholesale, never mutated**, `useSyncExternalStore` comparing by
identity. Eight fields, each answering a different question: `view` (null *is* the main menu),
`error`, `notice`, `connected`, `resuming`, `selection` (surviving the views that arrive
underneath it), and the two **one-shots**, `flight` and `announcement`. **`busy` locks on emit
and settles two ways** — on the ack for entering, leaving and anything producing a new position,
on a strictly newer position for a move — so a control is never released over a position still
showing the mover's own turn. **The client never enforces a rule the server owns**: what is
legal about the cards is all it applies ahead of the server (ADR-0002), and everything else it
offers is sent and refused.

**Every rule of the snapshot, `busy`, the seat resumed from `localStorage` and the screen a
dropped socket puts up is in `docs/client-session.md`.**

### Tooling

TypeScript runs **directly on Node 24 via native type stripping** — no build step, no
`tsx`/`ts-node`. Test runner is `node:test`; typechecking is `tsc --build` (composite project
references, `shared` → `server`). This constrains the codebase to *erasable* TypeScript: no
`enum`, no `namespace`, no parameter properties, `import type` for type-only imports, enforced
by `erasableSyntaxOnly` in `tsconfig.base.json`. Every workspace's `test` script names an
explicit glob rather than bare `node --test`, which would also pick up `test/helpers.ts` and
the `.d.ts` files `tsc --build` emits.

**`shared`'s tests are a separate tsconfig project** (`shared/tsconfig.test.json`), unlike the
server's: `types` is per-project, so folding them in would grant `shared/src` the Node types its
suites need. Split, `shared/src` importing a Node builtin is a typecheck error.

## Explicitly out of scope (for now)

Not oversights — deferred on purpose, in this order of likely next work:

- **What a mid-round seat does while its player is gone.** The rest of #138 (#143, #144 and
  #146-#150 are done): the status slot is display only, and within the room's grace period nothing
  pauses, times out, bot-plays or frees a seat whose player never comes back.
- **Starting a match with seats open for latecomers.** `startGame` seats bots on the spot, so
  anyone not joined by then plays the next match, not this one.
- **The settings and the scorecard from the terminal harness.** The browser edits all four
  settings (docs/adr/0006) and draws the ledger (0017); the CLI does neither.
- **Persistence for *rooms*.** Accounts are in Postgres (`docs/adr/0019`); rooms are still a
  `Map` in the process, so a redeploy drops every match in progress — an accepted cost, a match
  being a thing you were in the middle of, and the constraint that makes startup migrations safe.
- **Bots slapping down for themselves.** A human can win one inside the pause a bot takes before
  its turn, but no bot slaps down for itself — ADR-0005's other half.
- **Disambiguating a joker that extends a run.** Tap order decides where it sits — a wart (§4).

## Running things

```sh
npm test                                         # all workspaces, node:test
npm run typecheck                                # tsc --build across the monorepo
npm run serve:memory --workspace=@yaniv/server   # the socket server, profiles in memory
npm run serve --workspace=@yaniv/server          # the same, against DATABASE_URL (PORT, 3000)
```

Every command and flag is tabulated in `README.md`. One thing to know before reading it: the
browser client (`npm run dev`) and the CLI harness (`npm run play`) are each real clients of a
**separately running server**, so both take a second terminal running `npm run serve:memory`.
Deployment is one Railway service serving both halves, plus the Postgres service behind it
(`docs/adr/0003`, `docs/adr/0019`).

## Agent skills

- **Issue tracker** — GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
