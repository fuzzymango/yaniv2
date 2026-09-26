/**
 * How long the moving parts of the table last, as chains rather than a handful of numbers.
 *
 * Every duration below a root is a fraction of the one above it (issue #95), so a whole
 * chain is retuned by editing one value: slow a flight down and the slapdown slows with it,
 * and the jolt behind it with that. A second constant tuned to look right beside the first
 * would be right only until somebody changed the first.
 *
 * **There are three roots, and that they are several is deliberate** (issue #156). A chain is
 * the parts of one thing, and a card crossing the table and a call being announced are not one
 * thing — the reasoning is on `ANNOUNCE_MS` below and in docs/adr/0018, and it is the change
 * here most likely to be undone by somebody tidying. The third, the deal hold (issue #205),
 * is a chain of one: a pause on a control rather than an animation.
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
 *   DEAL_HOLD_MS        how long a scored round is on screen before it can be dealt away
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
  (count - 1) * ANNOUNCE_LEAD_MS + ANNOUNCE_MS;

/**
 * How long "Deal next round" is held disabled once it first appears for a scored round —
 * **a third root, derived from neither chain above** (issue #205).
 *
 * The browser choosing how long to present a round, **not a rule**: the server accepts a deal
 * at any moment of `roundEnd`, and a CLI player or the auto-deal may deal inside this hold.
 * What it stops is a double tap on Yaniv!, or a thumb already on its way to that slot, dealing
 * the round away before anybody has seen it.
 *
 * Bounded below by the longest call announcement — an Assafed round's banners fully gone,
 * `announceLeaveAt(2) + ANNOUNCE_EXIT_MS` — so nobody deals over the call that ended the
 * round; and above by the server's auto-deal delay (`AUTO_DEAL_MS`, ten seconds), so a human
 * is never held longer than a bots-only table waits for its watcher. Where it sits between
 * them is a judgement: the banners are gone by about 1.35s, which leaves a second and a half
 * for the revealed hands and the scores.
 *
 * Not derived from `ANNOUNCE_MS`, though it is bounded by it: a shorter announcement is no
 * reason to give a player less time to read the hands.
 */
export const DEAL_HOLD_MS = 3000;
