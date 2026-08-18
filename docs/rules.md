# Yaniv — Rules Specification

This document is the source of truth for the game engine. Every rule here should map to
at least one unit test. If gameplay and this document disagree, the document is right and
the code is a bug.

Variants deliberately **excluded** from this ruleset are listed in §8.

---

## 1. Cards

A single standard 52-card deck plus 2 jokers = **54 cards**.

Card values (used for hand scoring and for the Yaniv threshold):

| Rank | Value |
|------|-------|
| Ace | 1 |
| 2–10 | face value |
| Jack, Queen, King | 10 |
| Joker | 0 |

Each card has a stable `id`. Real cards use `"{suit}-{rank}"` (`hearts-K`, `spades-7`);
jokers are `joker-1` and `joker-2`. Ids are unique because there is exactly one deck. If
multi-deck support is ever added, ids must gain a copy suffix or become UUIDs.

**Rank ordering for runs** uses Ace low: A=1, 2–10, J=11, Q=12, K=13. There is no wrap —
`A-2-3` is a legal run, `Q-K-A` is not.

---

## 2. Players and setup

- A room holds **2–6 players**.
- Each player is dealt **5 cards**.
- After dealing, one card is turned face up from the draw pile to start the discard.
  That card is available to be picked up by the first player.
- Turn order is join order, and does not change between rounds.
- The player who opens round 1 is chosen **uniformly at random** from the seated
  players (see [ADR-0001](adr/0001-random-starting-player.md)). In every later round,
  the player who *won* the previous round starts (see §6).

---

## 3. A turn

On your turn you do exactly one of two things:

**A. Discard, then draw** (the normal turn), as one indivisible action:

1. **Discard** a valid set from your hand (§4). At least one card.
2. **Draw** exactly one card, from either:
   - the top of the **draw pile** (face down), or
   - the **first or last card** of the set the *previous* player discarded (§5).

**B. Call Yaniv** (§6), if your hand is worth 7 or less. This replaces the turn entirely —
you do not discard and do not draw.

Because you always discard at least one card and draw exactly one, a hand can never grow.

---

## 4. Valid discard sets

A discard is valid if it is one of:

- **A single card.** Always valid.
- **Two or more cards of the same rank.** (Two jokers count as a pair — both are rank
  Joker.)
- **A run of three or more consecutive cards of the same suit,** in which **jokers are
  wild** and may stand in for any missing card. For example `4♥ 5♥ 6♥`, `7♥ 8♥ Joker`
  (the joker playing as 6♥ or 9♥), or `5♥ Joker Joker 8♥`. Ace is low, and runs do not
  wrap past King — `Q♥ K♥ A♥` is not a run.

Two further constraints on runs:

- All the **non-joker** cards must share a suit. A joker has no suit and is exempt.
- A run needs at least **two real cards** to anchor it, so `Joker Joker 5♥` is not a run.

Jokers are wild in **runs only**. They do not complete a same-rank set: `7♥ 7♠ Joker` is
not three of a kind. Two jokers together are still a valid pair, since both are rank Joker.

### How a run is laid out

Runs are stored in ascending rank order regardless of the order the player submitted them,
so that "first and last card" is unambiguous. Same-rank sets keep the submitted order.

A joker filling an interior gap has only one possible position. A joker that *extends* the
run is ambiguous — `7♥ 8♥ Joker` could be 6-7-8 or 7-8-9 — and the player's own ordering
decides it: **jokers placed before the first real card extend downwards, the rest extend
upwards.** This matters because only the two end cards of a discard can be picked up, so
the choice controls what the next player is offered.

That preference is overridden only where the run would run off the end of the deck. A
joker cannot sit below the ace or above the king, so `Q♥ K♥ Joker` is always stored as
`Joker Q♥ K♥`, and `Joker A♥ 2♥` as `A♥ 2♥ Joker`.

---

## 5. The discard pile

The pile has two parts:

- **`lastDiscard`** — the set the most recent player discarded. It lies face up, and which
  of its cards may be picked up depends on its shape: a **run** exposes only its **first
  and last cards**; a **same-rank set** (any length 2+) exposes **every card** in it. If
  it is a single card, that card is the only option.
- **Buried cards** — everything discarded before that. Face up but out of play; they can
  never be picked up.

Sequencing within a turn matters: you pick up from the set that was on the table **when
your turn began** (the previous player's discard). Once your turn resolves, whichever of
those cards you did not take becomes buried, and your own discard becomes the new
`lastDiscard` for the next player.

**Draw pile exhaustion.** If the draw pile is empty when someone draws from it, the buried
cards are shuffled to form a new draw pile. The current `lastDiscard` stays on the table
and is not shuffled in.

---

## 6. Calling Yaniv

At the start of your turn, if the total value of your hand is **7 or less**, you may call
Yaniv. The round ends immediately and all hands are revealed.

- If **no other player** has a hand worth less than or equal to the caller's, the call
  succeeds. The caller scores **0**. Everyone else scores their hand value.
- If **any other player** has a hand worth less than or equal to the caller's, that is an
  **Assaf**. The caller scores their hand value **+ 30**. The Assafer scores **0**.
  Everyone else scores their hand value.

Ties favour the Assafer: a player equal to the caller's value still Assafs them.

If several players qualify to Assaf, the one with the **lowest hand value** does. If they
are still tied, it is the one who comes first in turn order starting from the player after
the caller.

The **round winner** — who starts the next round — is the Assafer if there was an Assaf,
otherwise the caller.

---

## 7. Scoring and end of match

Round scores accumulate. The match ends as soon as any player's total is **greater than
100**. The player with the **lowest** total wins; ties mean multiple winners.

Whenever a round adds to a player's total (a positive score for that round) and the
resulting total lands **exactly** on a multiple of 50, that player's score drops by 50 on
the spot, before the match-end check runs — which can pull them back under 100 and save
them from busting. The round winner (whose own delta is 0) never triggers this, even if
already sitting on a multiple of 50, and a round that jumps past a multiple without landing
on it exactly (45 → 53, say) triggers nothing. At most one reduction per player per round,
however large the delta. Landing on 100 is not special-cased as a first or only trigger —
150, 200 and every later multiple of 50 reduce exactly the same way. Always on, for every
match — there is no setting that turns it off.

A finished match may be **played again** by the same table: every score returns to 0, the
round count starts over, and round 1 is dealt straight away with its opening player drawn
at random exactly as in §2. Anyone who has left in the meantime is simply not in the new
match — their seat is not refilled.

---

## 8. Excluded variants

These are common in other Yaniv rulesets and are deliberately **not** implemented. Each
would be added as an explicit rule flag, never as scattered special cases.

- **Jokers wild in same-rank sets** — jokers are wild in runs (§4) but do not complete
  three of a kind.
- **Multi-deck play.**

---

## 9. Slapdown

If you discard a **same-rank set or a single card** and then draw from the **draw pile** a
card of that **same rank**, you may put it straight back down on top of the set you just
discarded, out of turn. Your hand shrinks by one, and you have shed a card for free.

This does **not** consume a turn: the turn passed to the next player the moment your
discard-and-draw resolved (§3), and it stays there. A slapdown only takes a card off your
hand and adds it to `lastDiscard`, which — being a same-rank set — leaves every card in it
pickup-eligible, the slapped one included (§5).

Four conditions, all required:

- The discard was a **same-rank set or a lone card**. Never a run: a run has no single
  rank to match.
- The draw came from the **draw pile**. A card picked up from the discard pile never
  qualifies, however well it matches.
- The drawn card's **rank matches** the discard's.
- The drawn card is **not a joker**. Two jokers do form a same-rank set, so a joker drawn
  after discarding one would otherwise qualify — but a joker is worth nothing, so there is
  nothing to shed.

**The window is brief.** It opens when your turn resolves and closes on the first of:

- you slap the card down, or
- the next player takes their turn or calls Yaniv (§6) — whichever the server processes
  first wins, with no pause held open for you. See
  [ADR-0005](adr/0005-slapdown-race-by-event-order.md).

Only the player who drew the card can slap it, and only while their own window is open.

If a slapdown leaves you holding **no cards at all**, your next turn has no legal discard
— a turn must discard at least one card (§3) — so calling Yaniv is your only move. A hand
worth 0 is always under the threshold, so the call always succeeds.
