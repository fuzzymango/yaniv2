/**
 * The match's running record, and the button in the bottom bar that holds it up.
 *
 * A player mid-match can see where everybody stands right now — the totals are on the felt
 * and the round just scored is spelled out as an equation — but not how anybody got there.
 * This is that: rows are rounds, oldest at the top, columns are the room's seats, and each
 * cell is the total that round left a player on. Three colours carry what happened (yellow
 * called, red Assafed, blue was cut by a milestone — the table's own colours for the two
 * that matter, issue #156), and nothing else is on the card: no
 * caption, no legend, no totals row. It is a sheet of paper, not a report.
 *
 * The control sits **in the viewer's own name bar**, to the left of their name, rather than
 * in the top shelf beside the settings and the way out — the card is about the match being
 * played, and it is opened from the row that says where this player stands in it. It is
 * offered while a round is being played and while one is being scored, to spectators as
 * well: the bottom bar is theirs too, and a player the match has gone on without has more
 * reason to want the history than anybody.
 *
 * **Not once the match is over.** The standings already answer the question the card is
 * opened for, and the panel they are drawn on covers this bar — so offering it there would
 * mean either moving the control for one phase or making that panel ignore taps.
 *
 * Whether it is open is this component's own state, as the settings dialog's is: nothing on
 * the wire knows or cares that somebody is looking at a panel. It is read as *open and the
 * match is not over*, so the final Yaniv closes the card as a function of the position
 * rather than through an effect chasing the phase — an effect would draw the card for one
 * frame and then take it away, which reads as an animation, and no animation was asked for.
 */

import { useCallback, useState } from "react";
import type { PlayerGameView } from "@yaniv/shared";
import { Modal } from "../shared/Modal.tsx";
import { scorecardGrid } from "../scorecard.ts";

/** What the panel is called to a screen reader. It is never drawn — see below. */
const TITLE = "Scorecard";

/**
 * A grid of rows, which is what a scorecard looks like on paper — and an X once the card is
 * up, in the same place, because the way out of something should be where the way in was.
 * `aria-hidden`: the button around it says what it is in words.
 */
function CardIcon({ open }: { open: boolean }) {
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
      {open ? (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      ) : (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
          <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
          <line x1="3.5" y1="14.5" x2="20.5" y2="14.5" />
          <line x1="9" y1="4.5" x2="9" y2="19.5" />
        </>
      )}
    </svg>
  );
}

/**
 * The card scrolled to its newest round **once, as it is attached**, and never again.
 *
 * A stable identity is the whole of it: React runs a callback ref when the element arrives
 * and when it goes, so an inline closure — a new function every render — would re-run on
 * every broadcast underneath the open card, which is about once a second while bots play.
 * A player who had scrolled up to round 2 would be dragged back to the bottom mid-read.
 * The panel is unmounted when the card is closed, so every *opening* is a fresh attach and
 * lands on the newest round again.
 */
function useScrollToNewest(): (box: HTMLDivElement | null) => void {
  return useCallback((box: HTMLDivElement | null) => {
    if (box) box.scrollTop = box.scrollHeight;
  }, []);
}

export function Scorecard({ view }: { view: PlayerGameView }) {
  const [open, setOpen] = useState(false);
  const scrollToNewest = useScrollToNewest();

  // The one read of the phase here, and the reason the card needs no effect to close it.
  const over = view.phase === "gameEnd";
  const showing = open && !over;

  // Assembled only while the card is up: this component re-renders with the table under
  // it, which is every broadcast and every frame of a card in flight, and the grid is of
  // no interest to any of them.
  const { columns, rows } = showing
    ? scorecardGrid(view)
    : { columns: [], rows: [] };

  return (
    <>
      {!over && (
        <button
          className={`you__card ${showing ? "you__card--open" : ""}`}
          type="button"
          aria-label={showing ? `Close the ${TITLE.toLowerCase()}` : TITLE}
          aria-haspopup="dialog"
          aria-expanded={showing}
          onClick={() => setOpen(!showing)}
        >
          <CardIcon open={showing} />
        </button>
      )}

      {showing && (
        // No visible heading: the names and the numbers are the whole document, and a
        // caption over them would be the panel talking about itself. The name is still
        // said to a screen reader — see `Modal.tsx`.
        <Modal title={TITLE} showTitle={false} onDismiss={() => setOpen(false)}>
          {/*
            Scrolled to the bottom as it opens, so a long match shows the round it is
            actually in and "where are we now" needs no scrolling. Earlier rounds are up
            the way a player would reach for them on paper.
          */}
          <div className="scorecard" ref={scrollToNewest}>
            <table className="scorecard__grid">
              {/*
                Column headers for the names and row headers for the round numbers, which
                is structure rather than labelling: it is what lets a screen reader
                navigate the grid instead of reading out a stream of numbers.
              */}
              <thead>
                <tr>
                  {/*
                    The corner above the round numbers. It names the row headers under it
                    to a screen reader and draws nothing, there being nothing on paper
                    above a column of round numbers either.
                  */}
                  <th scope="col">
                    <span className="offscreen">Round</span>
                  </th>
                  {columns.map((column) => (
                    <th scope="col" key={column.playerId}>
                      {column.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.roundNumber}>
                    <th scope="row">{row.roundNumber}</th>
                    {row.cells.map((cell, index) =>
                      cell.played ? (
                        <td
                          className={cell.tone ? `scorecard__cell--${cell.tone}` : ""}
                          key={columns[index]!.playerId}
                        >
                          {cell.total}
                        </td>
                      ) : (
                        // Empty, and empty means one thing: that seat was out of the match
                        // by this round. Decided in `scorecard.ts`, not by finding nothing
                        // to draw here.
                        <td key={columns[index]!.playerId} />
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
