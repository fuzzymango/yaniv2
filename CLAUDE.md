# yaniv2

Multiplayer [Yaniv](https://en.wikipedia.org/wiki/Yaniv_(card_game)), built top-down:
engine first, fully unit tested, no transport layer yet. TypeScript, npm workspaces, zero
runtime dependencies.

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
  src/      The engine: deck, rules, pure state transitions, serialization, rooms.
  scripts/  play.ts (CLI harness) and bot.ts (a simple opponent). Not shipped.
  test/     node:test suites, one file per src/ module plus integration.test.ts.
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

### `server/scripts/`

Not part of the shipped engine — a smoke-test harness and a demo opponent.

- **`play.ts`** — `npm run play` (interactive, you vs. bots) or `npm run demo`
  (bots-only transcript). Both accept `--seed <n>` and `--players <n>`. Drives
  `RoomManager` and the pure transitions exactly the way a Socket.io layer eventually
  will, so it doubles as a sanity check on that seam.
- **`bot.ts`** — a deliberately simple opponent. Decides only from a `PlayerGameView`
  (the same payload a real client gets), so it is structurally unable to see hidden
  hands or the draw pile. See "Bot architecture" below.

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

### Bot architecture: "may I" vs "should I"

Split deliberately across two layers:

- **`server/src/rules.ts`** owns what's *legal* — `legalDiscards` (every valid discard
  from a hand) and `canCallYaniv` (is the hand low enough). These are rules queries, not
  bot logic, and are also usable by a future client to highlight playable cards.
- **`server/scripts/bot.ts`** owns *judgement* — `shouldCallYaniv`, `chooseDiscard`,
  `chooseDraw`, composed by `decideTurn`. It takes a `PlayerGameView`, never raw
  `GameState`, so it cannot cheat by construction.

The bot is intentionally weak: it calls Yaniv the instant it's legal (no regard for
opponents' hand sizes), and picks up an exposed card only by face value in isolation (no
synergy with its own hand). This is a known, accepted limitation, not a bug — improving
it is future work, not a defect to fix incidentally.

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
the goal of keeping a future Socket.io layer thin. (The original sketch used `socket.id`
directly; that would make reconnect support a retrofit touching every fixture.)

### Room lifecycle

Lobby → host calls `startGame` (requires ≥2 players) → `playing` → `roundEnd` after a
Yaniv call → host calls `startNextRound`, or `gameEnd` once someone busts past 100.
2–6 players. `RoomManager` is an **in-memory `Map`** — a server restart drops every game
in progress. This is a documented, accepted limitation, not an oversight; persistence is
explicitly out of scope for now (see below).

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

- **Socket.io transport.** Nothing wired up yet. `scripts/play.ts` exists specifically
  to exercise the engine through the same seam (`RoomManager` + pure transitions) a
  socket layer will use.
- **Disconnect/reconnect handling.** `Player` has no `connected` field at all —
  deliberately absent rather than half-built. When this lands, expect a lobby-phase
  case (easy: drop the player, promote host if needed) and a mid-round case (harder:
  currently undecided — pausing on their turn vs. a timer vs. removal are all live
  options).
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
npm run play --workspace=@yaniv/server    # play interactively against bots
npm run demo --workspace=@yaniv/server    # watch bots play a full match
```

Both `play` and `demo` accept `-- --seed <n> --players <n>`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
