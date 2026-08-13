/**
 * The room's four settings, read-only.
 *
 * The same rows in both places a player can be shown settings they cannot change: the
 * lobby, on everyone's screen but the host's, and the modal behind the in-match icon, on
 * everyone's including the host's. One component rather than two listings, so a value
 * cannot be worded one way before the deal and another way after it.
 *
 * Plainly not a control: text in a description list, with nothing to tap and nothing that
 * looks tappable. That is the whole of what "read-only" means here — the rule that
 * settings are the host's and the lobby's alone is the server's, and it answers anyone
 * else with `NOT_HOST` or `WRONG_PHASE`.
 */

import type { ReactNode } from "react";
import type { RoomSettings } from "@yaniv/shared";

/**
 * What the settings are called, wherever they are shown — the lobby's box and the
 * in-match modal's heading. One string, because two would be two things to keep the same.
 */
export const SETTINGS_TITLE = "Room settings";

/**
 * The box the lobby's settings sit in, whether they are the host's controls or everybody
 * else's read-only copy of them. Both are the same thing in the same place on the screen,
 * so both are the same box.
 */
export function SettingsPanel({ children }: { children: ReactNode }) {
  return (
    <section className="settings">
      <h2 className="settings__title">{SETTINGS_TITLE}</h2>
      {children}
    </section>
  );
}

interface SettingsValuesProps {
  settings: RoomSettings;
  /**
   * How many bots to say, which is not always `settings.botCount`.
   *
   * In the lobby it is what the table can actually seat right now (`effectiveBotCount`),
   * because a host asking for more than there is room for is read back down rather than
   * refused (docs/adr/0006) — so the lobby shows what starting the match would deal. Once
   * the match is running there is no such question left and no way to ask it either: the
   * wire does not say which seats are bots, so the modal shows the room's own number.
   */
  botCount: number;
}

export function SettingsValues({ settings, botCount }: SettingsValuesProps) {
  return (
    <dl className="values">
      <div className="value">
        <dt className="value__label">Hand size</dt>
        <dd className="value__number">{settings.handSize} cards</dd>
      </div>
      <div className="value">
        {/* Worded as the rule reads (docs/rules.md §6): a call is legal *at or under* it. */}
        <dt className="value__label">Yaniv at</dt>
        <dd className="value__number">{settings.yanivThreshold} or less</dd>
      </div>
      <div className="value">
        <dt className="value__label">Match ends at</dt>
        <dd className="value__number">{settings.maxScore} pts</dd>
      </div>
      <div className="value">
        <dt className="value__label">Bots</dt>
        {/* "none" rather than a nought, because it is the answer to "who am I playing?" */}
        <dd className="value__number">{botCount === 0 ? "none" : botCount}</dd>
      </div>
    </dl>
  );
}
