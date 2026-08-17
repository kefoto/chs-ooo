/**
 * Receive one completed MELD consent/assent form: called once per required
 * form by js/src/consent.js's uploadConsentFiles, immediately after
 * verify-start has issued this session's ticket.
 *
 * Requires that ticket (Authorization: Bearer <ticket>), for the same reason
 * submit.js does -- and more urgently. An unauthenticated upload endpoint on a
 * public deploy is an open bucket: anyone could write arbitrary files into the
 * study's database, and this one takes attachments rather than a JSON shape
 * that has to look like a session.
 *
 *     Why Postgres, not Vercel Blob
 *     ------------------------------
 *     Exactly submit.js's argument, only more so. Blob's access mode is
 *     public: whoever holds the (unguessable) URL reads the object, with no
 *     credential. That was judged wrong for a payload carrying a child's age
 *     and ethnicity; a signed consent form carries a name, a signature, a
 *     date and a parent, and is a great deal more identifying than that. Rows
 *     here are reachable only through this API, which is the only holder of
 *     POSTGRES_URL.
 *
 *     The cost is that ~10MB of BYTEA per participant sits in Postgres, which
 *     is not what Postgres is for. That is the accepted trade: at one or two
 *     documents per participant the volume is small, and the alternative is
 *     the wrong access model rather than a slower one.
 *
 * The document is stored ONCE per (participant, form): a parent who attaches
 * the wrong file and redoes the session would otherwise leave two rows for the
 * same form with nothing to say which is current. The newest wins.
 */
import { sql } from "@vercel/postgres";
import { verifyTicket } from "./_lib/ticket.js";
import { ensureConsentSchema } from "./_lib/schema.js";

// Mirrors MAX_CONSENT_BYTES in js/src/consent.js. Checked there so a parent is
// told immediately, and here so the limit is real -- the browser's check is a
// courtesy to the person, not a control on the endpoint.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// base64 is 4 characters per 3 bytes, so the encoded body is ~1.34x the file.
// A little headroom over that for the JSON around it.
const MAX_BODY_BYTES = Math.ceil(MAX_FILE_BYTES * 1.4) + 4096;

// The five MELD instruments, by the keys consent.js's MELD_LINKS uses. An
// allowlist, so this table can only ever hold documents for forms the study
// actually has -- not whatever string a client puts in the field.
const FORM_KEYS = new Set([
  "adult", "parental", "age_12_17", "age_7_11", "age_0_6",
]);

// What a signed form is allowed to be. Deliberately narrow: a PDF from REDCap,
// or a photo/scan from a phone.
const ALLOWED_MIME = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/heic", "image/heif",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  if (!process.env.SESSION_TICKET_SECRET) {
    console.error("SESSION_TICKET_SECRET is not set");
    res.status(500).json({ ok: false, error: "server not configured" });
    return;
  }

  const auth = req.headers.authorization || "";
  const ticket = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const pid = verifyTicket(ticket);
  if (!pid) {
    res.status(401).json({ ok: false, error: "missing or expired session ticket" });
    return;
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ ok: false, error: "expected a consent upload" });
    return;
  }

  // The ticket's pid is the authenticated identity, exactly as in submit.js: a
  // body claiming another participant is either a bug or an attempt to file a
  // document into another child's record.
  const claimedPid = body.participant_id;
  if (claimedPid && claimedPid !== pid) {
    res.status(403).json({ ok: false, error: "body/ticket participant mismatch" });
    return;
  }

  const form = String(body.form ?? "");
  if (!FORM_KEYS.has(form)) {
    res.status(400).json({ ok: false, error: "unknown consent form" });
    return;
  }

  const b64 = typeof body.content_base64 === "string" ? body.content_base64 : "";
  if (!b64) {
    res.status(400).json({ ok: false, error: "no file content" });
    return;
  }
  if (b64.length > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "file too large" });
    return;
  }

  let content;
  try {
    content = Buffer.from(b64, "base64");
  } catch {
    res.status(400).json({ ok: false, error: "content is not base64" });
    return;
  }
  // Checked on the DECODED length, which is the only one that matters -- the
  // base64 ceiling above is a cheap pre-filter, not the limit.
  if (content.length === 0 || content.length > MAX_FILE_BYTES) {
    res.status(413).json({ ok: false, error: "file too large or empty" });
    return;
  }

  const mime = String(body.mime ?? "application/octet-stream");
  if (!ALLOWED_MIME.has(mime)) {
    res.status(415).json({ ok: false, error: `unsupported file type: ${mime}` });
    return;
  }

  // Kept for the record but never trusted as a path: only the basename, and
  // only to help a human recognise the document later.
  const filename = String(body.filename ?? "form")
    .replace(/[\\/]/g, "_").slice(0, 200);

  try {
    await ensureConsentSchema();
    const { rows } = await sql`
      INSERT INTO consent_files
        (participant_id, form, filename, mime, bytes, content)
      VALUES (${pid}, ${form}, ${filename}, ${mime}, ${content.length},
              ${content})
      ON CONFLICT (participant_id, form) DO UPDATE
        SET filename = EXCLUDED.filename,
            mime     = EXCLUDED.mime,
            bytes    = EXCLUDED.bytes,
            content  = EXCLUDED.content,
            created_at = now()
      RETURNING id;
    `;
    // The response says nothing about the document -- not its name, not its
    // size. There is no reason for a client to be told anything back except
    // that it landed.
    res.status(200).json({ ok: true, id: rows?.[0]?.id ?? null });
  } catch (e) {
    console.error("consent upload failed", e);
    res.status(502).json({ ok: false, error: "storage unavailable" });
  }
}
