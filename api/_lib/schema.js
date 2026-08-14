/**
 * The one table this study writes, created on demand.
 *
 * Shared by submit.js and export.js rather than owned by submit.js, because
 * "has the database been set up correctly" is a question you ask BEFORE any
 * session has ever run -- and the answer used to be a Postgres error saying
 * `relation "sessions" does not exist`, which reads as a broken database
 * rather than an empty one. With both endpoints creating it, an export
 * against a freshly connected database returns an empty list, which is the
 * honest answer and a usable health check.
 *
 * No separate migration step beyond setting POSTGRES_URL -- Vercel sets that
 * itself once a Postgres/Neon store is connected to the project.
 */
import { sql } from "@vercel/postgres";

let schemaReady = null;

export function ensureSchema() {
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
    `.catch((e) => { schemaReady = null; throw e; }); // retry next call, don't wedge forever
  }
  return schemaReady;
}
