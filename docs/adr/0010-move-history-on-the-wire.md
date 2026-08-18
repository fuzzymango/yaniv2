# The round keeps a move log, sent whole and redacted per entry

A player who looks away loses everything but the move that happened to be last. The discard
pile shows the current lay and not who put it there or what they took in exchange; a
slapdown leaves no trace once its card is buried under the next set; `lastMove` and
`lastSlapdown` are each one fact, overwritten by the next of their kind. Issue #89 asks for
a drawer on the felt listing the round's moves, and issue #90 for the half of it the server
owns: the moves themselves, on the wire, before anything renders them.

Decided: `RoundState.moveHistory` — every turn and every slapdown of the round, oldest
first, appended by `takeTurn` and `slapDown` on the same fresh round object that already
writes `lastMove`/`lastSlapdown`, and emptied by `dealRound` because round state is replaced
wholesale. A turn's entry carries the mover, the set they laid down, the pile they drew from
and the card; a slapdown's, the slapper and the card. Carried to every client as
`PlayerGameView.moveHistory`, in full, in every phase a round exists in — `roundEnd`
included, where reading the round back is exactly what a player is doing.

The two kinds are **tagged** (`kind: "turn" | "slapdown"`) rather than told apart by which
fields are filled in, the distinction `CardFlight` already draws on the client and for the
same reason: a turn's `drawnCard` is nullable on the wire, so "nothing came back" and "you
may not be told what did" would otherwise be the same absence.

**Uncapped, and unsuppressed.** A round is bounded by its own deck, so the list is short by
construction; a cap would be a rule about how far back a player may look, and `docs/rules.md`
has no such rule to point at. How much of it a drawer shows at once is the client's.

## Why this reopens ADR-0007

ADR-0007 chose `lastMove` as "one fact, overwritten by the next turn — deliberately not a
move log, which is a bigger thing to own (replays, round history) than the one gap this
fills." That was the right call for the gap it was filling: a client that needs to *animate*
the move it just received needs the latest move and nothing else, and a log bought at that
price would have been speculative.

It is no longer speculative — issue #89 asks for round history by name, which is one of the
two things ADR-0007 named as the bigger thing. So the log is now owned deliberately, and
what ADR-0007 decided about `lastMove` is left standing rather than replaced: `lastMove` and
`lastSlapdown` stay the single facts a client watches for *change*, and are **not** derived
from the log. "The newest entry tagged `turn`" would answer the same question today and
start moving the day a third kind of move joined the list, and a flight is a thing that
either just happened or did not — a question about the tail of a growing array is a worse
way to ask it. Two writes per transition, and a test on each.

Replays — the other thing ADR-0007 named — remain out of scope: this is round-scoped, dies
with the deal, and is never persisted.

## Redaction is ADR-0007's rule, applied per entry

`toMoveHistoryView` sits beside `toLastMoveView` in `serialize.ts` and shares its predicate
outright (`drawnCardFor`): a card drawn off the **deck** is named to the mover alone, since
it is a card of a hidden hand; a card taken off the **discard pile** is named to everyone,
having been face up a moment before it was taken; a **slapdown** passes through whole, on
ADR-0008's grounds. One rule, not a looser one for older moves — a card that was the mover's
alone when they drew it does not become everybody's for having scrolled up the list.

The rule earns considerably more here than it does one field along. A single withheld card
is a card; a round of them, unredacted, is every opponent's hand in order. So the boundary
is tested as the serializer's others are, including a deliberately broken serializer kept in
the suite to prove the leak test can fail.

## What the log newly makes public: buried cards

A turn's entry carries its **discarded set**, which `lastMove` did not need — `lastDiscard`
already held it, for the latest move. A history cannot lean on that: `lastDiscard` only ever
holds the current lay, and the sets before it have been buried.

So a set that has since been buried is now named on the wire, where before it reached a
client only inside `buriedCount`. This gives nothing away. Every player watched that set land
face up on the table; `buried` is a count on the wire to keep payloads small, not to keep a
secret, and `docs/rules.md` treats those cards as public throughout. The one thing that stays
hidden about the buried pile is its **order once reshuffled into the draw pile**, and the log
says nothing about order in a pile — only about the order the moves were made in.
