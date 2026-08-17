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
import { encrypt, encryptionReady, ENVELOPE_OVERHEAD } from "./_lib/crypto.js";

// Mirrors MAX_CONSENT_BYTES in js/src/consent.js. Checked there so a parent is
// told immediately, and here so the limit is real -- the browser's check is a
// courtesy to the person, not a control on the endpoint.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Ceiling on everything this table holds, across all participants.
//
// THE POINT IS NOT DISK COST. consent_files shares a database with `sessions`,
// which is where the actual measurement lands -- so documents that fill the
// storage quota do not merely stop being accepted, they start failing
// submit.js's INSERTs and lose research data. A paperwork attachment must
// never be able to cost a completed session.
//
// So this budget is deliberately a fraction of the smallest plan the study is
// likely to run on (Neon's free tier is 0.5GB), leaving the rest for session
// rows, which are small and are the thing that actually matters. When the
// budget is reached the UPLOAD is refused and the session carries on: a
// consent form is recoverable afterwards by asking the family, and a
// half-hour of a child's attention is not.
//
// Raise it once the forms are being exported and cleared regularly (see
// api/consent-export.js, which deletes what it has handed over).
const MAX_TOTAL_BYTES = Number(process.env.CONSENT_STORAGE_BUDGET_BYTES
  || 200 * 1024 * 1024);

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

  // Refused, not degraded. Without a key these documents could only be stored
  // in the clear, and a signed consent form sitting unencrypted in a database
  // that someone believes is encrypted is worse than one that was never
  // collected -- the first is a silent exposure, the second is a visible gap.
  if (!encryptionReady()) {
    console.error("CONSENT_ENCRYPTION_KEY is missing or not 32 bytes base64; "
      + "refusing to store consent documents in the clear");
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

    // The storage budget, checked BEFORE the insert so it is a ceiling rather
    // than a ceiling plus one document. The row this upload replaces is
    // discounted: re-attaching a form for a participant who already has one is
    // an upsert, so it costs the DIFFERENCE, not another whole document, and
    // charging it in full would refuse a correction on a nearly-full table.
    const stored = content.length + ENVELOPE_OVERHEAD;
    const { rows: [{ used, existing }] } = await sql`
      SELECT
        COALESCE((SELECT sum(octet_length(content)) FROM consent_files), 0)::bigint AS used,
        COALESCE((SELECT octet_length(content) FROM consent_files
                   WHERE participant_id = ${pid} AND form = ${form}), 0)::bigint AS existing;
    `;
    if (Number(used) - Number(existing) + stored > MAX_TOTAL_BYTES) {
      // Loud: this is not a client's mistake and not a rate to back off from.
      // It means the table needs exporting and clearing, and until it is,
      // every family's forms are being turned away.
      console.error(`consent storage budget exhausted: ${used} bytes stored, `
        + `budget ${MAX_TOTAL_BYTES}. Export and clear via /api/consent-export `
        + `?delete=1, or raise CONSENT_STORAGE_BUDGET_BYTES.`);
      res.status(507).json({ ok: false, error: "consent storage full" });
      return;
    }

    // Encrypted here, at the last moment before it is handed over, and bound
    // to this participant so the ciphertext cannot be replayed onto another
    // child's row. `bytes` stays the PLAINTEXT length: it is the record of how
    // big the document a family sent was, which is what a human comparing it
    // to the original cares about.
    const sealed = encrypt(content, pid);
    const { rows } = await sql`
      INSERT INTO consent_files
        (participant_id, form, filename, mime, bytes, content)
      VALUES (${pid}, ${form}, ${filename}, ${mime}, ${content.length},
              ${sealed})
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
