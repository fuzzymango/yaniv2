/**
 * A finished match: where everybody ended up, and the two things left to do — deal another
 * one, or leave.
 *
 * **A panel, not a screen** (issue #130). It is drawn over the table the match finished on,
 * where every hand is still revealed in its seat — so there is no scrim behind it and it
 * covers as little as it can: the cards it is floating over are half of what a player is
 * looking at, and dimming them to make a list of numbers louder would be dimming the thing
 * the list is about. `App.tsx` renders it as `Table`'s sibling; nothing here knows that,
 * beyond being fixed to the viewport rather than filling a column.
 *
 * Its own topbar rides above the panel all the same, because the table underneath has given
 * its own up: the settings of a match just played are worth a look (a run of rounds that
 * ended sooner than anybody expected is answered by the score it ended at), and this screen
 * is the only place left to ask from.
 *
 * Ordered by how long each player lasted, because that is what the match was decided on
 * (docs/rules.md §7) — and everyone the match named, not only whoever is still seated,
 * the roster keeping every seat it ever had. Both of those are `standings` in `shared`,
 * where the terminal harness reads them from too: how a row is drawn is this screen's
 * business, but where the rows come from is the same question on both, and two answers to
 * it are two chances to disagree about a match that is already over.
 *
 * Nothing here decides anything. Only the host may deal another match and the server is
 * what says so, answering anyone else with `NOT_HOST`; a table that has shrunk below two is
 * refused with `NOT_ENOUGH_PLAYERS`, and that refusal is shown rather than anticipated —
 * unlike a discard, there is no rulebook a client could read it out of.
 */

import type { GameError, PlayerGameView } from "@yaniv/shared";
import { standings } from "@yaniv/shared";
import { SettingsDialog } from "../settings/SettingsDialog.tsx";
import { WayOut } from "../shared/WayOut.tsx";

interface GameEndProps {
  view: PlayerGameView;
  error: GameError | null;
  busy: boolean;
  onPlayAgain: () => void;
  onExit: () => void;
  /** End the room. The host's way out of this screen — see `WayOut.tsx`. */
  onCloseRoom: () => void;
}

/** How a seat that has been given up is marked, the same word the terminal harness uses. */
const DEPARTED = "left";

/** "Ada", "Ada and Grace", "Ada, Grace and Alan" — a list punctuated the way it is said. */
function spokenList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function GameEnd({
  view,
  error,
  busy,
  onPlayAgain,
  onExit,
  onCloseRoom,
}: GameEndProps) {
  const isHost = view.hostId === view.you.id;
  const placings = standings(view);
  const winnerIds = view.winnerIds ?? [];

  /*
   * Who won, in a sentence, because a column of numbers is not an answer to the only
   * question this screen exists for. Whether it says "You" can only be decided here — it
   * depends on whose screen this is, which is why it is never sent over the wire.
   *
   * Taken off the standings rather than the roster, so a winner who has already walked away
   * is still named. A tie names everybody in it (docs/rules.md §7).
   *
   * The wire type allows no winners at all, which the server does not send at `gameEnd`.
   * Unlike a scored round with no result behind it, that costs this screen only its
   * sentence — the standings themselves are a function of the scores — so it says less
   * rather than routing somewhere else.
   */
  const winners = placings.filter((p) => winnerIds.includes(p.playerId));
  const youWon = winners.some((w) => w.playerId === view.you.id);
  const named = winners.map((w) => (w.playerId === view.you.id ? "You" : w.name));

  const headline =
    winners.length === 0
      ? "Match over"
      : winners.length === 1
        ? `${named[0]} ${youWon ? "win" : "wins"}`
        : `${spokenList(named)} tie`;

  return (
    <div className="final">
      {/*
        Alone in the bar here, as it is on the table: closing the room is in the row of
        controls on the panel, which this screen has and the table does not.
      */}
      <div className="topbar">
        <SettingsDialog settings={view.settings} />
      </div>

      {/*
        Named by the sentence it is here to deliver: a region floating over a table has no
        landmark of its own — the table under it is the page's `main` — so without this it is
        an unlabelled box to anybody arriving at it by anything but sight.
      */}
      <section className="final__panel" aria-labelledby="final-headline">
        <header className="final__header">
          <p className="code__label">Final standings</p>
          <h1 className="final__headline" id="final-headline">
            {headline}
          </h1>
          {/*
            The one rule of this screen worth saying out loud — and since elimination it is
            no longer "lowest score wins": the order is who outlasted whom, and a column of
            totals that does not run smallest-first would otherwise read as broken.
          */}
          <p className="code__hint">Last player standing wins.</p>
        </header>

        {/*
          Two columns, names down one and scores down the other, rather than a row per
          player sized by its own name: a table is read by comparing the numbers, and
          numbers that start in a different place on every line are numbers to hunt for.
          Each row is still one `li`, spanning both columns and taking their tracks with
          `subgrid`, so the list stays a list to anything not looking at it.
        */}
        <ul className="standings">
          {placings.map((player) => (
            <li
              className={[
                "standing",
                winnerIds.includes(player.playerId) ? "standing--winner" : "",
                player.departed ? "standing--departed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={player.playerId}
            >
              <span className="standing__who">
                <span className="player__name">{player.name}</span>
                {player.playerId === view.you.id && <span className="seat__mark">you</span>}
                {player.departed && <span className="seat__mark">{DEPARTED}</span>}
              </span>
              {/* "pts" spelled out, as everywhere else a score is shown. */}
              <span className="player__score">{player.score} pts</span>
            </li>
          ))}
        </ul>

        {/*
          Both of the things left to do, side by side rather than stacked: they are the two
          answers to one question, and a panel floating over a table has a width to spend
          rather than a page to fill.
        */}
        <div className="final__actions">
          {isHost ? (
            <button
              className="button button--primary"
              type="button"
              onClick={onPlayAgain}
              disabled={busy}
            >
              Play again
            </button>
          ) : (
            // Its own class rather than `notice`, which carries news that has just arrived.
            // This is a standing fact about the screen, as it is in the lobby.
            <p className="hint">The host deals another match.</p>
          )}

          {/* The lobby's two ways out, meaning the same thing here — see `WayOut.tsx`. */}
          <WayOut isHost={isHost} busy={busy} onExit={onExit} onCloseRoom={onCloseRoom} />
        </div>

        {error && (
          <p className="notice notice--error" role="alert">
            {error.message}
          </p>
        )}
      </section>
    </div>
  );
}
