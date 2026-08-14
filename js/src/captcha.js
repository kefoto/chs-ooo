/**
 * Session admission: solve Cloudflare Turnstile once, trade the token for a
 * short-lived session ticket from /api/verify-start, and hold onto that
 * ticket for the rest of the session. Every later /api/submit call (see
 * save.js) carries the TICKET, not the Turnstile token -- Turnstile tokens
 * are single-use and expire in minutes, wrong for authorizing uploads across
 * what can be an hour-plus session (js/README.md's pacing table). The ticket
 * itself is minted server-side in api/_lib/ticket.js.
 *
 * The Turnstile script is loaded dynamically, only when a site key is
 * configured, rather than a static <script> in index.html -- js/README.md
 * promises "no network, no build step" for local/offline testing, and a
 * hardcoded CDN <script> tag would break that for every dev session, gated
 * backend or not.
 *
 * Degrades to admitting the session ungated (with a console.warn) when no
 * site key is configured, or the CDN script fails to load -- e.g. local dev
 * via `python3 -m http.server`, or the headless jsdom test harness, neither
 * of which has a backend at /api/verify-start to talk to. A DEPLOYED site
 * with a site key configured but a broken backend fails CLOSED instead (see
 * admitSession's catch below): the difference is whether the deploy opted
 * into the gate at all.
 *
 * Ungated still asks for a ticket. The captcha and the ticket are separate
 * things: the captcha decides WHO gets in, the ticket is what /api/submit
 * accepts as identity for the rest of the session. Skipping the ticket when
 * there is no captcha meant every upload came back 401 and the session's
 * data was silently dropped -- an unconfigured captcha turned into a study
 * that recorded nothing. So the ticket is always requested; only the
 * Turnstile solve is conditional. Where there is no backend at all the
 * request simply fails and the session runs ticketless, exactly as before.
 */

let ticket = null;
let scriptPromise = null;

export function getTicket() {
  return ticket;
}

// A <script> tag that never fires either load or error is not hypothetical:
// jsdom (this file's own test harness) never fires either for an externally
// loaded script by design, and a real browser can stall the same way behind
// a slow network or an ad-blocker that silently drops the request. Without a
// timeout, admitSession() below would hang on "One moment…" forever instead
// of failing into the reload-and-try-again screen main.js shows.
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = withTimeout(new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error("Turnstile script failed to load"));
      document.head.appendChild(el);
    }), SCRIPT_LOAD_TIMEOUT_MS, "Turnstile script timed out loading")
      // A failed attempt must not wedge every later one behind the same
      // rejected promise -- clear it so a retry (e.g. the operator reloads)
      // starts a fresh load instead of instantly re-rejecting.
      .catch((e) => { scriptPromise = null; throw e; });
  }
  return scriptPromise;
}

/**
 * Solve the Turnstile challenge if this deploy has one, then trade the result
 * for a session ticket. Replaces `target`'s contents while the gate is up;
 * leaves it untouched when captcha is not configured for this deploy.
 *
 * @returns {Promise<void>} resolves once admitted; rejects if a CONFIGURED
 *   gate could not be passed (network failure, Turnstile rejection, backend
 *   misconfigured) -- callers should show that as a hard stop, not fall
 *   through to the session, or the gate is decorative.
 */
export async function admitSession({ siteKey, pid, target }) {
  let token = null;

  if (siteKey) {
    try {
      await loadTurnstileScript();
    } catch (e) {
      // The CDN being unreachable is an infrastructure problem, not a signal
      // about the visitor -- but this deploy DID opt into the gate, so treat
      // it as a hard stop rather than quietly admitting everyone whenever
      // Cloudflare's CDN has a bad moment.
      throw new Error(`captcha unavailable: ${e.message}`);
    }

    target.innerHTML = `
      <div class="captcha-gate">
        <p>One moment…</p>
        <div id="turnstile-widget"></div>
      </div>`;

    // Generous: Managed mode usually clears itself in well under a second, but
    // a visible challenge (rare -- only traffic Cloudflare considers
    // suspicious gets one) is a person solving a puzzle, not a script waiting
    // on a network call.
    token = await withTimeout(new Promise((resolve, reject) => {
      window.turnstile.render("#turnstile-widget", {
        sitekey: siteKey,
        callback: resolve,
        "error-callback": () => reject(new Error("Turnstile could not verify this browser")),
        "expired-callback": () => reject(new Error("Turnstile challenge expired")),
      });
    }), 120_000, "Turnstile did not respond in time");
  } else {
    console.warn("captcha: no Turnstile site key configured -- running ungated");
  }

  // The ticket, gated or not. `token` is null in the ungated case, which
  // /api/verify-start accepts only while it has no TURNSTILE_SECRET_KEY of
  // its own -- the two halves of the configuration agree or nobody gets in.
  let data;
  try {
    const r = await fetch("/api/verify-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, pid }),
    });
    data = await r.json().catch(() => ({ ok: false, error: "bad response from server" }));
  } catch (e) {
    data = { ok: false, error: `session admission unreachable: ${e.message}` };
  }

  if (!data.ok) {
    // A deploy that opted into the gate must not fall through it.
    if (siteKey) throw new Error(data.error || "session admission failed");
    // No gate and no backend: local dev over `python3 -m http.server`, or the
    // jsdom harness. The session runs, saves to a file, and uploads nothing --
    // which is what those two environments want. Loud, because on a real
    // deploy the same line means the data is going nowhere.
    console.warn(`captcha: no session ticket (${data.error}) -- `
                 + "uploads will be rejected by a backend that requires one");
    return;
  }
  ticket = data.ticket;
}
