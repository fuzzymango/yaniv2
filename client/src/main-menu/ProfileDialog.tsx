/**
 * A signed-in player's own account, held up over the main menu: a person icon in the
 * menu's corner, and the account's six stats behind it (#228, docs/adr/0026).
 *
 * The first place the counters this repo has kept since #166 are seen, and the only one —
 * the profile is the main menu's and nowhere else's, so nothing about an account stands
 * over a hand being played. A guest is offered none, there being nothing in it for them,
 * and neither is a player still confirming their name, who has no account yet to show;
 * `MainMenu` draws this only once the standing is `signedIn`.
 *
 * **The stats are read every time it opens** (`onOpen`, the session's `loadStats`), never
 * remembered from the last time: a match finished since would otherwise be missing from
 * it. The session blanks them on the way in, so a reopened profile starts from dashes and
 * never shows the last visit's numbers as this one's. What was read, and whose, is the
 * session core's (`stats`) and not state here — it has to go the moment the account does,
 * which is a rule about the account standing, not about a panel.
 *
 * Whether the panel is open is this component's own, as `SettingsDialog`'s is: nothing on
 * the wire knows or cares that somebody is looking at it. It takes no `busy`, since
 * reading stats is not an action and locks nothing.
 */

import { useState } from "react";
import type { Stats } from "@yaniv/shared";
import { Modal } from "../shared/Modal.tsx";

const PROFILE_TITLE = "Profile";

/**
 * The six rows, in the order they are drawn: the match-level counts before the
 * round-level ones, so the headline numbers come first. Each labelled with the name the
 * game uses for it (`CONTEXT.md`'s **Stats**), and each a raw count — nothing derived.
 */
const ROWS: ReadonlyArray<readonly [keyof Stats, string]> = [
  ["gamesCompleted", "Games completed"],
  ["gamesWon", "Games won"],
  ["yanivCalls", "Yaniv calls"],
  ["callsAssafed", "Calls Assafed"],
  ["assafs", "Assafs"],
  ["slapdowns", "Slapdowns"],
];

/**
 * Drawn rather than loaded, like the settings' sliders: a head and shoulders, which is
 * what a profile icon looks like everywhere else. `aria-hidden`, because the button around
 * it already says what it is in words.
 */
function PersonIcon() {
  return (
    <svg
      className="topbar__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}

/**
 * Every row laid out from the first frame, with a dash where a number has not arrived:
 * the panel neither jumps when the answer lands nor spins while it waits, and a read that
 * is refused costs nothing but the numbers.
 */
function StatsTable({ stats }: { stats: Stats | null }) {
  return (
    <dl className="values">
      {ROWS.map(([stat, label]) => (
        <div className="value" key={stat}>
          <dt className="value__label">{label}</dt>
          <dd className="value__number">{stats === null ? "–" : stats[stat]}</dd>
        </div>
      ))}
    </dl>
  );
}

interface ProfileDialogProps {
  /** The account's stats as last read, or null while they are being read or were refused. */
  stats: Stats | null;
  /** Read the stats afresh — called every time the profile opens. */
  onOpen: () => void;
}

export function ProfileDialog({ stats, onOpen }: ProfileDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="topbar__button"
        type="button"
        aria-label={PROFILE_TITLE}
        title={PROFILE_TITLE}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          onOpen();
          setOpen(true);
        }}
      >
        <PersonIcon />
      </button>

      {open && (
        // The backdrop, the Close below and Escape all land here — see `Modal.tsx`.
        <Modal title={PROFILE_TITLE} onDismiss={() => setOpen(false)}>
          <StatsTable stats={stats} />

          <button className="button" type="button" autoFocus onClick={() => setOpen(false)}>
            Close
          </button>
        </Modal>
      )}
    </>
  );
}
