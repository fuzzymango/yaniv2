/**
 * A signed-in player's own account, held up over the main menu: a person icon in the
 * menu's corner, and behind it the account's name — renamed in place, here and nowhere
 * else (#229) — over its six stats (#228, docs/adr/0026), and the way to sign out (#230).
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
 * Whether the panel is open is the main menu's rather than this component's, unlike
 * `SettingsDialog`'s, for one reason: while it is open the menu shows no error, the panel
 * showing a refused name under the field instead — one message in the one place the player
 * is looking, as `NameDialog` does. The error is put down on the way in and on the way out,
 * so anything on the screen while the panel is open is an answer about a name typed in it.
 * Nothing on the wire knows or cares that somebody is looking at it.
 *
 * **Signing out is asked before it is done, and asked here alone** (#230): an icon in the
 * header, opposite the title and as far from Close as the panel allows, swaps the panel's
 * contents for "Sign out of <name>?" with Cancel holding the focus, so a mis-tap on an icon
 * or an Enter pressed out of habit costs nothing. It forgets the seat as well as the account
 * (docs/adr/0020), which is why it lives on a panel the main menu alone opens. Confirmed, the
 * standing becomes a guest's at once and the menu puts the profile down in render; nothing
 * here closes it.
 *
 * **The panel does one thing at a time** — showing, editing the name, or confirming the
 * sign-out. The confirmation is drawn *instead of* the editor, so tapping sign-out mid-rename
 * unmounts the field and its draft with it, and cancelling comes back to the name, not to
 * the field. Whether it is confirming is this component's, reset every time it opens. A
 * rename already sent is not a draft and is not called back: tapping sign-out while one is
 * out leaves Sign out disabled until it is answered, and a refusal of it is cleared unseen
 * on the way back — a race of one tap against one round trip, accepted.
 *
 * **Escape backs out one level.** `Modal` catches it on its wrapper, so the name editor and
 * the confirmation each stop the key there and go back to showing the profile; from there
 * it reaches `Modal` and closes it.
 */

import { useState } from "react";
import type { GameError, Stats } from "@yaniv/shared";
import type { AccountStanding } from "../session.ts";
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

/** A door with an arrow leaving it: the account, not the panel, being left. */
function SignOutIcon() {
  return (
    <svg
      className="topbar__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" />
      <path d="M16 8l4 4-4 4" />
      <line x1="20" y1="12" x2="10" y2="12" />
    </svg>
  );
}

/** The pencil: a name that can be changed. */
function PencilIcon() {
  return (
    <svg
      className="topbar__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13 7l4 4" />
    </svg>
  );
}

/** The tick: keep what was typed. */
function CheckIcon() {
  return (
    <svg
      className="topbar__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

/** The cross: put back what was there. */
function CrossIcon() {
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
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

type SignedIn = Extract<AccountStanding, { status: "signedIn" }>;

interface EditNameProps {
  standing: SignedIn;
  error: GameError | null;
  busy: boolean;
  onRename: (displayName: string) => void;
  onClearError: () => void;
}

/**
 * The account's name and a pencil beside it, and the pencil swapping the name for a field
 * with a tick and a cross (#229). The stats below stay where they are either way: renaming
 * does not take the player anywhere.
 *
 * **Editing lasts for as long as the standing it was opened over is still the one on the
 * screen**, the rule the main menu's rename panel used before this replaced it: the session
 * replaces the standing when a rename lands — even to the same name — and keeps it when one
 * is refused (pinned in the session suite), so the field closes on the answer that means
 * "done" and stays open, the reason under it, on the one that means "not that". No effect
 * watches for either.
 *
 * The draft is this helper's own: a name half-typed is no use outside the field holding it.
 */
function EditName({ standing, error, busy, onRename, onClearError }: EditNameProps) {
  const [editingFrom, setEditingFrom] = useState<SignedIn | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * Whether the field has been open since the profile was, so the pencil takes the focus
   * back when it closes: an input that unmounts with the focus in it leaves it on the page
   * behind the panel, where `Modal` would never hear the second Escape. `autoFocus` acts on
   * mount alone — which is why the pencil and the field are separate returns, the pencil
   * remounting when the field closes — so the first open still gives the focus to Close.
   */
  const [returnFocus, setReturnFocus] = useState(false);
  const editing = editingFrom === standing;
  const { displayName } = standing.account;

  const cancel = () => {
    onClearError();
    setEditingFrom(null);
  };

  if (!editing) {
    return (
      <div className="profile__name">
        <strong className="menu__name">{displayName}</strong>
        <button
          className="topbar__button"
          type="button"
          aria-label="Change name"
          title="Change name"
          autoFocus={returnFocus}
          onClick={() => {
            onClearError();
            setDraft(displayName);
            setEditingFrom(standing);
            setReturnFocus(true);
          }}
        >
          <PencilIcon />
        </button>
      </div>
    );
  }

  return (
    <form
      className="profile__edit"
      onSubmit={(event) => {
        event.preventDefault();
        onRename(draft);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // One level at a time: the edit, not the profile around it.
        event.stopPropagation();
        cancel();
      }}
    >
      <div className="profile__name">
        <input
          className="field__input profile__input"
          aria-label="Your name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoComplete="nickname"
          enterKeyHint="done"
          autoFocus
          // Selected as well as focused, so retyping a name does not start by clearing it.
          onFocus={(event) => event.target.select()}
          // Read-only rather than disabled while the rename is out: a disabled control drops
          // the focus, and with it Escape and the chance to retype after a refusal. The two
          // buttons are left enabled for the same reason — the session ignores a rename sent
          // while one is out, and cancelling one leaves nothing on screen for its answer.
          readOnly={busy}
        />
        <button
          className="topbar__button"
          type="submit"
          aria-label="Save name"
          title="Save name"
          // The field keeps the focus through a click: Safari gives none to a clicked button,
          // so it would otherwise fall to the page, and a refusal — which leaves the field up —
          // would leave Escape with nowhere to land.
          onMouseDown={(event) => event.preventDefault()}
        >
          <CheckIcon />
        </button>
        <button
          className="topbar__button"
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onClick={cancel}
        >
          <CrossIcon />
        </button>
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </form>
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

interface ConfirmSignOutProps {
  displayName: string;
  busy: boolean;
  onSignOut: () => void;
  onCancel: () => void;
}

/**
 * The question in place of the profile's contents. Cancel is first and takes the focus, as
 * the leave-table question's Stay does — the answer an accidental tap wants, and somewhere
 * inside the panel for Escape to be caught. Sign out is disabled while anything else is out,
 * the session ignoring an account event sent over one.
 */
function ConfirmSignOut({ displayName, busy, onSignOut, onCancel }: ConfirmSignOutProps) {
  return (
    <div
      className="profile__confirm"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // One level at a time: the question, not the profile around it.
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="profile__question">
        Sign out of <strong>{displayName}</strong>?
      </p>

      <div className="modal__choice">
        <button className="button" type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button className="button" type="button" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </div>
    </div>
  );
}

interface ProfileDialogProps {
  /** Whose profile it is — the standing, not only the account, so a rename can see it land. */
  standing: SignedIn;
  /** The account's stats as last read, or null while they are being read or were refused. */
  stats: Stats | null;
  /** The session's, shown under the name while it is being edited. */
  error: GameError | null;
  busy: boolean;
  /** Whether the panel is up — the main menu's to hold, for the reason above. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read the stats afresh — called every time the profile opens. */
  onLoadStats: () => void;
  onRename: (displayName: string) => void;
  onClearError: () => void;
  onSignOut: () => void;
}

export function ProfileDialog({
  standing,
  stats,
  error,
  busy,
  open,
  onOpenChange,
  onLoadStats,
  onRename,
  onClearError,
  onSignOut,
}: ProfileDialogProps) {
  const [confirming, setConfirming] = useState(false);

  /** Back to showing: a refusal left over from anything cancelled has nothing to answer. */
  const showProfile = () => {
    onClearError();
    setConfirming(false);
  };

  const close = () => {
    onClearError();
    onOpenChange(false);
  };

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
          onClearError();
          onLoadStats();
          setConfirming(false);
          onOpenChange(true);
        }}
      >
        <PersonIcon />
      </button>

      {open && (
        // The backdrop, the Close below and Escape all land here — see `Modal.tsx`.
        // The title is drawn here rather than by `Modal`, so the sign-out icon can share its row.
        <Modal title={PROFILE_TITLE} showTitle={false} onDismiss={close}>
          <div className="profile__header">
            <h2 className="modal__title">{PROFILE_TITLE}</h2>
            {!confirming && (
              <button
                className="topbar__button"
                type="button"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => {
                  onClearError();
                  setConfirming(true);
                }}
              >
                <SignOutIcon />
              </button>
            )}
          </div>

          {confirming ? (
            <ConfirmSignOut
              displayName={standing.account.displayName}
              busy={busy}
              onSignOut={onSignOut}
              onCancel={showProfile}
            />
          ) : (
            <>
              <EditName
                standing={standing}
                error={error}
                busy={busy}
                onRename={onRename}
                onClearError={onClearError}
              />

              <StatsTable stats={stats} />

              {/* Remounted on the way back from the question, so it takes the focus again. */}
              <button className="button" type="button" autoFocus onClick={close}>
                Close
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
