/**
 * MELD (Multisensory Environments in Longitudinal Development) consent and
 * assent, gated on age.
 *
 * The bands here are NOT session.js's AGE_BINS. Those cut at 10/11
 * (middle_childhood/adolescence) for trial-pacing reasons; MELD's forms cut
 * at 11/12 (7-11 vs 12-17) because that is where the consent forms
 * themselves are drawn -- a regulatory boundary, not a pacing one. Mirrored
 * field-for-field in utilities/meld_consent.py.
 *
 * Updated 5-19-26.
 */

/** Largest consent file accepted, per form. A phone photo of a signed page is
 *  typically 2-6MB; a multi-page scan can be more. Checked in the browser (so
 *  a parent is told immediately) and again server-side (so the limit is real).
 *  Mirrored by api/consent.js's own cap in the deploy repo. */
export const MAX_CONSENT_BYTES = 10 * 1024 * 1024;

/** The attached files, held between the gate and the upload.
 *
 * Deliberately module state rather than a field on `cfg`, mirroring
 * captcha.js's getTicket(): cfg is serialised into the session payload, and a
 * signed consent form -- a named, dated document about a specific child --
 * must never end up inside a research data file. The gate runs BEFORE
 * admitSession has minted a ticket (see main.js), so the upload cannot happen
 * at the moment the file is chosen; this is what carries it across.
 */
let pendingFiles = [];

/** What the gate collected: `[{form, file}]`, or empty. */
export function getConsentFiles() {
  return pendingFiles.slice();
}

export const MELD_LINKS = {
  adult:    { label: "Adult Consent Form",    url: "https://redcap.link/MELDAdult" },
  parental: { label: "Parental Consent Form", url: "https://redcap.link/MELDParental" },
  age_12_17: { label: "12-17 Consent Form",   url: "https://redcap.link/MELD12-17" },
  age_7_11:  { label: "7-11 Assent Form",     url: "https://redcap.link/MELD7-11" },
  age_0_6:   { label: "0-6 Assent Form",      url: "https://redcap.link/MELD0-6" },
};

/**
 * Which MELD form(s) apply to `age`. Returns null when age is not a usable
 * number, so a caller can tell "unknown" from "adult" -- ageBin() in
 * session.js defaults an unknown age to "adults", which would silently skip
 * a minor's parental/assent form here.
 */
export function meldFormsForAge(age) {
  // Number("") is 0, not NaN -- a blank age would otherwise silently resolve
  // to the 0-6 band instead of being rejected. Checked before the cast.
  if (String(age ?? "").trim() === "") return null;
  const n = Number(age);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 18) return [MELD_LINKS.adult];
  if (n >= 12) return [MELD_LINKS.parental, MELD_LINKS.age_12_17];
  if (n >= 7) return [MELD_LINKS.parental, MELD_LINKS.age_7_11];
  return [MELD_LINKS.parental, MELD_LINKS.age_0_6];
}

/** `url` with the participant id appended, so a REDCap admin can pipe it into
 * a field on the instrument (see js/README.md's REDCap setup checklist) and
 * join a consent record back to this session by participant_id. */
export function consentLinkUrl(url, participantId) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}pid=${encodeURIComponent(participantId ?? "")}`;
}

/**
 * The blocking consent gate. Mirrors js/src/setup.js's showSetup shape:
 * renders into `root`, resolves with `cfg` merged in, never rejects.
 *
 * When `cfg.Age` is already known (the lab/facility path, set by showSetup)
 * the age question is skipped. When it is not (a CHS session -- CHS never
 * puts age in the URL, see js/README.md) a single age-only question is asked
 * first, so this is the one place a CHS session's age becomes known at
 * runtime instead of only afterward from the demographic-snapshot join.
 */
export function showConsentGate(cfg, root) {
  return new Promise((resolve) => {
    function renderAgeQuestion() {
      root.innerHTML = `
        <div class="setup consent-gate">
          <h1>Before we begin</h1>
          <p class="setup-sub">What is your (or your child's) age?</p>
          <div class="setup-grid">
            <label>Age
              <input id="c-age" type="number" min="0" max="120" required autocomplete="off"></label>
          </div>
          <p class="setup-error" id="c-age-error" hidden></p>
          <button class="big" id="c-age-next">Continue</button>
        </div>`;
      root.querySelector("#c-age-next").addEventListener("click", () => {
        const raw = root.querySelector("#c-age").value;
        const forms = meldFormsForAge(raw);
        if (!forms) {
          const err = root.querySelector("#c-age-error");
          err.textContent = "Please enter a valid age.";
          err.hidden = false;
          return;
        }
        renderForms(raw, forms);
      });
    }

    function renderForms(age, forms) {
      const pid = cfg.participant_id;
      const keyOf = (f) => Object.keys(MELD_LINKS).find((k) => MELD_LINKS[k] === f);
      root.innerHTML = `
        <div class="setup consent-gate">
          <h1>MELD consent</h1>
          <p class="setup-sub">Please complete the following before continuing:</p>
          <p class="consent-howto">
            Open each form below and complete it, then save or scan the signed
            copy and attach it here. ${forms.length === 1
              ? "There is one form to attach."
              : `There are ${forms.length} forms to attach — one for each row.`}
            PDF, photo or scan is fine.
          </p>
          <ul class="consent-links">
            ${forms.map((f, i) => `
              <li class="consent-row" data-form="${keyOf(f)}">
                <a href="${consentLinkUrl(f.url, pid)}"
                   target="_blank" rel="noopener">${f.label}</a>
                <label class="consent-file">
                  <span class="consent-file-label">Attach the completed form</span>
                  <input type="file" id="c-file-${i}" data-idx="${i}"
                         accept=".pdf,.png,.jpg,.jpeg,.heic,image/*,application/pdf">
                </label>
                <p class="consent-file-state" id="c-state-${i}"></p>
              </li>`).join("")}
          </ul>
          <p class="setup-error" id="c-file-error" hidden></p>
          <button class="big" id="c-continue" disabled>Continue</button>
        </div>`;

      const btn = root.querySelector("#c-continue");
      const err = root.querySelector("#c-file-error");
      // One slot per required form, filled in by index. Kept in this closure
      // and NEVER put on cfg: cfg is serialised into the session payload, and
      // a signed consent form must not travel inside a research data file.
      const chosen = new Array(forms.length).fill(null);

      const refresh = () => {
        // Every required form must have a file. `forms` is 1 or 2 long by age,
        // so this is also what enforces "both forms for a minor" -- a gate
        // that enabled on the first attachment would let a parental consent
        // through with no assent beside it.
        btn.disabled = chosen.some((c) => c === null);
      };

      for (const input of root.querySelectorAll('input[type="file"]')) {
        input.addEventListener("change", () => {
          const i = Number(input.dataset.idx);
          const file = input.files && input.files[0];
          const state = root.querySelector(`#c-state-${i}`);
          if (!file) {
            chosen[i] = null;
            state.textContent = "";
            refresh();
            return;
          }
          if (file.size > MAX_CONSENT_BYTES) {
            // Rejected here as well as server-side: a parent who photographed
            // a form on a modern phone can easily exceed this, and finding out
            // after the upload silently failed would mean a session that ran
            // with no consent file recorded against it.
            chosen[i] = null;
            input.value = "";
            state.textContent = "";
            err.textContent = `That file is too large (max `
              + `${Math.floor(MAX_CONSENT_BYTES / (1024 * 1024))}MB). `
              + `Please attach a smaller scan or photo.`;
            err.hidden = false;
            refresh();
            return;
          }
          err.hidden = true;
          chosen[i] = { form: keyOf(forms[i]), file };
          state.textContent = `Attached: ${file.name}`;
          refresh();
        });
      }
      refresh();

      btn.addEventListener("click", () => {
        if (chosen.some((c) => c === null)) return;   // belt and braces
        pendingFiles = chosen.slice();
        resolve({
          ...cfg,
          Age: String(age),
          consent_forms_shown: forms.map(keyOf),
          // What was attached, as a RECORD -- name, size, type -- never the
          // bytes. Enough to tell afterwards that a form was collected and
          // which one, while the document itself goes only to the endpoint in
          // uploadConsentFiles.
          consent_files: chosen.map((c) => ({
            form: c.form,
            filename: c.file.name,
            bytes: c.file.size,
            mime: c.file.type || "application/octet-stream",
          })),
          consent_acknowledged: true,
          consent_acknowledged_at: new Date().toISOString(),
        });
      });
    }

    if (cfg.Age) {
      renderForms(cfg.Age, meldFormsForAge(cfg.Age) ?? [MELD_LINKS.adult]);
    } else {
      renderAgeQuestion();
    }
  });
}

/** Read a File as base64, without the `data:...;base64,` prefix. */
function base64Of(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("could not read the file"));
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.readAsDataURL(file);
  });
}

/**
 * Send the attached consent forms to `url`, one POST per form.
 *
 * Called from main.js AFTER admitSession, because it needs that ticket: the
 * endpoint has to be authenticated, or a public deploy is carrying an open
 * file-upload URL that anyone can write to.
 *
 *     Where these end up, and why not Vercel Blob
 *     -------------------------------------------
 *     The same reasoning api/submit.js already sets out for the session
 *     payload, only more so. Blob's access mode is public: anyone holding the
 *     URL can read the object, with no credential. That was judged wrong for
 *     a payload carrying a child's age and ethnicity, and a signed consent
 *     form -- a name, a signature, a date, a parent -- is a good deal more
 *     identifying than that. So these go to Postgres through this API, which
 *     is the only holder of POSTGRES_URL, and are readable only through it.
 *
 * Returns `{sent, failed}`. Never throws and never blocks the session: a
 * consent form that fails to upload is a file to chase, not a reason to turn
 * a family away after they have already filled the forms in. The failure is
 * loud in the console and, because `consent_files` is recorded in the payload
 * either way, visible afterwards as a form the record says was attached with
 * no stored document to match.
 */
export async function uploadConsentFiles({ url, participantId, ticket }) {
  const files = getConsentFiles();
  if (!url || files.length === 0) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const { form, file } of files) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ticket ? { Authorization: `Bearer ${ticket}` } : {}),
        },
        body: JSON.stringify({
          participant_id: participantId ?? "",
          form,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          bytes: file.size,
          content_base64: await base64Of(file),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sent += 1;
    } catch (e) {
      failed += 1;
      console.error(`consent form ${form} did not upload -- it will have to be `
        + `collected another way`, e);
    }
  }
  // Dropped once sent: nothing later in the session has any business holding
  // a consent document in memory.
  pendingFiles = [];
  return { sent, failed };
}
