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

**Exit to main menu** is the action that leaves a room and returns to the main menu, and
it is the only way out of a room there is. It is available **in every phase**, to players
and spectators alike: nobody is trapped at a table that has gone quiet, and a seat given up
mid-round is taken out of the round on the spot rather than the round being abandoned
around it (`docs/rules.md` §7, "Out of the match" below).

It means the same thing whoever invokes it, and it costs the rest of the table nothing.
Before the first deal the leaver is removed from `players` entirely — their seat is freed,
not held or bot-replaced; from the first deal the roster is append-only, so leaving marks
the seat instead (**left**, see "Out of the match"). Either way the room lives on for
whoever remains: the lobby for the rest to join and start, or the finished match's
scoreboard for whoever is still looking at it.

**A room ends when its last seat leaves**, and that is the whole of it — there is no
control that ends one for anybody else, and a disconnect leaves the room and the seat
exactly as they were. The **close room** action that used to be the host's exception was
removed with [ADR-0012](docs/adr/0012-the-host-retires-at-the-first-deal.md), along with
the asymmetry that made a host's exit cost everyone else their match.

## Host

The seat that owns the **lobby**, and only the lobby: the one player who may edit the
room's settings and deal the first round. Everyone else asking is refused `NOT_HOST`.

**The role retires at that deal.** From `playing` onward nobody is host: the next round is
dealt by any player still in the match (`NOT_IN_MATCH` to a seat it has gone on without),
another match by anyone still in the room, spectators included — a match may have been won
by a bot, and a bot asks for nothing. `PlayerGameView.hostId` is null in every phase but
the lobby, so no screen can draw a host at a table that has none.

A host who **leaves the lobby** hands the role to the next remaining seat, so a room full
of people is not stranded by whoever clicked create wandering off. This is the one mutable
fact about a match, and it is mutable only in the lobby.
[ADR-0012](docs/adr/0012-the-host-retires-at-the-first-deal.md).

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
the view. Exactly one move, overwritten by the next; the log is the **move history**, below,
and this stays the single fact a client watches for change.

It exists because the drawn card is otherwise **unknowable downstream**: what is left of a
pile after a pickup reaches a client as a count, so a run's two ends, or a same-rank set,
leave nothing to say which card went. A **slapdown** and a **Yaniv call** are not draws and
so are not moves in this sense — both leave the last move standing, which is why a client
watches it for *changes* rather than treating every arrival as fresh news.

Its **drawn card** is the one part that varies by viewer: public when it came off the
discard pile, since it was face up there a moment earlier, and the mover's alone when it
came off the deck, since it is a card of a hidden hand now. See
[ADR-0007](docs/adr/0007-last-move-on-the-wire.md).

## Last slapdown

The slapdown that just resolved: whose it was and the card they put down —
`RoundState.lastSlapdown`, and `lastSlapdown` on the view. A **sibling** of the last move,
never a part of it: a slapdown is not a turn, so the last move is left standing and this
changes instead. Exactly one, overwritten by the next, cleared by a fresh deal.

It exists because *whose* seat the card came from is **unknowable downstream**: the card
itself can be read off `lastDiscard` growing by one, but an open window is private to its
holder (see "Slapdown and the slapdown window"), so every other viewer sees a card arrive
with no seat attached. Nothing about it is redacted — by the time it is written the card is
face up on the pile everyone is already sent in full. See
[ADR-0008](docs/adr/0008-slapdown-on-the-wire.md).

## Move history

Every move of the round in the order they were made — `RoundState.moveHistory`, and
`moveHistory` on the view (issue #90). A **move** here is a turn or a slapdown, and nothing
else: a Yaniv call ends the round rather than moving within it, and leaves the log exactly as
it found it. Each entry is **tagged** by which kind it is, on the same grounds `CardFlight`
is — a turn's drawn card is nullable, so "nothing came back" cannot be inferred from absence.

Where the last move and the last slapdown are each one fact overwritten by the next, this is
the **log** they are not: what a player who looked away reads back. Round-scoped like every
other round fact, so a deal empties it; uncapped, a round being bounded by its own deck.

A turn's entry carries its **discarded set** as well, which the last move leaves to
`lastDiscard` — a field that only ever holds the latest lay. That is the one thing the wire
did not previously name: a set that has since been **buried** is named here, which is no
secret to give away, every player having watched it land face up (`buriedCount` is a count to
keep payloads small, not to keep anything back). The **drawn card** is redacted per viewer on
exactly the last move's rule, and it matters more here: one withheld card is a card, a round
of them is an opponent's whole hand. See [ADR-0007](docs/adr/0007-last-move-on-the-wire.md).

Read on the browser client as the **history drawer**: the same log newest first, in mini
cards behind an arrow on the left edge of the felt, and drawn **only while the round is being
played** (issue #91) — a scored round tells its own story at full size in the seats. Which
end is the interesting one, how many moves fit before it scrolls, and whether the drawer is
open at all are the client's alone; none of them is a fact about the round.

## Card flight

One move as something to *watch*: the cards leaving a hand for the discard pile, and the card
coming back the other way from wherever it was drawn (issue #69). A flight belongs to the
move that produced a position, not to the position — it is over in well under the think time
the next move waits out, and a table showing the same position a second later is showing
nothing in flight at all.

Which is why the client treats it as an **event** rather than table state: it is decided once,
as a position reaches the screen (`flightFrom` in `client/src/flight.ts`, published as
`SessionSnapshot.flight`), and gone from everything published after it. A position nobody
watched arrive has no flight — a page that has just opened, a seat claimed back, a fresh deal
— and neither has a broadcast that left both facts it is read from where they were, which is
what a **Yaniv call** does.

Those facts are the **last move** and the **last slapdown**, watched together and each for
change of its own. A slapdown flies too, and as a shape of its own: one card out of a hand
onto the pile and nothing coming back, tagged as such rather than told apart by which fields
a turn's shape left empty. Exactly one broadcast carries one move, so at most one of the two
facts has changed on any arrival and there is never a choice to make between them.

The drawn card **may have no face**: `flight.ts` passes the server's redaction through
untouched, so a card off the deck flies as a back for everyone but the drawer. Nothing on the
client re-derives what a viewer may see.

What actually crosses the screen is a **ghost** — a copy of the card, drawn over the table and
inert, flying between two boxes measured off the real thing (`ghosts.ts`, `CardsInFlight.tsx`,
`flip.ts`). The card it is a copy of waits at its **landing place**: the spot the position has
already given it — a *place*, in the hand or on the pile, not merely a card, since a slapdown
inside a flight can put one card in both — kept empty for as long as its ghost is in the air,
or the same card would be drawn twice. A **seat** is the third place, and the one nothing waits
at: a hand that is not the viewer's own is a count drawn as a fan of backs, so it is one box
rather than a card each, and no card sits at that end of a journey to be shown twice. A ghost
off the **deck** is drawn as a back, and has no box of its own to have come from — the deck is
where its journey starts, and it turns over at neither end, because the hand it lands in is
already showing its face; a ghost with no face at all, flying into somebody else's hand, is
drawn the same way and named by the seat it is going to. The flight is over in `FLIGHT_MS`,
well inside the pause a bot takes before its move, so a chain of turns is one flight apiece.
Every move at the table flies, whoever took it (issues #72, #73, #74);
`docs/client-table.md` has the decisions.

A **slapdown flies as its own thing** (issue #95), and how it flies is most of what says it is
not a turn: the one card crosses in `SLAP_MS` rather than `FLIGHT_MS`, on an accelerating curve
where a discard decelerates, lands with a brief **pop** past its own size, and **jolts the
whole table** behind it. Those durations are a **chain, not a set of numbers**
(`client/src/timing.ts`): the slap is a fraction of the flight and the jolt a fraction of the
slap, so the table is retuned by editing one value and cannot end up half fast and half slow.
The chain is derived from nothing outside itself: what keeps a flight from being replaced
before it finishes is the **bot think time** the server spaces moves out by, which is several
times a flight and is a fact about the game rather than about the animation (issue #135). A
network that bunches two broadcasts can cut a flight short — cosmetic, accepted, and only on a
connection that has already stuttered. All three parts are one
thing to a player who has asked for less motion: the flight never starts, so the pop and the
jolt never happen, and the card is simply on the pile where the position already put it.

## Bot think time and the beat

**Bot think time** is the pause a bot takes before its turn — uniform across bots and every
turn alike, a round opening on a bot included. It is a fact about the server, not the table:
what a bot waits out before deciding, not a duration anything is drawn over. See
[ADR-0011](docs/adr/0011-bot-think-time-paces-the-server.md).

**The beat** is the informal word for what a table of bots *reads as* because of it: a chain
of turns landing one think time apart rather than all at once, so a run of moves looks played
rather than announced. Where think time is the cause, the beat is what a player sees — the
two stay distinct on purpose, since only one of them is a number anywhere in the code. The
beat used to be produced twice, once server-side by the spacing between bot turns and again
client-side by a queue that re-paced a burst back out to the same rhythm; the second was
retired as redundant once the first existed to depend on (ADR-0011) — the beat itself is
unchanged, only which side produces it.

It is also what a **slapdown window** races inside of: the only reason a human's client has a
round trip to win that race in at all is that the bot behind them is paused rather than
moving in the same tick (ADR-0011, superseding part of [ADR-0005](docs/adr/0005-slapdown-race-by-event-order.md)).

## Slapdown and the slapdown window

A **slapdown** is discarding the card you have just drawn straight back onto the set it
matches, out of turn and without taking one (`docs/rules.md` §9). It is not a turn and not
a mode of one: the turn passed to the next player the moment the discard-and-draw resolved,
and a slapdown leaves it exactly where it is. All it does is take a card off a hand, add it
to `lastDiscard`, and record itself as the **last slapdown** for a client to watch.

That record is the wire fact behind the flight above (issue #93): **who slapped and which
card**, sent to everyone unredacted, since the card is face up on the pile by the time it is
written and the seat it came out of is the part no client could work out for itself
([ADR-0008](docs/adr/0008-slapdown-on-the-wire.md)). It is the **last move**'s sibling
rather than a variant of it, and each is left standing by whatever the other records — which
is what lets a client watch the two facts side by side and always have at most one of them
change per broadcast.

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

## Out of the match

**Out of the match** is a player who was in a match and is no longer playing it, with the
consequences `docs/rules.md` §7 gives that. It is a fact about a *match*, not about a room
or a connection — someone out of the match is still a player of it, listed and scored, and
the match's record is incomplete without them.

There are exactly two ways to be out, and they are **causes** rather than states of their
own:

- **Eliminated** — out because their total passed the room's max score when a round was
  scored (`docs/rules.md` §7). They are still in the room.
- **Left** — out because they gave up their seat, from any phase, mid-round included.
  Leaving is final: there is no way back into a match once out of it, and the server says
  so rather than trusting a client to forget — a resume presented for a departed seat is
  refused. This is the same seat the **standings** call *departed* (below), named from the
  match's side rather than the scoreboard's.

The two are disjoint, and provably so rather than by convention: a player who left cannot
also be over the line, because crossing it would have taken them out at that round's
scoring, before they had anything to leave. So "out, and over the max score" and "out, and
departed" name the same players they would if each were stored, which is why neither is.

**Spectator** is what elimination leaves a human doing: out of the match, still in the
room, still connected. They see the table they saw while playing, with exactly what was
hidden from them still hidden — being knocked out is not a promotion — and the only action
left to them is leaving. Bots are never spectators: nothing is watching behind the seat. A
player who has **left** is not a spectator either, having no connection to the room to
watch it over; the word names the ones who stayed.

The cause is always **derived**, never a state of its own: out-ness is the one fact about a
seat, and which of the two put it there follows from the score and from whether the seat was
given up — as spectating follows from that and a live connection. One fact, and no second
source of truth to disagree with it.

## Connected, and away

**Connected** is whether there is a live socket behind a seat *right now*. It is a fact
about a connection and not about the match: a player who has dropped is still in the match,
still holds their hand, and the turn still waits for them. **Away** is the word the table
uses for the opposite — somebody who might be back in ten seconds, as against somebody who
has **left** (above), which is final.

It is **derived from the room's live sockets whenever a position is published, and stored
nowhere** ([ADR-0013](docs/adr/0013-connection-derived-from-the-live-sockets.md)): the
broadcast already walks those sockets, so it already knows, and `GameState` keeps its
freedom from anything to do with transport. Two consequences worth stating: a **bot** is
connected always, having no connection to lose, and a viewer's own seat is connected by
construction, the payload existing because there is a socket to send it down.

Every seat carries it on the wire, which is what lets a table say why it has gone quiet. The
**status slot** is where each seat says so — one word, by priority: **left**, then **away**,
then **watching**, and nothing at all for a bot or for somebody playing (`status.ts`,
`docs/client-table.md`) — on the felt, and on the lobby's roster rows, where only "away"
can come up. Nothing acts on it: a seat whose player is away is not skipped,
timed out or played by a bot.

## Turn order vs. seating

One list until elimination, because until then they were equal, and two things that were
always distinct:

- **Turn order** is the sequence play moves in — who acts after whom, within a round. It
  holds only the players still in the match, so a player going out comes out of it and the
  rest keep their relative order (`docs/rules.md` §2, §7). It is a fact about the round.
- **Seating** is where a player is drawn at the table: their position in the roster, which
  a room only ever appends to once it has dealt. It is fixed for the life of the room, so
  a seat holds its place whether its player is out, gone, or still playing, and the table
  does not rearrange itself around whoever is left.

Which is why a client seats off the roster and not off turn order: a table redrawn from
turn order would shuffle every remaining player one place along each time somebody was
knocked out. Turn order still decides who acts next, and nothing else.

Both lists are on the wire, side by side — `seating` and `turnOrder` — because a client
cannot recover the first from the roster it is sent: the viewer is lifted out of
`opponents` into `you`, so the roster as it arrives has a hole in it exactly where the seat
a viewer-relative sweep anchors on would be. That sweep anchors on the viewer's **own**
seat rather than on the next player to act, which is also what keeps it meaningful for a
spectator: they are still seated, and no longer in turn order at all.

## Standings

The final table of a finished match: every player who played it, ordered by **how long they
lasted** — the one player still in the match at the top, then the rest by the round they
went out in, latest first. Outlasting somebody places you above them whatever the two of you
finished on, because that is what winning is now (`docs/rules.md` §7); least is best only
*within* a round, where two players eliminated in the same one are separated by their final
scores — and, if even those are level, by an arbitrary but fixed order every screen reads
the same way round, since a match that is over must not finish two ways depending on who is
looking at it.

The standings are read off the **roster**, which from the first deal is append-only and so
carries every player who was ever in the match — including one who has since exited to the
main menu, marked as **departed**, with the score and the round they left frozen on their
seat. Nothing is rebuilt from the last round's record: the round says who played it, not who
was in the match.

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

Starts a fresh match in the same room, for the same seated players (minus anyone who has
exited to the main menu since the last game ended) — scores, eliminations, hands and the
deck all reset, and the next round is dealt immediately. It does not stop at the lobby the
way ending a match used to require. **Anyone still in the room may invoke it**, spectators
included (see "Host"), and only from `gameEnd`. See
[ADR-0001](docs/adr/0001-random-starting-player.md) for who opens the new match.
