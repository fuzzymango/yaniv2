# Errors are toasts the player dismisses, and the table never reports six refusals

Every screen used to draw the session's one `error` as an inline `notice--error` in normal flow. On
the table that line sat under the player's own bar, so the hand jumped up a row when a refusal
arrived and dropped back when the next action cleared it. The commonest refusal was the least
useful one: tapping a draw target or Yaniv off turn, where the turn indicator already says why
nothing happened.

Decided: **the session core never publishes the refusals the board already explains, and every
error it still publishes is a toast fixed to the top of the screen, which only its ✕ removes.**
Specified in #245, built in #246–#250.

## Six refusals are silent, keyed by action and code together

| Action | Code |
|---|---|
| `takeTurn`, `callYaniv`, `slapDown` | `NOT_YOUR_TURN`, `SLAPDOWN_NOT_AVAILABLE`, `WRONG_PHASE`, `CARD_NOT_PICKUP_ELIGIBLE` |
| `startNextRound`, `playAgain` | `WRONG_PHASE` |

In each, what the player sees next — the turn indicator, the slapdown window closing, the round
ending, the next round or match dealt — is the answer, and a red line over it says nothing more.
A silent refusal still releases `busy`, and the move stays the player's to make.

**The code alone is not enough.** The lobby's `WRONG_PHASE` ("Settings are locked once the match has
started") is news, so the key is the action as well. That is why silencing lives in the session
core (`SILENT_MOVE`, `SILENT_DEAL`, handed to `refuse`) rather than on the server or in `shared`.
The server still refuses, with the same code, and the error contract is unchanged. The client
still offers every control off turn, because the server owns turn order (ADR-0002).

## A toast is a list entry, and only ✕ removes it

`SessionSnapshot.errors` is a list of `Toast = { id, error }`, oldest first. The id comes from a
per-session counter and is fixed for the toast's life, so ✕ names the toast it was drawn on
whatever has arrived since. `dismissError(id)` is the only way an entry goes. It sends nothing and
touches nothing else, and an id that isn't up publishes nothing.

This **reverses the old clearing rules** on purpose. Trying again, entering or leaving a room, a
seat claimed back, `cancelSignIn`, and the profile or its editors opening or closing no longer put
an error down. Whether a refusal has been read is the player's call. A toast that vanished under
the tap that retried would be a jump of its own, the thing this decision exists to remove.

- **Appended, newest last.** A toast already on screen never moves when another arrives below it.
- **No cap, and duplicates stack literally.** A capped or de-duplicated stack would decide for the
  player which refusals they had read. A player hammering a refused action does pile up toasts; we
  accept that, and a cap is a later decision if it proves a nuisance.
- **Dropped where it was dropped before.** A refusal landing after the room has gone
  (`view === null`), the player's own exit having crossed an action in flight, is still not shown.
  That rule is about news not meant for this player, not about dismissing.
- **`notice` is not a toast.** A seat that couldn't be claimed back, or a lapsed session, is news
  rather than a refusal. It stays inline and keeps its own rule: put down by the next attempt to
  enter a room or act on the account.

## Drawn once, part of no layout

`ErrorToasts` is drawn by `App` beside whichever screen is up, fixed to the viewport, above the
modal and the call banner. The layer ignores taps and each toast does not, so the felt beside a
toast still takes a tap. No screen draws an error of its own: the profile's custom-call check
moved into the session's `setCustomCall` (#248), so its refusal is a toast like the rest. Arrival
slides in, except under reduced motion, and there is no exit animation.

## Amended: a toast is not always a refusal (spec #254)

The host's kick (ADR-0028) tells the kicked player why they are back at the menu, and that is news
rather than a refusal. The text above stands as written, with three changes:

- **The names** (#257). `SessionSnapshot.errors`, `dismissError` and `ErrorToasts` are now `toasts`,
  `dismissToast` and `Toasts`, because a toast is a general message.
- **A toast has a tone** (#260). `Toast` is `{ id, tone: "error", error }` or
  `{ id, tone: "news", message }`. Red is a refusal and green is news. A news toast is dismissed the
  same way, by its ✕ alone. Today the only one is "Host removed you from the room.", put up in the
  same publication as `view: null`. The drop-after-the-room-has-gone rule above is about refusals
  and never reaches it. `notice` still carries the rest of the news that is not a refusal.
- **A seventh silent refusal** (#260). `kickPlayer` is silent on `PLAYER_NOT_FOUND` (`SILENT_KICK`):
  it arises only where the target left first, and the roster already shows that. Its other refusals
  are still reported.
