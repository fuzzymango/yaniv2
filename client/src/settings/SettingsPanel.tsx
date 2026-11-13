/**
 * The box the lobby's settings sit in, and the name they go under wherever they are shown.
 *
 * Both halves of the lobby's settings are the same thing in the same place on the screen —
 * the host's controls (`SettingsEditor`) and everybody else's read-only copy of them
 * (`SettingsValues`) — so both are drawn in this one box rather than each in its own.
 */

import type { ReactNode } from "react";

/**
 * What the settings are called, wherever they are shown — the lobby's box and the
 * in-match modal's heading. One string, because two would be two things to keep the same.
 * It lives here, with the heading that renders it; the modal takes its title from the
 * same constant so the two cannot come to say different things.
 */
export const SETTINGS_TITLE = "Room settings";

interface SettingsPanelProps {
  /**
   * Whether the box holds the host's controls rather than the read-only copy. Said outright
   * rather than read off whatever the box happens to contain, because the lobby sizes the two
   * differently (issue #263): the controls grow into the room the roster leaves, the copy
   * does not.
   */
  editable?: boolean;
  children: ReactNode;
}

export function SettingsPanel({ editable = false, children }: SettingsPanelProps) {
  return (
    <section className={editable ? "settings settings--editor" : "settings"}>
      <h2 className="settings__title">{SETTINGS_TITLE}</h2>
      {children}
    </section>
  );
}
