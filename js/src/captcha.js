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
 */

let ticket = null;
let scriptPromise = null;

export function getTicket() {
  return ticket;
}

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error("Turnstile script failed to load"));
      document.head.appendChild(el);
    });
  }
  return scriptPromise;
}

/**
 * Render the gate, resolve the Turnstile challenge, and fetch a ticket.
 * Replaces `target`'s contents while the gate is up; leaves it untouched (and
 * resolves immediately) when captcha is not configured for this deploy.
 *
 * @returns {Promise<void>} resolves once admitted; rejects if a CONFIGURED
 *   gate could not be passed (network failure, Turnstile rejection, backend
 *   misconfigured) -- callers should show that as a hard stop, not fall
 *   through to the session, or the gate is decorative.
 */
export async function admitSession({ siteKey, pid, target }) {
  if (!siteKey) {
    console.warn("captcha: no Turnstile site key configured -- running ungated");
    return;
  }

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

  const token = await new Promise((resolve, reject) => {
    window.turnstile.render("#turnstile-widget", {
      sitekey: siteKey,
      callback: resolve,
      "error-callback": () => reject(new Error("Turnstile could not verify this browser")),
      "expired-callback": () => reject(new Error("Turnstile challenge expired")),
    });
  });

  const r = await fetch("/api/verify-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, pid }),
  });
  const data = await r.json().catch(() => ({ ok: false, error: "bad response from server" }));
  if (!data.ok) throw new Error(data.error || "session admission failed");
  ticket = data.ticket;
}
