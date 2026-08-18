# yaniv2

Multiplayer [Yaniv](https://en.wikipedia.org/wiki/Yaniv_(card_game)), built top-down:
engine first, fully unit tested, then transport. TypeScript, npm workspaces. `socket.io`
is the only runtime dependency, and only the server has it — `shared/` is types, the event
contract and the rulebook, so it stays dependency-free for the client's sake.

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

## Code structure

Four trees, tabulated one by one below: `shared/src` (types, the socket contract and the
rulebook, dependency-free), `server/src` (the engine — deck, pure transitions, serialization,
rooms, bots), `server/scripts` (two smoke-test harnesses, not shipped) and `client/src` (Vite +
React: a framework-free session core plus one component per screen). Every workspace has a
`test/` of `node:test` suites beside its `src/`: one file per module, plus the server's
`integration.test.ts` fuzzer, and `socketServer.test.ts` and the client's suites driving real
`socket.io-client` connections against a real server.

### `shared/src/`

| File | Contents |
|---|---|
| `cards.ts` | `Card`/`Suit`/`Rank`, rank ordering, `rankToValue` (the scoring table, `docs/rules.md` §1), and `sortHand`/`compareCards` (display order only — see below) |
| `views.ts` | `PlayerGameView` and friends — what a client actually receives |
| `errors.ts` | `GameErrorCode` union |
| `events.ts` | `ClientToServerEvents` / `ServerToClientEvents` — the socket contract |
| `rules.ts` | `isValidSet`, `canonicalizeSet`, `legalDiscards`, `canCallYaniv`, `pickupCandidates`, `opensSlapdown`, `handValue` — the rulebook, used by the engine, the bot and the client |
| `config.ts` | Every rule constant (`HAND_SIZE`, `YANIV_THRESHOLD`, `ASSAF_PENALTY`, `MAX_SCORE`, `MIN_RUN_LENGTH`, `MIN_RUN_REAL_CARDS`, `MIN_PLAYERS`, `MAX_PLAYERS`), each pointing at a `docs/rules.md` section. `HAND_SIZE`/`YANIV_THRESHOLD`/`MAX_SCORE` now survive only as `RoomSettings`' default seed values (`docs/adr/0006`) |
| `settings.ts` | `RoomSettings` (`handSize`, `yanivThreshold`, `maxScore`, `botCount`) — a room's own per-match configuration; `botSeatLimit`/`effectiveBotCount`, the seats left for bots and what `botCount` therefore means right now; `isValidSettings` and the option sets/limits it validates against (`HAND_SIZES`, `YANIV_THRESHOLDS`, `MAX_SCORE_LIMITS`, `BOT_COUNT_LIMITS`), which a lobby control renders from. `docs/adr/0006` |
| `standings.ts` | `standings` — a finished match's final table, lowest score first, including whoever has left since. Read by both clients |

Imported by the server and the client, so the wire contract can't drift between them. The
rulebook is here rather than in `server/src` for the same reason: a client must offer exactly
the moves the server will accept, and cannot reach into `server/src` to find out. `standings`
is here on the same grounds — a match that is over cannot finish two different ways depending
on which client is looking. Every function is pure over values the wire already carries, so
this costs `shared` none of its dependency-freedom. See `docs/adr/0002`.

### `server/src/`

| File | Contents |
|---|---|
| `state.ts` | `GameState`, `RoundState`, `Player` — the domain model |
| `config.ts` | The operational constants only — `BOT_NAMES` and `ROOM_CODE_*`. The rule constants live in `shared` |
| `rng.ts` | `Rng` type + `mulberry32` seeded PRNG |
| `result.ts` | `Result<T>` — `{ok: true, value}` / `{ok: false, error}` |
| `deck.ts` | `createDeck`, `shuffle`, `deal` — pure functions, no class |
| `game.ts` | `updateSettings`, `startGame`, `takeTurn`, `callYaniv`, `slapDown`, `startNextRound`, `playAgain`, `removePlayer` — the pure state transitions |
| `serialize.ts` | `serializeStateForPlayer` — the security boundary, explained below |
| `roomManager.ts` | `RoomManager` — owns live rooms, applies transitions, persists only on success |
| `bot.ts` | `decideTurn` and friends — a deliberately simple opponent. See "Bot architecture" below |
| `botTurns.ts` | `playBotTurns` — runs the seats the server owns until the turn returns to a human |
| `socketServer.ts` | `createSocketServer` — wires the event contract onto an `io` instance. Never calls `listen` |
| `staticServer.ts` | `serveStatic` — serves the built client (`client/dist`) same-origin alongside Socket.io, per ADR-0003. Hand-rolled, no framework |
| `index.ts` | The entrypoint. Binds a port and composes the above. `npm run serve` |

`bot.ts` is shipped, not a dev tool: bot opponents are part of the real game, so the socket
layer calls `decideTurn` in production to play a bot's turn. It decides only from a
`PlayerGameView` — the same payload a real client gets — so it is structurally unable to see
hidden hands or the draw pile.

### `server/scripts/`

Not part of the shipped engine — two smoke-test harnesses, split by what they exercise and
not redundant: `play.ts` answers "do the rules and the bot behave?", `playSocket.ts` answers
"does the wire work?".

- **`playSocket.ts`** — `npm run play`. A human against bots, or against other humans in their
  own terminals, over a **real socket connection** to a separately running server (`npm run
  serve` first). Composition only, like `index.ts`: argv, stdin/stdout and a socket, handed to
  `cli/`, where `render.ts` and `commands.ts` are pure and total — bad input returns `invalid`,
  never throws. `session.ts` drives the loop, its input and output injected so tests can, and
  **imports nothing from `src/` except types**: reaching for `RoomManager` makes it a second
  server, not a transport test.
- **`play.ts`** — `npm run demo`. Bots only, in process, no transport: drives `RoomManager`
  and the pure transitions directly. Accepts `--seed <n>` and `--players <n>`, and a whole
  match is reproducible from the seed alone — which makes it the tool for judging bot play.
  Keep it that way; there is deliberately no socket equivalent, since the server owns the
  rng and seats its own bots, and no client event asks for a seed.

### `client/src/`

A third client of the same contract, alongside the two harnesses — not a replacement for
either. It imports `@yaniv/shared` and nothing from `server/src`.

| File | Contents |
|---|---|
| `main.tsx` | The entrypoint. Opens the socket, hands over the seat store and mounts `App`, and nothing else — `server/src/index.ts`'s counterpart |
| `session.ts` | The session core: owns the socket and the seat's credential, exposes a `SessionSnapshot` and the intents. Framework-free, so `node:test` can drive it |
| `turn.ts` | What a tap means: `toggleSelection`, `retainSelection`, `isLegalSelection`, `isLegalCall`, `takeableIds`, `isSlapdownTarget`, `turnFrom`. Pure and total — `scripts/cli/commands.ts`'s counterpart |
| `flight.ts` | `flightFrom` — the position on the screen and the one arriving in, and either the move between them or nothing. Two facts watched, `lastMove` and `lastSlapdown`, and at most one changes per arrival; `CardFlight` is tagged by which (`TurnFlight`: mover, discarded cards, draw source, drawn card where the viewer may know it — `SlapdownFlight`: mover and the one card, never redacted). Pure and total, `turn.ts`'s counterpart on the way in |
| `ghosts.ts` | `ghostsFor` — a move and the boxes on the screen in, the cards actually in the air out (`Ghost`: what it answers to, the face to draw or none, from where, to where and into which place), dropping whatever the screen cannot place at both ends. Branches on the flight's tag — a slapdown is one card out of a hand or a seat onto the pile and nothing back, in the same box vocabulary. `DECK_BOX` and `seatBox` are the boxes that are not cards' — the deck a drawn card starts from, and the seat somebody else's hand is one place at, both ends the client is never told a card id for |
| `flip.ts` | `invert` and `transformOf` — where a card has landed and where it came from, as the transform that puts it back. The arithmetic of the flight, and all of it: measured boxes in, one CSS transform out. Pure and total |
| `pacing.ts` | `createPacer` and the `Clock` it takes — the queue that spaces a run of bot turns out into moves a person can watch. Injected clock, so tests drive it a beat at a time |
| `seating.ts` | `bySeat` — the `turnOrder` comparator every screen that lists players sorts by — and `seatZones`, which deals that ordered list round the three sides of the felt (`ZONES`: `left`/`top`/`right`, cycling; `right` never doubles, since 6 players is 5 opponents). One placement for the table in both its phases: a scored round is seated by the same call off the same roster, so the two cannot disagree. Generic over the opponent, since seating is a fact about a list's order and nothing about what is in it |
| `fan.ts` | The geometry of a hand held at a seat, in two shapes. Arced during play: `fanAngles`, `ZONE_ROTATION` (hinge to the screen edge, open edge to the felt), `fanFootprint` (the box the arc needs, so no card tip lands on the label) and `fanOverhang` (how far it is pushed off its edge). Cascaded once it is revealed: `cascadeOffset`, `cascadeFootprint`, `ZONE_CASCADE` (down the sides, across the top) and the `CARD_INDEX_STRIP`/`CASCADE_STEP` pair that keeps a covered card readable. And `seatFootprint` over both — the one box a seat reserves whichever shape is in it, so a round being scored never resizes a seat. Distances in card widths, so the CSS scales it |
| `score.ts` | What a scored round says: `scoreLabel` (the total and what the round added, always signed — every seat's label and the viewer's own footer, so one round cannot read two ways) and `roundOutcome` (the call and the verdict as one sentence, addressed to the viewer, named off the round's own record). Pure and total |
| `settings.ts` | What only a settings *form* knows: `wholeNumber` (a field part-way through being typed) and `sameSettings` (has the room caught up?). Pure and total, `turn.ts`'s counterpart — what a room may be set to is asked of `shared` |
| `tokens.ts` | `seatStore` — the seat written down where a reload will find it, and the only file here that knows the word `localStorage`. Injected storage, so it is driven under `node:test` with no browser; storage that is off, full or holding junk is answered with "no seat" rather than an error |
| `useSession.ts` | `useSyncExternalStore` over the above, and deliberately nothing else |
| `App.tsx` | Which screen: no connection comes first, then a seat being claimed back, then no view is the main menu, then everything else is a function of `view.phase` — with `playing` and `roundEnd` the one branch |
| `MainMenu.tsx` | Name, create, join by code — the one screen with no view behind it |
| `Lobby.tsx` | `phase: 'lobby'` — the code, who is seated, the room's settings (editable by the host, read-only to everyone else), start (host only), and the way out: closing the room for the host, leaving for everyone else |
| `Table.tsx` | `phase: 'playing'` **and `'roundEnd'`** — the hand, the deck, the discard, the opponents seated round the felt, a turn as two taps, the Yaniv call, and the discard as one flashing slapdown target while a window is open. Once the round is scored, the same table with three slots saying something else: every hand face up in its own seat, the line above the felt saying how the round ended, and the call become the deal |
| `CardsInFlight.tsx` | The move being watched: `useCardFlight` (measure every card on the screen, and the deck and the seats with them, after each render, and answer an arriving `CardFlight` with the ghosts `ghosts.ts` chooses and the places to leave empty for them), the `CardsInFlight` overlay they fly across, and `FLIGHT_MS`. The one file here that touches a rendered element, and the only one outside `useSession.ts` with a hook in it |
| `Seat.tsx` | A player in their zone: `SeatZone` (a side of the felt), `Seat` (cards, and an upright label that never turns with them), and the two shapes a hand takes there — `CardFan` (the arc of backs, one per card held, carrying the seat's own `data-flight-box` — the one box in this client drawn to be measured rather than looked at) and `CascadeReveal` (the same hand face up and read, in the seat's own reserved box). Both take that box from `seatFootprint`, so swapping one for the other moves nothing around them. `OpponentSeat` composes the first three for live play; `Table.tsx` composes the scored seat. Presentational throughout |
| `GameEnd.tsx` | `phase: 'gameEnd'` — the final standings lowest-first, who won, play again (host only), and the same two ways out the lobby offers |
| `SettingsEditor.tsx` | The host's four controls, in the lobby and nowhere else. Offers exactly what `isValidSettings` accepts, and sends the whole object per change |
| `SettingsValues.tsx` | The four values as text — the lobby for everyone but the host, and the in-match modal for everyone — plus the box (`SettingsPanel`) and title both lobby listings share |
| `SettingsDialog.tsx` | The settings icon every in-match screen carries, and the modal behind it. The only place a setting is shown once the match is running. The bar it sits in belongs to the screen, since the host has a second icon in it |
| `WayOut.tsx` | How a player gets out of a room: `CloseRoomIcon` for the host beside the settings, and `WayOut` — closing for the host, leaving for everyone else — where a screen has a row of controls. The one control in this client that asks before it acts |
| `Modal.tsx` | The panel the settings and the close-room question are both asked behind — shared for the half nobody can see: announced as a dialog, and dismissed by backdrop, control and Escape |
| `Resuming.tsx` | A seat being claimed back — the third screen with no view behind it, drawn where the main menu otherwise would be so a reload never flashes it |
| `Disconnected.tsx` | No socket — the screen above every other. One screen for a connection that went and one that never arrived, since neither leaves anything to tap |
| `PlayingCard.tsx` | One card, drawn in CSS, and named in the markup (`data-card-id`, which is how `CardsInFlight.tsx` finds a card to measure). Presentational only — it does not know what a card means where it sits |
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

**Slapdown does not reopen this.** `slapDown` (docs/rules.md §9) is not a turn and not a
mode of one: `takeTurn` records the window it opened (`round.slapdown`, per `opensSlapdown` in
the shared rulebook) and hands the turn on as usual, and slapping the card down only shrinks a
hand, extends `lastDiscard` and records `round.lastSlapdown` — `currentTurnPlayerId` never
moves. The window closes on the slap or on the next player's `takeTurn`/`callYaniv`, whichever
the server processes first; both assign `round.slapdown` outright rather than merging it, so a
stale window cannot survive a turn. No lock and no timer — ADR-0005.

The wire keeps that shape: a payload-free `slapDown` (the server already knows which card is
meant) through the same `act()` helper as `takeTurn`, `SLAPDOWN_NOT_AVAILABLE` for whoever loses
the race, and eligibility on `SelfView` alone. Both clients offer it; bots never slap down for
themselves and cannot be raced by a human, per ADR-0005 — what it costs, not a defect in either.

### Round state is nested

`GameState.round: RoundState | null` holds everything that resets between rounds (hands, piles,
whose turn it is). Starting a round replaces this object wholesale (`dealRound` in `game.ts`), so
no field can leak from the previous round by omission. Match-scoped data (`players[].score`,
`roomCode`, `hostId`) lives one level up and persists across rounds.

### The discard pile is two parts, not a flat array

`RoundState.lastDiscard: Card[]` is the most recent discarded set, face up, and which of its
cards may be taken depends on its shape (`pickupCandidates` in `shared/src/rules.ts`): a run
exposes **only its two ends**, a same-rank set of any length exposes **every card**, since a set
has no sequence for a middle position to protect. A slapdown extends that same array, so a
slapped card is takeable like the rest of the set it joined. `RoundState.buried: Card[]` is
everything discarded earlier — visible but out of play until the draw pile empties and it gets
reshuffled. A flat array can't express "only part of the last discard is takeable," hence two.

### Wildcard jokers in runs (docs/rules.md §4)

- Jokers are wild **in runs only** — never in same-rank sets (`Jk 7♠ 7♣` is not a set).
- A run needs **at least 2 real cards** to anchor it (`Jk Jk 5♥` is not a run).
- `isRun` in `shared/src/rules.ts` checks this via a span test, not a walk: real cards fit in a
  window of `cards.length` consecutive ranks (`max(rank) - min(rank) + 1 <= cards.length`), and
  no wrap past King/Ace falls out for free, since Ace and King are 12 apart.
- **Joker placement in a laid-out run is decided by the player.** A joker that fills an
  interior gap has one possible position; one that *extends* the run (`7♥ 8♥ Jk` → 6-7-8 or
  7-8-9) is ambiguous, and `layOutRun` resolves it from the order the player submitted the
  discard in: jokers listed before the first real card extend downward, the rest upward.
  This matters because it decides what the *next* player is offered for pickup. Overridden
  only at the deck boundary — a joker can never be placed below Ace or above King.

### Hand display order is presentation only

`sortHand`/`compareCards` in `shared/src/cards.ts` sort a hand for display: ascending by
value (jokers left, tens/faces right), tied cards broken by rank then suit then card id (the
id tie-break exists because two jokers otherwise compare fully equal and would visibly swap
places between renders). **This has zero effect on engine state** — hands in `RoundState`
stay in whatever order the engine produces them; sorting is applied only at
`serializeStateForPlayer`, the one place every client is guaranteed to pass through.

### Bot architecture: "may I" vs "should I" vs "who plays it"

Split deliberately across three layers:

- **`shared/src/rules.ts`** owns what's *legal* — `legalDiscards` (every valid discard from a
  hand) and `canCallYaniv` (is the hand low enough). Rules queries, not bot logic, which is
  why they sit in `shared`, where a client can reach them to highlight playable cards.
- **`server/src/bot.ts`** owns *judgement* — `shouldCallYaniv`, `chooseDiscard`, `chooseDraw`,
  composed by `decideTurn`. It takes a `PlayerGameView`, never raw `GameState`, so it cannot
  cheat by construction.
- **`server/src/botTurns.ts`** owns *execution* — `playBotTurns` loops while the current seat
  is bot-controlled, applying each decision through the same transitions a human goes through,
  and calling back once per action. It knows nothing about sockets, so it is testable without
  one, and takes its decision function as an argument (defaulting to `decideTurn`) so a test
  can drive a deliberately broken bot.

The bot is intentionally weak: it calls Yaniv the instant it's legal (no regard for
opponents' hand sizes), and picks up an exposed card only by face value in isolation (no
synergy with its own hand). A known, accepted limitation — improving it is future work,
not a defect to fix incidentally.

**A bot's decision being rejected by the engine is a defect, not a rule violation.**
`playBotTurns` throws when `apply` refuses a bot's own move: there is no client at fault to
report it to, and swallowing it would wedge the table on a turn nobody can take. The one
place in the server where a failed `Result` becomes a thrown error rather than an ack.

**Which seats are bot-controlled is `Player.isBot`**, a required field on the domain
model. The engine ignores it entirely — bots move through `takeTurn`/`callYaniv` exactly
as humans do — it exists so the layer above knows whose turn it has to play. Required
rather than optional so no construction can leave a seat ambiguously controlled.

The integration test's fuzzer (`server/test/integration.test.ts`) has its **own** separate
discard/draw logic and deliberately does not import from `bot.ts`: it explores weird states via
randomized draws, and coupling it to the real bot would let a smarter bot silently narrow what
it covers. It does share `legalDiscards` — a rules query, not a policy.

### Errors are values

Every rule-violating action returns a `Result<T>` (`ok: true/false`) carrying a
`GameErrorCode`, never throws, so TypeScript forces call sites to handle failure. Anything
that *does* throw (`RoomManager` code exhaustion, `deal` given too small a deck) is a
genuine defect, not a rule violation — the socket layer lets those propagate rather than
reporting them to a player.

### Randomness is injected, never ambient

Every function needing randomness takes an explicit `Rng` argument (`() => number`, same
contract as `Math.random`). Tests use `mulberry32(seed)` so a match, a deal, or a bug report
is reproducible from its seed — `server/test/integration.test.ts` asserts two runs with the
same seed produce byte-identical final scores.

### Serialization is the security boundary

`GameState` contains every hand and the full draw pile order and **must never reach a
client**. `serializeStateForPlayer` (in `serialize.ts`) is the one function that reduces it
to a `PlayerGameView`: the viewer's own hand, opponents reduced to a `handSize` (never an
optional `hand` — the type disallows the leaky shape), draw pile as a count only. Hands are
revealed to everyone only at `phase: 'roundEnd'` / `'gameEnd'`, where the rules require it.
Tests assert no hidden card id reaches a payload, mutation-tested by breaking the
serializer on purpose to confirm the leak tests fail.

**The last move is sent with its drawn card redacted.** `RoundState.lastMove` records who just
took a turn, which pile they drew from and the card itself; the serializer sends that card to
everyone off the face-up discard and to the mover alone off the deck (docs/adr/0007).
**`RoundState.lastSlapdown` is its unredacted sibling** — who slapped and which card, written by
`slapDown` and cleared by `dealRound`, sent whole: the card is face up by then, and the seat it
came out of is the part no client could infer. docs/adr/0008.

**A finished round names its own players.** `PlayerRoundResult` carries a `name` copied in
when the round is scored, and the serializer uses that rather than looking the id up in
`players`. The duplication is deliberate: a seat can be given up once the match ends
(`exitToMenu`), and resolving names against the live roster left a departed player nameless on
everyone else's scoreboard. The round-end reveal reads those names, and seats off the live
roster (issue #78) — the record says *what* to draw at a seat, never which seat.

### Player identity

`Player.id` is a **server-issued stable id**, generated at `RoomManager.createRoom` /
`joinRoom`, never a socket id: the domain model has zero transport awareness, which keeps
the Socket.io layer thin — and is what let `resumeSeat` rebind a seat to a second socket
without touching a fixture, where the original sketch's `socket.id` would have been a retrofit.

The socket layer bridges the two with a **session bound to the connection**: on a successful
`createRoom`/`joinRoom`, `socket.data.session = { playerId, roomCode }`, and every later
handler reads identity from there. A client-supplied player id is **never** trusted — a
socket could otherwise act as any player just by saying so. The session is one optional
object rather than two optional fields, so a half-bound connection is unrepresentable.

A connection binds **once**. A second `createRoom`/`joinRoom`/`resumeSeat` on an
already-bound socket is rejected with `ALREADY_IN_ROOM` (the one error code that exists
purely because there is a transport). Silently rebinding would orphan the first player —
seated in a room with no connection able to act for them.

Beside the id, every seat is issued a **`Player.resumeToken`** at creation
(`createRoom`/`joinRoom`/bot seating): a CSPRNG secret behind an injectable
`newResumeToken`, exactly as `newPlayerId` is, fixed for the life of the room — hence
`updatePlayer` cannot patch it, and no transition may reissue one (asserted over every
state a match passes through). It is the credential a seat is resumed with, and is
treated as a hidden hand is: **never in a view, in any phase**, mutation-tested at the
serializer and the wire. It reaches its owner in exactly one place — the ack of the event
that seated them — and `resumeSeat` deliberately does not send it back a second time.

### Room lifecycle

Lobby → host calls `startGame` → `playing` → `roundEnd` after a Yaniv call → host calls
`startNextRound`, or `gameEnd` once someone busts past the room's `maxScore`. 2–6 players.
`RoomManager` is an **in-memory `Map`** — a server restart drops every game in progress: a
documented, accepted limitation, not an oversight (persistence is out of scope, see below).

**`startGame` fills up to `settings.botCount` empty seats with bots**, reevaluated against
the room's current human count at read time rather than a stored, possibly-stale number
(`effectiveBotCount`, `shared/src/settings.ts` — docs/adr/0006). `botCount` defaults to
**zero** on a fresh room, a deliberate change from "always fill to six", and that is what
gives `MIN_PLAYERS` teeth: the check counts every seat, bots included, so a lone host who
asked for none is turned away rather than passing a check that could never fire.

**The host edits all four settings from the lobby and nowhere else** (`updateSettings`,
docs/adr/0006): the whole object at once, never a patch, so a room never plays under half
of one set of choices and half of another. Refused outside `lobby` (`WRONG_PHASE`), from
anyone but the host (`NOT_HOST`), and for a field outside its range or enum
(`INVALID_SETTINGS`) — the last of which a typed client cannot produce, and which stops an
off-contract one asking for a state the engine assumes away, like a hand size 54 cards
cannot deal. The payload stays `unknown` until `isValidSettings` says otherwise: its wire
type is a claim by whoever sent it, like a client-supplied player id, and the guard lives in
`shared` on the rulebook's own grounds (ADR-0002). The first deal locks the lot; `playAgain`
never returns to the lobby to offer another edit.

`RoomManager.seatBots(state)` is **pure** — it returns a filled state and stores nothing.
The socket handler folds it into the `startGame` transition passed to `apply`, so a start
that is then rejected (by someone who is not the host, say) discards the seating along with
everything else, rather than filling a table off the back of a refused call.

**A disconnect costs the room nothing** — there is deliberately no `disconnect` handler.
The seat, the player and the room are left as they were, and whoever dropped comes back
through **`resumeSeat({ roomCode, playerId, resumeToken })`**: session rebound, room
rejoined, the current position answered in the ack alone and broadcast to nobody, since
nothing about the table changed and the rest of it is never told who is connected. The
token is the whole of the check — a player id is public enough to appear in every
opponent's view — and a wrong token and an unknown player share `INVALID_RESUME_TOKEN`, or
a room code would be a way of fishing for the seats behind it. One live connection per
seat: a resume disconnects whatever socket still held it, so two tabs cannot disagree about
a table both think they are at.

### Leaving a room without dropping the connection

`exitToMenu` gives up a seat for good, and `playAgain` is the one way out of `gameEnd` other
than closing the room; both are allowed only where the table is not mid-round — the lobby
and `gameEnd` — for the same reason mid-match leaving is out of scope: a hand and a turn
order the round is still being played against. **`closeRoom` is the exception, and the
host's alone**: it works in every phase, because a table gone quiet mid-round is exactly the
one a host needs to abandon and no hand is left to protect once the room itself is going.
Everyone else is told `roomClosed`, the closer hears their own ack, `NOT_HOST` answers
anyone else.

Who invokes `exitToMenu` decides what it costs everyone else, and the caller does not get to
choose: **a non-host frees only their own seat** (the room plays on for whoever remains, told
by `playerLeft` and then handed the shrunk roster), while **the host closes the room outright**
(everyone else gets `roomClosed(reason)`, the last thing they hear about it). Identical in both
phases, deliberately: "a non-host leaving a finished match ends it, since the match is over
anyway" was the plausible drift, and one rule for both was chosen.

Neither exit is `act()`-shaped, and the split across layers mirrors bot seating.
`removePlayer` in `game.ts` is a pure transition that filters a player out; "the room must be
destroyed" is not a `GameState` it could return, so that branch lives in `socketServer.ts`,
where rooms and connections are owned. Both **clear `socket.data.session` and call
`socket.leave(roomCode)`**: clearing the session is what stops `ALREADY_IN_ROOM` meaning "for
the life of this connection", since a sessionless socket is indistinguishable from a fresh
one, and leaving the Socket.io room keeps it out of the next broadcast.

**`playAgain` seats no bots**, unlike `startGame`: a seat given up stays given up, so a table
that has shrunk below two is turned away with `NOT_ENOUGH_PLAYERS` rather than quietly refilled.

### Socket layer: wiring is separate from listening

`createSocketServer(httpServer, rooms)` attaches handlers and returns the `io` instance; it
never calls `listen`. `index.ts` does that and nothing else. The split exists so tests can
stand up a real server on an ephemeral port (`listen(0)`) without duplicating handler logic
or racing for a fixed port — `test/socketServer.test.ts` drives real `socket.io-client`
connections rather than a stub, since this layer's whole job *is* its wire behaviour. The
same reasoning shapes how those tests verify: server-side facts are observed through the
socket, never by asking `RoomManager`.

### Broadcasting: one send per socket, one broadcast per move

`broadcastState(roomCode)` loops the room's sockets and emits `serializeStateForPlayer`
per connection. Never `io.to(room).emit(state)` — raw state holds every hand and the draw
pile order (see "Serialization is the security boundary"). A wire-level test asserts that
no card id outside the viewer's own hand and the face-up discard appears anywhere in a
mid-round payload, and it has been mutation-tested by breaking the boundary on purpose.

It is **deliberately synchronous**, walking `io.sockets.adapter.rooms` rather than the
idiomatic `await io.in(room).fetchSockets()`. It has to be callable from inside a run of bot
turns, and by the time a promise resolved, the position it meant to publish would already
have been played past.

**Each bot action gets its own broadcast.** `playBotTurns` calls back per move and each
callback publishes, so a chain of five bot turns is five updates in seating order rather than
one collapsed jump — a client can replay it move by move. There is **no artificial delay**
between them: pacing a chain for a human is the client's job, asserted by a test.

Every in-game handler shares one `act(ack, transition)` helper: identify the caller from their
session, apply, and on success ack, broadcast, then run any bot turns. A rejection acks the
error and publishes nothing, so a refused action costs the player nothing.

### The turn is two taps, and draw targets are inert until legal

A turn on the client is never a button — it is built from two taps. Tapping a card in hand adds
it to an ordered **selection** (`CONTEXT.md`'s **Selection**); tapping a draw target — the deck,
or a takeable end of the last discard — commits it: the selection is discarded and the tapped
card drawn, in one action. That mirrors the server's atomic `takeTurn` (above); a "discard"
button then a "draw" button would imply a moment in between the engine has no state for.

Draw targets stay inert — untappable — until the current selection is a legal discard
(`isValidSet`, from `@yaniv/shared`'s rulebook). This is the reason the rulebook moved to
`shared/` at all (ADR-0002): without it on the client, an illegal set could only be caught by
sending it and being told no — a silent round trip that on a touch screen reads as a tap that
did not register. `client/src/turn.ts` is the pure module this lives in: `turnFrom` takes a
selection, the view and the tapped source and returns a `TurnAction` or `null`, and
`isLegalSelection`/`isLegalCall`/`takeableIds` decide which controls light up. It knows nothing
of whose turn it is — turn order is the server's alone, and comes back as a `GameError`.

An open slapdown window suspends all of it: `Table.tsx` draws the pile as one flashing control
instead of a row of draw targets, because a tap has to mean one thing. It is also the only
question in that module the rulebook cannot answer — a window is about a card off a pile the
server never sends, so `slapdownEligible` *is* the answer.

### The table is seated, and the scored round is the same table

Opponents are drawn round three sides of the felt (`seatZones`): fans of face-down backs under
upright labels while the round is played, the same seats cascaded face up once it is scored,
with each player's numbers on their own label. A hand shrinking is something to watch, and a
scored one something to read — which is why the two shapes differ.

**And it is one screen, not two** (issue #78): `Table.tsx` renders both phases, so a round
ending changes what is in three slots and nothing about where anything is. One placement
(`bySeat` off the live roster) and one reserved box per seat (`seatFootprint`) are what make
that hold by construction. Every decision behind the geometry is in `docs/client-table.md`
(issues #56, #58, #59, #60, #78, and the flight below); `fan.ts`, `score.ts`, `seating.ts` and
`Seat.tsx` are where it lives.

**A move is watched crossing that table, not merely published onto it** (issues #69, #72-#74).
The session says *what* moved (`flight.ts`), `ghosts.ts` which of it the screen can draw and which
way up, and `CardsInFlight.tsx` measures where it happens and animates the difference closed (FLIP,
`flip.ts`) rather than repeating the geometry above. Every move flies both ways, whoever took it —
one box for a hand that reaches the screen as a count, and the wire's redaction passed through, so
somebody else's draw off the deck flies as a back. Nothing waits on a flight, reduced motion skips
it, and it stays scoped to `playing`: a scored round is a table to read, not a move to watch.

### Settings are edited in one place and shown in another

The lobby is the only screen with the four controls (`SettingsEditor.tsx`, host only) and the
only one showing the values inline; the three in-match screens carry one icon that opens a
modal (`SettingsDialog.tsx`), because a room's numbers are worth a tap when somebody asks and
worth nothing standing over a hand being played. Both read-only listings are one component,
so a value cannot be worded two ways.

**The editor keeps the last settings it sent until the room says the same thing back**
(`sameSettings`). An edit is acked as soon as the server has it, but the position behind it
arrives separately and can be held a beat by the pacer — so a second tap read off the screen
would send the first one's change still undone in it, and hand size 6 would snap back to 5 a
moment after the host asked for it. That draft stays in the component, as does whether the
modal is open: a form half-filled in is no use outside the screen holding it, and no arriving
view can contradict either.

### The client's session core

The browser client's logic lives in `client/src/session.ts`, a plain module outside React
that owns the socket and exposes exactly two things: a `SessionSnapshot` to read and a set
of intents to call. `useSession` subscribes to it with `useSyncExternalStore` and holds no
logic — **if that hook ever grows a branch, the branch is in the wrong place.** The point
is testability: the session core is driven under `node:test` against a real socket server,
with no browser, no jsdom and no React test dependencies. Components are not tested at all,
a consequence of that split rather than a gap — behaviour worth testing on its own belongs in
the session core, or in one of the pure modules beside it (`turn.ts`, `seating.ts`, `fan.ts`,
`flight.ts`, `ghosts.ts`, `flip.ts`, `settings.ts`), where every layout rule with an answer lives.
`useCardFlight` is the one hook outside `useSession`, and only because a flight is measured
off rendered elements — it decides nothing the pure modules could have been asked instead.

Snapshots are **replaced wholesale, never mutated** — `useSyncExternalStore` compares by
identity, so a mutated object would leave React rendering a position that has moved on.

Seven fields, and each answers a different question:

- **`view`** — the position, or `null`. Null *is* the main menu: the one screen that is
  not a function of `view.phase`, because before a room exists there is nothing for the
  server to have sent — with `resuming` the one qualification, below. See `docs/adr/0004`.
- **`error`** — a `GameError`, i.e. something the player asked for and was refused, or one
  the server pushed as `errorMessage`. Cleared the moment they try again, because a refused
  action costs them nothing.
- **`notice`** — news about the room that is *not* a refusal: `roomClosed`, and a seat that
  could not be claimed back. Separate from `error` precisely because there is no action to
  blame and nothing to retry, and because it arrives while the player is sitting still.
- **`connected`** — whether there is a socket to play over. See "A session that loses its
  socket" below.
- **`resuming`** — a seat is being claimed back and the answer has not landed. It always
  rides with `busy`, and says what `busy` cannot: that a null view is a table still being
  asked for rather than the main menu. See "Claiming a seat back" below.
- **`selection`** — the cards tapped for the next turn, by id, in tap order. It lives here
  rather than in a component because it has to survive views arriving underneath it: a card
  that leaves the hand leaves the selection with it, which is `retainSelection` applied to
  every broadcast of a position still being played, and is also what empties it after a
  committed turn. A broadcast of any *other* phase empties it outright rather than
  filtering: a card id is the same string in every round of a match (the deck is rebuilt,
  not shuffled on), so a choice carried across a deal would come back chosen over whatever
  card inherited its id.
- **`flight`** — the move the position was reached by, when there is one worth watching
  happen, and null otherwise. The **one-shot**: `publish` clears it unless the publication
  being made is the one drawing that move, so a tap, a refusal or a reconnect never flies a
  card again. Decided in `show` — the one place holding the outgoing position and the
  arriving one at once — by asking `flight.ts`. See "Card flight" in `CONTEXT.md`.

**`busy` locks on emit, and settles two different ways.** Entering or leaving a room
settles on the **ack**: entry has been broadcast before it is acked, and a departing
connection is published to no longer. So do dealing the next round, dealing another match,
and editing the room's settings, which produce a position rather than moving within one —
and, in the settings case, none at all when refused, since a rejected edit is broadcast to
nobody. A **move settles on a strictly newer position** — a turn, the Yaniv call that
replaces one, or a slapdown, all sent through the same `play` helper, which keeps the CLI's
`Position { view, version }` / `actedOn` watermark in the session core. A slapdown is the
one of the three sent off turn, so what releases it may be the next player's move rather
than its own answer; both are strictly newer, and by either the window is spent. The server
acks an in-game action *before* it broadcasts the result, so controls released on the ack
would come back to life over a position still showing the mover's own turn. A rejected move
is the exception and releases at once: nothing was published, so no newer position is coming,
and the turn is still theirs. The ordering trap, plainly: the first snapshot carrying a view
after entering a room is one the player still cannot act from — tests wait on
`view !== null && !busy` rather than on the view alone.

**Positions are drawn on a clock, not on arrival.** A run of bot turns lands as one broadcast
per move within a few milliseconds of itself (see "Broadcasting" above), so a session that
published each on arrival would show only the last. `pacing.ts` queues them instead: **the
first arrival goes straight through, and anything landing in the beat behind it is let go one
per `PACE_MS` (700ms)** — a move of the player's own is a lone arrival and so never delayed,
which is why the rule is "first one free" rather than "one every beat". The queue is
phase-blind, and a round a bot's Yaniv ends is *why*: the scored position is the last link of
the chain. The accepted cost is set out in full in `pacing.ts`. Two things fall out of it.
**The watermark counts arrivals, not drawings** — a queued position carries the `version` it
*landed* on, or one already in flight when a move went out could pass for an answer to it.
And **a room that has gone takes its queue with it**: `roomClosed` and a successful
`exitToMenu` both `reset` the pacer, or the next beat would draw a table the player has left
back over the main menu.

**A tap the rules do not permit sends nothing and says nothing.** `turnFrom` answers with
`null`, `commitTurn` returns, and no error is published — the screen should not have offered a
target that lands there, and a player who found a dead one has asked for nothing and been
refused nothing. `callYaniv` is the same shape via `isLegalCall`. **What is legal about the
cards** is the whole of what the client applies ahead of the server (ADR-0002, and "The turn
is two taps" above); everything else the server owns is offered, sent, and refused by it.

**Leaving is the one action answered by the ack alone.** Everything else is confirmed by the
broadcast behind it, but the server stops publishing to a connection that has left, so
`exitToMenu` clears the view itself. Which of the two outcomes it got — a freed seat or a
closed room — it is never told and does not need to be; either way it is out.

**A rejection that lands after the room has gone is swallowed, not shown.** Two players
leaving at once is the case: the host's exit closes the room and drops everyone's session, so
a guest's in-flight action acks `PLAYER_NOT_FOUND` about a room that no longer exists. They
are already on the menu being told why, and a red error blaming them on top is what "a
refused action costs the player nothing" rules out — so an error is dropped whenever `view`
is already null. **An `errorMessage` shows and is dropped exactly where a rejected ack is**,
being the same news to a player, **but does not touch `busy`**: it is nobody's answer, and
letting go on news that answers nothing in flight would put a second copy of that action on
the wire. Nothing in the server sends one today; the handler exists because the contract does.

**`playerJoined`/`playerLeft` are deliberately unhandled.** The roster arrives right behind
each of them as a fresh view, and a screen that re-renders in place shows a seat filling or
emptying by itself. The CLI needs those nudges only because its frames scroll apart.

**The client never enforces a rule the server owns.** Showing the start control — and the
close-room control, on every screen a room has — to the host alone is a courtesy so a guest
is not hunting for a button that was never theirs; the rule is `NOT_HOST`, and the server says it. Refusing an empty name locally is the
one exception, and only because the server enforces the same rule — it is the client
declining to offer a move it knows will be refused, not a rule of its own.

### Claiming a seat back

The session holds its seat's `ResumeRequest` in two places, and the split is the whole
design: **in memory**, which survives a dropped socket, and in an injected **`TokenStore`**,
which survives the page. `createSession` takes the store the way it takes its socket — the
client reaches for no global below `main.tsx` — and defaults to one that keeps nothing, so a
session given none still resumes across a live reconnect and simply starts over on a reload.
The real one is `seatStore` (`tokens.ts`), one `localStorage` key holding one seat, and
`main.tsx` is the only place it is built: a reload therefore lands back at the table, and a
page that cannot write anything down behaves exactly as the client did before it existed.

The credential is written down at the two ways in and nowhere else, since the ack of a
seating event is the only place a token is ever sent; `joinRoom`'s names the seat but not
the room, so the room is completed from what was sent — upper-cased as the server matched
it, not as it was typed. It is forgotten in exactly four cases: the player's own
`exitToMenu`, the host's own `closeRoom`, an incoming `roomClosed`, and a claim the server
refuses — four ways of learning there is no seat there any more. **A dropped connection is
pointedly not one of them** — that is what it is kept for.

A claim goes out on session creation (a stored seat, i.e. a cold boot) and on every
reconnect, and **nothing is emitted into a socket that is down**: socket.io would buffer it,
the `connect` handler sends one anyway, and the second is answered `ALREADY_IN_ROOM` — a
refusal indistinguishable from a seat that has gone. So `claimSeat` publishes `resuming` and
emits only if `socket.connected`, and `connect` does the sending for a claim made before
there was a socket to make it on; `resuming` and `connected` go up in one publish, or a
screen would read the moment between them as the main menu.

A refused claim clears the credential, empties the pacer and lands on `view: null` with one
`notice` — the same sentence a room that has gone gets, since which of the two it was is a
distinction the server deliberately does not draw. A successful one publishes the acked view
directly rather than through the pacer, and with nothing in flight: it answers this call and
nobody else's, has no chain behind it to spread out, and is a table sat back down at rather
than a move anybody watched.

### A session that loses its socket

**`connected` is asked about before the view is.** A dropped socket makes every control on
every screen a lie, whatever the last position drawn still shows, so `App` renders
`Disconnected.tsx` above everything — the second screen that is not a function of
`view.phase`. It starts `true`, before the socket has finished connecting: socket.io buffers
what is emitted before then, and a page that announced a lost connection for the first
moment of every load would be crying wolf.

**A drop leaves the player on the disconnected screen, and the connection coming back sits
them straight back down.** `disconnect` resets the pacer, drops the watermark and releases
`busy` — nothing is in flight over a socket that is not there, a claim included — but leaves
the view alone, since that screen is over it anyway and is very likely the position still
there when the socket returns. The *reconnect* claims the seat rather than clearing anything:
`connect` sends `resumeSeat` with the credential the session holds, and the position comes
back in the ack. The main menu is now the fallback, for a returning connection with no seat
to claim — a real if narrow case, since the server broadcasts the lobby *before* it acks the
join that names the seat, so a drop in between leaves a view on the screen and nothing to ask
for it back with. A drop at the menu costs nothing and says nothing.

**A connection that never arrived is the same screen.** `connect_error` is treated the way
`disconnect` is, because the two are indistinguishable to whoever is looking at them: taps
buffered into a socket that has reached nothing is the same dead screen. Only the first of a
run of failed retries is news.

**Nothing argues about the tab closing.** A `beforeunload` warning guarded a live round
until issue #66 and went with it: a reload cost the player their place in a hand and now
costs a round trip, and a page carrying that listener is held out of the back/forward cache
— which is how a backgrounded tab comes back without reloading at all. The accepted cost is
that a player who cannot be resumed (storage off, or full) loses their place in silence.

### Tooling

TypeScript runs **directly on Node 24 via native type stripping** — no build step, no
`tsx`/`ts-node`. Test runner is `node:test`; typechecking is `tsc --build` (composite
project references, `shared` → `server`). This constrains the codebase to *erasable*
TypeScript: no `enum`, no `namespace`, no parameter properties, `import type` for
type-only imports. `tsconfig.base.json` enforces this via `erasableSyntaxOnly`.

All three workspaces have a `test` script, run by the root `npm test` via
`--workspaces --if-present`. Each uses an explicit glob (`node --test "test/**/*.test.ts"`)
rather than bare `node --test`, which also picks up `test/helpers.ts` and the `.d.ts` files
`tsc --build` emits into `dist/test/` — making test counts depend on a typecheck having run.

**`shared`'s tests are a separate tsconfig project** (`shared/tsconfig.test.json`),
unlike the server's, which includes `test/` in the one project. The suites need
`node:test`, and `types` is per-project, so folding them in would grant `shared/src` the
Node types too — and dependency-freedom would hold only by everyone remembering it.
Split, `shared/src` importing a Node builtin is a typecheck error.

## Explicitly out of scope (for now)

Not oversights — deferred on purpose, in this order of likely next work:

- **What a mid-round seat does while its player is gone.** Reconnect is built and whole, so a
  reload costs a round trip. Nothing pauses, times out, bot-plays or frees a seat whose player
  never comes back: the table waits on them as on a slow player, and `Player` has no `connected`
  field for a screen to say so with. The next thing to decide here.
- **Starting a match with seats still open for latecomers.** `startGame` seats bots on the
  spot, so anyone who has not joined by then is playing the next match, not this one.
- **Editing the settings from the terminal harness.** The browser lobby edits all four
  (docs/adr/0006) and the CLI has none, so a room created from `play` plays the defaults.
- **Persistence, and sweeping abandoned rooms.** Rooms are in-memory only, so a redeploy drops
  every match in progress — same as a restart, and the reason splitting client and server into
  two services (giving up same-origin, ADR-0003) would be the fix if that cost ever mattered. A
  room nobody resumes and no host closes leaks until then: no idle sweep.
- **Slapdown against a bot.** Both clients offer it, but bots neither slap down for themselves
  nor can be raced by a human, `playBotTurns` running in the same tick (ADR-0005).
- **Disambiguating a joker that extends a run.** Tap order decides where it sits — a wart (§4).

## Running things

```sh
npm test                                  # all workspaces, node:test
npm run typecheck                         # tsc --build across the monorepo
npm run serve --workspace=@yaniv/server   # the socket server (PORT, default 3000)
```

Every command and flag is tabulated in `README.md`. One thing to know before reading it:
the browser client (`npm run dev`) and the CLI harness (`npm run play`) are each real
clients of a **separately running server**, so both take a second terminal running
`npm run serve`. Deployment is one Railway service serving both halves (`docs/adr/0003`).

## Agent skills

- **Issue tracker** — GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
