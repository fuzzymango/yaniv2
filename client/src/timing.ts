/**
 * How long the moving parts of the table last, as chains rather than a handful of numbers.
 *
 * Every duration below a root is a fraction of the one above it (issue #95), so a whole
 * chain is retuned by editing one value: slow a flight down and the slapdown slows with it,
 * and the jolt behind it with that. A second constant tuned to look right beside the first
 * would be right only until somebody changed the first.
 *
 * **There are two roots, and that they are two is deliberate** (issue #156). A chain is the
 * parts of one thing, and a card crossing the table and a call being announced are not one
 * thing — the reasoning is on `ANNOUNCE_MS` below and in docs/adr/0018, and it is the change
 * here most likely to be undone by somebody tidying.
 *
 * The chains and what each link answers for:
 *
 *   FLIGHT_MS           how long a card takes to cross the table
 *   SLAP_MS             the same journey, made in anger
 *   SHAKE_MS            how long the table is still ringing from it
 *
 *   ANNOUNCE_MS         how long a call's banners are held once they are all up
 *   ANNOUNCE_LEAD_MS    how long YANIV is up alone before ASSAF answers it
 *   ANNOUNCE_ENTER_MS   a banner arriving
 *   ANNOUNCE_EXIT_MS    the pair leaving together
 *
 * Pure arithmetic and nothing else — no element, no clock, no preference — so the derivations
 * are asserted by a test with no DOM near it, which is the whole reason they live here rather
 * than beside the animation that runs them.
 */

/**
 * How long a card is in the air.
 *
 * The top of the flight chain and derived from nothing: what keeps a flight from being replaced
 * before it finishes is the server's bot think time, which is several times this and is a
 * fact about the game rather than about the animation. A network that bunches two
 * broadcasts can cut a flight short — cosmetic, accepted, and only on a connection that has
 * already stuttered.
 *
 * Long enough to be seen and short enough that a player who already knows what they played
 * never waits on it. They never wait on it in any case: the turn is sent, acked and drawn
 * regardless of what is in the air.
 */
export const FLIGHT_MS = 300;

/**
 * The same distance, half the time: a slapdown is a card thrown down rather than played
 * (docs/rules.md §9), and how fast it crosses is most of what says so.
 *
 * Half is the ratio because the difference has to be legible without being a different
 * animation — a card that arrived at a quarter of the time would read as a glitch, and one at
 * three quarters as the same discard. What it is a half *of* is the point: the sharpness is a
 * fact about a slapdown relative to a turn, not a speed of its own.
 */
export const SLAP_MS = FLIGHT_MS / 2;

/**
 * How long the table jolts for once the card lands — two thirds of the flight that caused it,
 * so the jolt is over before a player's eye has left the pile.
 *
 * Derived from the slap and not the flight, because it is the *slap's* aftershock: a slapdown
 * made quicker should ring for less time, not the same time.
 */
export const SHAKE_MS = (SLAP_MS * 2) / 3;

/**
 * How long the pair of call banners is held once both are up — **a second root, derived
 * from nothing above it, and deliberately not from `FLIGHT_MS`** (issue #156).
 *
 * That is a departure from the one-chain doctrine at the top of this file, and it is a
 * decision rather than an oversight: every link of the chain above is a part of *one move*,
 * so a slapdown's aftershock genuinely should shorten when the slapdown does. A call
 * announcement has no such relationship to how fast a card crosses a table. Hung off the
 * flight, speeding the cards up would quietly drain the tension out of an Assaf — correct
 * by the letter of the doctrine and wrong by its reason. Please do not tidy the two roots
 * into one; see docs/adr/0018.
 *
 * Each root is bounded by the thing that actually constrains it. The flight's bound is the
 * server's bot think time; this one's is the server's auto-deal delay (`AUTO_DEAL_MS`, ten
 * seconds), inside which the whole sequence has to finish comfortably — a table only bots
 * are playing deals itself on, and a watcher must see the round they are watching.
 *
 * `ANNOUNCE_MS` is three times `FLIGHT_MS` **by coincidence and not by relationship**. The
 * ratio is stated here because it will otherwise be noticed and "fixed".
 */
export const ANNOUNCE_MS = 900;

/**
 * How long `YANIV` is up alone before `ASSAF` joins it — half the hold, so the reversal
 * lands as an answer to the call rather than as a second simultaneous claim.
 *
 * A fraction of the hold rather than a number of its own, on the same principle the flight
 * chain is built on: a longer announcement should have a longer beat inside it.
 */
export const ANNOUNCE_LEAD_MS = ANNOUNCE_MS / 2;

/** A banner arriving. A third of the hold: a snap, and over before it is read. */
export const ANNOUNCE_ENTER_MS = ANNOUNCE_MS / 3;

/**
 * The pair leaving together — longer than the entrance on purpose. A banner should arrive
 * with a snap and leave without one, and the asymmetry is what makes the round read as
 * closed rather than as cut off.
 */
export const ANNOUNCE_EXIT_MS = ANNOUNCE_MS / 2;
