/**
 * The two screens still to be built — a scored round and a finished match — standing in
 * for each other until they are.
 *
 * The lobby and the table have their own screens now (`Lobby.tsx`, `Table.tsx`), so what
 * is left here is the two phases that show a round already played. Each is a function of
 * `view.phase` and each is built as it is reached; until then this at least says which
 * room a player is in and what is happening in it, so a finished round does not look like
 * a blank page.
 */

import type { Phase, PlayerGameView } from "@yaniv/shared";

/** The phases that reach this screen: the ones with a finished round behind them. */
export type FinishedPhase = Exclude<Phase, "lobby" | "playing">;

/**
 * A phase is a wire token, not something to show a player — `roundEnd` names a type, not
 * a sentence. The phases with screens of their own have no entry, and taking the phase as
 * an already-narrowed prop is what makes those absences a typecheck rather than a cast.
 */
const HAPPENING: Record<FinishedPhase, string> = {
  roundEnd: "The round is over.",
  gameEnd: "The match is over.",
};

export function Room({ view, phase }: { view: PlayerGameView; phase: FinishedPhase }) {
  return (
    <main className="screen room">
      <p className="code__label">Room {view.roomCode}</p>
      <p className="room__phase">{HAPPENING[phase]}</p>
      <p className="code__hint">You are {view.you.name}</p>
    </main>
  );
}
