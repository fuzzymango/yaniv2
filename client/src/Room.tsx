/**
 * The screen still to be built — a finished match — and the fallback for a scored round
 * that arrives without the round it scored.
 *
 * Everything else has a screen of its own now (`Lobby.tsx`, `Table.tsx`, `RoundEnd.tsx`),
 * so what is left here is `gameEnd`, which is built when it is reached. `roundEnd` reaches
 * this only in the position the wire type allows and the server does not produce — a
 * scored round with a null `roundResult` — where saying what is happening beats a blank
 * page or a crash.
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
