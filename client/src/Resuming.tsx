/**
 * The screen a page shows while it is asking for its seat back.
 *
 * The third screen that is not a function of `view.phase`, and it exists for a moment that
 * would otherwise be a lie: a page opened on a stored credential has no view yet, and a
 * null view *is* the main menu (docs/adr/0004). Drawn ahead of that branch, so a player
 * reloading mid-hand sees the table being fetched rather than a flash of the menu they were
 * never sent back to — and, a beat later, either their hand or the news that the room has
 * gone.
 *
 * Only where there is nothing else to show. A connection that drops and returns mid-match
 * claims its seat with the last position still on the screen, and covering that over with a
 * spinner would throw away the very thing being asked for — see `App.tsx`.
 *
 * There is nothing to tap, deliberately: the claim is already in flight, and the two things
 * that can end it — an answer, or the socket failing to arrive at all — both land on a
 * screen of their own.
 */

export function Resuming() {
  return (
    <main className="screen resuming">
      {/*
        `status` rather than `alert`: this interrupts nothing — it is the page still
        starting up — so a screen reader should say it in its turn rather than break in.
      */}
      <div className="resuming__body" role="status">
        {/* Drawn in CSS like the cards, and hidden from the label it sits above. */}
        <span className="spinner" aria-hidden="true" />
        <p className="resuming__detail">Finding your seat…</p>
      </div>
    </main>
  );
}
