# The seated table

How the browser client arranges a table on a phone: opponents round the felt during play,
and the same seats read back once the round is scored. Extracted from `CLAUDE.md` when it
reached its length cap; the decisions are unchanged, and `CLAUDE.md` points here.

## The table is seated, and part of every seat is off the screen

Opponents are drawn round three sides of the felt (`seatZones`), each a fan of face-down
backs — one per card they are actually holding — under an upright label, in place of a row
of text. The fan is the point: a hand shrinking is something to watch rather than a number
to notice. Six decisions hold it up, in `fan.ts` and `styles.css` — five the prototype's
variant D verdict (issue #56) rather than a re-derivation, and a sixth about what the felt
had to give up to make room for the lot:

- **The fan turns and the label never does.** Rotating the cards says whose side of the
  table they are on; a name turned with them is read sideways by the only person looking.
- **A seat reserves the box its arc needs** (`fanFootprint`, off the angles the cards are
  drawn at), because a transform costs no layout space and the tips would otherwise be
  drawn across the label below — the rough edge the prototype left behind.
- **About 37% of every fan is pushed off its own edge** (`FAN_HIDDEN`, `fanOverhang`): five
  full fans do not fit round a phone's felt, shrinking them to fit read as cramped, and
  cutting each back to its tips left too little of a hand to watch (issue #58). Enough hidden
  to fit six on a phone and no more, flat at every hand size and viewport rather than scaled
  per count or width. The band is out of the column's flow and pinned to the screen, or "off
  the edge" would mean off the edge of the padding; the cards scale by height as well as
  width, since a doubled zone stacks up an edge.
- **Only the label is ringed on turn**, not the seat's box — which is mostly the space
  reserved for an arc turned inside it and hung off the edge, so a ring there reads as a box
  near a player rather than round them.
- **The table's settings icon is pinned out of flow too** (`.table > .topbar`), since the
  band covers the top of the screen the column's first row would sit in: it belongs to the
  table's corner, above the band. That is now the corner in both phases (issue #78) — the
  lobby and `GameEnd` have no band and keep theirs in flow.
- **The felt gave way to the seats** (issue #59, `.felt`): the deck stacks above the discard
  and the pair is pinned against the hand, not centred in a height the seats are out of the
  flow of and float up into — and side by side at the card size the ticket keeps, the two of
  them are wider than a 320px phone. `.turn` reserves two lines for the same reason: the pair
  sits on it, and a message that wraps on one turn and not the next would walk it up and down
  between moves. The one crossing left — a wide discard against a doubled zone's label, six
  on a short screen — goes to the cards, the felt being lifted over the band, since a label
  over a tap target reads as one out of play. The table's old desktop rule went the same way:
  centring its column carries the hand and the felt up, the seats do not.

## The scored round is the same table, read rather than watched

**Literally the same table** (issue #78): `Table.tsx` renders `playing` and `roundEnd` both,
and a round ending changes what is *in* three slots rather than which screen is up. There is
no round-end screen to jump to, so the seats do not reflow, the corner icons do not snap down
the page, and nobody has to be re-found. What changes is what changed:

- **Every hand turns face up where it already is.** An in-place content swap and no
  repositioning — instantaneous, since a player reaching a scored round is reading it, not
  waiting on it. Animating the flip is deferred.
- **Each label swaps a running score for `scoreLabel`** — the total and what the round added,
  the delta always signed so a `+0` and a gain are never confusable in a label a few
  characters wide. One function for every seat and for the viewer's own footer, which drops
  its hand value: the cards are face up by then, and adding them up is what they are for.
- **The turn line says how the round ended**, in place. A heading above the seats would push
  every one of them down the page at the one moment they must not move.
- **The Yaniv call becomes the deal** — the host's control, or the reason there is none, in
  the slot the call was in.

Seats are placed by the live roster sorted by `bySeat` in **both** phases, and the round's
own record is looked up by id against whoever is already in a zone. Two placements could
disagree; one cannot. (Mid-round leaving is impossible, so the round's recorded order and
`turnOrder` agree here in every real case — reusing one calculation forecloses the drift by
construction rather than by invariant.) A `roundEnd` with a null `roundResult` — a wire state
the server does not produce — still falls through to `Room.tsx`.

Three things still separate the revealed hand from the played one (issues #56, #60):

- **The arc becomes a straight cascade** (`cascadeOffset`, `cascadeFootprint`), along the
  zone's own axis (`ZONE_CASCADE`) so a doubled zone does not collide with itself: an arc
  overlaps faces at an angle, which is what makes checking a call against five hands hard.
  Nothing rotates either — a rotation says whose hand it is by making it unreadable, a fair
  trade for a fan of backs and none at all for a hand being added up.
- **A cascaded card wears its index on the edge the next card leaves showing**
  (`.cascade--*`, `CARD_INDEX_STRIP`, which `CASCADE_STEP` is chosen to clear). A face carries its
  rank in the middle, which under another card is blank card — why real cards have corners.
- **The seat reserves one box for both shapes** (`seatFootprint`): the larger of the arc's
  footprint and the cascade's, so the seat's own size never changes across the phase boundary
  and the reveal cannot nudge its neighbours by reflow — and the larger of the two rather than
  a fixed maximum, so a small hand still sits in a small seat. The overhang counts on the
  cascade's side of that max and along its axis alone: the seat hangs off its edge of the
  screen in both shapes, which is right for a fan of backs, so what is left on screen has to
  hold the whole of a hand somebody must read. `GameEnd` is untouched — `standings` carries no
  hands, so it stays a plain scoreboard.

## A move is watched crossing that table

A position arriving is a move having happened, and the cards it moved are drawn crossing the
table on their way to where the position already has them (issue #69). What moved is decided
in the session core and off the wire (`flight.ts`, "Card flight" in `CONTEXT.md`); which of it
the screen can actually draw is `ghosts.ts`; where on the screen it happens is
`CardsInFlight.tsx`, the one file in this client that measures a rendered element. Seven
decisions, none of them about the rules of anything:

- **It asks the screen, not the geometry.** Every card names itself in the markup
  (`data-card-id`, on `PlayingCard` itself), every card on screen is measured after each
  render, and a move is flown by putting the card that has landed back where it was a moment
  ago and letting go — FLIP, and `flip.ts` is the whole of the arithmetic. Nothing repeats
  what the CSS worked out, so an arc, a gap or a card size can change underneath it and a
  card still flies to where it actually lands. Only the destination boxes are trusted to
  outlive the animation, which is why the ghost is placed there and moved back rather than
  the other way round.
- **The deck and every seat are measured as places, being the ends that are not cards.** A
  card drawn off the deck was nowhere on the screen a moment ago — the draw pile reaches a
  client as a count — and a card in somebody else's hand is nowhere on it now, that hand
  being a count too, drawn as a fan of backs. So the deck's element and each seat's are
  measured alongside the cards (`data-flight-box`, `DECK_BOX`, `seatBox`), and stand in at
  whichever end of a journey the client was never told a card id for. One box per seat and
  not per card: a hand held there is one place however many cards are in it. The seat's box
  *is* the middle card of its fan, laid out like every other card in it, with the box that
  gets measured turned back level inside it — two elements, because the fan turns about its
  hinge and the levelling has to turn about the card's own centre, and an element has one
  `transform-origin`. The CSS still does all the trigonometry, and what is measured is
  card-shaped rather than the bounding box of a rotated card, which is wider at every angle
  but a right one.
- **A card off the deck flies face down and turns over nowhere.** It was face down where it
  started, and where it lands the hand underneath is already showing its face: a flip at the
  end would animate a fact the position had stated before the card set off. A card off the
  discard pile has been public all along and flies as itself, from the place on the pile it
  has just left. Which way up follows from where it came from, so there is one decision
  rather than two that could disagree — with one addition for somebody else's draw off the
  deck, which has no face at all for anyone but them (ADR-0007) and so flies as a back named
  by the seat it is going to. The client re-derives none of that: `ghosts.ts` passes the
  wire's redaction through, and a ghost with no face is drawn as a back.
- **The ghost flies and the real card waits.** A card in the air leaves its landing place
  empty (`.landing .card`, `visibility` so the row is already laid out as it will settle), or
  the same card would be drawn twice — once sitting at the end of the other's journey. The
  *face* waits and never the control around it: the slapdown window opens on the viewer's own
  discard, so a hidden button would be an untappable window for the length of every flight,
  and a card still arriving in hand can be tapped into a selection before it has landed. A
  landing place is a place and not a card (`Ghost.into`): one card can be drawn in two of them
  at once, since a slapdown inside a flight puts the card still arriving in the hand onto the
  pile, and the place it has genuinely reached has nothing to wait for. **A seat is the one
  landing nothing waits at**: the fan there stands for a count the position has already
  settled, so there is no card at the end of that journey to be drawn twice — and a back too
  few would misstate the count its own label states in words.
- **`FLIGHT_MS` is nobody's sibling but `PACE_MS`'s.** 300ms against a 700ms beat: how long
  a card takes to cross and how long a position stays are separate questions, tied only by
  the flight having to be over inside the beat, with room to read the settled table.
- **A slapdown is the same journey, played harder** (issue #95). One card, at twice the
  speed, on an accelerating curve where a discard decelerates, landing with a pop past its own
  size and a jolt across the whole table. Nothing in it is a second animation: the pop is a
  keyframe on the ghost already flying, and the jolt is a class the flight's own settling puts
  on the element every control is already inside — a transform, so hit-testing goes with it
  and a tap during the jolt lands where it looks like it lands.
- **Below the beat, the durations are one chain** (`timing.ts`): `SLAP_MS` a fraction of
  `FLIGHT_MS`, and the jolt a fraction of `SLAP_MS`. A slapdown is *sharper than a discard*,
  which is a ratio and not a speed — tuned as a number of its own it would be right until the
  next time the flight changed. The chain is plain arithmetic in a module of its own precisely
  so a test with no DOM near it can assert the derivations hold.
- **The jolt is the table's, not the pile's.** What a slapdown is worth showing is the room
  reacting to it; a pile that wobbled on its own would be a card doing something the position
  does not say it did. The known cost is that a transformed table is briefly the containing
  block for the settings modal, the one `fixed` thing inside it — invisible on a phone, where
  the table is the viewport, and cheaper than a wrapper around everything but the modal.
- **It is decorative, and that is a constraint.** Nothing locks, delays or waits on a
  flight; a player tapping through one plays exactly as they would with none, and whatever
  is still in the air when the screen moves on is dropped mid-flight.
- **Reduced motion is asked in code, not in CSS.** The rest of the client answers
  `prefers-reduced-motion` with a stylesheet rule, but a measured animation cannot be turned
  off from one — so the preference is read as a flight that never starts, and the table is
  the one it was before any of this existed. One gate covers all three parts of a slapdown:
  the pop rides the flight and the jolt is triggered by its finishing, so a flight that never
  happens takes both with it, and neither needs a rule of its own to suppress.

Every move at the table flies, whoever took it: the viewer's own between their hand and the
felt (issues #72, #73), and everybody else's between their seat and it (issue #74) — which is
what answers the complaint this started from, since "did they draw from the deck or the pile?"
is a question about somebody else's turn. Whose move it is decides only which boxes are asked
for; nothing downstream of `ghosts.ts` knows the difference, and a chain of bot turns is
already one position per beat, so each move flies inside its own (`pacing.ts`).
