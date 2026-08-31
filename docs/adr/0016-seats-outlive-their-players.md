# Seats outlive their players

A room used to have one list of players and one meaning for it: `GameState.players` was who
was in the room, who was in the match, and who was drawn at the table, all at once. Leaving
spliced a seat out of it, in any phase, and every one of those three questions changed answer
together.

Elimination (`docs/rules.md` §7) and leaving from any phase (#147) broke that apart. A player
knocked out in round three is not playing and is still in the match's record; a player who
walked off in round five has to appear in the standings that decide who beat whom, and has to
keep the seat they were drawn at while the round they left is still on the screen. A spliced
seat can do neither: it cannot be drawn darkened at the table it played, and a scoreboard
rebuilt without it says the wrong player won.

Decided: **from the first deal the roster is append-only. Leaving marks a seat rather than
removing it, and the seat is a fact about the room for as long as the room lasts. In the
lobby, leaving still splices.**

## What a mark is

`removePlayer` on a dealt room sets two fields and nothing else:

- **`departed: true`** — the seat has been given up. Whatever holds its id is no longer
  somebody the room is for: a resume presented for it is refused
  (`INVALID_RESUME_TOKEN`, the answer a seat that never existed gets, so a room code is no
  way of fishing for the seats behind it), and `removePlayer` and `playAgain` refuse it
  outright (`PLAYER_NOT_FOUND`).
- **`outInRound`**, if it was not set already — the round they stopped playing in. Left where
  it is if they were already out, because being eliminated in round three is not undone by
  walking off after round seven.

There is no third field saying *why* a seat is out, and deliberately no boolean beside
`outInRound` that could disagree with it. **Out-ness is the one stored fact**; eliminated is
out with a score past the limit, left is out with `departed`, and the two are disjoint by the
rules rather than by convention — a player who left cannot also be over the line, since
crossing it would have taken them out at that round's scoring, before they had anything to
leave. ("Out of the match" in `CONTEXT.md` carries the same argument from the domain's side.)

## Membership in the roster is no longer membership in the match

This is the whole cost of the decision, and it is paid in one currency: **every count over
`players` and every map across it had to be asked which question it meant.** `inMatch`
(`server/src/state.ts`) is that filter, and it is the only one — `dealRound`, `randomOpener`,
the minimum to start, `seatBots`, `startNextRound`'s eligibility, the match-over check and the
serializer's `turnOrder` all go through it.

A missed call site is a **live bug, not a type error**: `players.length` still compiles and
still means something, just not what it used to. That is the risk accepted here, and it is
accepted because the alternative — a second list — pays the same cost twice (below).

Three seat counts deliberately do **not** ask it, and each is a rule rather than an oversight:

- **`playAgain`** counts the seats that are still somebody's, departed excluded but the
  eliminated included: a new match is for everyone still in the room, so last match's losers
  are in it and a seat given up stays given up.
- **`joinRoom`** counts the raw roster against `MAX_PLAYERS`, which is exact: a room only
  admits in the lobby, where nothing is marked and the roster is still spliced. Append-only
  therefore never fills a room.
- **The standings** read the raw roster on purpose — that is what they are for.

## Why the lobby still splices

Because none of the reasons above apply before the first deal. There is no match record for
a lobby seat to be part of, no round it played, no score to freeze and no standing to appear
in — so a ghost row in a room that has not dealt is noise on the one screen whose entire
content is who is here. It would also cost a seat against `MAX_PLAYERS` for nothing, and
give the host migration a departed seat to consider handing the lobby to.

The line is the deal rather than the phase list because the deal is what creates the record:
before it, a seat is a person waiting; after it, it is a row in a match's history.

## The room still dies

Seats outliving their players does not mean rooms outliving everybody. Two ends, and this
decision touches neither:

- **A room ends when its last seat leaves.** The marking is what a seat *becomes*; the room
  is destroyed by the layer above when nothing is left un-departed, which is not a
  `GameState` a pure transition could return (docs/adr/0012).
- **And when nobody is attending it.** No seat held by a connected human for a minute and the
  room is swept, timers and all (docs/adr/0015) — the case nobody takes deliberately, which
  is exactly what an append-only roster cannot answer, since a tab closing marks nothing.

A departed seat counts toward neither of those as a presence. It is a record, not an
occupant.

## Considered options

- **Splice, and keep a separate record of who has played.** The obvious alternative, and it
  is the same change with the seams in worse places: two lists to keep in step, a name and a
  score copied into the second one, and every screen having to decide which it is drawing.
  Membership questions do not go away — they move from `inMatch` to "which list am I holding".
- **Splice, and rebuild the standings from the rounds.** Rejected outright: a round's record
  says who *played it*, not who was in the match, so a player who left before the last round
  would be missing from a table whose whole point is how long each player lasted. And a match
  that ends by departure has no scored round behind it at all.
- **A `departed` seat comes out of `seating` but stays on the roster.** Tempting — it is the
  one list a departed seat is arguably not part of — and wrong for the reason seating exists
  (#144): a seat vacating its place slides everyone after it one along, mid-match, which is
  the rearrangement roster-order seating was introduced to prevent. A seat holds its place
  whether its player is out, gone, or still playing.
- **Splice the roster but leave the player in `turnOrder`.** Rejected: the turn would reach a
  seat with no hand and no connection behind it, and the round would wedge waiting on it.
  What actually happens is the inverse — the seat stays and comes out of `turnOrder`
  (`withdrawFromRound`).

## Consequences

- **`Player.departed` is required, not optional**, so no construction can leave a seat
  ambiguously present — the same reasoning as `isBot`.
- **A departed seat is still broadcast**, and says so: the table draws it dim with `left` in
  its status slot, and the standings list it as departed with its frozen score
  (`docs/client-table.md`). A seat that has gone silently would leave the arithmetic looking
  wrong.
- **`playAgain` clears eliminations but not departures.** Every `outInRound` goes back to
  null except a departed seat's, which is set to round 0 — out of the new match before it
  starts, since there is nobody behind it to play.
- **A mid-round departure ends the match without a scored round** when it leaves one player,
  so `gameEnd` is reachable with no reveal under the standings. The wire already allowed it;
  it had never happened before #147.
- **Two lists on the wire.** `PlayerGameView.seating` is the roster in its own order, every
  seat included, beside `turnOrder`, which holds only the players still in the match — the
  same split, one layer out (#144, "Turn order vs. seating" in `CONTEXT.md`).
