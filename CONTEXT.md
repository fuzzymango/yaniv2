# Yaniv — Domain Context

Vocabulary for talking about the shape of the game's state, as distinct from the rules of
play (`docs/rules.md`). This file grows lazily — a term gets added when a design
conversation actually needs it, not up front.

## Lobby vs. active

A `GameState` is either **lobby** or **active**:

- **Lobby** — a room exists, players may join, no round has been dealt yet. There is no
  hand, no draw pile, no discard pile; there is nothing to serialize into a table view.
- **Active** — a round has been dealt. This spans three phases (`playing`, `roundEnd`,
  `gameEnd`) that all carry a live round — `roundEnd` and `gameEnd` still hold the just-
  finished round's hands and piles, revealed face up, until the host deals the next one
  or the match ends. "Active" names *this* — the round is populated — not "a turn is
  currently being taken."

This split is what `GameStateLobby` / `GameStateActive` (`server/src/state.ts`) are named
after: the domain distinction came first, the types are just making it real.

## Main menu vs. lobby

Two distinct concepts, easy to conflate because both sit "before the game":

- **Main menu** — a client-side, room-less screen. No `GameState` exists yet; there is no
  room code and nothing on a server to point at. Its only options are to create a lobby,
  join one by code, or quit the application.
- **Lobby** — `GameState.phase === "lobby"` (see above): a room already exists
  server-side, has a code, and players are staged in it up to the player cap.

**Exit to main menu** is the action that leaves a room and returns to the main menu. It
is available in the lobby and at `gameEnd` only — not mid-match (`playing`/`roundEnd`),
where a seat cannot be given up part-way through a hand. **Close room** is the host's
counterpart and the exception: available in every phase, it ends the room for everyone at
once, and it is the only thing that ends one early — a disconnect leaves the room and the
seat exactly as they were. Exiting is asymmetric by who invokes it, the same way in both
phases:

- A **non-host** player exiting is removed from `players` entirely — their seat is freed,
  not held or bot-replaced. The room lives on for whoever remains: the lobby for the rest
  to join and start, or the finished match's scoreboard for the host to still choose
  between playing again and exiting.
- The **host** exiting closes the room outright — every other human player is booted to
  the main menu, told the room closed because the host quit.

## Selection

The cards a player has chosen for their turn but has not yet discarded. A selection belongs
to the player whose turn it is and to nobody else: it exists only in front of them, is sent
nowhere until the turn is committed, and has no representation in `GameState` — the engine
learns of it only as the finished discard of a completed turn.

A selection is **ordered**, not a set, despite reading as one. For most discards the order
is immaterial, but a joker extending a run takes its position from where it sits in the
submitted order (`docs/rules.md` §4), so the same cards chosen in two different orders are
two different moves — and they offer the next player different cards to pick up.

Committing a selection is indivisible with drawing, so there is no moment at which a
selection has been discarded but the turn is unfinished. A selection is pending or gone.

## Draw target

What a selection is committed *against*: the deck, or one of the two takeable ends of the
last discard (`pickupCandidates` in `shared/src/rules.ts`). Tapping a draw target is what
turns a pending selection into a finished turn — the two are a pair, and neither means
anything alone. A draw target is *live* only while the current selection is a legal
discard; otherwise it is inert, and a tap on it asks for nothing and is refused nothing
(see "The turn is two taps" in `CLAUDE.md`). This is the same fact the wire already
carries as `DrawAction` — which pile, and which card if it came off the discard — named for
the tap that produces it rather than the message it sends.

## Last move

The turn that just resolved, named as a fact rather than reconstructed: who took it, which
pile they drew from, and which card they drew — `RoundState.lastMove`, and `lastMove` on
the view. Exactly one move, overwritten by the next — not a history, not a log.

It exists because the drawn card is otherwise **unknowable downstream**: what is left of a
pile after a pickup reaches a client as a count, so a run's two ends, or a same-rank set,
leave nothing to say which card went. A **slapdown** and a **Yaniv call** are not draws and
so are not moves in this sense — both leave the last move standing, which is why a client
watches it for *changes* rather than treating every arrival as fresh news.

Its **drawn card** is the one part that varies by viewer: public when it came off the
discard pile, since it was face up there a moment earlier, and the mover's alone when it
came off the deck, since it is a card of a hidden hand now. See
[ADR-0007](docs/adr/0007-last-move-on-the-wire.md).

## Card flight

One move as something to *watch*: the cards leaving a hand for the discard pile, and the card
coming back the other way from wherever it was drawn (issue #69). A flight belongs to the
move that produced a position, not to the position — it is over in well under the beat the
next move waits out, and a table showing the same position a second later is showing nothing
in flight at all.

Which is why the client treats it as an **event** rather than table state: it is decided once,
as a position reaches the screen (`flightFrom` in `client/src/flight.ts`, published as
`SessionSnapshot.flight`), and gone from everything published after it. A position nobody
watched arrive has no flight — a page that has just opened, a seat claimed back, a fresh deal
— and neither has a broadcast that left the **last move** where it was, which is what a
slapdown and a Yaniv call both do.

The drawn card **may have no face**: `flight.ts` passes the server's redaction through
untouched, so a card off the deck flies as a back for everyone but the drawer. Nothing on the
client re-derives what a viewer may see.

What actually crosses the screen is a **ghost** — a copy of the card, drawn over the table and
inert, flying between two boxes measured off the real thing (`CardsInFlight.tsx`, `flip.ts`).
The card it is a copy of waits at its **landing place**: the spot the position has already
given it, kept empty for as long as its ghost is in the air, or the same card would be drawn
twice. The flight is over in `FLIGHT_MS`, well inside the pacer's beat. Today only the
viewer's own discard flies (issue #72); `docs/client-table.md` has the decisions.

## Slapdown and the slapdown window

A **slapdown** is discarding the card you have just drawn straight back onto the set it
matches, out of turn and without taking one (`docs/rules.md` §9). It is not a turn and not
a mode of one: the turn passed to the next player the moment the discard-and-draw resolved,
and a slapdown leaves it exactly where it is. All it does is take a card off a hand and add
it to `lastDiscard`.

The **slapdown window** is the state it is available in: the stretch between one player's
turn resolving and the next player's beginning. It is the only state in this game in which
a player has a move while the turn belongs to somebody else, which is why it is a field of
its own (`RoundState.slapdown`) rather than something derivable from whose turn it is. It
opens only on the conditions §9 lists, closes on the slap or on the next player's turn —
whichever the server processes first, with nothing arbitrating them but that order
([ADR-0005](docs/adr/0005-slapdown-race-by-event-order.md)) — and belongs to exactly one
player.

Whether a window is open is **private**: it says its holder drew a rank they had just
discarded, which nothing else on the wire reveals, so it reaches the client as
`slapdownEligible` on `SelfView` alone. The pile it is taken on is the **slapdown target**
— the counterpart of a draw target, except that it is the whole pile rather than a card,
since a player draws one card a turn and so at most one card is ever eligible.

## Standings

The final table of a finished match: every player who played it, ordered lowest score
first, with the winner (or winners, on a tie) marked. Not the same thing as the roster —
the standings are the record of a match that is over, so they include a player who has
exited to the main menu since it ended, marked as **departed**. Their name and final score
come from the round result that ended the match, which carries its own copy of both; the
roster no longer holds either. A departed player can still be the winner, and is still
shown as one. Level scores are separated by where the two were sitting, so every screen
lists the same match the same way round; a player who has left has no seat to be placed by
and sits after whoever stayed.

Who is on the standings, and in what order, is `standings` in `shared/src` — one answer for
both clients, the same way the rulebook is (see
[ADR-0002](docs/adr/0002-shared-owns-the-rulebook.md)). How a row is *drawn* is each
client's own business.

## Room settings

The host's four choices for how a room's matches are played: **hand size**, **Yaniv
threshold**, **max score**, and **bot count**. Distinct from the *rules* (`docs/rules.md`),
which are fixed — settings are the finite set of knobs the rules deliberately leave open
to a host, each constrained to a range or enum chosen so no combination can produce an
unplayable or crashing table (see [ADR-0006](docs/adr/0006-room-settings.md)).

Settings are editable only in the **lobby**, by the host alone; every other player sees
the same values **read-only**. Once `startGame` deals the first round they **lock** — not
just for that match but for the life of the room, since **play again** never passes back
through the lobby to offer another chance to edit them.

**Bot count** is the one setting that isn't a fixed value so much as a request: a host
asking for more bots than there is room for (`6 - <human count>`) isn't refused — it's
read back down to what fits, recomputed wherever it's read rather than stored clamped.
This is why a room can never reject a join over a stale setting: the number simply means
less than the host asked for, the same way an empty seat has always just gone to a bot.

## Resume token

The secret that proves a connection is entitled to a **seat**. One per seat, issued from a
CSPRNG the moment the seat is created (`createRoom`, `joinRoom`, bot seating) and fixed for
the life of the room — never rotated, never reissued, so it names one seat for as long as
that seat exists.

Deliberately *not* called a session: "session" is already double-booked, for the socket's
own `socket.data.session` and for the client's session core (`client/src/session.ts`).
A resume token is neither — it is a credential, and outlives any connection holding it.

It is a secret of the same class as a hidden hand, and a worse one to lose: a leaked hand
is a look at someone's cards, a leaked token is their whole seat. So it lives in
`GameState` and never in a `PlayerGameView`, in any phase, to any player — including the
one it belongs to. It reaches its owner in exactly one place: the ack of the event that
seated them.

**Resume seat** is what they present it back over — `resumeSeat({ roomCode, playerId,
resumeToken })` — binding a new connection to a seat that already exists, in any phase, and
answering with the position that seat stands in. Distinct from joining, which admits
somebody new. A seat holds one live connection, so a resume puts down whatever socket was
still holding it.

## Play again

Starts a fresh match in the same room, for the same host and the same seated players
(minus anyone who has exited to the main menu since the last game ended) — scores,
hands, and the deck all reset, and the next round is dealt immediately. It does not stop
at the lobby the way ending a match used to require; only the host may invoke it, and
only from `gameEnd`. See [ADR-0001](docs/adr/0001-random-starting-player.md) for who
opens the new match.
