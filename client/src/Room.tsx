/**
 * The screen for a position that has none of its own.
 *
 * Every phase a match passes through is built now — `Lobby.tsx`, `Table.tsx`,
 * `RoundEnd.tsx`, `GameEnd.tsx` — so what is left here is the one position the wire type
 * allows and the server does not produce: `roundEnd` with a null `roundResult`, where
 * saying what is happening beats a blank page or a component asserting its way past a
 * result that is not there.
 *
 * It keeps a `phase` prop, narrowed by `App`'s earlier returns, for what that costs
 * nothing: a phase added to the union with no screen behind it fails to typecheck here
 * rather than landing a player on a page that describes a different position.
 */

import type { Phase, PlayerGameView } from "@yaniv/shared";

/** The phases that reach this screen: today, the one that should not arrive here at all. */
export type UnscreenedPhase = Exclude<Phase, "lobby" | "playing" | "gameEnd">;

/**
 * A phase is a wire token, not something to show a player — `roundEnd` names a type, not a
 * sentence. The phases with screens of their own have no entry, and taking the phase as an
 * already-narrowed prop is what makes those absences a typecheck rather than a cast.
 */
const HAPPENING: Record<UnscreenedPhase, string> = {
  roundEnd: "The round is over.",
};

export function Room({ view, phase }: { view: PlayerGameView; phase: UnscreenedPhase }) {
  return (
    <main className="screen room">
      <p className="code__label">Room {view.roomCode}</p>
      <p className="room__phase">{HAPPENING[phase]}</p>
      <p className="code__hint">You are {view.you.name}</p>
    </main>
  );
}
