/**
 * The three screens still to be built — the table, a scored round, a finished match —
 * standing in for each other until they are.
 *
 * The lobby has its own screen now (`Lobby.tsx`), so what is left here is every phase
 * with a dealt round behind it. Each is a function of `view.phase` and each is built as
 * it is reached; until then this at least says which room a player is in and what is
 * happening in it, so a match that has started does not look like a blank page.
 */

import type { Phase, PlayerGameView } from "@yaniv/shared";

/** The phases that reach this screen: every one with a round dealt behind it. */
export type TablePhase = Exclude<Phase, "lobby">;

/**
 * A phase is a wire token, not something to show a player — `roundEnd` names a type, not
 * a sentence. The lobby has no entry because it has its own screen, and taking the phase
 * as an already-narrowed prop is what makes that absence a typecheck rather than a cast.
 */
const HAPPENING: Record<TablePhase, string> = {
  playing: "The match is under way.",
  roundEnd: "The round is over.",
  gameEnd: "The match is over.",
};

export function Room({ view, phase }: { view: PlayerGameView; phase: TablePhase }) {
  return (
    <main className="screen room">
      <p className="code__label">Room {view.roomCode}</p>
      <p className="room__phase">{HAPPENING[phase]}</p>
      <p className="code__hint">You are {view.you.name}</p>
    </main>
  );
}
