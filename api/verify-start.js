/**
 * Gate the START of a session on a Cloudflare Turnstile solve, once.
 *
 * Called by js/src/captcha.js before the timeline is built. On success this
 * mints a session ticket (see _lib/ticket.js) that every later submit.js
 * call carries instead of re-solving Turnstile -- solving it once per
 * session, not once per block, is the whole reason the ticket exists.
 *
 * TURNSTILE_SECRET_KEY must be set as a Vercel environment variable, paired
 * with the site key in js/src/config.js (site keys are not secret -- they are
 * meant to ship to the client; the secret key is what must never leave the
 * server).
 *
 * With NEITHER of the two set the endpoint still mints tickets, and the study
 * is then open to anyone who asks for one. That is deliberate, and it is the
 * weaker setting. The alternative -- refusing every ticket until Turnstile is
 * configured -- does not protect the study, because it does not stop a
 * session being RUN: it only makes every /api/submit call 401 and throws the
 * child's data away (which is exactly what this deploy did until now). An
 * unprotected endpoint that records data is recoverable; a session that
 * recorded nothing is not.
 *
 * Turning the gate on is one env var here and one line in js/src/config.js,
 * and the two must move TOGETHER: a site key with no secret key fails every
 * session closed, which is the one combination this file still rejects.
 */
import { issueTicket } from "./_lib/ticket.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  const { token, pid } = req.body ?? {};
  // The participant id is embedded in the ticket so submit.js can bind an
  // upload to the session it claims to belong to, but it is never treated
  // as a secret -- it is exactly the id already visible in the study URL.
  const participantId = typeof pid === "string" && pid ? pid : "unknown";

  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    // Logged on every session, not once: an ungated study is a thing you
    // should be able to notice from the runtime logs alone.
    console.warn("TURNSTILE_SECRET_KEY is not set -- admitting this session UNGATED");
    res.status(200).json({ ok: true, gated: false, ticket: issueTicket(participantId) });
    return;
  }

  if (!token || typeof token !== "string") {
    res.status(400).json({ ok: false, error: "missing token" });
    return;
  }

  let verified;
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    // Cloudflare's own docs recommend also forwarding the visitor's IP when
    // available; Vercel exposes it on this header.
    const ip = req.headers["x-forwarded-for"];
    if (ip) body.set("remoteip", String(ip).split(",")[0].trim());
    const r = await fetch(VERIFY_URL, { method: "POST", body });
    verified = await r.json();
  } catch (e) {
    console.error("Turnstile verify request failed", e);
    res.status(502).json({ ok: false, error: "verification unreachable" });
    return;
  }

  if (!verified.success) {
    res.status(403).json({ ok: false, error: "captcha failed",
                           codes: verified["error-codes"] });
    return;
  }

  res.status(200).json({ ok: true, gated: true, ticket: issueTicket(participantId) });
}
