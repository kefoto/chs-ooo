/**
 * Pull the signed consent documents back out, decrypted -- for the researcher
 * only, and the only way to read them at all.
 *
 * DORMANT, with api/consent.js -- see its header. Nothing uploads documents at
 * present (the gate is a tick box), so this will report an empty table until
 * that changes. It is still the right thing to reach for if the table DOES
 * hold rows: anything stored while the upload path was live is here, and
 * `?content=1` is how to get it out.
 *
 * Guarded by ADMIN_EXPORT_SECRET, the same separate secret api/export.js uses
 * and deliberately NOT a session ticket: a ticket is short-lived and scoped to
 * one participant, and must never become a way to read another family's
 * consent form. Reading these needs the admin secret AND the environment's
 * CONSENT_ENCRYPTION_KEY, which is the whole point of encrypting them (see
 * api/_lib/crypto.js).
 *
 * Usage:
 *   # list what is stored, without any document bodies
 *   curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
 *     "https://<deployment>/api/consent-export"
 *
 *   # one participant's forms, base64 bodies included
 *   curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
 *     "https://<deployment>/api/consent-export?participant_id=P07&content=1"
 *
 *   # and, once they are safely saved, free the space they occupied
 *   curl -X POST -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
 *     "https://<deployment>/api/consent-export?participant_id=P07&content=1&delete=1"
 *
 * `delete=1` is a POST, never a GET. A GET that destroys data is one
 * accidental browser visit, link preview or retry away from deleting consent
 * records, and this endpoint's whole subject matter is the paperwork you
 * cannot re-create after the family has gone home.
 *
 * It also deletes ONLY the rows included in the response it just produced,
 * by id -- not "everything matching the query", which would silently discard a
 * document that arrived between the SELECT and the DELETE.
 */
import { sql } from "@vercel/postgres";
import { ensureConsentSchema } from "./_lib/schema.js";
import { decrypt, encryptionReady } from "./_lib/crypto.js";

export default async function handler(req, res) {
  const wantsDelete = req.query.delete === "1";
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "GET or POST only" });
    return;
  }
  if (wantsDelete && req.method !== "POST") {
    res.status(405).json({ ok: false,
      error: "delete=1 requires POST, so a stray GET cannot destroy records" });
    return;
  }

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const expected = process.env.ADMIN_EXPORT_SECRET;
  if (!expected) {
    console.error("ADMIN_EXPORT_SECRET is not set");
    res.status(500).json({ ok: false, error: "server not configured" });
    return;
  }
  if (!token || token !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const pid = typeof req.query.participant_id === "string"
    ? req.query.participant_id : null;
  // Bodies are opt-in. The default is an inventory -- who has which form, how
  // big, when -- which is what answers "did this family's paperwork arrive"
  // without moving the documents anywhere.
  const withContent = req.query.content === "1";

  if (withContent && !encryptionReady()) {
    res.status(500).json({ ok: false,
      error: "CONSENT_ENCRYPTION_KEY is not set; stored documents cannot be read" });
    return;
  }
  // Refuse to delete what was never handed over. Otherwise `delete=1` without
  // `content=1` is a one-request way to destroy every document while
  // receiving none of them.
  if (wantsDelete && !withContent) {
    res.status(400).json({ ok: false,
      error: "delete=1 requires content=1: documents are only cleared once "
           + "this response has actually handed them over" });
    return;
  }

  try {
    await ensureConsentSchema();
    const { rows } = pid
      ? await sql`SELECT id, participant_id, form, filename, mime, bytes,
                         created_at, content
                    FROM consent_files WHERE participant_id = ${pid}
                   ORDER BY participant_id, form;`
      : await sql`SELECT id, participant_id, form, filename, mime, bytes,
                         created_at, content
                    FROM consent_files ORDER BY participant_id, form;`;

    const failed = [];
    const files = rows.map((r) => {
      const out = {
        id: r.id,
        participant_id: r.participant_id,
        form: r.form,
        filename: r.filename,
        mime: r.mime,
        bytes: Number(r.bytes),
        created_at: r.created_at,
      };
      if (!withContent) return out;
      try {
        // Bound to the participant it was stored under -- a row whose
        // ciphertext was moved to another participant fails here rather than
        // decoding into the wrong child's record.
        out.content_base64 = decrypt(r.content, r.participant_id).toString("base64");
      } catch (e) {
        // Reported per row, not thrown: one unreadable document (wrong key,
        // altered bytes) must not withhold every other family's paperwork.
        out.error = `could not decrypt: ${e.message}`;
        failed.push(r.id);
      }
      return out;
    });

    let deleted = 0;
    if (wantsDelete) {
      // Only rows handed over INTACT in this response. A document that failed
      // to decrypt is the one thing that must survive: deleting it would
      // destroy the only copy of something already known to be in trouble.
      const ids = files.filter((f) => f.content_base64).map((f) => f.id);
      if (ids.length) {
        const { rowCount } = await sql`
          DELETE FROM consent_files WHERE id = ANY(${ids}::int[]);`;
        deleted = rowCount ?? 0;
      }
    }

    const { rows: [{ used }] } = await sql`
      SELECT COALESCE(sum(octet_length(content)), 0)::bigint AS used
        FROM consent_files;`;

    res.status(200).json({
      ok: true,
      count: files.length,
      deleted,
      undecryptable: failed,
      stored_bytes: Number(used),
      files,
    });
  } catch (e) {
    console.error("consent export failed", e);
    res.status(502).json({ ok: false, error: "storage unavailable" });
  }
}
