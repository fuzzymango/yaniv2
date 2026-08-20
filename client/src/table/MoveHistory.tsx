/**
 * The round read back: every move made since the deal, newest first, in a drawer on the
 * left edge of the felt (issues #89, #91).
 *
 * The table shows one moment. The discard pile is the current lay and says nothing about
 * who put it there or what they took in exchange; a slapdown leaves no trace once its card
 * is buried under the next set; `lastMove` and `lastSlapdown` are each one fact, overwritten
 * by the next of their kind. This is the log they are not — what a player who looked away,
 * or who dropped and came back, reads to catch up. See "Move history" in `CONTEXT.md`.
 *
 * **A pass-through and nothing else.** The entries arrive on the view in the order they
 * happened and are reversed for reading; the redaction has already been applied per entry by
 * the server (`toMoveHistoryView`, docs/adr/0010), so a `drawnCard` of null here is not a
 * gap to fill in but the answer: that card is not this viewer's to know, and it is drawn
 * face down exactly as it is everywhere else in this client. There is no rule of its own in
 * this file, which is why there is no test for it either — see `useSession.ts` on what is
 * tested in this client and what is not.
 *
 * **Open or closed is this component's alone.** It has no server round trip behind it and
 * nothing else on the screen changes with it, so it is `useState` rather than a field of
 * `SessionSnapshot` — and closed on every fresh mount, deliberately: nothing writes it down,
 * so a new round, a reconnect and a reload all start with the felt uncovered.
 */

import { useState } from "react";
import type {
  MoveHistoryEntryView,
  SlapdownHistoryEntryView,
  TurnHistoryEntryView,
} from "@yaniv/shared";
import { PlayingCard } from "../shared/PlayingCard.tsx";

interface MoveHistoryProps {
  /** The round's moves, oldest first, as the wire sends them. */
  entries: readonly MoveHistoryEntryView[];
  /**
   * Who a mover is, by id. An entry names a seat and not a player — the same choice the
   * round's own record makes — so the name is looked up against the roster on the screen.
   */
  nameOf: (playerId: string) => string;
}

/**
 * A card nobody at this seat is entitled to see: the back, at the size of the icons around
 * it. Written here rather than asked of `PlayingCard`, which draws a card it is *given* —
 * there is no card to give it, which is the whole point of a redacted draw.
 */
function FaceDown() {
  return <span className="card card--back card--mini" />;
}

/**
 * One turn: the set that went down, and the card that came back off the pile it came off.
 *
 * The two halves are separated by where the draw came from, because that is the one thing
 * about a turn that is neither a card nor a name — a word rather than an icon, since "the
 * deck" is a pile and not a card, and drawing a back for it would say the card came from
 * somewhere face down, which is a different fact.
 */
function TurnEntry({ entry, who }: { entry: TurnHistoryEntryView; who: string }) {
  return (
    <li className="history__move">
      <span className="history__who">{who}</span>
      <span className="history__cards">
        {entry.discarded.map((card) => (
          <PlayingCard card={card} mini key={card.id} />
        ))}
        <span className="history__from">
          {"▹"}
        </span>
        {entry.drawnCard === null ? <FaceDown /> : <PlayingCard card={entry.drawnCard} mini />}
      </span>
    </li>
  );
}

/**
 * One slapdown, marked as its own kind of move rather than laid out like a shortened turn:
 * a slapdown is not a turn (docs/rules.md §9, and "Turn model" in `CLAUDE.md`), and a row
 * that read as a turn with the draw missing would be saying the wrong thing about it.
 */
function SlapdownEntry({
  entry,
  who,
}: {
  entry: SlapdownHistoryEntryView;
  who: string;
}) {
  return (
    <li className="history__move history__move--slap">
      <span className="history__who">{who}</span>
      <span className="history__cards">
        <span className="history__slap">slap</span>
        <PlayingCard card={entry.card} mini />
      </span>
    </li>
  );
}

export function MoveHistory({ entries, nameOf }: MoveHistoryProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="history">
      {/*
        The arrow, and the whole of the control. It stays on the edge whether the drawer is
        out or not, so the tap that puts it away is in the place the tap that pulled it out
        was — a control that moved with the panel would be a second thing to find.
      */}
      <button
        className="history__toggle"
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide the round's moves" : "Show the round's moves"}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{open ? "‹" : "›"}</span>
      </button>

      {/*
        Only drawn while it is open: a closed drawer is the arrow and nothing else, so a
        round's worth of rows is not sitting off-screen being laid out and scrolled past.
      */}
      {open && (
        <ol className="history__list" aria-label="The round's moves, newest first">
          {/*
            Newest at the top, where a glance lands: the wire is chronological, like every
            other array on the view, and which end of it is the interesting one is this
            screen's business. Reversed off a copy — the prop is the session's, not ours.

            Keyed by where a move sits in the round, which is fixed the moment it is made:
            the log only ever grows at the end, so no row can move out from under another.
          */}
          {[...entries].reverse().map((entry, index) => {
            const who = nameOf(entry.playerId);
            const key = entries.length - 1 - index;
            return entry.kind === "turn" ? (
              <TurnEntry entry={entry} who={who} key={key} />
            ) : (
              <SlapdownEntry entry={entry} who={who} key={key} />
            );
          })}
        </ol>
      )}
    </div>
  );
}
