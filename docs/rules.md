# Yaniv — Rules Specification

This document is the source of truth for the game engine. Every rule here should map to
at least one unit test. If gameplay and this document disagree, the document is right and
the code is a bug.

Variants deliberately **excluded** from this ruleset are listed at the bottom.

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
- The **host** starts round 1. In every later round, the player who *won* the previous
  round starts (see §6).

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
- **A run of three or more consecutive cards of the same suit.** For example
  `4♥ 5♥ 6♥`. Ace is low, and runs do not wrap past King.

Jokers are **not wild** in this ruleset — a joker has no suit and so can never be part of
a run, and can only pair with the other joker.

Runs are stored in ascending rank order regardless of the order the player submitted them,
so that "first and last card" is unambiguous. Same-rank sets keep the submitted order.

---

## 5. The discard pile

The pile has two parts:

- **`lastDiscard`** — the set the most recent player discarded. It lies face up, and only
  its **first and last cards** may be picked up. If it is a single card, that card is the
  only option.
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

There is no score reduction on hitting a round number — see excluded variants.

---

## 8. Excluded variants

These are common in other Yaniv rulesets and are deliberately **not** implemented. Each
would be added as an explicit rule flag, never as scattered special cases.

- **100/50 halving** — landing exactly on 100 dropping you to 50.
- **Wild jokers** — jokers substituting for a missing card in a run.
- **Slapdown** — discarding a just-drawn matching card out of turn. This one also
  conflicts with the engine's atomic-turn model and would require revisiting it.
- **Multi-deck play.**
