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
npm run build      # builds the client; the server serves it (see Deploying below)
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

Enter a name, create a room or join one by its code, and the host starts the match. The
host is whoever made the room — or, if they leave before the deal, whoever has been waiting
longest.

The lobby is where the room is set up, and the host is the only one who can (`docs/adr/0006`):
how many cards are dealt (5, 6 or 7), what a hand has to be worth to call Yaniv (3, 5, 7 or
11), the score that ends the match, and how many bots fill the empty seats. Everyone else
sees the same four values, plainly read-only. A fresh room asks for **no bots at all**, so a
host alone at the table is turned away with `NOT_ENOUGH_PLAYERS` until they either raise the
bot count or somebody joins. The moment the match starts the settings lock for the life of
the room — `Play again` deals another match with the same ones — and move behind the small
icon in the top corner of every in-match screen, which opens them read-only for everybody.

Everyone else sits round the table, their hand fanned face down at their seat — one card
per card they are actually holding, so a hand shrinking is something you watch rather than
a number you notice — with their name, count and score on a label beside it, and that label
ringed in yellow while it is their turn. The deck and the discard sit between them and you,
the deck above the discard, a fixed step above your own hand at the bottom of the screen.

A turn is two taps and no button: tap cards in your hand
to choose them (chosen cards are outlined in yellow, tapped again to unchoose), then tap
either the deck or one of the two end cards of the face-up discard. That second tap is the
move — the chosen cards are discarded and the tapped card drawn, in one action. The deck
and the face-up cards do nothing until what you have chosen is a legal discard, so a move
the rules refuse is never offered in the first place. Your own move lands immediately; the
opponents' then play out one at a time — each bot thinks for a second and a half before it
moves — so you see what each of them discarded rather than the table jumping back to you.

Once in a while the discard pile starts flashing on somebody else's turn: you discarded a
same-rank set (or a lone card) and drew that same rank off the deck, so the card can go
straight back down (`docs/rules.md` §9). One tap on the pile sheds it, and the window shuts the moment the
next player moves — so against a bot it is open for as long as that bot takes to think,
which is a second and a half, and against a person for as long as they do.

The **Yaniv** button above your hand is the exception — the one control that is not a card.
It lights up the moment your hand is worth the room's threshold (7 unless the host changed
it) or less, and is dead until then, and pressing
it ends the round. The table you are looking at does not change: everybody stays in the seat
they were playing from and their hand simply turns face up in it, spread out to be read,
with their new total and what the round added on their own label. Who called and whether
they were Assafed is said on the same line that was telling you whose turn it was, and the
Yaniv button becomes "deal the next round" in the same place — for anybody still in the
match, since nobody is host once the cards are out (`docs/adr/0012`).

Reloading the tab, or backgrounding it and coming back, costs you nothing: the server holds
your seat through a dropped connection, and the page claims it back with a credential it
keeps in `localStorage` — a spinner while it asks, and then the same lobby, hand or
scoreboard you left. If the connection goes, the screen says so rather than leaving you
tapping at a dead table, and sits you back down when it returns. Only if the room itself has
gone are you sent to the main menu, and told why — which happens a minute after the last
person in it drops, the table being kept that long for exactly this reason (`docs/adr/0015`).

While you are away, everybody else's table says so: each seat carries one word about the
player behind it — **away** while their connection is gone, **watching** once the match has
gone on without them, **left** when they have given the seat up. A bot says nothing there,
which is how you tell one. Nothing is done about it: their seat keeps its place and their
turn still waits for them.

Everybody has the same way out — "leave the room", from **any** point in a match, whether you
are still playing or only watching — which frees their own seat and leaves the table playing
for whoever remains. Leave mid-round and the round carries on without you: the cards you were
holding go to the bottom of the discard pile, the turn moves along if it was yours, and you are
scored for nothing that round. It is final, so the table asks first, and if it leaves one
player they have won the match there and then. Nobody holds a control that ends anybody
else's match: the host owns the lobby and retires at the first deal, and a room ends when its
last seat leaves (`docs/adr/0012`).

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

The host — the first player, or the next seat along if they leave first — types `start`
once everyone has joined. A fresh room's bot count
defaults to zero (`docs/adr/0006`) and this harness has no control that changes it — only
the browser lobby does — so a host alone here is turned away with `NOT_ENOUGH_PLAYERS`.
Everyone plays through to a winner. At the prompt:

| Input | Meaning |
|---|---|
| `start` | (host only) begin the match once everyone has arrived |
| `menu` | leave the room for the main menu — from any phase, mid-round included |
| `1` or `2 3 4` | discard those cards by hand position, drawing from the deck |
| `1 3 t2` | the same, but take face-up card 2 off the table instead |
| `yaniv` | call Yaniv |
| `slap` | slap down the card you just drew, while the frame says a window is open |
| enter | deal the next round, once one has ended (any player still in the match) |
| `again` | (at a finished match) deal a fresh match to the same table |
| `q` or Ctrl-D | quit |

A finished match stops at the standings rather than ending the session. `again` starts
another one immediately for everyone still seated — scores back to zero, hands dealt, no
stop at a lobby — and anyone still in the room may type it (`docs/adr/0012`), with
`NOT_ENOUGH_PLAYERS` back if too few people are left to play. A seat given up stays given
up: nobody is replaced by a bot, and departed players show as `(left)` in the standings so
the final scores still add up.

`slap` is the one input offered when the turn is not yours: discard a same-rank set or a
lone card, draw its rank off the deck, and the frame says a slapdown is open until the next
player moves (`docs/rules.md` §9). Against a bot that is the second and a half it takes to think, and
against a person however long they take, so it is winnable either way — type it quickly.

Leaving with `menu` is not quitting: the connection stays up and you land back at the main
menu, free to create or join another room. It works the same way from the lobby and from a
finished match, and it means the same thing whoever types it — your seat is freed and the
others carry on without you. Leaving a lobby you made hands it to the next seat, so the
room is not stranded. Mid-match there is still no graceful exit; `q` or Ctrl-D just drops
the connection, which leaves the room standing with your seat held open for a minute — the
harness cannot resume it, and after that the room is swept if nobody else is there.

Illegal moves come back with the engine's real error codes (`INVALID_SET`,
`YANIV_THRESHOLD_NOT_MET`, ...) and cost you nothing — the turn is still yours. Every bot
move arrives as its own update and a beat apart, so a chain of five bot turns prints as
five positions rather than one jump. Requires `-- --name <name>`; also accepts `--url <url>`,
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

## Deploying

One Railway service serves both halves (`docs/adr/0003`): `npm run build` builds the client,
and the server's `index.ts` serves `client/dist` as static files (SPA fallback to
`index.html`) alongside Socket.io on the same port. `railway.json` at the repo root pins the
start command to `npm run serve --workspace=@yaniv/server`; Nixpacks runs `npm run build`
automatically as part of the build phase.

## Not yet built

Persistence (rooms are in-memory, so a restart or redeploy drops games in progress), and any
policy for a seat whose player never comes back. A match plays end to end in the browser now:
create or join, set the room up, deal, take turns, watch a run of bot turns a move at a time,
call Yaniv, and finish on the standings with another match one tap away. Reconnect is whole — a
drop leaves the room and the seat alone, and the page presents the seat's token and picks up
where it left off, whether the socket came back or the whole tab did. What is missing is what
a table does about a player who is simply gone: their seat is marked **away** for everyone
else and nothing else happens — nothing pauses, nothing times out, nobody takes their turn.
The room itself no longer outlives them, at least: one nobody is connected to is dropped a
minute later (`docs/adr/0015`).
