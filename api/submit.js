/**
 * Receive one session's data: called once per completed room (see
 * js/README.md's block table) and again with the full payload at session
 * end, so a child who disengages partway still has their earlier blocks
 * recorded server-side rather than only in a browser tab that may never save.
 *
 * Requires a ticket from verify-start.js (Authorization: Bearer <ticket>) --
 * Turnstile itself is solved only once, at session start; see _lib/ticket.js
 * for why.
 *
 *     Why Postgres, not Vercel Blob
 *     ------------------------------
 *     Blob's only access mode is "public": anyone with the (unguessable)
 *     URL can read it, no credential required. The payload carries a
 *     child's age, gender, ethnicity, race, handedness and first language --
 *     an IRB expects that behind real access control, not obscurity. Rows
 *     here are reachable only through this API, which is the only holder of
 *     POSTGRES_URL.
 *
 * Every call is an INSERT, never an UPDATE: each block's payload (which
 * already contains every response so far, not just that block's) lands as
 * its own row, so the row with the highest id for a participant is always
 * the most complete one available if the session never reaches "final".
 */
import { sql } from "@vercel/postgres";
import { verifyTicket } from "./_lib/ticket.js";

// Generous for 550 trials of small JSON rows, and still small enough that a
// forged/oversized body from a client that got past the ticket check cannot
// turn this into a storage-cost attack.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

let schemaReady = null;

/** CREATE TABLE IF NOT EXISTS, once per cold start -- no separate migration
 * step needed beyond setting POSTGRES_URL (Vercel sets it automatically once
 * a Postgres database is linked to the project). */
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        participant_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sessions_participant_idx
        ON sessions (participant_id, created_at DESC);
    `.catch((e) => { schemaReady = null; throw e; }); // retry on next call, don't wedge forever
  }
  return schemaReady;
}

function tagFor(payload, block) {
  if (Number.isFinite(block)) return `block-${block}`;
  return payload?.participant_data?.completion_status === 1 ? "final" : "final_partial";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  const auth = req.headers.authorization || "";
  const ticket = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const pid = verifyTicket(ticket);
  if (!pid) {
    res.status(401).json({ ok: false, error: "missing or expired session ticket" });
    return;
  }

  const raw = req.body;
  if (!raw || typeof raw !== "object" || !raw.payload) {
    res.status(400).json({ ok: false, error: "expected {payload, block?}" });
    return;
  }
  const { payload, block } = raw;
  if (JSON.stringify(payload).length > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "payload too large" });
    return;
  }

  // The ticket's pid is the authenticated identity; a payload claiming a
  // different participant_id would either be a bug or an attempt to write
  // into another child's record under a stolen/guessed ticket -- reject
  // rather than trust the body.
  const claimedPid = payload?.participant_data?.participant_id;
  if (claimedPid && claimedPid !== pid) {
    res.status(403).json({ ok: false, error: "payload/ticket participant mismatch" });
    return;
  }

  const tag = tagFor(payload, block);

  try {
    await ensureSchema();
    const { rows } = await sql`
      INSERT INTO sessions (participant_id, tag, payload)
      VALUES (${pid}, ${tag}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id;
    `;
    res.status(200).json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error("session insert failed", e);
    res.status(502).json({ ok: false, error: "storage unavailable" });
  }
}
