# Yaniv — Domain Context

Vocabulary for talking about the shape of the game's state, as distinct from the rules of
play (`docs/rules.md`). This file grows lazily — a term gets added when a design
conversation actually needs it, not up front.

## Lobby vs. active

A `GameState` is either **lobby** or **active**:

- **Lobby** — a room exists, players may join, no round has been dealt yet. There is no
  hand, no draw pile, no discard pile; there is nothing to serialize into a table view.
- **Active** — a round has been dealt. This spans three phases (`playing`, `roundEnd`,
  `gameEnd`) that all carry a live round — `roundEnd` and `gameEnd` still hold the just-
  finished round's hands and piles, revealed face up, until the host deals the next one
  or the match ends. "Active" names *this* — the round is populated — not "a turn is
  currently being taken."

This split is what `GameStateLobby` / `GameStateActive` (`server/src/state.ts`) are named
after: the domain distinction came first, the types are just making it real.
