# A slapdown is its own wire fact, beside the last move and unredacted

A slapdown (`docs/rules.md` §9) now has to be *watched*, not merely applied: the slapped card
leaves a hand and lands on the pile, and a client that animates a move (issue #69, and #92
for this one) needs to know which seat it flew out of. The question was whether the server
has to say so, or whether a client can work it out from two consecutive positions.

It cannot, and for a different reason than the last move's. A slapdown does change something
visible — `lastDiscard` grows by exactly one card, so *which* card is recoverable by
diffing. **Whose it was is not.** An open window is private to its holder by design:
`SelfView.slapdownEligible` is told to that player alone, and `OpponentView` has no such
field to populate (ADR-0005, and the field's own note in `shared/src/views.ts`). So every
viewer but the slapper sees a card appear on the pile with no seat attached to it, and a
hand size dropping by one — which is what an ordinary discard does too. Inferring the seat
from the shrunk hand would mean reconstructing an opponent's move from counts, and getting
it wrong the moment two things change in one beat.

Decided: `RoundState.lastSlapdown` — the slapper and the card — written by `slapDown` and by
nothing else, cleared by `dealRound` so a fresh deal never inherits the previous round's,
and carried to every client as `PlayerGameView.lastSlapdown`. One fact, overwritten by the
next slapdown, deliberately not a log — the same shape as `lastMove`, for the same reason.

## Why this does not contradict ADR-0007

ADR-0007 says `slapDown` "leaves [`lastMove`] exactly as [it] found it: neither is a draw,
so neither has a move of its own to record, and clearing it would erase a turn a client may
not have finished drawing." That reasoning is untouched and still holds — `slapDown` does
not write, clear or disturb `lastMove`, asserted by its own test. What has changed is not
the answer to "does a slapdown record a *move*?" (still no) but the discovery that a
slapdown needs a fact of its **own**. A sibling field is what keeps both true at once: the
last move stays the last *turn*, and the slapdown that happened alongside it is named
separately, so a client can watch either for change without the other lying.

The alternative — folding a slapdown into `lastMove` — is what ADR-0007 actually rules out,
and would break it in exactly the way it warns about: a client mid-flight on the drawing
turn would see that move replaced by something that was never a draw.

## Why nothing is redacted

`LastMoveView.drawnCard` is nulled for everyone but the mover when the card came off the
deck, because that card is now in a hidden hand. A slapped card is the opposite case by
construction: it is the card just drawn, and it is **face up on `lastDiscard`** by the time
`lastSlapdown` exists — part of a field every viewer is already sent in full. Naming it says
nothing the pile does not already say, so there is no per-viewer variation to draw and
`lastSlapdown` is one object for everybody.

The slapper's identity is public on the same grounds `lastMove.playerId` is: a table watches
a seat act. What stays private is the *window* — that a player is holding a card they could
slap down — and `slapdownEligible` still owns that, alone. A window that was never used
leaves `lastSlapdown` null and reveals nothing.

This is a wire addition, not a rules change: `docs/rules.md` §9 is untouched, and the engine
behaves as it did — the card still shrinks the hand and extends `lastDiscard`, the turn still
does not move, and the window still closes on the slap (ADR-0005).
