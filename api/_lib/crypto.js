/**
 * Encryption at rest for the consent documents -- see api/consent.js.
 *
 * The session payloads in `sessions` are protected by access control: they are
 * reachable only through this API, which is the only holder of POSTGRES_URL.
 * That is the right level for demographics. It is not the right level for a
 * signed consent form, because access control has exactly one failure mode --
 * anyone who ends up holding the connection string, a database dump, a
 * backup, or a console session reads every document in the clear.
 *
 * So the documents are encrypted before they are ever handed to Postgres, with
 * a key that lives only in the environment. A database compromise on its own
 * then yields ciphertext; it takes the database AND the deployment's env to
 * read a form. That is the whole claim -- it is defence in depth against
 * exactly the leak that access control cannot cover, not a substitute for it.
 *
 *     AES-256-GCM, and why the tag matters
 *     -------------------------------------
 *     GCM is authenticated: decryption FAILS on a modified ciphertext rather
 *     than returning plausible garbage. For a consent record that is the
 *     point -- a document that cannot be shown to be the one that was signed
 *     is not evidence of consent, and silent corruption would be worse than
 *     an error, because it would be believed.
 *
 *     The participant_id is bound in as additional authenticated data, so a
 *     row's ciphertext cannot be moved onto another participant's row and
 *     still decrypt. Filing one child's consent form under another child's id
 *     is precisely the corruption worth making impossible.
 *
 *     THE ENVELOPE, and why it is one column
 *     ---------------------------------------
 *     [version:1][iv:12][tag:16][ciphertext:...] in a single BYTEA. Keeping
 *     iv/tag in their own columns would have meant altering a table that may
 *     already exist in a live database, and CREATE TABLE IF NOT EXISTS does
 *     not add columns -- a migration for no benefit. The version byte is what
 *     lets the scheme change later without guessing at the old rows.
 */
import crypto from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;      // GCM's standard nonce length
const TAG_BYTES = 16;

/** Read the key, or throw. 32 raw bytes, base64 in the environment.
 *
 *  Generate one with:  openssl rand -base64 32
 *
 *  THROWS rather than falling back to storing plaintext. A missing key must
 *  be a loud failure: the quiet alternative -- write the document unencrypted
 *  and carry on -- would put signed consent forms in the clear at exactly the
 *  moment someone believed they were protected.
 */
function key() {
  const raw = process.env.CONSENT_ENCRYPTION_KEY;
  if (!raw) throw new Error("CONSENT_ENCRYPTION_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    throw new Error(
      `CONSENT_ENCRYPTION_KEY must be 32 bytes base64 (got ${k.length})`);
  }
  return k;
}

/** True when a key is configured and usable, without throwing. Lets a caller
 *  refuse the request with a clear message instead of a 500. */
export function encryptionReady() {
  try { key(); return true; } catch { return false; }
}

/** Plaintext Buffer -> the stored envelope. `aad` binds it to a participant. */
export function encrypt(plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** The stored envelope -> plaintext Buffer. Throws if the key is wrong, the
 *  document was altered, or `aad` does not match the participant it was
 *  stored under. */
export function decrypt(envelope, aad) {
  const buf = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error("stored document is too short to be an envelope");
  }
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(`unknown consent envelope version ${version}`);
  }
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  if (aad) d.setAAD(Buffer.from(String(aad), "utf8"));
  return Buffer.concat([d.update(body), d.final()]);
}

/** Bytes the envelope adds over the plaintext. Used by the storage accounting
 *  in consent.js, so the budget is measured in what is actually stored. */
export const ENVELOPE_OVERHEAD = 1 + IV_BYTES + TAG_BYTES;
