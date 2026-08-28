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
React: a framework-free session core, plus components foldered by screen). Every workspace has
a `test/` of `node:test` suites beside its `src/`: one file per module, plus the server's
`integration.test.ts` fuzzer, and the socket-driven suites on both sides.

### `shared/src/`

| File | Contents |
|---|---|
| `cards.ts` | `Card`/`Suit`/`Rank`, rank ordering, `rankToValue` (the scoring table, `docs/rules.md` §1), and `sortHand`/`compareCards` (display order only — see below) |
| `views.ts` | `PlayerGameView` and friends — what a client actually receives, the round's `moveHistory` and each seat's `MatchStanding` (out, departed, **connected**) included. `seating` (the roster's order, every seat) and `turnOrder` (only the players still in the match) are two lists since #144, because elimination made them two questions. `SelfView` is a tagged union (`spectating`): the playing variant holds the hand and `slapdownEligible`, the spectating one has neither field at all. `OpponentView` carries `spectating` too, since which seats are bots is deliberately not on the wire |
| `errors.ts` | `GameErrorCode` union |
| `events.ts` | `ClientToServerEvents` / `ServerToClientEvents` — the socket contract |
| `rules.ts` | `isValidSet`, `canonicalizeSet`, `legalDiscards`, `canCallYaniv`, `pickupCandidates`, `opensSlapdown`, `handValue` — the rulebook, used by the engine, the bot and the client |
| `config.ts` | Every rule constant (`HAND_SIZE`, `YANIV_THRESHOLD`, `ASSAF_PENALTY`, `MAX_SCORE`, `MILESTONE_INTERVAL`, `MILESTONE_REDUCTION`, `MIN_RUN_LENGTH`, `MIN_RUN_REAL_CARDS`, `MIN_PLAYERS`, `MAX_PLAYERS`), each pointing at a `docs/rules.md` section. `HAND_SIZE`/`YANIV_THRESHOLD`/`MAX_SCORE` now survive only as `RoomSettings`' default seed values (`docs/adr/0006`); `MILESTONE_INTERVAL`/`MILESTONE_REDUCTION` are not settings-backed at all — always on, `docs/adr/0009` |
| `settings.ts` | `RoomSettings` (`handSize`, `yanivThreshold`, `maxScore`, `botCount`) — a room's own per-match configuration; `botSeatLimit`/`effectiveBotCount`, the seats left for bots and what `botCount` therefore means right now; `isValidSettings` and the option sets/limits it validates against (`HAND_SIZES`, `YANIV_THRESHOLDS`, `MAX_SCORE_LIMITS`, `BOT_COUNT_LIMITS`), which a lobby control renders from. `docs/adr/0006` |
| `standings.ts` | `standings` — a finished match's final table, ordered by how long each player lasted (the survivor, then out order descending, then score, then the roster), read off the append-only roster alone, so whoever has left since is still on it. Read by both clients |

Imported by the server and the client, so the wire contract can't drift between them. The
rulebook is here rather than in `server/src` for the same reason: a client must offer exactly
the moves the server will accept. `standings` is here on the same grounds — a match that is
over cannot finish two different ways depending on which client is looking. Every function is pure over values the wire already
carries, so this costs `shared` none of its dependency-freedom. See `docs/adr/0002`.

### `server/src/`

| File | Contents |
|---|---|
| `state.ts` | `GameState`, `RoundState`, `Player` (`outInRound`/`departed` included), `MoveHistoryEntry` — the domain model — plus `inMatch`/`playersInMatch`, the filter every count over a roster goes through, and `spectating`, the one derivation of watching-rather-than-playing — over a seat *and* whether anybody is connected to it, connection being the one thing here the model never stores (docs/adr/0013) |
| `config.ts` | The operational constants only — `BOT_NAMES` and `ROOM_CODE_*`. The rule constants live in `shared` |
| `rng.ts`, `clock.ts` | The two ambient capabilities, injected rather than reached for: `Rng` + `mulberry32` (a seeded PRNG), and `Clock` + `systemClock` (the one thing scheduling needs from outside, and what `roomTimers.ts` is built on) |
| `result.ts` | `Result<T>` — `{ok: true, value}` / `{ok: false, error}` |
| `deck.ts` | `createDeck`, `shuffle`, `deal` — pure functions, no class |
| `game.ts` | `updateSettings`, `startGame`, `takeTurn`, `callYaniv`, `slapDown`, `startNextRound`, `playAgain`, `removePlayer` — the pure state transitions |
| `serialize.ts` | `serializeStateForPlayer` — the security boundary, explained below |
| `roomManager.ts` | `RoomManager` — owns live rooms, applies transitions, persists only on success |
| `bot.ts` | `decideTurn` and friends — a deliberately simple opponent. See "Bot architecture" below |
| `roomTimers.ts` | `createRoomTimers` — the work a room has waiting on the clock, keyed by purpose (`TimerPurpose`). Set replaces, cancel is explicit, and `cancelRoom` calls off everything one room holds. Deliberately dumb: it schedules and cancels, and never decides *whether* to |
| `botTurns.ts` | `playBotTurn` — takes the turn in front of a room when it belongs to a bot — and `createBotTurnRunner`, which waits out **bot think time** before each one and so walks a chain a move at a time. One pending run per room, as the registry's `botTurn` purpose |
| `autoDeal.ts` | `autoDealSeat` — whether a scored round deals itself on, and as which seat — and `createAutoDealer`, the pause it waits out first. The registry's `autoDeal` purpose. Only where a spectator is watching a table only bots are still playing (#148) |
| `socketServer.ts` | `createSocketServer` — wires the event contract onto an `io` instance. Never calls `listen` |
| `staticServer.ts` | `serveStatic` — serves the built client (`client/dist`) same-origin alongside Socket.io, per ADR-0003. Hand-rolled, no framework |
| `index.ts` | The entrypoint. Binds a port and composes the above. `npm run serve` |

`bot.ts` is shipped, not a dev tool: bot opponents are part of the real game, so the socket
layer calls `decideTurn` in production. It decides only from a `PlayerGameView` — the same
payload a real client gets — so it cannot see hidden hands or the draw pile.

### `server/scripts/`

Not part of the shipped engine — two smoke-test harnesses, split by what they exercise: `play.ts`
answers "do the rules and the bot behave?", `playSocket.ts` "does the wire work?".

- **`playSocket.ts`** — `npm run play`. A human against bots or other humans, over a **real
  socket** to a separately running server. Composition only, like `index.ts`: argv, stdio and a
  socket handed to `cli/`, where `render.ts` and `commands.ts` are pure and total and
  `session.ts` drives the loop with its io injected. It **imports nothing from `src/` except
  types** — reaching for `RoomManager` makes it a second server, not a transport test.
- **`play.ts`** — `npm run demo`. Bots only, in process, no transport, `--seed`/`--players`: a
  whole match is reproducible from the seed alone, which makes it the tool for judging bot play.
  Keep it that way; there is deliberately no socket equivalent, the server owning the rng.

### `client/src/`

A third client of the same contract, alongside the two harnesses. It imports `@yaniv/shared`
and nothing from `server/src`.

**One exported component per file, in a folder named after the screen or feature it serves.**
The folders are broad and flat inside — `main-menu/`, `lobby/`, `table/`, `game-end/`,
`connection/`, `settings/` (cross-cutting: the lobby's listing and every in-match screen's
modal) and `shared/` (chrome no one screen owns). The entrypoints (`main.tsx`, `App.tsx`), the
pure logic modules and `styles.css` stay flat at the root: they are not a screen's. **No barrel
`index.ts`** anywhere — every import names the file it pulls from.

Two exemptions, and only these. **Private, single-use render helpers stay inline** with the one
component that uses them (`table/MoveHistory.tsx`'s `FaceDown`/`TurnEntry`/`SlapdownEntry`).
**Two or more exported components share a file only where splitting them would lose an
invariant, and the file's own header must say which**. There is one: `table/Seat.tsx`
(`CardFan` and `CascadeReveal` size from one `seatFootprint` call).

| File | Contents |
|---|---|
| `main.tsx` | The entrypoint. Opens the socket, hands over the seat store and mounts `App`, and nothing else — `server/src/index.ts`'s counterpart |
| `session.ts` | The session core: owns the socket and the seat's credential, exposes a `SessionSnapshot` and the intents. Framework-free, so `node:test` can drive it |
| `turn.ts` | What a tap means: `toggleSelection`, `retainSelection`, `isLegalSelection`, `isLegalCall`, `takeableIds`, `isSlapdownTarget`, `turnFrom`. Pure and total — `scripts/cli/commands.ts`'s counterpart |
| `flight.ts` | `flightFrom` — the position on the screen and the one arriving in, and either the move between them or nothing. Two facts watched, `lastMove` and `lastSlapdown`, and at most one changes per arrival; `CardFlight` is tagged by which (`TurnFlight`: mover, discarded cards, draw source, drawn card where the viewer may know it — `SlapdownFlight`: mover and the one card, never redacted). Pure and total, `turn.ts`'s counterpart on the way in |
| `ghosts.ts` | `ghostsFor` — a move and the boxes on the screen in, the cards actually in the air out (`Ghost`: what it answers to, the face to draw or none, from where, to where and into which place), dropping whatever the screen cannot place at both ends. Branches on the flight's tag — a slapdown is one card out of a hand or a seat onto the pile and nothing back, in the same box vocabulary. `DECK_BOX` and `seatBox` are the boxes that are not cards' — the deck a drawn card starts from, and the seat somebody else's hand is one place at, both ends the client is never told a card id for |
| `flip.ts` | `invert` and `transformOf` — where a card has landed and where it came from, as the transform that puts it back. The arithmetic of the flight, and all of it: measured boxes in, one CSS transform out. Pure and total |
| `seating.ts` | `bySeat` — the absolute `view.seating` comparator, used by the lobby's roster listing — and `byRelativeSeat`, the same ordering rebased on the viewer's own seat (whoever sits one place along sorts first), used by the table so the zone sweep reads correctly from whoever is looking rather than only from whoever sits first. Both read the **roster** and never `turnOrder` (#144): turn order shrinks as players are eliminated, and a table sorted by it would slide everyone left one seat each time somebody went out. `seatZones` deals whichever ordered list it is given round the three sides of the felt (`ZONES`: `left`/`top`/`right`) in **contiguous runs**, `left` alone reversed, so the sweep reads in turn order at a doubled zone too (`right` never doubles, since 6 players is 5 opponents) — why, in `docs/client-table.md`. One placement for the table in both its phases: a scored round is seated by the same call off the same roster, so the two cannot disagree. Generic over the opponent, since seating is a fact about a list's order and nothing about what is in it |
| `fan.ts` | The geometry of a hand held at a seat, in two shapes. Arced during play: `fanAngles`, `ZONE_ROTATION` (hinge to the screen edge, open edge to the felt), `fanFootprint` (the box the arc needs, so no card tip lands on the label) and `fanOverhang` (how far it is pushed off its edge). Cascaded once it is revealed: `cascadeOffset`, `cascadeFootprint`, `ZONE_CASCADE` (down the sides, across the top) and the `CARD_INDEX_STRIP`/`CASCADE_STEP` pair that keeps a covered card readable. And `seatFootprint` over both — the one box a seat reserves whichever shape is in it, so a round being scored never resizes a seat. Distances in card widths, so the CSS scales it |
| `status.ts` | `seatStatus` — what one seat's status slot says about the player behind it, or nothing: `left` › `away` › `watching` by priority, and nothing for a bot or somebody playing, which is what makes an empty slot unambiguous (#146). `STATUS_LABEL` is the word for each, said once. Pure and total |
| `score.ts` | What a scored round says: `scoreLabel` (the round as one checkable equation — where the player started, what it was net worth once any milestone reduction is folded in, and the total it left them on; every seat's label and the viewer's own footer, so one round cannot read two ways) and `roundOutcome` (the call and the verdict as one sentence, addressed to the viewer, named off the round's own record). Pure and total |
| `settings.ts` | What only a settings *form* knows: `wholeNumber` (a field part-way through being typed) and `sameSettings` (has the room caught up?). Pure and total, `turn.ts`'s counterpart — what a room may be set to is asked of `shared` |
| `tokens.ts` | `seatStore` — the seat written down where a reload will find it, and the only file here that knows the word `localStorage`. Injected storage, so it is driven under `node:test` with no browser; storage that is off, full or holding junk is answered with "no seat" rather than an error |
| `useSession.ts` | `useSyncExternalStore` over the above, and deliberately nothing else |
| `timing.ts` | How long the moving parts of a move last, as one chain: `FLIGHT_MS` → `SLAP_MS` → `SHAKE_MS`, each a fraction of the one above it, so the table is retuned from one number and cannot end up half fast and half slow. Nothing above the chain: what a flight has to finish inside is the server's bot think time. Plain arithmetic, so a test with no DOM asserts the derivations |
| `App.tsx` | Which screen: no connection comes first, then a seat being claimed back, then no view is the main menu, then everything else is a function of `view.phase` — with `playing` and `roundEnd` the one branch, and `gameEnd` the one branch rendering two things: `Table` with `GameEnd` drawn over it |
| `main-menu/MainMenu.tsx` | Name, create, join by code — the one screen with no view behind it |
| `lobby/Lobby.tsx` | `phase: 'lobby'` — the code, who is seated (each row carrying the same status slot the felt's seats do, where only "away" can come up), the room's settings (editable by the host, read-only to everyone else), start (host only), and the way out. The one screen with a host on it: `view.hostId` is null from the first deal (docs/adr/0012), and a host who leaves hands the marker to the next seat |
| `lobby/SettingsEditor.tsx` | The host's four controls, in the lobby and nowhere else. Offers exactly what `isValidSettings` accepts, and sends the whole object per change |
| `table/Table.tsx` | `phase: 'playing'`, **`'roundEnd'` and `'gameEnd'`** — the hand, the deck, the discard, the opponents seated round the felt, a turn as two taps, the Yaniv call, and the discard as one flashing slapdown target while a window is open. `SelfView` is narrowed once at the top: a viewer the match has gone on without gets a bar where their hand was, saying so and carrying no control at all (issue #143). Once the round is scored, the same table with three slots saying something else: every hand face up in its own seat, the line above the felt saying how the round ended, the call become the deal, the history drawer gone, and an `OUT` tag on any seat the round took out of the match. Once the *match* is over it is that same scored table with its controls given up — no topbar and no bottom slot — for `GameEnd` to float over |
| `table/LeaveTable.tsx` | The way out of a match still being played (#147), in the corner beside the settings and offered to everybody looking at the table — a watcher's bar carried the only copy until this. The one control in this client that **asks before it acts**: every other exit costs the player nothing, and this one costs them the match |
| `table/Seat.tsx` | A player in their zone: `SeatZone` (a side of the felt), `Seat` (cards, and an upright label that never turns with them), and the two shapes a hand takes there — `CardFan` (the arc of backs, one per card held, carrying the seat's own `data-flight-box` — the one box in this client drawn to be measured rather than looked at) and `CascadeReveal` (the same hand face up and read, in the seat's own reserved box). Both take that box from `seatFootprint`, so swapping one for the other moves nothing around them. `Seat`'s label also carries the one **status slot** (`seatStatus`, #146), where a seat says whether its player has left, is away or is watching. `OpponentSeat` composes the first three for live play; `Table.tsx` composes the scored seat. Presentational throughout |
| `table/CardsInFlight.tsx` | The move being watched: `useCardFlight` (measure every card on the screen, and the deck and the seats with them, after each render, and answer an arriving `CardFlight` with the ghosts `ghosts.ts` chooses and the places to leave empty for them), and the `CardsInFlight` overlay they fly across. Also *how* it flies, which is the one thing here that is not a measurement: a turn crosses in `FLIGHT_MS` and decelerates, a slapdown crosses in `SLAP_MS` on a sharper curve, pops on landing and jolts the table (`.table--jolt`, worn for `SHAKE_MS`). The one file here that touches a rendered element, and the only one outside `useSession.ts` with a hook in it |
| `table/MoveHistory.tsx` | `phase: 'playing'` only — the round's moves behind an arrow on the left edge of the felt, newest first, in mini cards. A pass-through of `view.moveHistory`: the redaction arrived applied, so a null drawn card is drawn face down rather than filled in. Open or closed is `useState`, so every fresh mount starts closed |
| `table/Room.tsx` | The fallback for a `roundEnd` with no result behind it — a position the wire type allows and the server does not produce |
| `game-end/GameEnd.tsx` | `phase: 'gameEnd'` — a panel over the table the match ended on, not a screen of its own (issue #130): the final standings in out order as a name/score grid, who won, play again — offered to everybody, since anyone still in the room may deal one (docs/adr/0012) — beside the same way out the lobby offers, and its own settings icon above it. No scrim — the hands revealed behind it are half of what there is to look at |
| `connection/Resuming.tsx` | A seat being claimed back — the third screen with no view behind it, drawn where the main menu otherwise would be so a reload never flashes it |
| `connection/Disconnected.tsx` | No socket — the screen above every other. One screen for a connection that went and one that never arrived, since neither leaves anything to tap |
| `settings/SettingsDialog.tsx` | The settings icon every in-match screen carries, and the modal behind it. The only place a setting is shown once the match is running, and now the only thing in the bar it sits in |
| `settings/SettingsValues.tsx` | The four values as text — the lobby for everyone but the host, and the in-match modal for everyone |
| `settings/SettingsPanel.tsx` | The box both lobby listings sit in — the host's controls and everyone else's read-only copy are the same thing in the same place — and `SETTINGS_TITLE`, the one string the box's heading and the in-match modal's are both taken from |
| `shared/Modal.tsx` | The panel a question is asked behind — the settings today, and shared for the half nobody can see: announced as a dialog, and dismissed by backdrop, control and Escape |
| `shared/WayOut.tsx` | How a player gets out of a room, which is one button reading the same thing for everybody: leave. Nothing here ends anybody else's match (docs/adr/0012), so nothing here asks before it acts — the lobby and `gameEnd`, where nothing is being played. The table's own is `table/LeaveTable.tsx`, and it asks |
| `shared/PlayingCard.tsx` | One card, drawn in CSS, and named in the markup (`data-card-id`, which is how `CardsInFlight.tsx` finds a card to measure). Presentational only — it does not know what a card means where it sits. `mini` is its one variant, and is two things at once: icon-sized, and nameless — a picture of a card cannot answer for the card it copies when the flight layer measures |
| `styles.css` | Mobile-first. Cards are drawn in CSS — no image assets |

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
out, which is what makes "out, and gone" representable. In the lobby it still splices.

Membership in `players` therefore no longer means membership in the match, and every seat count
and map over it asks `inMatch` (`state.ts`): `dealRound`, `randomOpener`, the minimum to start,
`seatBots`, `playAgain`, the serializer's `turnOrder`. A missed one is a live bug, not a type
error — the riskiest part of the change, and not the rule.

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

### Hand display order is presentation only

`sortHand`/`compareCards` in `shared/src/cards.ts` sort a hand for display: ascending by value,
ties broken by rank then suit then card id — the last because two jokers otherwise compare
fully equal and would visibly swap places between renders. **This has zero effect on engine
state**: hands in `RoundState` stay in whatever order the engine produces them, and sorting is
applied only at `serializeStateForPlayer`, the one place every client passes through.

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
turn it has to play, and so `autoDeal.ts` knows a table has only bots left in the match.

The integration fuzzer has its **own** discard/draw logic and deliberately does not import from
`bot.ts`, which would let a smarter bot silently narrow what it covers. It shares
`legalDiscards` alone — a rules query, not a policy.

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
spectating variant has no `hand` and no `slapdownEligible` at all, on `OpponentView`'s
principle: being knocked out must not make a player an oracle for a friend still playing.
Mutation-tested too.

**Who is connected is an argument, not a field** (docs/adr/0013). `serializeStateForPlayer`
takes the set of player ids with a live socket, which `broadcastState` reads off the room's
sockets once per publication; the viewer and every bot are connected by construction. Required
rather than defaulted, so a call site that publishes cannot forget — the two with no transport
under them (a bot deciding, `scripts/play.ts`) pass `NO_CONNECTIONS` and say so. `GameState`
stays transport-free, and no stored flag can go stale behind a drop.

**The last move is sent with its drawn card redacted.** `RoundState.lastMove` records the mover,
the pile they drew from and the card itself; the serializer sends that card to everyone off the
face-up discard and to the mover alone off the deck (docs/adr/0007). **`lastSlapdown` is its
unredacted sibling** — the card is face up by then, and the seat no client could infer
(docs/adr/0008). And **`moveHistory` is the log neither is**, redacted per entry (docs/adr/0010).

**A finished round names its own players.** `PlayerRoundResult` carries a `name` copied in when
the round is scored, and the serializer uses that rather than looking the id up in `players`
(issue #78): the record says *what* to draw at a seat, never which seat.

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
by whoever sent it and the guard living in `shared` on the rulebook's own grounds (ADR-0002).
The first deal locks the lot; `playAgain` never returns to the lobby.

**A disconnect costs the room nothing, and is told to it anyway.** The `disconnect` handler
**mutates nothing** — the seat, the player and the room are left as they were — and republishes
the room, the only way whoever is left learns a seat has gone quiet (docs/adr/0013). Whoever
dropped comes back through **`resumeSeat({ roomCode, playerId, resumeToken })`**: session
rebound, room rejoined, the position answered in the ack and the room published to behind it — a
seat sat back down at is news to everyone looking at it. The token is the check for a seat still
somebody's, a player id appearing in every opponent's view; a wrong token, an unknown player and
a seat given up share `INVALID_RESUME_TOKEN`, or a room code would be a way of fishing for the
seats behind it. One live connection per seat: a resume disconnects whatever socket still held it.

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
last seat leaves (`abandoned` → `destroyRoom`, which also cancels its timers); one whose
players merely *dropped* is not swept yet.

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

`createSocketServer(httpServer, rooms, options?)` attaches handlers and returns the `io`
instance; it never calls `listen`, and `index.ts` does that and nothing else. The split exists
so tests can stand up a real server on an ephemeral port (`listen(0)`) without duplicating
handler logic — `socketServer.test.ts` drives real `socket.io-client` connections rather than a
stub, this layer's whole job *being* its wire behaviour, and observes server-side facts through
the socket rather than by asking `RoomManager`. `options` carries the clock every room timer is
set on and the bot think time, both defaulted, so production construction is unchanged.

### Broadcasting: one send per socket, one broadcast per move

`broadcastState(roomCode)` loops the room's sockets and emits `serializeStateForPlayer` per
connection — the same walk that yields the connected player-id set every view of that one
position is built with (docs/adr/0013), and the one place the room's auto-deal is reconsidered
(below). Never `io.to(room).emit(state)`: raw state holds every hand and the draw pile order,
and a wire-level test asserts no card id outside the viewer's own hand and the face-up discard
reaches a mid-round payload.

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
`botTurns.ts` waits out `BOT_THINK_MS` (1500ms) — every bot and every turn alike, a round
opening on a bot included — then decides from the position in front of it. Two things follow as
one fact: a table of bots reads as a game being played, and **a human can win the slapdown
window their own turn opened**, which a same-tick bot turn made unreachable (ADR-0005) — there
is no window timer, only the pause the next bot takes. **At most one pending run per room**,
which is the registry's doing rather than `botTurns.ts`'s: every per-room timer is set on
`roomTimers.ts`, so closing a room is `cancelRoom`, naming no behaviour. Asserted at the socket
seam alone.

### A table only bots are playing deals itself on

Only a player still in the match may deal the next round (docs/adr/0012), leaving a spectator
whose match went on without them watching a scored round no bot will ever advance. So the server
deals it, `AUTO_DEAL_MS` (10s) after `roundEnd`, on three conditions each of which is a rule —
that phase and not `gameEnd`, **every seat still in the match a bot**, and **somebody
`spectating`** it. Pure judgement (`autoDealSeat`) on the registry's `autoDeal` purpose,
**reconsidered on every publication**. Each of those, in `docs/adr/0014`.

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
where their hand was (#143), and an out seat keeps its place on the felt, darkened (#144).

Every decision behind the geometry, the flight, the bar and the dim is in **`docs/client-table.md`**
(#56, #58-#60, #78, #130, #143, #144); the code is `fan.ts`, `score.ts`, `seating.ts`, `table/`.

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
no use outside the screen holding it, and no arriving view can contradict either.

### The client's session core

The browser client's logic lives in `client/src/session.ts`, a plain module outside React that
owns the socket and exposes exactly two things: a `SessionSnapshot` to read and a set of intents
to call. `useSession` subscribes to it with `useSyncExternalStore` and holds no logic — **if
that hook ever grows a branch, the branch is in the wrong place.** The point is testability: the
session core is driven under `node:test` against a real socket server, with no browser, no jsdom
and no React test dependencies. Components are not tested at all, a consequence of that split
rather than a gap — behaviour worth testing belongs in the session core or in one of the pure
modules beside it (`turn.ts`, `seating.ts`, `fan.ts`, `flight.ts`, `ghosts.ts`, `flip.ts`,
`timing.ts`, `settings.ts`). `useCardFlight` is the one hook outside `useSession`.

Snapshots are **replaced wholesale, never mutated**: `useSyncExternalStore` compares by
identity, so a mutated object would leave React rendering a position that has moved on.

Seven fields, and each answers a different question:

- **`view`** — the position, or `null`. Null *is* the main menu: the one screen that is
  not a function of `view.phase`, because before a room exists there is nothing for the
  server to have sent — with `resuming` the one qualification, below. See `docs/adr/0004`.
- **`error`** — a `GameError`, i.e. something the player asked for and was refused, or one
  the server pushed as `errorMessage`. Cleared the moment they try again, because a refused
  action costs them nothing.
- **`notice`** — news about the room that is *not* a refusal: today only a seat that could
  not be claimed back. Separate from `error` because there is no action to blame and nothing
  to retry, and because it arrives while the player is sitting still.
- **`connected`** — whether there is a socket to play over (this session's own, not the
  wire's per-seat `connected`). See "A session that loses its socket" below.
- **`resuming`** — a seat is being claimed back and the answer has not landed. It always
  rides with `busy`, and says what `busy` cannot: that a null view is a table still being
  asked for rather than the main menu. See "Claiming a seat back" below.
- **`selection`** — the cards tapped for the next turn, by id, in tap order. It lives here
  rather than in a component because it has to survive views arriving underneath it:
  `retainSelection` on every broadcast of a position still being played drops whatever has left
  the hand, which is also what empties it after a committed turn. A broadcast of any *other*
  phase empties it outright rather than filtering — a card id is the same string in every round
  of a match, so a choice carried across a deal would come back chosen over its inheritor — as
  does a position this viewer is only **watching**, which has no hand to filter against and
  where `toggleCard` refuses a tap outright, so a watcher's selection is empty at every moment
  rather than only just after a position arrived (#149).
- **`flight`** — the move the position was reached by, when there is one worth watching
  happen, and null otherwise. The **one-shot**: `publish` clears it unless the publication
  being made is the one drawing that move, so a tap, a refusal or a reconnect never flies a
  card again. Decided in `show`, by asking `flight.ts`. See "Card flight" in `CONTEXT.md`.

**`busy` locks on emit, and settles two different ways.** Entering or leaving a room
settles on the **ack**: entry has been broadcast before it is acked, and a departing
connection is published to no longer. So do dealing the next round, dealing another match,
and editing the room's settings, which produce a position rather than moving within one —
and, in the settings case, none at all when refused, since a rejected edit is broadcast to
nobody. A **move settles on a strictly newer position** — a turn, the Yaniv call that replaces
one, or a slapdown, all sent through the same `play` helper, which keeps the CLI's
`Position { view, version }` / `actedOn` watermark in the session core. A slapdown is the one
of the three sent off turn, so what releases it may be the next player's move rather than its
own answer; both are strictly newer, and by either the window is spent. The server acks an
in-game action *before* it broadcasts the result, so controls released on the ack would come
back to life over a position still showing the mover's own turn. A rejected move is the
exception and releases at once: nothing was published, so no newer position is coming. The
ordering trap, plainly: the first snapshot carrying a view after entering a room is one the
player still cannot act from — tests wait on `view !== null && !busy`, not the view alone.

**A position is drawn the moment it arrives.** There is no queue between the socket and the
snapshot: the server spaces a run of bot turns out itself (above), so there is no burst left for
the client to smooth (issue #135). Bot think time is what a flight finishes inside.

**A tap the rules do not permit sends nothing and says nothing.** `turnFrom` answers with
`null`, `commitTurn` returns, and no error is published — the screen should not have offered a
target that lands there; `callYaniv` is the same shape via `isLegalCall`. **What is legal about
the cards** is all the client applies ahead of the server (ADR-0002); everything else it owns is
offered, sent, and refused by it.

**Leaving is the one action answered by the ack alone.** Everything else is confirmed by the
broadcast behind it, but the server stops publishing to a connection that has left, so
`exitToMenu` clears the view itself.

**A rejection that lands after the room has gone is swallowed, not shown** — a player's own exit
crossing an action still in flight acks `PLAYER_NOT_FOUND` about a room they have left, so an
error is dropped whenever `view` is already null. **An `errorMessage` shows and is dropped
exactly where a rejected ack is**, being the same news, **but does not touch `busy`**: it is
nobody's answer, and letting go would put a second copy of the action on the wire.

**`playerJoined`/`playerLeft` are deliberately unhandled.** The roster arrives right behind each
as a fresh view, and a screen that re-renders in place shows a seat filling or emptying by
itself. The CLI needs those nudges only because its frames scroll apart.

**The client never enforces a rule the server owns.** Showing the start control to the host
alone is a courtesy, so a guest is not hunting for a button that was never theirs; the rule is
`NOT_HOST` and the server says it. The deal is the same shape — drawn for a viewer still in the
match, enforced by `NOT_IN_MATCH`. Refusing an empty name is the one exception.

### Claiming a seat back

The session holds its seat's `ResumeRequest` in two places, and the split is the whole
design: **in memory**, which survives a dropped socket, and in an injected **`TokenStore`**,
which survives the page. `createSession` takes the store the way it takes its socket — no
global is reached for below `main.tsx` — and defaults to one that keeps nothing, so a session
given none still resumes across a live reconnect and starts over on a reload. The real one is
`seatStore` (`tokens.ts`), one `localStorage` key holding one seat, built in `main.tsx` alone.

The credential is written down at the two ways in and nowhere else, the ack of a seating
event being the only place a token is sent; `joinRoom`'s names the seat but not the room, so
the room is completed from what was sent — upper-cased as the server matched it. It is
forgotten in exactly two cases: the player's own `exitToMenu`, and a claim the server refuses.
**A dropped connection is pointedly not one of them.**

A claim goes out on session creation (a stored seat, i.e. a cold boot) and on every
reconnect, and **nothing is emitted into a socket that is down**: socket.io would buffer it,
the `connect` handler sends one anyway, and the second is answered `ALREADY_IN_ROOM` — a
refusal indistinguishable from a seat that has gone. So `claimSeat` publishes `resuming` and
emits only if `socket.connected`; `resuming` and `connected` go up in one publish, or a
screen would read the moment between them as the main menu.

A refused claim clears the credential and lands on `view: null` with one `notice` — the same
sentence a room that has gone gets, since which of the two it was is a distinction the server
deliberately does not draw. A successful one publishes the acked view with nothing in flight:
a table sat back down at rather than a move anybody watched.

### A session that loses its socket

**`connected` is asked about before the view is.** A dropped socket makes every control on
every screen a lie, whatever the last position drawn still shows, so `App` renders
`Disconnected.tsx` above everything — the second screen that is not a function of
`view.phase`. It starts `true`, before the socket has finished connecting: socket.io buffers
what is emitted before then, and a page that announced a lost connection for the first
moment of every load would be crying wolf.

**A drop leaves the player on the disconnected screen, and the connection coming back sits
them straight back down.** `disconnect` drops the watermark and releases `busy` — nothing is
in flight over a socket that is not there, a claim included — but leaves the view alone, that
screen being over it anyway and very likely the position still there on return. The *reconnect* claims the seat rather than clearing anything: `connect`
sends `resumeSeat` with the credential the session holds, and the position comes back in the
ack. The main menu is the fallback, for a returning connection with no seat to claim — a real
if narrow case, since the server broadcasts the lobby *before* it acks the join that names
the seat. A drop at the menu costs nothing and says nothing.

**A connection that never arrived is the same screen.** `connect_error` is treated the way
`disconnect` is, the two being indistinguishable to whoever is looking at them. Only the
first of a run of failed retries is news. **Nothing argues about the tab closing** either: a
`beforeunload` warning guarded a live round until issue #66 and went with it, a page carrying
that listener being held out of the back/forward cache — which is how a backgrounded tab
comes back without reloading at all.

### Tooling

TypeScript runs **directly on Node 24 via native type stripping** — no build step, no
`tsx`/`ts-node`. Test runner is `node:test`; typechecking is `tsc --build` (composite project
references, `shared` → `server`). This constrains the codebase to *erasable* TypeScript: no
`enum`, no `namespace`, no parameter properties, `import type` for type-only imports, enforced
by `erasableSyntaxOnly` in `tsconfig.base.json`.

Every workspace's `test` script names an explicit glob rather than running bare `node --test`,
which would also pick up `test/helpers.ts` and the `.d.ts` files `tsc --build` emits.

**`shared`'s tests are a separate tsconfig project** (`shared/tsconfig.test.json`), unlike the
server's: `types` is per-project, so folding them in would grant `shared/src` the Node types
its suites need. Split, `shared/src` importing a Node builtin is a typecheck error.

## Explicitly out of scope (for now)

Not oversights — deferred on purpose, in this order of likely next work:

- **What a mid-round seat does while its player is gone.** The rest of #138 (#143, #144 and
  #146-#149 are done): the status slot is display only, and nothing pauses, times out,
  bot-plays or frees a seat whose player never comes back.
- **Starting a match with seats still open for latecomers.** `startGame` seats bots on the
  spot, so anyone not joined by then plays the next match, not this one.
- **Editing the settings from the terminal harness.** The browser lobby edits all four
  (docs/adr/0006); the CLI has none, so a room made from `play` plays the defaults.
- **Persistence, and sweeping abandoned rooms.** Rooms are in-memory only, so a redeploy drops
  every match in progress — two services (giving up same-origin, ADR-0003) is the fix if that
  cost matters. A room is dropped when its last seat *leaves*; one whose players merely
  dropped lives on, #150.
- **Bots slapping down for themselves.** A human can now win one against a bot, inside the
  pause it takes before its turn, but no bot slaps down for itself — ADR-0005's other half.
- **Disambiguating a joker that extends a run.** Tap order decides where it sits — a wart (§4).

## Running things

```sh
npm test                                  # all workspaces, node:test
npm run typecheck                         # tsc --build across the monorepo
npm run serve --workspace=@yaniv/server   # the socket server (PORT, default 3000)
```

Every command and flag is tabulated in `README.md`. One thing to know before reading it: the
browser client (`npm run dev`) and the CLI harness (`npm run play`) are each real clients of a
**separately running server**, so both take a second terminal running `npm run serve`.
Deployment is one Railway service serving both halves (`docs/adr/0003`).

## Agent skills

- **Issue tracker** — GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
