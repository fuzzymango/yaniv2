# The last move is a wire fact, with its drawn card redacted per viewer

A client that wants to show a draw happening — a card flying from the deck or from the pile
into the drawer's hand (issue #69) — has to know which card was drawn. The question was
whether the server needs to say so, or whether a client can work it out for itself by
comparing the position before a move with the position after it.

It cannot, and not for want of trying. A pickup takes one card off `lastDiscard`, and what
is left of that set becomes `buried` — which reaches the client as `buriedCount`, a number.
Whenever more than one card of the pile was pickup-eligible (a run always exposes both its
ends, a same-rank set exposes every card in it), the cards left behind are indistinguishable
from the one taken: the count is the same whichever end went. So the fact is not recoverable
downstream, and the only place that still knows it is the transition that performed the
draw.

Decided: `RoundState.lastMove` — the mover, the pile they drew from, and the card itself —
written by `takeTurn` and by nothing else, cleared by `dealRound` so a fresh deal never
inherits the previous round's last move. `slapDown` and `callYaniv` leave it exactly as they
found it: neither is a draw, so neither has a move of its own to record, and clearing it
would erase a turn a client may not have finished drawing. One fact, overwritten by the next
turn — deliberately not a move log, which is a bigger thing to own (replays, round history)
than the one gap this fills.

The discarded half of a move needs no field: `lastDiscard` already holds exactly what the
mover put down, complete and in order.

`PlayerGameView.lastMove` is the same fact per viewer, with `drawnCard` redacted by
`serializeStateForPlayer`:

- **From the discard pile — shown to everyone.** The card was face up on the pile a moment
  before it was taken. Naming it reveals nothing that was not already on every screen.
- **From the deck — shown to the mover alone, `null` for everyone else.** That card is now
  part of a hidden hand, and `OpponentView` is shaped so an opponent's cards cannot be
  populated by accident; a `lastMove` that named the card would be the same leak through a
  different field.

This is the boundary `SelfView.slapdownEligible` already sits on, one field along, and it is
kept the same way: the serializer's leak tests assert that no card id outside what a viewer
may see appears anywhere in their payload, and the wire-level test in
`server/test/socketServer.test.ts` asserts it against a real burst of bot broadcasts —
where a bot drawing from the deck is exactly the case that would leak.

Whose turn it was and which pile they drew from stay public in every case. Both are things a
table watches happen; only the card's identity is private, and only when it came off the
deck.
