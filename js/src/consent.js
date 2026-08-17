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
      root.innerHTML = `
        <div class="setup consent-gate">
          <h1>MELD consent</h1>
          <p class="setup-sub">Please complete the following before continuing:</p>
          <p class="consent-howto">
            ${forms.length === 1
              ? "Open the form below and complete it."
              : `Open each of the ${forms.length} forms below and complete them — `
                + "both are needed."}
            Each opens in a new tab. Come back here afterwards and tick the box
            to confirm, then continue.
          </p>
          <ul class="consent-links">
            ${forms.map((f) => `<li><a href="${consentLinkUrl(f.url, pid)}"
              target="_blank" rel="noopener">${f.label}</a></li>`).join("")}
          </ul>
          <label class="consent-ack">
            <input type="checkbox" id="c-ack">
            I confirm the required consent/assent form(s) above have been completed.
          </label>
          <button class="big" id="c-continue" disabled>Continue</button>
        </div>`;

      const ack = root.querySelector("#c-ack");
      const btn = root.querySelector("#c-continue");
      ack.addEventListener("change", () => { btn.disabled = !ack.checked; });

      btn.addEventListener("click", () => {
        resolve({
          ...cfg,
          Age: String(age),
          consent_forms_shown: forms.map((f) =>
            Object.keys(MELD_LINKS).find((k) => MELD_LINKS[k] === f)),
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
