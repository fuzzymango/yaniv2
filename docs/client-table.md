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
  table's corner, above the band. `RoundEnd`/`GameEnd` have no band and keep theirs in flow.
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

`RoundEnd` seats those same three sides — `revealSeats`, off `result.players` and never
`bySeat`, since a player who has given up their seat is in no `turnOrder` to be sorted
against — with the viewer's own hand flat along the bottom where they were holding it, and
the round's numbers riding on each seat's label rather than in a list of their own, so one
player reads in one place. Three things separate it from live play (issues #56, #60):

- **The arc becomes a straight cascade** (`cascadeOffset`, `cascadeFootprint`), along the
  zone's own axis (`ZONE_CASCADE`) so a doubled zone does not collide with itself: an arc
  overlaps faces at an angle, which is what makes checking a call against five hands hard.
  Nothing rotates either — a rotation says whose hand it is by making it unreadable, a fair
  trade for a fan of backs and none at all for a hand being added up.
- **A cascaded card wears its index on the edge the next card leaves showing**
  (`.cascade--*`, `CARD_INDEX_STRIP`, which `CASCADE_STEP` is chosen to clear). A face carries its
  rank in the middle, which under another card is blank card — why real cards have corners.
- **The sides are flowed into a grid, not pinned to a band** (`.round__seats`): no felt to
  keep clear, and a pinned seat contributes no height for six revealed hands to scroll
  through, which on a short phone they still must — as the flat list they replace did.
  `GameEnd` is untouched: `standings` carries no hands, so it stays a plain scoreboard.

## A move is watched crossing that table

A position arriving is a move having happened, and the cards it moved are drawn crossing the
table on their way to where the position already has them (issue #69). What moved is decided
in the session core and off the wire (`flight.ts`, "Card flight" in `CONTEXT.md`); where on
the screen it happens is `CardsInFlight.tsx`, the one file in this client that measures a
rendered element. Five decisions, none of them about the rules of anything:

- **It asks the screen, not the geometry.** Every card names itself in the markup
  (`data-card-id`, on `PlayingCard` itself), every card on screen is measured after each
  render, and a move is flown by putting the card that has landed back where it was a moment
  ago and letting go — FLIP, and `flip.ts` is the whole of the arithmetic. Nothing repeats
  what the CSS worked out, so an arc, a gap or a card size can change underneath it and a
  card still flies to where it actually lands. Only the destination boxes are trusted to
  outlive the animation, which is why the ghost is placed there and moved back rather than
  the other way round.
- **The ghost flies and the real card waits.** A card in the air leaves its landing place
  empty (`.landing .card`, `visibility` so the row is already laid out as it will settle), or
  the same card would be drawn twice — once sitting at the end of the other's journey. The
  *face* waits and never the control around it: the slapdown window opens on the viewer's own
  discard, so a hidden button would be an untappable window for the length of every flight.
- **`FLIGHT_MS` is nobody's sibling but `PACE_MS`'s.** 300ms against a 700ms beat: how long
  a card takes to cross and how long a position stays are separate questions, tied only by
  the flight having to be over inside the beat, with room to read the settled table.
- **It is decorative, and that is a constraint.** Nothing locks, delays or waits on a
  flight; a player tapping through one plays exactly as they would with none, and whatever
  is still in the air when the screen moves on is dropped mid-flight.
- **Reduced motion is asked in code, not in CSS.** The rest of the client answers
  `prefers-reduced-motion` with a stylesheet rule, but a measured animation cannot be turned
  off from one — so the preference is read as a flight that never starts, and the table is
  the one it was before any of this existed.

Today it flies the viewer's own discard (issue #72). An opponent's discard and the card
coming back the other way are the same mechanism pointed at other boxes.
