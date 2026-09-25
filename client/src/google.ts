/**
 * Google Identity Services, as far as this client reaches for it — and the only file in
 * the client that knows the words `window.google`, as `tokens.ts` is for `localStorage`.
 *
 * The script is Google's and arrives on a `<script>` tag (docs/adr/0020), so the global
 * may not be there at all: not loaded yet, never loaded — a returning signed-in player
 * never contacts Google — or blocked. Everything here answers that by doing nothing, which
 * is what the player would want: sign-in being down never means play is down.
 *
 * Only what sign-out needs today. The button the main menu draws will be the rest of it.
 */

import type { GoogleSignIn } from "./session.ts";

/** As much of the GIS global as is used here, all of it optional until the script lands. */
interface GoogleGlobal {
  accounts?: { id?: { disableAutoSelect?: () => void } };
}

/*
 * Declared on `Window` because the script puts it there — and so that `window` is a
 * `GoogleHolder` to the type checker, which would otherwise see the two as sharing nothing.
 */
declare global {
  interface Window {
    google?: GoogleGlobal;
  }
}

/** As much of `window` as this reaches for. */
export interface GoogleHolder {
  readonly google?: GoogleGlobal;
}

export function googleSignIn(target: GoogleHolder): GoogleSignIn {
  return {
    // Asked for at the call rather than once, the script loading whenever it loads.
    disableAutoSelect: () => target.google?.accounts?.id?.disableAutoSelect?.(),
  };
}
