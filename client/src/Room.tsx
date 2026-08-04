/**
 * A room, reduced to the one thing a player needs the moment they are in one: its code,
 * large enough to read across a table.
 *
 * Every screen from here on is a function of `view.phase` — the lobby, the table, a
 * scored round, a finished match — and each is built as it is reached. Until then this
 * stands in for all four, so a player who has just created or joined a room can see
 * that they are in it and share the code.
 */

import type { PlayerGameView } from "@yaniv/shared";

export function Room({ view }: { view: PlayerGameView }) {
  return (
    <main className="screen room">
      <p className="room__label">Room code</p>
      {/*
        Letter-spaced in CSS rather than run together: these are four unrelated
        characters, read out one at a time and not pronounced as a word.
      */}
      <p className="room__code">{view.roomCode}</p>
      <p className="room__hint">Read it out to whoever is playing with you.</p>
      <p className="room__you">You are {view.you.name}</p>
    </main>
  );
}
