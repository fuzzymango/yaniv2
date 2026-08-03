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

## Main menu vs. lobby

Two distinct concepts, easy to conflate because both sit "before the game":

- **Main menu** — a client-side, room-less screen. No `GameState` exists yet; there is no
  room code and nothing on a server to point at. Its only options are to create a lobby,
  join one by code, or quit the application.
- **Lobby** — `GameState.phase === "lobby"` (see above): a room already exists
  server-side, has a code, and players are staged in it up to the player cap.

**Exit to main menu** is the action that leaves a room and returns to the main menu. It
is available in the lobby and at `gameEnd` only — not mid-match (`playing`/`roundEnd`),
where the only way to leave today is still a hard disconnect that ends the room for
everyone. It is asymmetric by who invokes it, the same way in both phases:

- A **non-host** player exiting is removed from `players` entirely — their seat is freed,
  not held or bot-replaced. The room lives on for whoever remains: the lobby for the rest
  to join and start, or the finished match's scoreboard for the host to still choose
  between playing again and exiting.
- The **host** exiting closes the room outright — every other human player is booted to
  the main menu, told the room closed because the host quit.

## Play again

Starts a fresh match in the same room, for the same host and the same seated players
(minus anyone who has exited to the main menu since the last game ended) — scores,
hands, and the deck all reset, and the next round is dealt immediately. It does not stop
at the lobby the way ending a match used to require; only the host may invoke it, and
only from `gameEnd`. See [ADR-0001](docs/adr/0001-random-starting-player.md) for who
opens the new match.
