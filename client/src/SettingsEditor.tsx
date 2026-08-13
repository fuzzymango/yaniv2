/**
 * The host's four choices for the room, and the only screen in this client that edits
 * anything but a hand.
 *
 * Every control here offers exactly what `isValidSettings` accepts and nothing else — the
 * option sets and the range come from `@yaniv/shared` (ADR-0002), and `settings.ts` is
 * what turns them into what a control may put on offer. `INVALID_SETTINGS` exists for a
 * client that is off the contract, and this one stays on it rather than discovering the
 * rule by being refused.
 *
 * Nothing here decides who may edit: the editor is shown to the host alone as the same
 * courtesy the start control is, and the server is what says `NOT_HOST` and `WRONG_PHASE`.
 *
 * Each change is sent whole, because that is the shape of the event — a room is never
 * half-way between one set of choices and another (docs/adr/0006).
 */

import { useState } from "react";
import type { HandSize, RoomSettings, YanivThreshold } from "@yaniv/shared";
import {
  HAND_SIZES,
  MAX_SCORE_LIMITS,
  YANIV_THRESHOLDS,
  botSeatLimit,
  effectiveBotCount,
  isValidSettings,
} from "@yaniv/shared";
import { SettingsPanel } from "./SettingsValues.tsx";
import { sameSettings, wholeNumber } from "./settings.ts";

interface SettingsEditorProps {
  settings: RoomSettings;
  /**
   * How many people are in the room. Every seat in a lobby holds one — bots are seated at
   * `startGame` and not before — so the roster is the count, and it is what the bot
   * control has left to offer.
   */
  humanCount: number;
  busy: boolean;
  onChange: (settings: RoomSettings) => void;
}

interface ChoicesProps<T extends number> {
  label: string;
  options: readonly T[];
  /** Which option is on. Not typed as `T`: a stored bot count can sit above what the table currently offers. */
  chosen: number;
  busy: boolean;
  onChoose: (option: T) => void;
}

/**
 * One row of a settings form: a label, and the values it may take laid out as a row of
 * chips.
 *
 * Chips rather than a `<select>` because a phone is what this is played on — every option
 * is a tap target of its own, visible without opening anything, and there are never more
 * than six of them. The chosen one carries `aria-pressed`, so a screen reader is told
 * which it is without relying on the colour that says so on screen.
 */
function Choices<T extends number>({
  label,
  options,
  chosen,
  busy,
  onChoose,
}: ChoicesProps<T>) {
  return (
    <div className="setting">
      <span className="setting__label">{label}</span>
      {/*
        Named again for a screen reader rather than pointed at the label beside it: the
        chips carry bare numbers, and "5, pressed" out of context says nothing about what
        five of anything is.
      */}
      <div className="chips" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            className={`chip ${option === chosen ? "chip--on" : ""}`}
            type="button"
            key={option}
            aria-pressed={option === chosen}
            disabled={busy}
            onClick={() => onChoose(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsEditor({
  settings,
  humanCount,
  busy,
  onChange,
}: SettingsEditorProps) {
  /**
   * The last whole set of choices sent, until the room comes back saying the same thing —
   * or null, when the room's own settings are all there is to show.
   *
   * This is what makes four controls out of one whole-object event. A second tap builds on
   * what the first one asked for rather than on the position on screen, which may still be
   * the one before it: an edit is acked as soon as the server has it, but the view behind
   * it arrives separately and can be held back a beat by the pacer (see `pacing.ts`). Two
   * quick taps read from the screen would send the second with the first still undone in
   * it, and the room would land on hand size 5 a moment after the host asked for 6.
   *
   * It is a draft of a form and nothing more, which is why it lives here rather than in the
   * session core: nothing outside this screen has any use for a setting nobody has been
   * told about yet. A refusal would leave it standing, since a refused edit is broadcast to
   * nobody — but every way one can be refused takes this screen with it (the phase moved on,
   * or the room did), so there is nothing left to be stale.
   */
  const [asked, setAsked] = useState<RoomSettings | null>(null);

  /* The room has caught up with what was asked for, so it is the room that is read again. */
  if (asked !== null && sameSettings(asked, settings)) setAsked(null);

  const shown = asked ?? settings;

  /**
   * What the host has typed into the score field and not yet finished typing, or null
   * when the field is simply showing the number the room is set to.
   *
   * The one free-form control here, so the one that can hold something meaningless
   * half-way through — "1" on the way to "150", or nothing at all while the field is
   * being cleared. A control bound straight to the room would fight the typing, so the
   * typing lives here until it is committed and the room is read from otherwise.
   */
  const [typed, setTyped] = useState<string | null>(null);
  const shownScore = typed ?? String(shown.maxScore);

  /**
   * One control's worth of change, sent as the whole object the event asks for — and only
   * if the whole object is one the room would take.
   *
   * That guard is `isValidSettings`, the same one the server judges the payload by
   * (ADR-0002). The chips cannot produce anything it refuses, since their options are its
   * own; the typed score is why it is asked at all.
   */
  const change = (choice: Partial<RoomSettings>): void => {
    const next = { ...shown, ...choice };
    if (!isValidSettings(next)) return;

    setAsked(next);
    onChange(next);
  };

  /**
   * The score field, finished with. What it says goes to `change`, which sends it only if
   * the room would take it; anything else — half-typed, not a number, past the end of the
   * range — is dropped, and the field goes back to the room's own number.
   *
   * None of that is an error to report: it is a field nobody finished, and the `min`/`max`
   * on the input is what says so before it gets this far.
   */
  const commitScore = (): void => {
    const maxScore = wholeNumber(typed ?? "");
    setTyped(null);
    if (maxScore !== null && maxScore !== shown.maxScore) change({ maxScore });
  };

  return (
    <SettingsPanel>
      <Choices<HandSize>
        label="Hand size"
        options={HAND_SIZES}
        chosen={shown.handSize}
        busy={busy}
        onChoose={(handSize) => change({ handSize })}
      />

      <Choices<YanivThreshold>
        label="Yaniv at"
        options={YANIV_THRESHOLDS}
        chosen={shown.yanivThreshold}
        busy={busy}
        onChoose={(yanivThreshold) => change({ yanivThreshold })}
      />

      <label className="setting">
        <span className="setting__label">Match ends at</span>
        {/*
          The one setting with no list to choose from, so the one control that is typed
          into. It commits when the field is left rather than on every keystroke: a room
          is not set to 2, then 25, then 250 on the way to a host typing 250, and only the
          last of those would survive the lock the first takes.
        */}
        <input
          className="field__input field__input--score"
          type="number"
          inputMode="numeric"
          min={MAX_SCORE_LIMITS.min}
          max={MAX_SCORE_LIMITS.max}
          step={1}
          value={shownScore}
          disabled={busy}
          onFocus={() => setTyped(null)}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={commitScore}
          // Enter on a phone keyboard means "done with this field", which is what leaving
          // it means here too — so it is the same thing rather than a second way in.
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>

      <Choices<number>
        label="Bots"
        // Only the seats the humans have left, recomputed as they arrive and leave. A host
        // who asked for more is not refused — the number simply means less than they asked
        // for (docs/adr/0006), and this is that same reading, one step earlier.
        options={Array.from({ length: botSeatLimit(humanCount) + 1 }, (_, n) => n)}
        chosen={effectiveBotCount(shown, humanCount)}
        busy={busy}
        onChoose={(botCount) => change({ botCount })}
      />
    </SettingsPanel>
  );
}
