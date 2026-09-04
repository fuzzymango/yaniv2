# The call announcement: a one-shot banner over the seat, on a timing chain of its own

A Yaniv call is the most consequential moment in a round — a player stakes the round on
holding the lowest hand and either takes it or is Assafed for 30 — and the table barely
acknowledged it. The news was a small grey `yaniv` / `assaf` chip in a seat's score row and
one line of coloured text above the felt, both the same size and weight as everything else on
a screen that has just filled with revealed hands. The single loudest event in the game
arrived quieter than the cards around it, and the Assaf — the reversal — was worse served
than the call. Issue #124 asks for the announcement; issue #156 specifies it.

Decided: a **call announcement** — a large, transient banner drawn over the seat of the
player a call belongs to, `YANIV` in the table's accent yellow and `ASSAF` in its danger red,
staged so the call lands before the answer to it, held together, and faded out together.

## It is an event, not table state

The client already draws that distinction and the **card flight** is the precedent: a flight
is decided once as a position reaches the screen, published on the session snapshot, and
cleared by everything published after it. The announcement takes exactly that shape — a
position nobody watched arrive has nothing to announce.

It also fills a hole the flight explicitly leaves. A Yaniv call is the one broadcast that
leaves *both* facts a flight is read from where they were, so it produces no flight at all.
The announcement is the Yaniv call's counterpart to one.

`SessionSnapshot.announcement` is therefore decided at the same point in the publication path
as `flight` and cleared under the same rule: cleared on every publication except the one
drawing it. A component that re-renders reads the same announcement; playing it exactly once
is the animating layer's job, as it is for a flight.

The consequences are accepted rather than worked around. A reload during a scored round never
shows it. A reconnect does not replay it. A player who deals quickly truncates it. The line
above the felt and the scorecard are what carry the round after it has gone.

## The freshness key is the scorecard's length

"There is a round result in this view" is **not** a safe trigger. `lastRoundResult` is
match-scoped and is not cleared between rounds; a disconnect republishes the room, a departure
republishes it, and a departure-caused match end reaches `gameEnd` carrying the *previous*
round's result behind it. Any of those would replay an announcement, or invent one for a call
nobody made.

The key is instead the **number of scored rounds**. The scorecard is sent whole in every phase
and grows by exactly one row per scored round ([ADR-0017](0017-the-scorecard.md)), so a row
that was not there a moment ago *is* a round that was just scored. Every failure case above is
made impossible rather than handled: none of those paths adds a row.

The newest row is also what the announcement is read *from*, rather than `roundResult` beside
it — taking the key and the content from one fact leaves no second fact to disagree with it.

The coupling to the scorecard is accepted and is commented at both ends: in
`client/src/announcement.ts` and at the append in `server/src/game.ts`. If a row were ever
written for something other than a scored round, this would break silently.

## It fires at match end as well as round end

The round result is populated at **both** `roundEnd` and `gameEnd`, so a match-winning Yaniv
never arrives as a `roundEnd`. Triggering on `roundEnd` alone would leave the most dramatic
call of a match as the one call with no announcement. The scorecard key is phase-agnostic and
is therefore correct in both without naming either.

The match-end panel renders over the top as it renders over everything else, and is explicitly
**not** delayed to let the announcement finish: which screen is showing is a function of the
phase, and gating a screen on an animation timer is the effect-chasing-the-phase pattern this
client has deliberately avoided.

## A second timing root, and why it is not derived from the flight

`client/src/timing.ts` states a doctrine in prose: one chain, every link a fraction of the one
above it, so the table is retuned from one number and a second constant tuned to look right
beside the first cannot go stale. **This adds a second root, and the departure is the
decision.**

The existing chain's links are parts of *one move* — a slapdown's aftershock genuinely should
shorten when the slapdown does. The announcement has no such causal relationship to how fast a
card crosses a table. Deriving it from the flight would mean speeding up card animations
quietly drains the tension out of an Assaf: correct by the letter of the doctrine, wrong by
its reason.

Each root is honestly bounded by the thing that actually constrains it — the flight by the
server's **bot think time** ([ADR-0011](0011-bot-think-time-paces-the-server.md)), the
announcement by the server's **auto-deal delay**
([ADR-0014](0014-auto-dealing-a-bots-only-table.md)), inside which the whole sequence must
comfortably finish so a watcher sees the round they are watching.

```
ANNOUNCE_MS       = 900         // root: how long the banner (or pair) is held
ANNOUNCE_LEAD_MS  = /2  → 450   // YANIV alone before ASSAF joins it
ANNOUNCE_ENTER_MS = /3  → 300   // a banner's arrival
ANNOUNCE_EXIT_MS  = /2  → 450   // the pair leaving together
```

Entrance is faster than exit on purpose: a banner should arrive with a snap and leave without
one. An Assafed round totals 1.8s, a clean call 1.35s. `ANNOUNCE_MS` is three times
`FLIGHT_MS` **by coincidence and not by relationship**, which is stated in the file because the
ratio will otherwise be noticed and "fixed".

This is the decision in this change most likely to be undone by accident, which is why it is
written down here as well as on the constant.

## The sequence is CSS, with no JavaScript timer

The whole timeline is declarative — two elements at fixed offsets, no branching after the
first frame — so it is keyframes, with the second banner's delay taken from its index in the
ordered tuple and the durations passed down from `timing.ts` as custom properties, so the
numbers stay where a test can assert them.

The decisive advantage is cancellation: if the announcement is cleared mid-sequence the
elements unmount and the animation goes with them. There is no timer to cancel, so none can
leak or fire against a table that has moved on. A component-held state machine was rejected
because this client tests by *not* putting branches in components; a session-held timer was
rejected because the session core is driven under test with no clock.

Faded-out banners stay mounted until the next publication clears them, and are therefore inert
to pointer events — an invisible box that ate a tap meant for a card is the one way this could
cost somebody a move.

## What the pure module answers, and what shape it answers in

`client/src/announcement.ts` sits beside the client's other pure, total decision modules and
mirrors `flightFrom`'s signature: the position on screen and the position that has arrived in,
an announcement or nothing out.

```ts
type Announcement = readonly [Banner] | readonly [Banner, Banner] | null;
```

The tuple union follows this codebase's habit of making bad states unrepresentable rather than
guarding them: an empty announcement and a third banner are both impossible, and "nothing to
announce" has one spelling. The ordering guarantee — the call first — is what lets each
banner's delay fall out of its index with no conditional anywhere near a component.
`bannerAt` asks the same question from one seat's point of view, which is the branch the
screen would otherwise be trusted with.

## Rendering is CSS-positioned inside the box it belongs to

The banner is anchored to the **person**, not centred on the felt: over an opponent's seat
when it is them, over the viewer's own hand row when it is the viewer. Position is what says
who, which is the whole difference between this and a larger copy of the line above the felt.

It is **not** a measured overlay. DOM measurement stays contained to `CardsInFlight.tsx`,
which needs it because a card genuinely travels between two distant boxes; a banner does not
travel — it sits on one box already positioned and already sized by the seat's reserved
footprint. The component owns all of its own styling and its two parents supply nothing but
the fact that it should be there, so the call sites cannot drift.

The viewer's own anchor is the **revealed hand, not the live hand**. The caller can be the
player the round knocks out, and at that scored round they still have a hand row, read off the
round's own record — being dimmed out of the *next* round does not retract the last one. From
the following deal on they are a spectator with a bar and no hand row, and can never be the
caller then.

Two pieces of real CSS work follow: seats allow the banner to overflow their bounds, and a
stacking context puts it above neighbouring seats' cards.

## Reduced motion keeps the banner and the beat

`prefers-reduced-motion` is a request not to be moved, not a request to be told less. The same
elements, the same staging, the same delays — with the entrance's transform stripped so it
cross-fades.

This differs from the card flight, which is skipped outright under the same preference, and
the difference is justified: a flight is redundant with a position that can be read at
leisure, whereas the entire premise here is that the quieter treatment was insufficient.
Answering an accessibility preference by reverting to the treatment we just called too quiet
would make the accessible path the worse-informed one.

## Yellow is the call, red is the Assaf, everywhere

The table already used the accent yellow for a call that stood and the danger red for one that
was Assafed. The banner reuses both tokens rather than introducing dedicated ones. The
overloading objection — the accent yellow also means "yours, and not yet played" — dissolves
on the phase: that meaning only ever appears during play, and the banner only ever appears on
a scored round, so the two are never on screen together.

The scorecard is brought into line: its call tone moves from green to the same accent yellow.
Its Assaf red and milestone blue are unchanged. The cell tone type is semantic
(`"yaniv" | "assaf" | "milestone"`), so this was a stylesheet value and no logic moved.

And the now-redundant `yaniv` / `assaf` chips come out of the scored seat's badge row.
`milestone` and `out` stay — they are the two facts nothing else on the table records, and
`out` remains the loudest of the row, being the only one with consequences beyond the round.

## What is tested, and what deliberately is not

Three seams, one of them new. The pure module gets direct unit tests, including every path
that must **not** announce — a republish, a departure-caused match end, a seat claimed back.
The session suite drives a real socket server and asserts the field arrives where a screen
would read it, that a whole match announces exactly its scored rounds in order, and that the
final call is announced at `gameEnd`. The timing suite asserts the derivations and that the
two chains are independent.

Collapsing the new seam into the session suite was considered and rejected: it would mean
driving a real server to a *specific* Assafed round with a known caller to assert ordering,
which is expensive and flaky for decisions that are pure arithmetic over two views. The card
flight sets the precedent exactly — its own unit suite *and* session coverage of the wiring.

The component and the stylesheet are not tested, which is the consequence of putting every
branch in a pure module and is why the renderer is left with a lookup and no conditional of
its own.
