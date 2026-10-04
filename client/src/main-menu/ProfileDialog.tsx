/**
 * A signed-in player's own account, held up over the main menu: a person icon in the
 * menu's corner, and behind it the account's name — renamed in place, here and nowhere
 * else (#229) — over its six stats (#228, docs/adr/0026), its two custom calls (#237), and
 * the way to sign out (#230).
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
 * showing a refusal under the field instead — one message in the one place the player
 * is looking, as `NameDialog` does. The error is put down on the way in and on the way out,
 * so anything on the screen while the panel is open is an answer about something typed in it.
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
 * **The custom calls are shown as the table would shout them** (#237): upper-cased the way
 * the banner is, in the banner's yellow or red, and — where the player has chosen none — the
 * banner's own `YANIV` or `ASSAF`, dimmed. Each row is edited exactly as the name is, by the
 * same editor, an empty save putting the banner's word back. Unlike a name, a call is asked
 * of `shared`'s rule here rather than in the session, which sends a call as given: the
 * refusal is worded by this panel, the server judging it again regardless (ADR-0002).
 *
 * **The panel does one thing at a time** — showing, editing one field, or confirming the
 * sign-out — one value (`Panel`) rather than a flag per field, so opening one editor closes
 * another by construction and tapping sign-out mid-edit unmounts the field and its draft
 * with it, cancelling coming back to the profile, not to the field. It is this component's,
 * reset every time the panel opens. An edit already sent is not a draft and is not called
 * back: tapping sign-out or another pencil while one is out leaves Sign out disabled and the
 * new field read-only until it is answered, and the answer lands on whatever is showing — a
 * rename landing closes a call's field opened behind it, a refusal shows under it, or is
 * cleared unseen on the way back to the profile. A race of one tap against one round trip,
 * accepted.
 *
 * **Escape backs out one level.** `Modal` catches it on its wrapper, so an editor and the
 * confirmation each stop the key there and go back to showing the profile; from there it
 * reaches `Modal` and closes it.
 */

import { useState } from "react";
import { MAX_CUSTOM_CALL_LENGTH, normalizeCustomCall } from "@yaniv/shared";
import type { Call, GameError, Stats } from "@yaniv/shared";
import type { AccountStanding } from "../session.ts";
import { CALL_WORD } from "../announcement.ts";
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

/** What the panel has to edit: the account's name, and its two custom calls (#237). */
type Field = "name" | Call;

/**
 * What the panel is doing, as one value, so it can only be doing one thing: showing,
 * editing one field, or asking about the sign-out.
 *
 * **An edit lasts for as long as the standing it was opened `over` is still the one on the
 * screen**, the rule the main menu's rename panel used before the profile replaced it: the
 * session replaces the standing when an edit lands — even to the same value — and keeps it
 * when one is refused (pinned in the session suite), so the field closes on the answer that
 * means "done" and stays open, the reason under it, on the one that means "not that". No
 * effect watches for either.
 *
 * `returnTo` is the field whose editor closed last, so its pencil takes the focus back: an
 * input that unmounts with the focus in it leaves it on the page behind the panel, where
 * `Modal` would never hear the second Escape. `autoFocus` acts on mount alone — which is why
 * a pencil and its field are separate returns, the pencil remounting when the field closes —
 * so the first open still gives the focus to Close. An edit outlived by its standing returns
 * to its own pencil the same way.
 */
type Panel =
  | { readonly kind: "showing"; readonly returnTo: Field | null }
  | { readonly kind: "editing"; readonly field: Field; readonly over: SignedIn }
  | { readonly kind: "confirming" };

const SHOWING: Panel = { kind: "showing", returnTo: null };

/** How each call is named on its controls, the banner's word being no sentence. */
const CALL_NAME: Record<Call, string> = {
  yaniv: "Yaniv call",
  assaf: "Assaf call",
};

/**
 * The profile's own sentence for a call the shared rule refuses, as the session words its
 * own for a name: the rule is `shared`'s, its wording each caller's. Asked before sending so
 * a typo is not a round trip, the server applying the same rule regardless (ADR-0002).
 */
const UNUSABLE_CALL = `Enter up to ${MAX_CUSTOM_CALL_LENGTH} letters, digits, single spaces and ! ? . , ' -`;

interface PencilProps {
  label: string;
  autoFocus: boolean;
  onClick: () => void;
}

/** The pencil beside something that can be changed in place. */
function Pencil({ label, autoFocus, onClick }: PencilProps) {
  return (
    <button
      className="topbar__button"
      type="button"
      aria-label={label}
      title={label}
      autoFocus={autoFocus}
      onClick={onClick}
    >
      <PencilIcon />
    </button>
  );
}

interface EditInPlaceProps {
  /** The field's accessible name, and the save button's. */
  label: string;
  saveLabel: string;
  /** What the field opens with, focused and selected. */
  initial: string;
  placeholder?: string;
  autoComplete: string;
  /**
   * The panel's own check, asked before `onSave` and answered with a refusal to show, or
   * null to send. Absent where the session asks the rule itself, as it does for a name.
   */
  refuse?: (draft: string) => string | null;
  /** The session's refusal, shown under the field while the panel is open. */
  error: GameError | null;
  busy: boolean;
  onSave: (draft: string) => void;
  onCancel: () => void;
}

/**
 * The field that swaps in for a value and its pencil, with a tick and a cross (#229): the
 * name's editor first, and each custom call's the same one (#237), so the three behave alike
 * by construction. The rest of the panel stays where it is: editing takes the player nowhere.
 *
 * The draft is this component's own, and so is a refusal it answered itself: a value
 * half-typed is no use outside the field holding it, and the field mounts afresh on every
 * open, so neither can outlive the edit it belongs to.
 */
function EditInPlace({
  label,
  saveLabel,
  initial,
  placeholder,
  autoComplete,
  refuse,
  error,
  busy,
  onSave,
  onCancel,
}: EditInPlaceProps) {
  const [draft, setDraft] = useState(initial);
  const [refusal, setRefusal] = useState<string | null>(null);
  const message = refusal ?? error?.message ?? null;

  return (
    <form
      className="profile__edit"
      onSubmit={(event) => {
        event.preventDefault();
        const refused = refuse?.(draft) ?? null;
        setRefusal(refused);
        if (refused === null) onSave(draft);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // One level at a time: the edit, not the profile around it.
        event.stopPropagation();
        onCancel();
      }}
    >
      <div className="profile__row">
        <input
          className="field__input profile__input"
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          autoComplete={autoComplete}
          enterKeyHint="done"
          autoFocus
          // Selected as well as focused, so retyping a value does not start by clearing it.
          onFocus={(event) => event.target.select()}
          // Read-only rather than disabled while an edit is out: a disabled control drops
          // the focus, and with it Escape and the chance to retype after a refusal. The two
          // buttons are left enabled for the same reason — the session ignores an edit sent
          // while one is out, and cancelling one leaves nothing on screen for its answer.
          readOnly={busy}
        />
        <button
          className="topbar__button"
          type="submit"
          aria-label={saveLabel}
          title={saveLabel}
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
          onClick={onCancel}
        >
          <CrossIcon />
        </button>
      </div>

      {message !== null && (
        <p className="notice notice--error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

/**
 * A custom call as the table would shout it: upper-cased the way the banner will be, in the
 * banner's colour — yellow the Yaniv, red the Assaf — or, unset, the banner's own word,
 * plain and dimmed, which is what the table says instead.
 */
function CallValue({ call, text }: { call: Call; text: string | null }) {
  return text === null ? (
    <strong className="profile__call profile__call--unset">{CALL_WORD[call]}</strong>
  ) : (
    <strong className={`profile__call profile__call--${call}`}>{text.toLocaleUpperCase()}</strong>
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
  /** Whose profile it is — the standing, not only the account, so an edit can see it land. */
  standing: SignedIn;
  /** The account's stats as last read, or null while they are being read or were refused. */
  stats: Stats | null;
  /** The session's, shown under whichever field is being edited. */
  error: GameError | null;
  busy: boolean;
  /** Whether the panel is up — the main menu's to hold, for the reason above. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read the stats afresh — called every time the profile opens. */
  onLoadStats: () => void;
  onRename: (displayName: string) => void;
  /** Set one custom call; an empty text puts the banner's own word back. */
  onSetCustomCall: (call: Call, text: string) => void;
  onClearError: () => void;
  onSignOut: () => void;
}

/** Each call's text on the account, by the call — the account's two fields, read as one. */
const callText = (standing: SignedIn, call: Call): string | null =>
  call === "yaniv" ? standing.account.customYanivCall : standing.account.customAssafCall;

/**
 * The rule asked before a call is sent, refused in the profile's own words. What passes is
 * sent as typed, the server trimming it by the same rule — empty, after that, unsetting it.
 */
const refuseCall = (draft: string): string | null =>
  normalizeCustomCall(draft).accepted ? null : UNUSABLE_CALL;

export function ProfileDialog({
  standing,
  stats,
  error,
  busy,
  open,
  onOpenChange,
  onLoadStats,
  onRename,
  onSetCustomCall,
  onClearError,
  onSignOut,
}: ProfileDialogProps) {
  const [panel, setPanel] = useState<Panel>(SHOWING);

  /** The field being edited, if any — none once the standing it was opened over is gone. */
  const editing = panel.kind === "editing" && panel.over === standing ? panel.field : null;
  const returnTo =
    panel.kind === "showing" ? panel.returnTo : panel.kind === "editing" ? panel.field : null;
  const { displayName } = standing.account;

  /** Open one field's editor, closing whichever other one was open: one thing at a time. */
  const edit = (field: Field) => {
    onClearError();
    setPanel({ kind: "editing", field, over: standing });
  };

  /** Back to showing: a refusal left over from anything cancelled has nothing to answer. */
  const showProfile = (from: Field | null) => {
    onClearError();
    setPanel({ kind: "showing", returnTo: from });
  };

  const close = () => {
    onClearError();
    onOpenChange(false);
  };

  const callRow = (call: Call) => {
    const text = callText(standing, call);
    return editing === call ? (
      <EditInPlace
        key={call}
        label={`Your ${CALL_NAME[call]}`}
        saveLabel={`Save ${CALL_NAME[call]}`}
        initial={text ?? ""}
        placeholder={CALL_WORD[call]}
        autoComplete="off"
        refuse={refuseCall}
        error={error}
        busy={busy}
        onSave={(draft) => onSetCustomCall(call, draft)}
        onCancel={() => showProfile(call)}
      />
    ) : (
      <div className="profile__row" key={call}>
        <CallValue call={call} text={text} />
        <Pencil
          label={`Change ${CALL_NAME[call]}`}
          autoFocus={returnTo === call}
          onClick={() => edit(call)}
        />
      </div>
    );
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
          setPanel(SHOWING);
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
            {panel.kind !== "confirming" && (
              <button
                className="topbar__button"
                type="button"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => {
                  onClearError();
                  setPanel({ kind: "confirming" });
                }}
              >
                <SignOutIcon />
              </button>
            )}
          </div>

          {panel.kind === "confirming" ? (
            <ConfirmSignOut
              displayName={displayName}
              busy={busy}
              onSignOut={onSignOut}
              onCancel={() => showProfile(null)}
            />
          ) : (
            <>
              {editing === "name" ? (
                <EditInPlace
                  label="Your name"
                  saveLabel="Save name"
                  initial={displayName}
                  autoComplete="nickname"
                  error={error}
                  busy={busy}
                  onSave={onRename}
                  onCancel={() => showProfile("name")}
                />
              ) : (
                <div className="profile__row">
                  <strong className="menu__name">{displayName}</strong>
                  <Pencil
                    label="Change name"
                    autoFocus={returnTo === "name"}
                    onClick={() => edit("name")}
                  />
                </div>
              )}

              <StatsTable stats={stats} />

              <section className="profile__calls" aria-labelledby="profile-calls">
                <h3 className="profile__heading" id="profile-calls">
                  Custom calls
                </h3>
                {callRow("yaniv")}
                {callRow("assaf")}
              </section>

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
