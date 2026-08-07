# Pip's Castle — browser build (jsPsych)

A web port of the **Tier 1** (visual) and **Tier 2** (V / A / AV) triplet
odd-one-out tasks and their kid-facing game layer, for running the study at a
remote facility. Targets **jsPsych 8**.

## Run it

The page fetches manifests and images, so it must be served over HTTP.
Opening `index.html` from disk will fail (`file://` blocks `fetch`).

```bash
# from the repository root
python3 -m http.server 8000
# then open:
#   http://localhost:8000/js/index.html
```

Opening it **without a query string** shows the experimenter's **setup screen**
— the browser counterpart to `experiments/setup_experiment.py`, with the same
fields: participant id, age, task tier, session length, the demographics, and
the gamified / reduced-motion switches. It previews the session it will run and
starts it on submit.

The participant id starts blank and is required: it seeds the triplets, the
block order and the reward schedule, so a blank or reused one would hand every
child an identical session.

### Session length

**Every session runs 550 trials**, whatever the participant's age or the
requested duration (`FIXED_TRIALS_PER_SESSION` in `js/src/session.js`, matching
`core/flexible_session_manager.py` — a test parses one against the other, since
a browser session and a lab session that disagree are not the same study).

This replaced an age-bin × duration table that ran 16/24/32 for early childhood
up to 350/600/800 for adults. Fixing it makes counts comparable across age bins
without reweighting.

> 550 does **not** fit a `short` session: ~32 min of responding at the 3.5s
> visual estimate against 24 effective minutes, and ~73 min at the 8s estimated
> for early childhood. Sessions run past their nominal duration or stop early on
> the time check. For young children the protocol answer is repeat sessions
> across days rather than one sitting.

**Tier 2 is capped by its own pacing.** Its A and AV blocks play three clips
before a choice is possible (~9.8s), so it costs ~9.2s a trial against ~3.5s
for a visual one. Feeding it the adult visual figure would schedule ~98 minutes
of playback into a 60-minute session, so it takes whichever is smaller — the
table, or what the clock holds. An adult standard Tier 2 session is 312 trials,
not 600.

That is the **session total**. It is split into blocks of **11 trials
(under 18)** or **25 (adults)** — a block boundary is where a room ends and its
stickers are awarded, so block size is really "how often is the child
rewarded", and it decides the room count:

| Age | Per block | Rooms |
|---|---|---|
| under 18 | 11 | 50 |
| 18+ | 25 | 22 |

The size cannot be picked freely: it must **divide 550** or the session lands
short, because rooms are what get scheduled and the division truncates. Since
550 = 2 × 5² × 11, the only options between 10 and 20 are 10 (55 rooms) and
11 (50 rooms). Under-18s were on 5, which meant 110 rooms — 110 sticker
ceremonies and playgrounds in a single session.

> **Stickers repeat at 50 rooms.** The pool is 104 and a room awards 2–4, so a
> 50-room session needs ~144 and `CastleState.create` reshuffles the pool when
> it runs dry — roughly 40 of them are second sightings. Avoiding repeats
> entirely needs ≤ ~34 rooms, i.e. 22 per block, which is outside the 10–20
> range. Adults at 22 rooms stay inside the pool.

Tier 2 runs **6 blocks, two per condition**, dividing its own (capped) total.

`trials` in the URL is trials **per block**, never the session total.

### Per-session settings, via the URL

A URL carrying `pid` skips the setup screen — that is the form for a facility
link, or for the test harness. `?setup=1` forces the form even so, and any
other params below preselect its fields.

```
http://localhost:8000/js/index.html?pid=P07&rooms=6&trials=8&age=7&site=LabA
```

| Param | Meaning |
|---|---|
| `pid` | participant id — **seeds the whole session**, so it must be unique |
| `tier` | `1` (default, visual) or `2` (blocked V / A / AV) |
| `rooms` | number of castle rooms (`Num Blocks`); in Tier 2 one room = one condition block |
| `trials` | trials per room (`Num Trials`) |
| `age`, `site` | recorded into `participant_data` |
| `plain=1` | non-gamified baseline arm: no castle, no mascot |
| `calm=1` | reduced-stimulation mode |
| `upload=URL` | also POST the finished JSON to a collection endpoint |
| `mode` | Tier 2 only: `shared` (default) or `disjoint` — see below |
| `lead`, `gap` | Tier 2 stimulus pacing in ms (default 800 / 3000) |
| `duration` | `short`, `standard` (default) or `extended` — recorded; the trial count no longer varies with it |
| `setup=1` | show the setup screen even when `pid` is given |
| `child`, `response` | set by Children Helping Science — see below |
| `media=URL` | serve `assets/` and `datasets/` from another origin (needs CORS) |

Give neither `rooms` nor `trials` and both come from the session plan above.

## Running it as a Children Helping Science study

CHS's own jsPsych runner cannot host this build: it forbids custom plugins, and
almost every screen here is one (`TripletPlugin`, `AudioTripletPlugin`,
`CutscenePlugin`, `PlaygroundPlugin`, `ScreenPlugin`). So it runs as a CHS
**external study** — CHS keeps recruitment, eligibility and consent, and links
out to this page.

**1. Host it.** Enable GitHub Pages on this repository (Settings → Pages →
deploy from `main`, folder `/`). The whole repo is served, so `index.html` keeps
its position above `assets/` and `datasets/` and the relative paths in
`config.js` resolve unchanged. A `.nojekyll` file at the repo root stops Pages
running the content through Jekyll. The study is then at:

```
https://<user>.github.io/<repo>/js/index.html
```

**2. Set the Study URL** on the CHS study page, with any of the params above
baked in — CHS keeps your query string and appends its own:

```
https://<user>.github.io/<repo>/js/index.html?tier=1&upload=https://your-endpoint
```

**3. What CHS sends.** When a family presses "Participate now", CHS appends the
hashed child id and the response id, and nothing else:

```
...?tier=1&upload=...&child=SG7JLN&response=d5c8f502-6588-46c8-84fa-a9657a44fe47
```

Seeing `child`, the build treats the session as a family at home: the
experimenter's setup form never appears (not even for `?setup=1`), the child
hash becomes the `participant_id` that seeds the session, `setting` is recorded
as `home`, and **no file download is offered** — a save prompt on a parent's
computer is not a data pipeline.

**4. Give it somewhere to put the data.** `upload=` is therefore mandatory for a
CHS session: it is the only route out, and without it the session is lost. The
endpoint receives the same JSON the desktop build writes, POSTed as
`application/json`.

**5. Age comes later, not from the link.** CHS does not put the child's age in
the URL, so `participant_data.age` is empty for these sessions. It lives in the
CHS demographic snapshot and is joined afterwards on `chs_child`, which is
recorded in every payload alongside `chs_response`. The analysis pipeline bins
by `participant_data.age`, so that join has to happen before
`analysis/spose_comparison.py` will bin these sessions by age.

> **Repeat participation.** The participant id is the child hash, which is
> stable — so a child who takes part twice replays the *same* triplet sequence.
> If repeat sessions should cover new triplets, seed from `chs_response`
> instead (one line in `applyUrlOverrides`).

## Tier 2: the V / A / AV conditions

Tier 2 measures **supradditivity** — whether seeing-and-hearing an item
constrains similarity more than seeing plus hearing it separately. Two design
properties carry that measurement, and both are ported:

**Conditions are blocked and Latin-square counterbalanced.** One room = one
block = one condition, cycling the participant's order from
`LATIN_SQUARE_ORDERS`. The order actually run is recorded per room in
`game_state.castle.rooms[*].condition`, so it never has to be re-derived from
the id.

**`mode=shared` (default) yokes the triplets.** Every condition block presents
the *same* triplet list, so AV vs (V + A) is a within-item contrast. That
yoking is what makes the test well defined at item level. `mode=disjoint`
gives each block its own triplets: no cross-condition carryover, but
group-level comparison only.

Presentation follows the desktop build. Sounds auto-play in sequence — a
lead-in, then one clip every 3s — and every item keeps a **replay** button,
because sound is serial where an image is parallel: a child cannot re-listen
to sound 1 while sound 3 plays. Selecting stops playback *before* any
feedback, so a clip never runs under it. A-only items show a speaker and an
explicit "Pick this one"; AV items show the image and the whole card is the
target.

### The one thing a browser adds: autoplay

Chrome will not start playback on a page nobody has touched, and a blocked
A-only trial is a **silent** trial — the child picks from nothing and the row
looks like ordinary data. Two defences:

- `armPriming()` plays 0.05s of silence on the page's clicks until one
  unlocks the tab. Every session opens with screens the child taps, so this
  is resolved long before the first sound.
- If a `play()` still rejects, the screen falls back to "tap replay", and the
  row is flagged `stimulus_autoplay_blocked: true` so those trials can be
  **filtered rather than analysed**.

A/AV rows also carry `playback_ms`, the point at which the auto-play sequence
finished. `response_time_ms` matches the desktop build and is measured from
trial onset, so on these trials it is dominated by ~10s of forced playback;
decision time is `response_time_ms - playback_ms`. Both fields are additive
and ignored by the Python analysis.

## What comes out

The same JSON schema the desktop build writes, so
`analysis/spose_comparison.py`, `analysis/supradditivity_analysis.py` and
`analysis/vice_utils.py` read it **unchanged**:

```json
{
  "participant_data": { "...": "age, gamified, completion_status, ..." },
  "responses":        [ { "concept_triplet": [], "concept_selected": "", "...": "" } ],
  "game_state":       { "castle": { "...": "rooms, allocation, placements" } }
}
```

Verified end to end: a payload built by `src/save.js` was parsed by
`analysis.vice_utils.responses_to_vice_format` and produced the expected
triplets, with attention trials correctly excluded.

The file downloads at the end, named exactly as the desktop build names it
(`tier<1|2>_<pid>_<stamp>.json`). Drop it into `data/responses/` and the existing
analysis picks it up. **Closing the tab partway still saves**, with
`completion_status: 0` and a `_partial` suffix — a child who disengages is
data, not a hole.

## The rule this port had to preserve

The odd-one-out task has **no correct answer** on regular trials. Feedback is
a function of the *act* of responding, never of *what* was chosen. In this
codebase, concretely:

- `afterResponseText()` takes no argument, so it cannot branch on the choice.
- The selection highlight is blue. Never green or red — those read as
  correct/incorrect to a child.
- `allocate()` and `completeRoom()` take a room count and a room index. A test
  asserts their signatures contain no response-shaped parameter.
- The whole sticker schedule is drawn at session start, before any response
  exists.

Breaking any of these does not throw. It quietly teaches children a
similarity structure and corrupts every embedding built from the data.

## Tests

```bash
node js/test/run.mjs        # 15 headless tests
node js/test/browser.mjs    # drives a full session of EACH tier in a DOM
```

`run.mjs` covers the parts that need no DOM: seeding reproducibility, triplet
pair coverage, the reward contract, the save schema, and the Tier 2 design
properties — Latin-square balance, yoking under `shared`, disjointness under
`disjoint`, and that shuffling never crosses a block.

One of those tests found a real defect. `hashSeed(pid) % 6` looks like a fine
way to pick a Latin square, but FNV-1a's low bits are poorly mixed for short,
near-sequential ids — `P1`, `P2`, `0001` — which is exactly what a facility
assigns. Over 264 realistic ids it put 52 on one order and 35 on another, and
over 200 ids it never produced one of the six orders **at all**: a silently
uncounterbalanced design. The index is now drawn from a dedicated mulberry32
stream, and the test asserts both coverage and spread.

## Verified

`browser.mjs` drives a whole session of each tier in **jsdom against the real
jsPsych**, importing the real `src/main.js` and clicking through every screen.
It reports trials recorded, `trial_index` range, condition/block order,
stimulus `play()` calls, rooms completed, and console errors.

That it imports `main.js` matters. The first version of this harness
re-implemented the timeline builder inside the test, so the two could drift —
and they did. The copy kept passing while the shipping code wrote **jsPsych's
global timeline index** into `trial_index`, because jsPsych reserves that
field name and overwrites whatever a plugin puts there. Saved rows were
numbered 5, 6, 7, 11, 12, 13, … — counting story screens and playgrounds —
where the desktop build numbers trials 0..N-1. Plugins now emit
`task_trial_index`, and the harness asserts the saved range.

The harness has caught page-level failures too: it found the page not loading
at all, because the CDN URL pointed at jsPsych's ESM build, whose bare imports
(`auto-bind`) no browser can resolve. jsDelivr's `/+esm` output is no better —
it still fetches dependencies from the CDN at runtime. `index.html` loads the
**standalone** build from `vendor/`, which works with no network.

### Confirmed in a real Chrome browser

Both tiers were driven in Chrome over `http://localhost:8000`: images and font
render, layout holds, the V / A / AV screens each present correctly, all 100
matched Tier 2 items resolve in **both** modalities (200 requests, no misses),
a clip decodes via WebAudio (2.00s, mono, 48 kHz), and a completed Tier 2
session downloads with `trial_index` 0..N-1 and conditions cleanly blocked.
The resulting JSON was then parsed by
`analysis.vice_utils.responses_to_vice_format` — the same two triplets came
back under all three conditions, with attention trials excluded — and read by
`analysis/supradditivity_analysis.py`, which split it V:3 / A:3 / AV:3.

**One check still needs a human**: that sound is actually audible. Browser
automation drives a background tab, and Chrome does not load or start media in
a hidden tab (`play()` never settles), so audible playback cannot be verified
from a script. Open a Tier 2 session in a foreground tab, click through to an
A block, and confirm you hear three clips in sequence and that the replay
buttons work.

## Differences from the desktop build

| | Desktop (PyQt) | Browser (this) |
|---|---|---|
| Tier 1 visual task | yes | yes |
| Tier 2 V / A / AV task | yes | yes |
| Tier 2 Latin-square block order | md5(pid) | mulberry32 — **different order per id** |
| Stimulus audio | QMediaPlayer | `<audio>`, plus autoplay unlock + blocked-trial flag |
| Game sound effects | QSoundEffect | `<audio>` via `src/sfx.js`, gated on stimulus playback |
| REDCap upload | yes | `upload=URL` POST instead |
| Cutscene cross-fade | yes | plain screens |
| Sticker silhouettes | alpha-mask shapes | CSS grayscale |
| Trial sequence for a given `pid` | Mersenne Twister | mulberry32 — **different** |

The seeding rows matter: the two builds seed differently, so the same
participant id does **not** produce the same triplets — nor, in Tier 2, the
same block order — in both. Within either build an id is fully reproducible.
`participant_data.platform` records which build wrote a file (`jspsych-web`),
and `game_state.castle.rooms[*].condition` records the order actually run, so
the arms can always be separated.

## Dependencies

None to install. jsPsych 8.2.1 is vendored at
`js/vendor/jspsych-8.2.1.browser.js` (standalone, ~77 KB) with its stylesheet
alongside, so the study runs with no network and no build step. To move to a
different version, replace that file with the same `dist/index.browser.min.js`
build — **not** the ESM one, for the reason above.

`js/test/browser.mjs` needs `jsdom`, which is a dev-only dependency:

```bash
cd js && npm install --no-save jsdom
```
