/**
 * How long the moving parts of the table last.
 *
 * **Every duration here is a plain number, derived from none of the others** (issue #241). They
 * used to be chains, each a fraction of one root, so a table could be retuned from one number —
 * and so no one of them could be tuned without moving the rest: holding the banners a second
 * longer would have stretched the beat before an Assaf and made each entrance sluggish. Each is
 * judged by eye, on its own, and the reason for its value is the comment on it. Why the chains
 * were released is recorded in docs/adr/0018.
 *
 *   FLIGHT_MS           how long a card takes to cross the table
 *   SLAP_MS             the same journey, made in anger
 *   SHAKE_MS            how long the table is still ringing from it
 *
 *   ANNOUNCE_HOLD_MS    how long a call's banners are held once they are all up
 *   ANNOUNCE_LEAD_MS    how long YANIV is up alone before ASSAF answers it
 *   ANNOUNCE_ENTER_MS   a banner arriving
 *   ANNOUNCE_EXIT_MS    the pair leaving together
 *
 *   DEAL_HOLD_MS        how long a scored round is on screen before it can be dealt away
 *
 *   MILESTONE_COUNT_MS  a milestone seat's total draining from the multiple of 50
 *   MILESTONE_PULSE_MS  one throb of that total while it drains
 *
 * What a test asserts here is the staging built on them and where a duration would collide with
 * something outside the animation — the server's auto-deal delay, and a deal landing before an
 * Assaf has — never a number. Pure arithmetic and nothing else — no element, no clock, no
 * preference — which is why it lives here rather than beside the animation that runs it.
 */

/**
 * How long a card is in the air.
 *
 * What keeps a flight from being replaced before it finishes is the server's bot think time,
 * which is several times this and is a fact about the game rather than about the animation. A
 * network that bunches two broadcasts can cut a flight short — cosmetic, accepted, and only on a
 * connection that has already stuttered.
 *
 * Long enough to be seen and short enough that a player who already knows what they played
 * never waits on it. They never wait on it in any case: the turn is sent, acked and drawn
 * regardless of what is in the air.
 */
export const FLIGHT_MS = 300;

/**
 * A slapdown crossing the same distance as a flight, sharper than a discard: a slapdown is a
 * card thrown down rather than played (docs/rules.md §9), and how fast it crosses is most of
 * what says so.
 *
 * Sharper by enough that the difference is legible, and not so much that it reads as a different
 * animation — too quick and the card reads as a glitch, too close to the flight and as the same
 * discard.
 */
export const SLAP_MS = 150;

/**
 * How long the table jolts for once a slapdown lands — shorter than the slap that caused it, so
 * the jolt is over before a player's eye has left the pile.
 */
export const SHAKE_MS = 100;

/**
 * How long the call banners are held once every one of them has arrived — not the
 * announcement's whole length, which adds the beat before an Assaf and the exit
 * (`announceLeaveAt(count) + ANNOUNCE_EXIT_MS`).
 *
 * Long because a round's biggest moment was over before a player who glanced away had seen who
 * called, and a custom call may be a phrase that takes longer to read than `YANIV` (issue #241).
 * The same for every call, standard or custom, lone or answered.
 *
 * Bounded by the server's auto-deal delay (`AUTO_DEAL_MS`, ten seconds), inside which the whole
 * sequence has to finish comfortably — a table only bots are playing deals itself on, and a
 * watcher must see the round they are watching.
 */
export const ANNOUNCE_HOLD_MS = 1900;

/**
 * How long `YANIV` is up alone before `ASSAF` joins it — long enough for the call to have fully
 * arrived and been read, short enough that the reversal lands as an answer to the call rather
 * than as a second simultaneous claim.
 */
export const ANNOUNCE_LEAD_MS = 450;

/** A banner arriving: a snap, and over before it is read. */
export const ANNOUNCE_ENTER_MS = 300;

/**
 * The pair leaving together — longer than the entrance on purpose. A banner should arrive
 * with a snap and leave without one, and the asymmetry is what makes the round read as
 * closed rather than as cut off.
 */
export const ANNOUNCE_EXIT_MS = 450;

/**
 * When one banner of an announcement arrives, and when every banner of it leaves.
 *
 * Here rather than in the component that reads them, on the same grounds as the constants
 * above: a component in this client is asserted about nowhere, and these two lines are the
 * whole of the staging — the beat between the call and the answer to it, and the fact that
 * the exit is measured from the *last* arrival rather than from each banner's own, which is
 * what makes the pair leave together.
 *
 * Total over any index and count; a lone banner is index 0 of one.
 */
export const announceEnterAt = (index: number): number => index * ANNOUNCE_LEAD_MS;

export const announceLeaveAt = (count: number): number =>
  (count - 1) * ANNOUNCE_LEAD_MS + ANNOUNCE_HOLD_MS;

/**
 * How long "Deal next round" is held disabled once it first appears for a scored round
 * (issue #205).
 *
 * The browser choosing how long to present a round, **not a rule**: the server accepts a deal
 * at any moment of `roundEnd`, and a CLI player or the auto-deal may deal inside this hold.
 * What it stops is a double tap on Yaniv!, or a thumb already on its way to that slot, dealing
 * the round away before anybody has seen it.
 *
 * Bounded below by both banners' arrival — an Assafed round's second banner fully in,
 * `announceEnterAt(1) + ANNOUNCE_ENTER_MS` — so nobody deals before an Assaf has landed; and
 * above by the server's auto-deal delay (`AUTO_DEAL_MS`, ten seconds), so a human is never held
 * longer than a bots-only table waits for its watcher. Where it sits between them is a
 * judgement, and nothing holds it past the banners' exit (issue #241): a player who deals as
 * soon as they can may cut them off, which unmounts them. An accepted trade — the banners take
 * no tap, and the deal is never held back for them.
 */
export const DEAL_HOLD_MS = 2000;

/**
 * How long a milestone seat's total takes to drain from the multiple of 50 it landed on to the
 * score the round recorded (docs/rules.md §7, spec #280).
 *
 * Two seconds because that is what the prototype was judged on (#279): long enough that the
 * total reads as *falling* — the integers ticking through, from across a six-seat table on a
 * phone — rather than as one number swapped for another, and short enough that it is over while
 * the call's banners are still up, so the table is not still settling when it is dealt. That it
 * equals `DEAL_HOLD_MS` is a coincidence, not a derivation: the count holds nothing up, and a
 * prompt deal ends it wherever it has got to.
 *
 * Bounded by the server's auto-deal delay (`AUTO_DEAL_MS`, ten seconds), like the banners: a
 * watcher of a table only bots are playing has to see the count land.
 */
export const MILESTONE_COUNT_MS = 2000;

/**
 * One throb of a draining total — a scale of 1 to 1.1 and back (`pulseScale` in
 * `milestone.ts`, spec #280) — so a steady 4Hz.
 *
 * What the prototype was judged on (#279, variant A): quick enough to read as the number
 * *beating* rather than breathing, which is what says something is still happening to it, and
 * slow enough that a phone's frame rate draws every throb as a rise and a fall rather than as a
 * flicker. That a count is a whole number of them, so the last one ends at rest as the total
 * lands, is the two values as they stand and not a derivation: a count that landed mid-throb
 * would only snap a tenth of a size back.
 */
export const MILESTONE_PULSE_MS = 250;
