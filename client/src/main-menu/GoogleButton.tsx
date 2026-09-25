/**
 * Google's sign-in button, at the top of a signed-out menu — or nothing at all.
 *
 * The script behind it is fetched when this mounts and not before (docs/adr/0020), so there
 * is a moment with no button while it loads, and there is no button ever where it cannot
 * load: blocked, offline, Google down. Nothing is said about either. A player on a network
 * that blocks Google sees a menu with no button on it and plays the game, which is the
 * whole point of sign-in being an option and never a wall (#174 §10).
 *
 * The slot is an empty `div` until Google draws into it, and the stylesheet takes an empty
 * one out of the form's flow entirely, so "nothing" does not leave a gap where a button
 * would have been.
 *
 * The button is Google's own, drawn by its script inside an iframe, as its branding rules
 * ask — which is also why `busy` is not passed in: nothing here can disable it, and the
 * session core drops a sign-in that arrives while another event is in flight.
 */

import { useEffect, useRef } from "react";
import { loadGoogleIdentity, renderSignInButton } from "../google.ts";

interface GoogleButtonProps {
  /** Handed the ID token of a sign-in Google has completed, to be sent for verifying. */
  onCredential: (idToken: string) => void;
}

export function GoogleButton({ onCredential }: GoogleButtonProps) {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A menu gone by the time the script arrives has no slot to draw into.
    let mounted = true;
    void loadGoogleIdentity<HTMLScriptElement>(window).then((identity) => {
      const into = slot.current;
      if (!mounted || identity === null || into === null) return;
      // The column's width, not the slot's: an empty slot is taken out of the flow, and is
      // measured as nothing until there is something in it.
      renderSignInButton(identity, into, into.parentElement?.clientWidth ?? 0, onCredential);
    });
    return () => {
      mounted = false;
    };
  }, [onCredential]);

  return <div ref={slot} className="menu__google" />;
}
