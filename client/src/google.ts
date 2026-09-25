/**
 * Google Identity Services, as far as this client reaches for it — and the only file in
 * the client that knows the words `window.google`, as `tokens.ts` is for `localStorage`.
 *
 * The script is Google's and arrives on a `<script>` tag put on the page **when the main
 * menu draws its sign-in slot**, not before (docs/adr/0020): a returning signed-in player
 * signs back in with the session token and never contacts Google, and a guest who never taps
 * the button is never shown to it by a tag in `index.html`. So the global may not be there
 * at all — not loaded yet, never loaded, or blocked — and everything here answers that by
 * doing nothing, which is what the player would want: sign-in being down never means play
 * is down.
 *
 * The page is injected rather than reached for, as storage is in `tokens.ts`, so the
 * loader is driven under `node:test` with a `document` that only records its tags.
 */

import { GOOGLE_CLIENT_ID } from "@yaniv/shared";
import type { GoogleSignIn } from "./session.ts";

/** Where the script is fetched from, Google's one documented address for it. */
export const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

/**
 * As much of GIS's `google.accounts.id` as this client calls. Generic in what a button is
 * drawn into only so a test can hand over something that is not a DOM node.
 */
export interface GoogleIdentity<Slot = HTMLElement> {
  initialize: (config: {
    client_id: string;
    callback: (response: { credential?: unknown }) => void;
  }) => void;
  renderButton: (parent: Slot, options: Record<string, string | number>) => void;
  disableAutoSelect: () => void;
}

/** As much of the GIS global as is used here, all of it optional until the script lands. */
interface GoogleGlobal {
  accounts?: { id?: Partial<GoogleIdentity> };
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

/** As much of `window` as sign-out reaches for. */
export interface GoogleHolder {
  readonly google?: GoogleGlobal;
}

/** As much of a `<script>` element as the loader touches. */
export interface ScriptTag {
  src: string;
  async: boolean;
  addEventListener: (type: "load" | "error", listener: () => void) => void;
  remove: () => void;
}

/**
 * As much of `window` as loading the script reaches for. Generic in the tag because the
 * DOM's `appendChild` takes any `Node` and only a `Node`: the page is asked for a tag and
 * handed the same one back, whatever it is.
 */
export interface GooglePage<Tag extends ScriptTag = ScriptTag> extends GoogleHolder {
  readonly document: {
    createElement: (tagName: "script") => Tag;
    readonly head: { appendChild: (node: Tag) => unknown };
  };
}

export function googleSignIn(target: GoogleHolder): GoogleSignIn {
  return {
    // Asked for at the call rather than once, the script loading whenever it loads.
    disableAutoSelect: () => target.google?.accounts?.id?.disableAutoSelect?.(),
  };
}

/** The namespace, if the script has put a whole one on the page, and null otherwise. */
function identityOn(page: GoogleHolder): GoogleIdentity | null {
  const id = page.google?.accounts?.id;
  return id?.initialize && id.renderButton && id.disableAutoSelect ? (id as GoogleIdentity) : null;
}

/**
 * The load in flight or landed, per page, so every mount waiting on it shares one tag:
 * StrictMode mounts the menu twice, and a player signing out and back comes back to it.
 */
const loads = new WeakMap<object, Promise<GoogleIdentity | null>>();

/**
 * Google's identity namespace, fetching the script the first time it is asked for — or
 * null when it cannot be had, which the caller answers by drawing nothing.
 *
 * A failure is not remembered: the tag is taken back off the page and the next mount tries
 * again, since a phone that was offline when the menu first came up may well not be by the
 * time the player is back at it. What is remembered is a load that worked.
 */
export function loadGoogleIdentity<Tag extends ScriptTag>(
  page: GooglePage<Tag>,
): Promise<GoogleIdentity | null> {
  const present = identityOn(page);
  if (present) return Promise.resolve(present);

  const pending = loads.get(page);
  if (pending) return pending;

  const loading = new Promise<GoogleIdentity | null>((resolve) => {
    const script = page.document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => {
      const identity = identityOn(page);
      if (!identity) loads.delete(page);
      resolve(identity);
    });
    script.addEventListener("error", () => {
      script.remove();
      loads.delete(page);
      resolve(null);
    });
    page.document.head.appendChild(script);
  });
  loads.set(page, loading);
  return loading;
}

/**
 * How the button is drawn: Google's own, as its branding rules ask, dark to sit on the felt,
 * and as wide as the column it sits in — which GIS takes as a number of pixels between these
 * two and nothing relative, so it is measured and clamped rather than stated.
 */
const BUTTON_OPTIONS = {
  type: "standard",
  theme: "filled_black",
  size: "large",
  text: "signin_with",
  shape: "rectangular",
} as const;

export const BUTTON_MIN_WIDTH = 200;
export const BUTTON_MAX_WIDTH = 400;

/**
 * Where each namespace's credential is sent: GIS keeps one callback for the page, set by
 * `initialize`, and warns when that is called twice — so it is called once, with a callback
 * that forwards to whichever button was drawn last.
 */
const credentialRoutes = new WeakMap<object, { onCredential: (idToken: string) => void }>();

/**
 * Draw Google's button into `slot`, `width` pixels wide as near as GIS allows, sending the ID
 * token of a sign-in to `onCredential`. Anything that comes back that is not a string is not
 * a token, and is dropped here rather than sent to be refused.
 */
export function renderSignInButton<Slot>(
  identity: GoogleIdentity<Slot>,
  slot: Slot,
  width: number,
  onCredential: (idToken: string) => void,
): void {
  const existing = credentialRoutes.get(identity);
  if (existing) {
    existing.onCredential = onCredential;
  } else {
    const route = { onCredential };
    credentialRoutes.set(identity, route);
    identity.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: ({ credential }) => {
        if (typeof credential === "string") route.onCredential(credential);
      },
    });
  }
  const clamped = Math.round(Math.min(BUTTON_MAX_WIDTH, Math.max(BUTTON_MIN_WIDTH, width)));
  identity.renderButton(slot, { ...BUTTON_OPTIONS, width: clamped });
}
