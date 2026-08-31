# Connection is derived from the live sockets, never stored

A table can go quiet for two very different reasons: somebody is thinking, or somebody is
not there. Until now the wire said nothing about which, so a game waiting on a player whose
phone had locked itself looked exactly like a game waiting on a player deciding what to
discard — and a seat somebody had given up for good looked the same as one they might be
back at in ten seconds (issue #146, user stories 18-19 of #138).

Saying so needs one fact the game itself does not have: whether there is a live connection
behind each seat. The obvious place to put it is `Player.connected`, set on connect and
cleared on disconnect.

Decided: **connection is derived from the room's live sockets at the moment a position is
published, and never stored anywhere.**

- `serializeStateForPlayer(state, viewerPlayerId, connectedPlayerIds)` takes the set of
  player ids with a live socket as an argument. It is required, not defaulted: a call site
  that publishes a view knows who is there, and one that forgets should not compile. The
  two callers that genuinely have no transport under them — a bot deciding its turn, and
  the in-process demo harness — pass the named `NO_CONNECTIONS` and say so.
- `broadcastState` builds that set once per broadcast, off the same walk of the room's
  sockets it was already doing, so every view of one position agrees about who was there
  when it was built.
- `connected` appears on both the self view and the opponent view, as `outInRound` and
  `departed` already do. The viewer's own seat is connected **by construction** rather than
  by lookup: the payload exists because there is a socket to send it down.
- A **bot** is connected always. There is no connection for one to lose, and a bot that
  read as away would make the empty status slot mean two things.
- Two seams start broadcasting that did not. A `disconnect` handler is added that
  **mutates nothing** and republishes the room, and `resumeSeat` — which deliberately
  published nothing, on the grounds that the table had not changed — now broadcasts,
  because a status marker turning over *is* the table changing.

## Why not a field on `Player`

`GameState` has no transport awareness at all, and a great deal is built on that: the
engine is pure, every transition is a total function of state and inputs, and a player's id
is a server-issued value rather than a socket id precisely so the domain model never has to
know what a socket is. A `connected` field would put the one transport fact in the middle of
it, and every transition would then be free to read it — at which point whether a player has
a socket becomes a rule of the game rather than a note on the screen.

It would also be the only field in the model with two writers and no single moment of
truth. A drop is asynchronous, a resume rebinds a seat to a second socket, and a resume that
displaces an older connection fires that connection's disconnect *after* the new one is
seated: keeping a stored flag correct across those three would mean ordering them, and every
ordering bug shows up as a seat permanently marked away with somebody sitting at it. Derived,
the question cannot be stale — the answer is recomputed from the sockets that exist, every
time anything is published, and a wrong answer is not representable for longer than a
broadcast.

The cost is that connection is only as fresh as the last broadcast, which is why the
disconnect handler exists: without a publication there is nothing to recompute *into*.

## What this does not do

Display, and nothing else. A disconnected seat holds its place, its turn still waits for it,
and nothing pauses, times out or bot-plays it — the indicator was never the hard part of
that. A room whose players have all merely dropped is likewise still standing; sweeping one
is its own ticket, and a reload is a disconnect.
