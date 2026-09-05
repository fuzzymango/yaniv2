# The match keeps a scorecard: server-owned, trimmed to numbers, sent whole in every phase

A player mid-match can see where everybody stands right now — every seat's running total is
on the felt, and the round just scored is spelled out as an equation — but not how anybody
got there. Once a round is dealt on, the round before it is gone: who called Yaniv in round
3, whether anyone Assafed them, and which totals a milestone cut are facts the game has
already forgotten by the time somebody asks. A human keeping score on paper would have all
of it written down. Issue #84 asks for the paper; issue #154 specifies it.

Decided: the match keeps a **scorecard** — `GameState.scorecard`, a row per scored round,
appended by the same transition that writes `lastRoundResult`, cleared by `playAgain`, and
carried to every client as `PlayerGameView.scorecard` in every phase.

The decisions below are one decision. They only justify each other: the record is affordable
to send uncapped *because* it is trimmed to numbers, it needs no view twin *because* the
trim leaves nothing to redact, and the trim costs nothing *because* the reveal still carries
hands.

## Server-owned, not accumulated by the client

A client could keep its own ledger from the broadcasts it receives. It would be wrong for
exactly one player: the one who reloaded. A dropped socket comes back through `resumeSeat`
and is sent the current position and nothing else, so a player rejoining in round 5 would
open a card with four blank rows, and there is no mechanism to backfill it. The resume flow
exists precisely so a drop costs nothing (ADR-0013), and a client-side ledger would make a
drop cost the whole history.

Deriving it from the current standings is not available either at any price: running totals
recover neither who called nor who Assafed.

Server ownership also keeps the property `standings` was moved into `shared` for (ADR-0002):
a match that is over cannot read two different ways depending on which client is looking.

## One type, `shared`'s, used by the domain directly

`RoundScore` and `PlayerRoundScore` live in `shared/src/views.ts` and are used **unchanged**
by `GameState` and by the wire. There is no `RoundScoreView` and no mapping function in the
serializer.

Every neighbouring pair in this codebase — `RoundResult`/`RoundResultView`,
`LastMove`/`LastMoveView`, `MoveHistoryEntry`/`MoveHistoryEntryView` — exists *because of
redaction*: the domain type is fully populated and the view type has a nullable field where
a viewer is not entitled to know something. A scorecard has nothing to redact. Scores, who
called, who Assafed and milestone reductions are public to everyone in every phase, exactly
as `MatchStanding` is. A twin would be two shapes kept identical by hand, plus an identity
function that looks like it does something.

There is precedent for a shared value type in the domain model: `state.ts` already imports
`DrawSource` and `RoomSettings` and uses both in domain types.

The trade accepted: if a scorecard ever needs per-viewer redaction, splitting it is a real
change rather than a field edit. A scorecard that reads differently per player is not a
scorecard, so this is judged not to be coming.

## What the record deliberately does not carry

- **No hands and no hand values.** The scorecard is a ledger of numbers. The reveal that
  needs cards is `lastRoundResult`, unchanged.
- **No name per seat per round.** Column headers come off the roster, which is append-only
  from the first deal (ADR-0016) and therefore keeps every seat that ever played, departed
  and eliminated included. The reveal keeps its copied-in name because that record is drawn
  per seat standalone (#78); the scorecard is drawing the roster already, and a string per
  cell would ride every broadcast to answer a question nothing asks.
- **No `delta`.** Cells are running totals, so a round's own points are never displayed.
- **No `winnerId`.** Green reads `callerId` and red reads `assaferId`; nothing consults the
  winner.

## `milestoneReduction` is stored, not derived

A client could *nearly* derive the blue rule from running totals: a reduction takes a
multiple of 50 down by 50, landing on another multiple. The derivation is wrong in two
reachable cases, both silent:

- **A round winner sitting on a multiple.** Reduced to 200 in one round, then winning the
  next with a delta of 0, they stay on 200. No reduction fired; a derived rule paints it
  blue.
- **A player holding a lone Joker.** Their hand is worth 0, so their delta is 0 and the same
  false positive appears at any multiple of 50.

The first is patchable from the caller and Assafer ids; the second is not, without hand
values the record deliberately drops. One integer per cell, mostly zero, is what it costs
for the record to say what happened rather than for a client to re-run a scoring rule the
server already ran.

## Match-scoped, and cleared by playing again

The scorecard sits beside `players[].score`, not in `RoundState`: it starts empty at
`createRoom`, grows a row when a round is scored, and is **untouched by a deal**.

`playAgain` clears it, and that is the riskiest line of this change. The transition builds
the new match by spreading the old state, so anything left out of the reset carries over
silently — and the round numbering goes back to zero, so a surviving scorecard would grow a
second round 1 beneath the previous match's rows with no type error anywhere. It is the same
class of hazard already documented around match membership, where a missed call site is a
live bug rather than a type error, and it has a test of its own for that reason.

## Uncapped on the wire, in every phase

Sent in all four phases — empty in the lobby — rather than gated on `roundEnd` the way
`roundResult` is: the card is openable while a round is being played, which is most of the
time anybody wants it.

**Uncapped.** A match's round count is bounded by nothing: the max score setting permits
values three orders of magnitude past the default. This is genuinely unlike the round's move
history, whose uncapped-ness is justified by a round being bounded by its own deck.

A cap was rejected because a ledger with early rows silently missing is worse than no
ledger, and "how far back may a player look" would become a rule `docs/rules.md` does not
have. Sending it only when it changes is client accumulation in disguise, and fails the
reload case above.

The accepted cost, plainly: at the default max score the record is a few kilobytes,
comparable to the move history already riding on every broadcast. The pathological case
needs a host to set a limit far past the default deliberately, and the fix for that would be
the setting's ceiling, not a truncated scorecard.

## The scored round appears twice at `roundEnd`

The payload carries the round both as `roundResult` — with hands, for the reveal — and as
the newest scorecard row, without them. This is the relationship `lastMove` and
`moveHistory` already have (ADR-0010) and for the same reason: they answer different
questions, and deriving one from the other is a search whose answer starts moving the day
either shape changes.

## The colours are a legend of what happened

Green marks the seat that **called Yaniv**, red the seat that **made the Assaf**, blue any
total a **milestone** cut. Which of them a cell wears is `client/src/scorecard.ts`, tested;
what each looks like is the stylesheet's.

This inverts the originating feature request, which put red on the player who *was* Assafed
— that is the caller, so as written it asked for one cell to be both colours while leaving
the Assafer unmarked. The agreed semantics make the colours a legend of what happened rather
than a verdict on who did well: the caller and the Assafer can never be the same seat, so
every round has exactly one green cell and at most one red, and no tie-break between them
exists.

Two collision rules follow. **Red and blue can never collide** — the Assafer's delta is
always 0, and a reduction requires a delta above 0. **Green and blue can**, for an Assafed
caller, whose delta is their hand plus the penalty; **blue wins**. The green/red pair
answers "what happened in this round" and the row already answers it — a red cell means
somebody was Assafed, and only the caller can be. Blue answers "why did this number go
down", which nothing else on the card answers at all.

**Colour is the only encoding**, and the limitation is named rather than left as an
oversight: to a reader with red-green colour deficiency the card is a grid of
undifferentiated numbers, and the milestone blue is the case where colour is the *only*
explanation of a total that went down. A visually-hidden name per coloured cell, or a
non-colour mark, remains available later and changes nothing about the data.

## Where the control lives

In the viewer's own name bar at the bottom of the table, to the left of their name — not in
the top shelf beside the settings and the way out, which is where the feature request put
it. Those two are about the *room*; this is about the match being played, and it is opened
from the row that says where this player stands in it. Spectators get it: the bottom bar is
theirs too, carrying their name and their frozen total.

**Not offered once the match is over.** The standings already answer the question the card
is opened for, and the layer they are drawn on covers the bottom bar — so offering it there
would have meant either relocating the control for one phase or making that layer
pointer-transparent. Whether the card is up is read as *open and the match is not over*, so
the final Yaniv closes it as a function of the position rather than through an effect
chasing the phase; an effect would draw the card for a frame and then take it away, which
reads as an animation, and no animation was asked for.

The existing `Modal` is reused rather than forked — it already provides the fixed backdrop,
dismissal by backdrop tap, dialog semantics and an opaque panel, and its stated reason for
existing is that a dialog's invisible contract should not be duplicated. One change: its
title is the accessible name always and a visible heading only when a caller asks for one.
Escape stays; making a shared component take a prop to *remove* a way out is branching it to
be worse for one caller.

## Naming

The domain term is **Scorecard**, and the same word names the data and the panel. A
scorecard is a real object in card games — the thing a person keeps on paper — so the panel
does not represent the scorecard, it *is* the scorecard shown, and there is nothing to keep
in sync.

"Round history" was rejected for risking a false parallel with **move history**: the two
sound like the same kind of thing at different scales and are not. Move history is a
redacted log of *actions* that resets every deal; the scorecard is an unredacted,
match-scoped record of *outcomes*. Names that rhyme invite readers to assume the properties
rhyme.

The row and cell types are named near the round result types deliberately: a *result* is a
round revealed with hands, a *score* is a round as a number in a ledger.

## Amended: the call is yellow, not green (issue #156)

The `yaniv` tone's colour moved from green to the table's accent yellow when the call
announcement unified the game's colour language — **yellow is the call, red is the Assaf,
on the felt and on the card alike**. The semantics above are unchanged: the tone is named
for what happened rather than for the colour, so this was a stylesheet value and nothing
more, and "blue beats the call" still holds for an Assafed caller. The red-green colour
deficiency limitation named above is narrowed rather than lifted — yellow and red are
easier to tell apart than green and red, and colour is still the only encoding. See
[ADR-0018](0018-the-call-announcement.md).
