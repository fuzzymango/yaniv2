# The host may remove a lobby seat

ADR-0012 left the lobby with one way out, your own: `exitToMenu` takes the seat of whoever invokes
it and nobody else's. That leaves a table with no answer when a stranger gets the invite code, a
friend joins twice from two devices, or a phone drops out and its row just says "away". Everyone
wanting to play without that seat had to leave and make a new room.

Decided: **in the lobby, the host may free any other seat, and that seat is all it costs.**
Requested in #252, specified in #254.

- **Lobby only, host only.** `kickPlayer` is refused `WRONG_PHASE` outside the lobby and `NOT_HOST`
  from anyone but the host, the same two refusals as the role's other powers. Once the cards are
  out nobody is host, so nobody can kick.
- **It is a leave somebody else asks for.** `kickPlayer` checks the phase, the host and the target,
  then hands off to `removePlayer`'s lobby branch, so there is one splice for both. The target is
  never the host, so `hostId` does not move.
- **The target is a claim until checked.** It arrives as `unknown`, on `updateSettings`' grounds. A
  non-string, an id that is no seat here and the host's own id are all `PLAYER_NOT_FOUND`. No new
  error code: a host's own client sends an id that is no seat here only when the target left first,
  which the roster already shows, so that refusal is silent (`SILENT_KICK`). Only an off-contract
  client can send the other two, and the host's own way out is `exitToMenu`.
- **Nothing is kept of the seat, so nothing is banned.** The player may join the same code again
  and gets a new seat, with a new id and token. A signed-in player is not handed the old seat back,
  because it no longer exists to be claimed.
- **One tap, no confirm.** What it costs is undone by typing the code again. A ✕ ignores taps for
  400ms after any tap and after the rows move (`KICK_HOLD_MS`): the rows below close up once the
  ack arrives, and a tap meant for one player would otherwise remove the next. An ignored tap
  still counts, so a burst of taps removes one player. The hold lives in `Lobby` because it is
  about where a finger is, not about the session.
- **`Rooms.kick` is `leave`'s sibling**, on ADR-0025's grounds: stored, observers told, `accepted`
  called, published, reconsidered. It answers the kicked seat's id and name rather than a
  `Departure`, because the host is still seated and it can never end the room.
- **The kicked connection is released and told.** Inside `accepted` the adapter sends it `kicked`,
  clears its seat and takes it out of the socket.io room, so `ALREADY_IN_ROOM` does not follow it
  and no later broadcast reaches it. Its account binding and its socket are untouched.
- **A seat with no connection is kicked the same way**, and there is nobody to tell. When that
  player comes back, the claim is refused `INVALID_RESUME_TOKEN`, which the client already words as
  "That game is no longer available." With no ban list, the room has no record to say more from.

## This amends ADR-0012

ADR-0012 says "no player can end anybody else's game". That now reads: no player can end anybody
else's game, **nor take anybody's seat once the cards are out**.

It does not reopen what 0012 was protecting against. Its objection to `closeRoom` was one misplaced
thumb ending four other people's match. A lobby seat holds no hand, no score and no place in a
match, and it can be had again by rejoining. The two rules 0012 cares about both stand: a kick
never ends a room, and the role still retires at the first deal.

## Considered options

- **A ban list** — rejected. Rooms are joined by invite code, so a list would be guarding something
  already private, and a guest has no identity to ban beyond a connection. A host who wants someone
  gone kicks again or starts the match.
- **Kicking mid-match** — rejected. It would need the role 0012 retired, or a vote, and a seat in a
  match has a hand and a score in play. What an absent seat does mid-round is its own open question,
  listed out of scope in `CLAUDE.md`.
- **A confirm step** — rejected: there is little to protect, and the lobby's other host controls
  have none.
- **`removePlayer` as the wire name** — rejected: that is the transition every exit goes through, so
  the word would mean two things. The wire says `kickPlayer` and `kicked`, and the domain says
  **kick**.

## Consequences

- `removePlayer` is still the one transition that writes `hostId`. A kick passes through it without
  ever reaching that case.
- `exitToMenu` is no longer the only way a seat leaves a room, though it is still the only way a
  player leaves one themselves.
- The toast a kicked player sees is news rather than a refusal, which ADR-0027 did not foresee; it
  is amended where that is built.
- The CLI harness gets no kick command, as it has no settings or scorecard, but it has to cope with
  being kicked.
