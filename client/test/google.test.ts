/**
 * Google's script, fetched when the menu asks for it and not before, driven with no
 * browser in sight.
 *
 * The page is injected, as storage is in `tokens.test.ts`: this suite hands the loader a
 * `document` that records the `<script>` tags put into it and lets the test decide whether
 * each one loads or fails — which is the whole of what the browser does for us here, and
 * the only thing worth asserting (docs/adr/0020).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GOOGLE_CLIENT_ID } from "@yaniv/shared";
import {
  BUTTON_MAX_WIDTH,
  BUTTON_MIN_WIDTH,
  GIS_SCRIPT_URL,
  loadGoogleIdentity,
  renderSignInButton,
  type GoogleIdentity,
  type GooglePage,
  type ScriptTag,
} from "../src/google.ts";

/** A `<script>` tag the test fires the load or the failure of, by hand. */
interface FakeScript extends ScriptTag {
  load: () => void;
  fail: () => void;
  removed: boolean;
}

/** `accounts.id`, recording what is asked of it. */
function fakeIdentity() {
  const initialized: { client_id: string; callback: (response: { credential?: unknown }) => void }[] =
    [];
  const rendered: unknown[] = [];
  const widths: unknown[] = [];
  const identity: GoogleIdentity<unknown> = {
    initialize: (config) => {
      initialized.push(config);
    },
    renderButton: (parent, options) => {
      rendered.push(parent);
      widths.push(options.width);
    },
    disableAutoSelect: () => {},
  };
  return { identity, initialized, rendered, widths };
}

/**
 * A page with a `<head>` to put scripts in. Loading a script is what puts the global on the
 * page, as the real one does — `arrives` says what it puts there.
 */
function fakePage(arrives: GoogleIdentity<unknown> | null = fakeIdentity().identity) {
  const scripts: FakeScript[] = [];
  const page: GooglePage & { google?: { accounts?: { id?: GoogleIdentity<unknown> } } } = {
    document: {
      createElement: () => {
        const listeners = { load: [] as (() => void)[], error: [] as (() => void)[] };
        const script: FakeScript = {
          src: "",
          async: false,
          removed: false,
          addEventListener: (type, listener) => {
            listeners[type].push(listener);
          },
          remove: () => {
            script.removed = true;
          },
          load: () => {
            if (arrives) page.google = { accounts: { id: arrives } };
            for (const listener of listeners.load) listener();
          },
          fail: () => {
            for (const listener of listeners.error) listener();
          },
        };
        return script;
      },
      head: {
        appendChild: (node) => {
          scripts.push(node as FakeScript);
          return node;
        },
      },
    },
  };
  return { page, scripts };
}

describe("loading Google's script", () => {
  it("puts one script tag on the page, asynchronously, from Google", () => {
    const { page, scripts } = fakePage();

    void loadGoogleIdentity(page);

    assert.equal(scripts.length, 1);
    assert.equal(scripts[0]!.src, GIS_SCRIPT_URL);
    assert.equal(scripts[0]!.async, true, "never in the way of the page it is put on");
  });

  it("answers with Google's identity namespace once the script has run", async () => {
    const { identity } = fakeIdentity();
    const { page, scripts } = fakePage(identity);

    const loading = loadGoogleIdentity(page);
    scripts[0]!.load();

    assert.equal(await loading, identity);
  });

  it("answers null, and leaves nothing behind, when the script is blocked or fails", async () => {
    const { page, scripts } = fakePage();

    const loading = loadGoogleIdentity(page);
    scripts[0]!.fail();

    assert.equal(await loading, null, "no button to draw: the menu plays on without one");
    assert.equal(scripts[0]!.removed, true, "a dead tag is not left in the head");
  });

  it("answers null when the script ran but put no global on the page", async () => {
    const { page, scripts } = fakePage(null);

    const loading = loadGoogleIdentity(page);
    scripts[0]!.load();

    assert.equal(await loading, null);
  });

  it("fetches it once however many times the menu mounts", async () => {
    const { identity } = fakeIdentity();
    const { page, scripts } = fakePage(identity);

    const first = loadGoogleIdentity(page);
    const second = loadGoogleIdentity(page);
    scripts[0]!.load();

    assert.equal(scripts.length, 1, "one tag, shared by every mount waiting on it");
    assert.equal(await first, identity);
    assert.equal(await second, identity);

    assert.equal(await loadGoogleIdentity(page), identity, "and answered at once after that");
    assert.equal(scripts.length, 1);
  });

  it("tries again on the next mount after a failure", async () => {
    const { identity } = fakeIdentity();
    const { page, scripts } = fakePage(identity);

    const failed = loadGoogleIdentity(page);
    scripts[0]!.fail();
    assert.equal(await failed, null);

    // Offline when the menu first came up, online by the time it comes up again.
    const retried = loadGoogleIdentity(page);
    assert.equal(scripts.length, 2);
    scripts[1]!.load();
    assert.equal(await retried, identity);
  });

  it("puts no tag on a page the global is already on", async () => {
    const { identity } = fakeIdentity();
    const { page, scripts } = fakePage();
    page.google = { accounts: { id: identity } };

    assert.equal(await loadGoogleIdentity(page), identity);
    assert.equal(scripts.length, 0);
  });
});

describe("the sign-in button", () => {
  it("is set up for this app's client ID, and hands the credential on", () => {
    const { identity, initialized } = fakeIdentity();
    const credentials: string[] = [];

    renderSignInButton(identity, "slot", 300, (credential) => credentials.push(credential));

    assert.equal(initialized.length, 1);
    assert.equal(initialized[0]!.client_id, GOOGLE_CLIENT_ID);
    initialized[0]!.callback({ credential: "an-id-token" });
    assert.deepEqual(credentials, ["an-id-token"]);
  });

  it("draws into the slot it is given", () => {
    const { identity, rendered } = fakeIdentity();

    renderSignInButton(identity, "slot", 300, () => {});

    assert.deepEqual(rendered, ["slot"]);
  });

  it("is as wide as the column it is drawn in, inside the widths GIS will draw", () => {
    const { identity, widths } = fakeIdentity();

    renderSignInButton(identity, "slot", 287.6, () => {});
    renderSignInButton(identity, "slot", 120, () => {});
    renderSignInButton(identity, "slot", 900, () => {});

    assert.deepEqual(widths, [288, BUTTON_MIN_WIDTH, BUTTON_MAX_WIDTH]);
  });

  it("sets Google up once, and routes a credential to whoever drew the button last", () => {
    const { identity, initialized, rendered } = fakeIdentity();
    const first: string[] = [];
    const second: string[] = [];

    // A menu mounted twice — StrictMode's double effect, or signing out and coming back.
    renderSignInButton(identity, "first slot", 300, (credential) => first.push(credential));
    renderSignInButton(identity, "second slot", 300, (credential) => second.push(credential));

    assert.equal(initialized.length, 1, "Google warns about a second initialize");
    assert.equal(rendered.length, 2, "but every slot is drawn into");
    initialized[0]!.callback({ credential: "an-id-token" });
    assert.deepEqual(first, []);
    assert.deepEqual(second, ["an-id-token"]);
  });

  it("hands on nothing that is not a token", () => {
    const { identity, initialized } = fakeIdentity();
    const credentials: string[] = [];

    renderSignInButton(identity, "slot", 300, (credential) => credentials.push(credential));
    initialized[0]!.callback({});

    assert.deepEqual(credentials, []);
  });
});
