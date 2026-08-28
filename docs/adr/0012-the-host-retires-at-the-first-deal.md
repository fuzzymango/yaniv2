# The host owns the lobby and retires at the first deal

A room used to have an owner for its whole life. The host started the match, dealt every
round, dealt every next match — and, whichever way they left, took the room with them:
`exitToMenu` from a host closed it for everybody, and `closeRoom` did the same on purpose
from any phase, mid-round included. That made one seat's departure everyone else's problem,
and it got worse under elimination (issue #141): a host knocked out in round three was
sitting there holding a button that ended four other people's match.

Decided: **the host owns the lobby and nothing else, and the role retires at the first
deal.**

- In the lobby the host is what they always were: the only seat that may edit the room's
  settings (`updateSettings`, docs/adr/0006) and deal the first round (`startGame`).
  Everyone else is refused with `NOT_HOST`.
- **A host who leaves the lobby hands it on.** `hostId` migrates to the next remaining seat
  in roster order, so a room full of people is not stranded because whoever clicked create
  wandered off. This is the one mutable field of a match, and `removePlayer` is the one
  transition that writes it.
- **From `playing` onward nobody is host.** `GameState.hostId` is left where the lobby set
  it and consulted by nothing; the serializer sends `hostId: null` in every phase but the
  lobby, so no client can draw a host at a table that has none, or gate a control on being
  one.
- **The next round is dealt by any player still in the match** (`startNextRound`). A seat
  the match has gone on without — eliminated, or gone — is refused with `NOT_IN_MATCH`:
  they cannot rush a match they are no longer in.
- **Another match is dealt by anyone still in the room** (`playAgain`), spectators
  included. A departed seat is refused with `PLAYER_NOT_FOUND`.
- **`closeRoom` is gone** — the event, the handler and both clients' controls. No player
  can end anybody else's game. A room ends when its last seat leaves.

This supersedes the exit asymmetry documented at length in `CONTEXT.md` and `CLAUDE.md`:
"who invokes `exitToMenu` decides what it costs everyone else" is no longer true, and there
is no longer a second, deliberate way to end a room.

## Why the role ends at the deal rather than at elimination

Scoping the host down to "still in the match" was the obvious smaller change, and it does
not work at `gameEnd`: exactly one player is still in the match there and that player may
be a **bot**, which presses nothing. A bot-won room would freeze with nobody able to deal
another match. Nor does it help mid-match — "the host, unless they are out, in which case
the next seat" is a rule with a running derivation behind it, and the thing being derived
is a privilege nobody at a dealt table needs. Once the cards are out there is no decision
left that belongs to one person: dealing the next round is not a choice about the room, it
is the table asking to carry on.

Two eligibility rules rather than one, deliberately. **Dealing a round** is an act inside a
match, so it belongs to the players in it. **Dealing another match** is an act about the
room, so it belongs to whoever is in the room — which is what keeps a bot-won table
playable, and what puts a knocked-out player straight back into the next match rather than
making them ask somebody.

Bot-ness is not checked by either transition. A requester is identified from the connection
that sent the event, and a bot has none, so a bot id can only ever arrive from the server
itself — the demo harness dealing a bots-only match, and nothing a player could send.

## Why the mid-match close-room control goes rather than moving

Earlier designs kept it as an escape hatch: a player stranded at a table that had gone
quiet needed *something*. Letting anybody leave at any time (#147) is that something, and
it costs nobody else anything. Keeping both would mean keeping the one control in the
interface where a misplaced thumb ends four other people's game — for a case already
covered.

A lobby-only close was considered and rejected on the same grounds, one size smaller: the
host who wants a lobby gone can leave it, and if they were the last seat the room goes with
them anyway. Two ways out of one screen, one of which is destructive, is worse than one.

`roomClosed` goes with it. Nothing can emit it: a room now ends when its last seat leaves,
and that seat is the one doing the leaving — there is nobody to tell. A player whose room
went while they were disconnected finds out the way they already did, by having their claim
refused when they come back (`INVALID_RESUME_TOKEN` / `ROOM_NOT_FOUND`).

## Considered options

- **Migrate the host through the whole match, not just the lobby** — rejected: it keeps a
  role alive to answer a question nobody asks after the deal, and every migration rule
  ("the next seat still in the match", "unless they are a bot") is a rule that can be got
  wrong for no gain.
- **Keep `closeRoom` for the host, lobby only** — rejected above.
- **One eligibility rule for both deals** — rejected: "still in the match" freezes a
  bot-won room, and "still in the room" would let a spectator rush a round they are not
  playing.
- **Null `hostId` on `GameState` too, not just on the wire** — considered. It would make
  "no host after the deal" unrepresentable rather than merely unread, but `hostId` sits on
  `GameStateBase`, and moving it onto the lobby variant alone turns every `state.hostId` in
  a test or harness into a phase narrowing. The wire is where the claim matters, since that
  is what a client could act on.

## Consequences

- `hostId` is mutable, a first for this model, and mutable in exactly one place. A test
  asserts it moves in the lobby and does not move once a match exists.
- `PlayerGameView.hostId` is `string | null`. The lobby is the one screen in either client
  that reads it.
- `NOT_IN_MATCH` joins `GameErrorCode`: a seat that is still in the room and still being
  broadcast to, asking for something only a player in the match may have. Distinct from
  `PLAYER_NOT_FOUND`, which says the room does not know who is asking.
- **The browser client loses a control and a screen gains none**: the close-room icon is
  off the table's topbar, `WayOut` is one button reading "Leave the room" for everybody, and
  `GameEnd`'s play-again is offered to whoever is looking at it. The confirm dialog that
  guarded closing goes with it — leaving costs nobody else anything, so there is nothing to
  ask about.
- **A bots-only table at `roundEnd` stalls until #148.** Every human being eliminated while
  bots play on leaves nobody eligible to deal. The auto-deal ticket is the answer; until it
  lands, the suites that play matches out seat one bot rather than five, or play at a limit
  no run of rounds reaches.
- **A room is dropped when its last seat leaves**, which is the whole of room destruction
  now. The 60-second sweep for rooms whose humans have all *dropped* is #150; until then a
  room whose players never come back lives until the server restarts, which is the
  documented cost of rooms living in memory at all.
- One socket-seam test is lost with the control: a pending bot turn being called off with
  its room was asserted by closing a room mid-think, and there is no longer a way to end a
  room mid-round. The cancellation is unchanged, and gets its seam back with mid-round
  leaving (#147) and the sweep (#150).
