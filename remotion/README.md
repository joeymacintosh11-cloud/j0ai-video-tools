# Remotion video

<p align="center">
  <a href="https://github.com/remotion-dev/logo">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-dark.apng">
      <img alt="Animated Remotion Logo" src="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-light.gif">
    </picture>
  </a>
</p>

Welcome to your Remotion project!

## Toshi Beat Visualizer

This project renders the `ToshiBeatVisualizer` composition — a branded,
audio-reactive video template — for any beat you drop into `public/tracks/`.

### Adding a new track

Scaffold a track folder from its name:

```console
npm run new-track -- "Midnight Rider"
npm run new-track -- "Midnight Rider" --presets youtube-16x9,vertical-9x16
```

This creates `public/tracks/midnight-rider/` with a `metadata.json`
template and prints the next steps. It refuses to run if that track folder
already exists — it never overwrites or deletes anything.

`--presets` records which formats the track is meant to ship in; it defaults
to `youtube-16x9` and is editable later in the app.

A track folder needs exactly these three files:

```
public/tracks/<track-slug>/
  cover.png       Square cover art
  beat.wav        The audio to render against
  metadata.json   Track info (see below)
```

`metadata.json` looks like this once filled in:

```json
{
  "title": "Ghetto Geek",
  "artist": "Toshi",
  "key": "F Minor",
  "bpm": 100,
  "subtitle": "Boom bap soul, trap bounce and latin heat.",
  "exportPresets": ["youtube-16x9", "vertical-9x16"]
}
```

- `title`, `artist`, `key` — required strings
- `bpm` — required positive number
- `subtitle` — optional string; if present it's shown under the title, if
  omitted the layout simply skips it
- `exportPresets` — optional list of the formats this track ships in. **Leave
  it out and every format is assumed**, which is how tracks behaved before the
  field existed, so nothing needs updating. Unknown or repeated ids are
  refused, as is an empty list — leaving the field out is how you say "not
  decided yet".

Toshi's brand assets (logo, icon mark) live once in `public/brand/toshi/` and
are shared automatically by every track — you never need to duplicate them.

`public/tracks/ghetto-geek/` is a working example.

### Full workflow

```console
npm run new-track -- "Midnight Rider"
# add cover.png and beat.wav to public/tracks/midnight-rider/
# edit public/tracks/midnight-rider/metadata.json (fill in key and bpm)
npm run prepare-track -- midnight-rider
npm run render-track -- midnight-rider
```

### Preparing a track

```console
npm run prepare-track -- <track-slug>
```

Validates `cover.png`, `beat.wav` and `metadata.json`, and generates (or
refreshes) `public/tracks/<track-slug>/analysis.wav` — a small mono/16-bit
copy of the beat used only for waveform analysis. This is what makes
rendering fast: analyzing the original 24-bit master on every one of a
video's thousands of frames is slow, so a lightweight copy is analyzed
instead. The final video's audio always comes from the original `beat.wav`
— `analysis.wav` never affects what's heard.

`analysis.wav` is regenerated automatically whenever it's missing or older
than `beat.wav`, so this step isn't easy to forget — `validate-track` and
`render-track` both run it for you too.

### Validating a track

```console
npm run validate-track -- <track-slug>
```

An alias for `render-track --validate-only`: runs the same preparation and
validation as a real render (including the `analysis.wav` step), but stops
before rendering. Useful right after `new-track`, and after adding the
missing `cover.png`/`beat.wav`.

If anything is missing or invalid — folder, cover, audio, or metadata — the
command prints a clear description of what's wrong and exits with a
non-zero status.

### Rendering a track

```console
npm run render-track -- <track-slug>
```

For example:

```console
npm run render-track -- ghetto-geek
```

This prepares the track (see above), bundles the project, resolves the
video's duration from `beat.wav` automatically, and writes the result to
`out/<track-slug>/<preset>.mp4` (e.g. `out/ghetto-geek/youtube-16x9.mp4`).

Rendering uses the Remotion engine. `render-track` also takes an optional
`--engine <id>`: `remotion` (the default — leaving the flag out behaves exactly
as before) or `after-effects` (see below). `premiere` is a reserved name that
is refused as "not available", and anything else is an unknown engine.
`render-missing`, `content-package` and `content-package-batch` accept
`--engine remotion` only, because they plan from Remotion's exports. Each
export records the engine that made it; see
[ARCHITECTURE.md](ARCHITECTURE.md#choosing-the-engine-per-job).

### Choosing a track's render engine in the app

**Track info** has a **Render engine** picker beside the intended formats:
Remotion or After Effects. (Premiere is reserved but not built, so it isn't
offered.) The choice is saved in the track's `metadata.json` as
`"renderer": "after-effects"`. Choosing Remotion stores nothing, so a track
that never chose has no `renderer` key and behaves exactly as before.

Availability comes from the server (`GET /api/renderers`), live:

- an engine that can't run on this machine (After Effects not installed) is
  shown dimmed and can't be picked; its tooltip says why;
- After Effects installed but not configured (no valid
  `after-effects.local.json`) can be picked, and the hint says exactly what is
  missing. Renders stay unavailable until it's fixed.

The **Render** panel (under *Advanced*) renders with the track's saved engine
and names it on the button ("Render YouTube 16:9 · After Effects"). If that
engine can't run here, the button is disabled with the reason. It never
falls back to Remotion. Batches started there and **Show <format>** use the
same engine. Catalogue **Add to render queue** reads each selected track's
saved preference before queueing and carries that engine per target; a failed
track read refuses the batch.

A track's export marks judge **its** engine's exports. After Effects' live in
`out/<slug>/after-effects/`, so a Remotion export never counts for a track
that chose After Effects, or the other way round. Export missing, delivery,
release bundles, content packages and destination fix plans handle Remotion
exports only. For a track that chose After Effects they leave it out with
that reason, rather than rendering, copying or describing a Remotion video in
its place. Auto-delivery after an After Effects render reports the export as
not delivered, for the same reason.

The preference is a default for the app only. On the command line and the API
an engine is still named explicitly: `render-track` without `--engine` and
`POST .../render` without `"engine"` render with Remotion, as they always did.

### Rendering with After Effects (proof of concept)

`--engine after-effects` renders a track through your own After Effects
project, using After Effects' command-line renderer, `aerender`:

```console
npm run render-track -- ghetto-geek --engine after-effects
npm run render-track -- ghetto-geek --engine after-effects --preset vertical-9x16
```

The result goes to `out/<track-slug>/after-effects/<preset>.mp4`, next to (never
over) the Remotion export, and is recorded in the content library as an After
Effects export.

**1. After Effects.** Install it (macOS). `aerender` is found automatically in
`/Applications/Adobe After Effects <version>/` (newest first) or on `PATH`. To
choose a specific one, set `TOSHI_AERENDER_PATH`, or `"aerenderPath"` in the
config below. Without it, the command stops with a "not available" error that
lists where it looked.

**2. A template.** Create `after-effects.local.json` in this folder (it is
git-ignored; `TOSHI_AE_CONFIG` can point elsewhere):

```json
{
  "project": "/Users/you/Toshi/ToshiVisualizer.aep",
  "composition": "Toshi Visualizer",
  "compositions": { "vertical-9x16": "Toshi Visualizer 9x16", "square-1x1": "Toshi Visualizer 1x1" },
  "outputModule": "H.264 - Match Render Settings - 15 Mbps"
}
```

Only `project` and `composition` are required. `compositions` picks a
composition per format. `outputModule` must name an H.264/MP4 output-module
template in your After Effects; leave it out to use the project's own. Also
optional: `dataFile` (default: `toshi-render-data.json` beside the project)
and `aerenderPath`. Missing or wrong settings stop the render with a "not
configured" error saying what to fix.

**3. The template (the contract).** Before each render Toshi writes these
files next to `dataFile` (by default, your `.aep`'s folder). The template
imports the images and audio **by these names**, and After Effects reloads them
from disk every time `aerender` opens the project:

| File | Contents | Template must use it |
| --- | --- | --- |
| `toshi-render-data.json` | Title, artist, key, BPM, subtitle, format, timing | Read when the template is built (text) |
| `toshi-cover.png` | The track's cover | Yes |
| `toshi-audio.wav` | The track's audio | Yes (audio is mandatory) |
| `toshi-waveform-audio.wav` | Lighter audio for audio-reactive layers | Optional |
| `toshi-brand-logo.png`, `toshi-brand-badge.png` | The brand marks | Optional |

**Text is written into the template when it is built, so build it for each
track.** In a real After Effects 2026 render, `footage("toshi-render-data.json")`
was found but its `sourceData` and `sourceText` were both `null`. So expressions
can't read the title, artist, key and BPM at render time. Adobe's own notes say
a render can miss a JSON file that only expressions use. Instead,
`create-toshi-template.jsx` reads the staged JSON and writes the text into the
layers. The cover, audio and waveform still follow whatever is staged. Never
import a track's own `public/tracks/...` files into the template.

Two checks stop a broken template from wasting a render:

- **Before rendering:** if the project never mentions the cover and audio
  files, the render stops in seconds with "does not use ...", instead of
  rendering a black, silent video. If the template was built for another
  track, it stops with "was built with another track's title, artist and key",
  with this track already staged for the rebuild. Set `"templateCheck": false`
  only for a template that genuinely does not need these checks.
- **After rendering:** a video with no audio (or no picture) is a failed
  render. It is never published or recorded.
- **Warnings (never fatal):** the render log says so if the project carries
  no Toshi text marker (built by hand or by an older script), doesn't seem to
  contain the composition's name, or has no Audio Waveform effect. It also
  prints the text this track needs.

**Building the template: the quick way.** `adapters/after-effects/template/create-toshi-template.jsx`
builds the complete minimal template for you, using only native After Effects
features (no plugins, nothing `aerender` can't render):

1. Stage the track:
   `npm run render-track -- <track> --engine after-effects`. On a new or empty
   project, or one built for another track, this stops with "does not use ..."
   or "was built with another track's ...". That's expected: the files are now
   in the data folder.
2. In After Effects, **File > New > New Project**, then **File > Scripts > Run
   Script File...** and choose `create-toshi-template.jsx`. When asked, pick the
   folder with `toshi-render-data.json`. If an effect couldn't be set up, the
   final message lists it under "Check by hand".
3. **File > Save As** the `"project"` from `after-effects.local.json`, in that
   same folder (replacing the old one), and render again.

**Rebuilding.** Run the script again (steps 1–3, in a new project) **for every
new track**, and whenever this script changes. Template contract 3 writes the
text in at build time. The composition's comment shows the contract and the
track's text marker (`toshi-text-` plus 8 hex digits). The Title layer's comment
shows the marker too.

It creates composition **Toshi Visualizer** (1920×1080, 30fps, 10 minutes)
with these layers, top to bottom:

| Layer | Source | Setup |
| --- | --- | --- |
| `Audio` | `toshi-audio.wav` | Time Remapping on; Time Remap expression `time - thisLayer.inPoint`; layer extended to the end of the composition |
| `Brand Logo` | `toshi-brand-logo.png` | Bottom right; Scale expression fits it into 240 px |
| `Waveform` | Solid + **Audio Waveform** effect | Audio Layer: `Audio`; Start Point 960,860; End Point 1780,860; Displayed Samples 220; Maximum Height 140; Audio Duration 400 ms; Thickness 3; Softness 15%; Inside Color `#b8860b`; Outside Color `#f4e8d0` |
| `Accent` | Solid 160×4 `#b8860b` | Thin gold rule under the track details |
| `Key BPM` | Text, 40 px, `#f4e8d0`, 80% opacity | The track's key and BPM, e.g. `F Minor · 100 BPM` |
| `Artist` | Text, 56 px, `#b8860b` | The track's artist, e.g. `Toshi` |
| `Title` | Text, 96 px, `#f4e8d0` | The track's title, e.g. `Ghetto Geek`; comment: the text marker |
| `Cover` | `toshi-cover.png` | Left; Scale expression `var s = 640 / Math.max(thisLayer.source.width, thisLayer.source.height) * 100; [s, s]` |
| `Background` | Solid `#0b0b0b` + **Gradient Ramp** effect | Ramp Shape Radial; Start of Ramp 576,486, Start Color `#2a1e10` (warm amber charcoal); End of Ramp 2016,1242, End Color `#0b0b0b` |

The colours are the Remotion visualizer's (`adapters/remotion/BeatVisualizer/theme.ts`):
off-black `#0b0b0b`, warm cream `#f4e8d0` and vintage gold `#b8860b`.

**The metadata text.** The script reads `toshi-render-data.json` and fills the
layers by the rules in `templateText` (`adapters/after-effects/templateContract.mts`):
title, artist, and key and BPM joined with ` · `. A missing optional field shows
as nothing. No track's values are in the source code. A test keeps the script's
rules and marker identical to the contract's. The render log prints the text a
render needs (`After Effects: this track's text: Title "...", ...`). The render
stops if the project carries another track's marker. It only warns if the
project carries none: the marker check reads the project's bytes, so it can
prove a mismatch but can't vouch for a template built some other way.

**The waveform.** The native **Audio Waveform** effect draws from the `Audio`
layer's sound at render time, so it always follows the staged
`toshi-audio.wav`, whatever the track and its length, with no per-track setup.
The effect sits on its own full-frame solid, which it doesn't show (Composite On
Original is off).

**Building it by hand** instead: create the same composition and layers. Import
the cover, audio and logo from the data folder (**File > Import > File...**),
drag them in, add the effects from **Effect > Generate**, and type the track's
text into the text layers. The `Audio`
layer's time remapping matters. A footage layer keeps the length its file had
when you added it, so without remapping, a longer track's audio would stop
early. Enable it with **Layer > Time > Enable Time Remapping**, add the
expression, and drag the layer's end to the end of the composition. Fonts,
sizes, positions and animation are yours to change; the file names and the
text are the contract. A template built by hand has no text marker. The render
log warns about that on every render, and you must retype the text for each track.

**Output and formats.** The output module (`"outputModule"`, or the project's
default) must write **H.264 / MP4 with audio**: its *Audio Output* must be **On**
or **Auto**. Each composition needs its format's canvas and frame rate (30fps;
1920×1080, 1080×1920 or 1080×1080) and must be at least as long as your longest
track. Toshi renders exactly the track's length from frame 0. For 9:16 or 1:1,
duplicate the composition, change its size, and map it under `"compositions"`.

The diagnostics show which `aerender`, project, composition and output were
used, whether the template uses the staged files and matches this track's
text, and why a render failed
(including `aerender`'s exit code and last output lines).

**Limits of this proof of concept:**
- Only `render-track` and the API render with After Effects. Freshness
  checks, delivery, release bundles and content packages still look at
  Remotion exports only.
- One After Effects render at a time per data folder, because they share the
  data file and staged assets.
- Nothing checks that a composition's canvas, frame rate or length matches the
  format, or what is visible in the picture. The checks prove the template
  references the staged files and that the video has picture and sound.
- `create-toshi-template.jsx` builds the 16:9 composition only, uses After
  Effects' default font, and has no animation beyond the waveform.
- The text is written in when the template is built, so each new track means
  rerunning the script by hand in After Effects (the render stops and says so).
  Batch renders across tracks would need that rebuild to be automated.
- The UI does not offer engine selection yet.

### Export formats

Three formats ship, all at 30fps, defined once in
`core/domain/video/renderPresets.ts`:

| Preset | Format | Size |
| --- | --- | --- |
| `youtube-16x9` | YouTube landscape | 1920×1080 |
| `vertical-9x16` | Reels / Shorts | 1080×1920 |
| `square-1x1` | Square | 1080×1080 |

```console
npm run render-track -- ghetto-geek                          # 16:9 (default)
npm run render-track -- ghetto-geek --preset vertical-9x16
npm run render-track -- ghetto-geek --all-formats
npm run render-all-formats -- ghetto-geek                    # same thing
```

All three use the same visualizer — 16:9 keeps cover and copy side by side,
while the vertical and square formats stack into a single centred column
rather than cropping the landscape design. The audio, duration and brand are
identical across formats; only the layout adapts.

A render made before formats existed still sits at `out/<slug>.mp4`. It is
still found and shown, and nothing overwrites or deletes it — but new renders
always go to the per-format path above.

### Previewing in Remotion Studio

```console
npm run dev
```

Studio's preview always shows the `ghetto-geek` track by default
(`adapters/remotion/Composition.tsx`). It's only the default props for the live preview —
`npm run render-track` renders any track's own data regardless of what
Studio is currently showing.

## Local app

A local web UI over the same API: browse tracks, edit metadata, upload cover
art and audio, prepare, preview with the real composition, render with live
progress, and reveal the result in Finder.

It needs two processes, in two terminals:

```console
npm run server    # the API on 127.0.0.1:4600
npm run ui        # the UI on 127.0.0.1:5174
```

Then open <http://127.0.0.1:5174>.

The UI's dev server proxies `/api` to the API server, so the browser only ever
talks to one origin — that's why the API needs no CORS handling. It also serves
`public/` at the web root, which is what lets the preview resolve the
composition's `staticFile()` paths and show real cover art.

Both bind to loopback only. There is no auth, no database and no cloud, exactly
as with the CLI.

The selected track is kept in the URL, so reloading keeps your place. The track
list and detail re-read when the window regains focus, so editing
`metadata.json` in an editor shows up without pressing Refresh.

### Uploading files

Cover art and audio can be dropped onto the track's panel (or picked with a
file dialog) instead of being copied into `public/tracks/<slug>/` by hand. Each
upload streams straight to disk and is checked before it is kept — a cover must
really be a PNG and audio must really be a WAV, up to 25 MB and 400 MB
respectively. A rejected upload leaves the existing file untouched.

Replacing `beat.wav` makes `analysis.wav` stale, so press **Prepare**
afterwards (or just render, which prepares first).

### Previewing

**Load preview** mounts the real `ToshiBeatVisualizer` component with that
track's own props. It fetches the audio and decodes `analysis.wav` for the
waveform, so give it a few seconds before playback is smooth. It is deliberately
behind a button rather than loading for every track you click.

Remotion Studio (`npm run dev`) is still there and unchanged; it previews the
`ghetto-geek` default props rather than a selected track.

### Rendering

**Render** starts a job and follows it over Server-Sent Events. Progress and
frame counts come straight from Remotion.

Progress sits near zero for the first stretch even though work is happening:
each of the three render workers decodes the analysis audio once before its
first frame. That's why the panel leads with the phase (`preparing` →
`rendering`) and treats the bar as secondary.

**Cancel** stops a running or queued render. It never touches a previously
completed video. Job history lives in the server's memory, so restarting the
server forgets the jobs — the rendered files on disk are unaffected.

One render runs at a time; more requests queue. On 16 GB, avoid running Studio,
the UI, and a render all at once if you can.

### Rendering several tracks and formats at once

Tick the formats you want in the toolbar, tick one or more tracks in the list,
and press **Add to render queue**. That queues every ticked track in every
ticked format and opens the queue panel, which shows each render's status,
progress, elapsed time and output, with a cancel action while it is unsettled.

Selecting more than one format turns the single-track **Render** button into a
batch too. With one format selected it behaves exactly as it always did, so
nothing forces you to batch.

Renders still run one at a time in the order queued. A failed or cancelled
render does not stop the rest of the batch, and asking for a track/format pair
that is already queued or running skips it rather than duplicating the work.

Batch progress is the average of the renders' real progress, so a batch
containing a failure settles below 100% — the counts next to it say why.

### Export freshness and re-exporting

Each track row shows a mark per format: a tick for a **current** export, a
warning for a **stale** export, and separate missing, queued and rendering
states. The detail panel explains stale reasons. A zero-byte file is missing,
not a finished export. Invalid track inputs are reported separately.

A format the track does not ship in is dimmed with its own mark, so "we are not
making this one" never reads as "this one is missing".

**Export missing** queues only the formats a track is meant to have and does
not. It asks first: one click shows the plan — how many are missing, already
rendered, already queued or invalid — and only the confirm queues anything. If
there is nothing to do it says so rather than making an empty batch. The same
action works for every ticked track at once, and **Export missing for
catalogue** covers every track, each on its own intended formats — a track that
ships only in 16:9 is never queued for vertical just because another track is.

**Re-export stale** selects existing exports whose inputs changed. **Export
missing + stale** covers both. These actions exist for a track, selected tracks,
and the catalogue. Each uses the same two-step plan/confirm flow, respects
per-track intent and skips current or in-flight exports. One confirmation lists
all replacements; there are no per-file dialogs. The ordinary Render controls
remain available for an explicit render of any chosen format.

Every successful render now writes two files:

```text
out/<slug>/<preset>.mp4
out/<slug>/<preset>.manifest.json
```

The manifest records hashes of rendered metadata, cover, original `beat.wav`,
render-relevant preset settings, and the versioned visualizer/shared brand
assets. Changes make the export stale. Regenerating `analysis.wav`, changing
`exportPresets`, UI styling, logs or documentation does not.

Existing nonempty per-format MP4s without manifests show **Stale — earlier
export, no manifest**. Nothing is migrated, deleted or rendered automatically.
The older `out/<slug>.mp4` file remains an unverified earlier export; new renders
still use per-format paths and never touch it.

Replacement rendering uses a private staging directory. Only a successful,
nonempty MP4 and complete manifest are published. Failure or cancellation keeps
the previous pair. Publication errors roll back the video; an abrupt process/OS
crash between the two atomic renames is detected as `output_changed`, not
silently reported current. See handoff §38 for recovery and cache limits.

```console
# Plan without queueing anything
curl -X POST http://127.0.0.1:4600/api/export-missing \
  -H 'content-type: application/json' \
  -d '{"tracks":["ghetto-geek"],"dryRun":true}'

# Queue whatever is missing, each track in its own intended formats
curl -X POST http://127.0.0.1:4600/api/export-missing \
  -H 'content-type: application/json' \
  -d '{"tracks":["ghetto-geek","midnight-rider"]}'

# The whole catalogue
curl -X POST http://127.0.0.1:4600/api/export-missing \
  -H 'content-type: application/json' \
  -d '{"catalogue":true,"dryRun":true}'
```

Omit `presets` to use each track's own `exportPresets`; name them to override
that for one request. `tracks` and `catalogue` are mutually exclusive and one
is required — the catalogue has to be asked for outright, so a request that
merely forgot its `tracks` array is an error rather than a catalogue-wide
queue. The response reports `intendedTargets`, `missing`, `queued`,
`skippedExisting`, `skippedQueued`, `skippedActive`, `invalid`, `tracks` and a
`nothingToDo` flag. The optional `mode` is `missing` (default), `stale`, or
`missing-and-stale`. Additive fields `current`, `stale` and `selected` describe
freshness and work selected by that mode. `queued` is what was actually queued;
it remains empty on a dry run. `skippedExisting` is the backward-compatible
presence list (current **or** stale); use `current` for verified freshness.

```console
curl -X POST http://127.0.0.1:4600/api/export-missing \
  -H 'content-type: application/json' \
  -d '{"catalogue":true,"mode":"missing-and-stale","dryRun":true}'
```

Review the returned replacement list, then send the same request with
`dryRun:false` to queue it. Planning is refreshed at execution time.

The same thing from the terminal, which renders directly rather than queueing:

```console
npm run render-missing -- ghetto-geek --dry-run
npm run render-missing -- ghetto-geek
npm run render-catalogue-missing
npm run render-missing -- ghetto-geek --mode stale --dry-run
npm run render-missing -- ghetto-geek --mode stale --replace
npm run render-catalogue-missing -- --mode missing-and-stale --dry-run
npm run render-catalogue-missing -- --mode missing-and-stale --replace
```

These use the same planner as the API, and render one format after another.
A stale replacement requires `--replace` unless `--dry-run` is set. Existing
commands keep their default behavior; `render-track` also writes manifests.

### One renderer per export at a time

The app and the CLI are separate processes, so a filesystem lock — not the
render queue — is what stops both producing the same export at once. Before a
render starts it takes `out/.locks/<slug>__<preset>.lock`, created exclusively,
and releases it on success, failure or cancellation.

Locks are per track *and* format, so rendering three formats of one track still
runs them back to back, and unrelated tracks never block each other. Asking for
a target another process holds is refused clearly rather than queued:

```console
✗ ghetto-geek / square-1x1 is already being rendered by another process.
  Held by process 10947 on this-mac since 2026-09-18T13:44:17.648Z.
```

The API answers `409 RENDER_TARGET_LOCKED` for a single render, and a batch
leaves the contended target out while queueing the rest.

If a render is killed outright, its lock stays behind until the next render
reclaims it — which happens automatically once the owning process is gone. A
lock written by another machine, or one whose contents cannot be read, is never
reclaimed automatically, because nothing here can prove it is dead. The same
applies to the short-lived guard a render holds while ownership changes hands:
a process killed inside that moment leaves one behind, and clearing it is the
one thing the release command is allowed to do that a render never is:

```console
npm run render-locks                                    # what is held, and why
npm run render-locks -- --release ghetto-geek square-1x1
```

Release takes a track and a format, never a path. Only do it once you are
certain nothing is rendering that export.

Render job and batch history is kept in memory and bounded — the most recent
200 jobs and 50 batches — so a long-running server does not grow without limit.
Anything queued or running is never dropped, and files on disk are untouched.

### Delivering exports to a folder

Optionally, a finished export can be copied somewhere you actually use it: a
Movies folder, a release folder, or a locally synced Dropbox or Drive folder.
From here those are all just directories — there is no cloud integration, no
account and no upload.

`out/` stays the source of truth. The copy is never consulted for freshness, the
canonical file is never moved, and **a delivery that fails leaves a
successfully rendered export untouched** — "render current, delivery failed" is
a real state and is reported as one.

Set the destination in the app under **Delivery**, or from the terminal:

```console
npm run deliver-track -- --set-root "/Users/you/Movies/Toshi Exports"
npm run deliver-track -- --show
npm run deliver-track -- ghetto-geek --dry-run
npm run deliver-track -- ghetto-geek
npm run deliver-catalogue -- --dry-run
npm run deliver-catalogue
```

The destination is stored in `delivery.local.json`, which is **not committed** —
an absolute path belongs to one machine, so it never goes into a track's
metadata or into git. What *is* portable lives in `metadata.json`:

```json
{ "deliveryFolder": "Ghetto Geek" }
```

Files land in a deterministic layout, with the folder defaulting to the slug:

```
Toshi Exports/
  Ghetto Geek/
    ghetto-geek-youtube-16x9.mp4
    ghetto-geek-vertical-9x16.mp4
```

**Only current exports are delivered.** A missing or stale one is reported so
you can re-render it first, rather than copying content that is already known to
be out of date. Copies are published through a temp file and an atomic rename,
so nobody watching that folder sees a partial video, and the previous copy
survives until the new one is complete.

A delivery holds that export's render lock while it runs, so the file it is
copying cannot be replaced underneath it — and a delivery of something that is
being rendered right now is refused with a message saying so rather than
copying a half-replaced file. The copy itself runs in a helper pinned to the
folder that was checked, so renaming or replacing that folder mid-copy cannot
redirect it; if anything about the destination or the export changes while the
copy is in flight, the staged file is discarded instead of published.

Delivery freshness is tracked in a small receipt beside the export, so nothing
has to hash a video to answer it:

| Canonical export | Delivered copy | Shown as |
| --- | --- | --- |
| current | matches | delivered |
| stale (cover changed, say) | unchanged | outdated — re-render first |
| re-rendered, current again | still the old copy | outdated — deliver again |
| current | matches | delivered |

Nothing is ever deleted to express that, and delivery never removes anything
from the destination.

**Deliver after each render** is available in Delivery settings and is off
unless you turn it on.

### Release bundles

Every delivered track can describe itself. A release bundle is two small files
written beside the delivered videos:

```
Toshi Exports/
  Ghetto Geek/
    ghetto-geek-youtube-16x9.mp4
    ghetto-geek-vertical-9x16.mp4
    release.json
    release.md
```

`release.md` is what you read when you open the folder:

```markdown
# Ghetto Geek — Toshi

Key: F Minor
BPM: 100

## Delivered

- YouTube 16:9 — 1920×1080 — 3:05 — 62.4 MB
- Reels 9:16 — 1080×1920 — 3:05 — 59.8 MB

## Missing

- Square 1:1 — not rendered yet
```

`release.json` is the same thing for anything that reads it, with preset ids,
dimensions, frame rate, duration, byte sizes, delivery timestamps and the
canonical export fingerprint each copy was made from. **Neither file records an
absolute path** — a bundle travels with its folder.

Generate one from the Delivery section of a track, from the catalogue action, or
from the terminal:

```console
npm run release-bundle -- ghetto-geek --dry-run
npm run release-bundle -- ghetto-geek
npm run release-bundles
npm run release-bundles -- --force
```

**A partial release is a first-class result.** A track that ships two of three
formats gets a bundle saying exactly that, and delivered, outdated and missing
stay three separate answers — an MP4 sitting at the destination is never itself
taken as proof that something shipped, only a receipt that still matches the
current export.

The app shows whether each bundle still describes what shipped — current,
outdated or not written yet — and only missing and outdated bundles are
rewritten, so running it over a settled catalogue does nothing. A bundle goes
outdated when the metadata changes, the intended formats change, something is
delivered, or a re-render changes what should ship; it is a fingerprint of that
state, not a timestamp, so touching the file cannot make it look current.

**Update release bundles** in Delivery settings rewrites a track's bundle after
a successful delivery. Off unless you turn it on, and a bundle that fails to
write never affects the files that were delivered.

### Content packages

"For this beat, what do I need for YouTube, Reels/TikTok and Instagram, what
is ready, what is missing or stale, and what caption/description goes with
it?" A content package answers that per track by mapping each platform onto
one of the existing render presets — no second rendering format:

| platform | preset |
|---|---|
| YouTube | `youtube-16x9` |
| Reels / TikTok | `vertical-9x16` |
| Instagram Square | `square-1x1` |

It is **derived, not stored** — there is no new manifest file, and nothing
here is a second source of truth. A package is computed fresh, on every read,
from the same export coverage, queue state and delivery state the rest of the
app already tracks. The Track Detail panel's **Content package** section
shows a readiness mark per platform (ready / missing / stale / rendering /
blocked), a generated title/description (YouTube) or caption (Reels/TikTok,
Instagram) built deterministically from the track's own title/artist/key/BPM/
subtitle — no external AI calls — and a status badge on each catalogue row.

By default a package uses the track's own declared `exportPresets` (§ Export
formats), so nothing is silently added to a track that only ships one format.
"Full package" asks for all three platforms regardless of what is declared,
without changing the track's saved intent. A third mode, **Custom**, lets you
pick exactly which platforms this *view* covers right now — also without
touching the track's saved intent; it resets to Intent on a track switch or
reload, by design.

The Track Detail panel folds all of this into one **Ready to Publish**
banner: once every platform in the current scope has a current render (and a
current copy at the destination, wherever one is configured), the package
reads "Ready to publish," with a one-click "Copy all metadata" for whatever
is in scope. Until then, the banner names the one thing to do next — build a
missing asset, re-render a stale one, or deliver — and each platform card
carries its own "Copy" and, once a render exists, "Reveal" action.

**Build package** and **Deliver package** are not a new render or delivery
path — they are the existing "export missing" and "deliver" actions, scoped to
the package's platforms:

```console
npm run content-package -- ghetto-geek
npm run content-package -- ghetto-geek --mode full --json
npm run content-package -- ghetto-geek --platform youtube --platform reels
npm run content-package -- ghetto-geek --apply
```

Default behavior is inspection only; `--apply` renders the package's own
missing/stale outputs, reusing the same planner and render call as
`npm run render-missing`.

### Editable metadata templates

The title/description/caption/keywords/hashtags a content package generates
come from small, editable templates rather than fixed code, resolved per
field with this precedence:

```
per-track override  ->  global template  ->  built-in default
```

Templates are plain text with a fixed set of placeholders —
`{title} {artist} {key} {bpm} {subtitle} {slug} {platform} {filename}`, plus
`{tagline}` and `{subtitleSuffix}` (subtitle-aware fallbacks used by the
built-in defaults) — no expressions, no conditionals, no code. `{{title}}`
escapes to a literal `{title}`.

**Global templates** live in the Delivery panel's "Content metadata
templates" section, or from the terminal:

```console
npm run content-metadata -- --show
npm run content-metadata -- --set youtube.titleTemplate "{title} | {artist}"
npm run content-metadata -- --reset youtube.titleTemplate
npm run content-metadata -- --reset-all
```

Stored in `content-metadata.local.json` (gitignored, machine-local — only
the fields you actually override are written; the built-in Toshi defaults
ship in code). A malformed file is never silently ignored: it is reported
(in the panel, in the API, in the CLI) and built-in defaults are used until
it is fixed.

**Per-track overrides** live in a track's own metadata editor, under
"Content metadata overrides" (collapsed by default). Each field shows
"Inherited" with a live preview of what it currently resolves to, or, once
overridden, an editable box and "Clear override (inherit)". Saved through
the same metadata save as everything else in that form — there is no
second write path.

None of this affects what gets rendered into a video, and none of it can
make a current export go stale: only the fields actually burned into the
composition (title, key, BPM, subtitle, cover, audio) do that, exactly as
before this feature existed.

### Batch content packages

Select several tracks (tick their checkboxes in the catalogue — "Select
all"/"Select none" ticks or clears exactly the tracks currently listed, never
a hidden superset) and inspect, plan and build their content packages
together, instead of opening each one individually.

**Inspect content packages** opens a panel over the selection: totals across
every ticked track (platform targets ready/missing/stale/rendering) and a
one-line summary per track. **Create plan** shows exactly what applying would
queue — one action per missing/stale platform, de-duplicated by track and
format — without queueing anything. **Apply N actions** re-checks current
state immediately before queueing (a target that became ready or started
rendering elsewhere in the meantime is never re-queued) and hands the result
to the same render queue and progress drawer every other render already uses.
**Deliver ready packages** is the existing delivery action, scoped to the
same selection — not a new copy path.

```console
npm run content-package-batch -- --track beat-a --track beat-b
npm run content-package-batch -- --tracks beat-a,beat-b --mode full --plan
npm run content-package-batch -- --catalogue --apply
```

Default behavior is inspection only, `--plan` also shows what would be
queued, and `--apply` builds it — reusing the exact same per-track resolver
and render call as the single-track `content-package` command, just across
several tracks at once. A batch covers at most 100 tracks per request, named
explicitly; there is no implicit "operate on the whole catalogue" behavior.

### Content library

Every render replaces the file at `out/<slug>/<preset>.mp4`, so the folder only
ever shows the latest version. The content library remembers every version: each
completed export appends one line to `out/.content-library/library.jsonl` with
the track and format as they were rendered, the manifest's fingerprint and
identity, the render job, and — for a re-export — which version it replaced and
which inputs had changed ("cover changed", "metadata changed").

It is written only after an export is atomically published, so a failed,
cancelled or refused render never appears in it (those stay in the render
journal). It needs no delivery destination, and it is independent of release
bundles; when a destination *is* configured, each version also shows how many
times it was delivered, read from the destination's own delivery log.

Records are never rewritten. Whether a version is **current**, **stale**,
**superseded** or **missing** is worked out when you look, from the manifest on
disk now. Open **Library** in the app header to filter, inspect a version and
its lineage, reveal the file, or re-export the version that is on disk now —
which queues a normal render and adds a new record when it finishes. An older
version cannot be re-exported: every render uses the track's current files.

```console
npm run content-library                              # newest first
npm run content-library -- --track ghetto-geek       # plus which formats exist
npm run content-library -- --status superseded --since 30d
npm run content-library -- --id <record id>          # one version, every sibling
npm run content-library -- --adopt-existing          # record exports rendered before the library existed
npm run content-library -- --repair-tail             # drop an interrupted final line, nothing else
```

### Delivery history

A release bundle says what a track ships *now*. It cannot say what went out last
Tuesday, so each destination also keeps an append-only log of deliveries as they
happen:

```
Toshi Exports/
  delivery-log.jsonl
  Ghetto Geek/
    ...
```

One JSON object per line, one line per delivered file. Each event records the
track and the format **as they were at the time**, the delivered file's path
relative to the destination, its size, and the fingerprint of the export it came
from. Renaming a track later does not rewrite what history says shipped, and no
event ever carries an absolute path.

Open **History** in the header for the destination as a whole, or read a track's
last few deliveries in its own Delivery section. From the terminal:

```console
npm run delivery-history
npm run delivery-history -- --track ghetto-geek
npm run delivery-history -- --preset square-1x1 --since 7d
npm run delivery-history -- --since 30d --limit 100 --oldest
npm run delivery-history -- --since 7d --report
```

`--report` writes `delivery-report.md` at the destination — a plain summary of a
chosen range, regenerated each time.

**Nothing but a completed delivery is an event.** Rendering, cancelling, a failed
copy and writing a release bundle never add one. A re-delivery does, and is
marked as such. The log is written after the copy is published and its receipt
committed, so an event can never describe a file that is not there — and if the
log itself cannot be written, the delivery still succeeded and says
"not recorded in the delivery log" rather than pretending to have failed.
`npm run delivery-history-reconcile` puts that right from the receipts, marking
anything it reconstructs as such.

**If the log is damaged** it says so, with line numbers, and still shows what it
could read — a bad line never costs you the rest, and no view reports a damaged
log as a complete answer. A crash can only ever damage the last line; that one
case is repairable with `npm run delivery-history -- --repair-tail`, which drops
the incomplete fragment and refuses to touch anything else. An event or a
delivery appearing twice is reported too, since nothing this tool does can
produce a repeat. Nothing deletes or rewrites an event.

Appends are serialized by a small lock at the destination, so two deliveries
finishing together cannot interleave. If a process is killed while holding it,
`npm run delivery-history -- --release-lock` clears it — it refuses while a live
process on this machine still holds it, and refuses a lock from another
machine, where it cannot tell.

### Destination health

Delivery receipts and release bundles say what the app *believes* is at the
destination. Nothing checks that against what is actually there — until now. A
health scan compares the two: every delivered file a receipt names, every
track's release bundle, and (for a catalogue-wide scan) every folder at the
destination root that looks like one of this app's own.

```console
npm run destination-health
npm run destination-health -- --track ghetto-geek
npm run destination-health -- --json
```

It answers: which delivered files are missing or have been changed since; which
export-looking files sit at the destination with no receipt behind them (an old
export, a leftover from a renamed delivery folder); which release bundles are
missing, outdated, or have two files that disagree with each other; whether the
destination root itself is still the folder that was configured, rather than
something a symlink now quietly points elsewhere. Findings are `error`,
`warning` or `info`, fixed per finding rather than judged case by case.

**Detection only.** A scan never writes to or deletes from the destination —
not even the file it is reporting on. It is a read-only sweep: a `readdir` per
folder that matters and a handful of `stat` calls, reusing exactly the same
checks delivery and release bundles already trust, never a video hashed,
decoded, or even opened.

In the app, run it from **Delivery** settings for the whole catalogue, or from
a track's own Delivery section to check just that one. A scan is a single
step — there is nothing to confirm, because nothing is ever written.

```console
curl -X POST http://127.0.0.1:4600/api/render-batches \
  -H 'content-type: application/json' \
  -d '{"targets":[
        {"slug":"ghetto-geek","preset":"youtube-16x9"},
        {"slug":"ghetto-geek","preset":"vertical-9x16"}
      ]}'

curl http://127.0.0.1:4600/api/render-batches/<batchId>
curl -N http://127.0.0.1:4600/api/render-batches/<batchId>/events
curl -X POST http://127.0.0.1:4600/api/render-batches/<batchId>/cancel
```

A track/format pair can only have one render in flight. Asking for a second while one is
queued or running is refused with `RENDER_ALREADY_ACTIVE` (409), since both
would take the single slot in turn and write the same `out/<slug>/<preset>.mp4`. The UI
recovers the running job from the server on load, so reloading the page or
switching tracks re-attaches to a render in progress rather than offering to
start another.

### Destination fix plan

Destination health finds drift; this turns a finding into a reviewed plan of
what could be done about it, and — only when told to — runs the safe part.
Detection and remediation stay two separate steps: nothing here is executed
just because a plan was made.

```console
npm run destination-fix-plan
npm run destination-fix-plan -- --track ghetto-geek
npm run destination-fix-plan -- --apply
npm run destination-fix-plan -- --apply --wait --timeout 600
```

A plan proposes, for each finding, one of:

- **redeliver** — the canonical export is current; copy it again.
- **rerender_and_deliver** — the canonical export is missing or stale, so it
  is queued on the existing render queue first, never rendered synchronously
  inside a plan/apply call. See "Confirmed delivery after a queued render"
  below for what happens after it queues.
- **regenerate_release_bundle** — one action per track, however many of its
  three finding codes (missing, outdated, pair-mismatch) triggered it.
- **manual_review** — never run, with or without `--apply`. Covers an
  unexpected file or folder, anything unreadable, and any problem with the
  destination root itself. Nothing here ever deletes or replaces a file it
  did not itself deliver.

A bundle action never runs before every delivery action the same plan
proposed for that track has settled. `--apply` (or selecting actions and
pressing Apply in the app) re-derives the plan fresh first and only ever runs
an action that plan still produces itself: a stale id from an old plan is
revalidated, not trusted, and one already fixed by the time apply runs is
reported `skipped_already_fixed` rather than repeated.

```console
curl -X POST http://127.0.0.1:4600/api/destination-health/plan \
  -H 'content-type: application/json' \
  -d '{"tracks":["ghetto-geek"]}'

curl -X POST http://127.0.0.1:4600/api/destination-health/apply-plan \
  -H 'content-type: application/json' \
  -d '{"tracks":["ghetto-geek"],"actionIds":["<id from the plan above>"]}'
```

No plan is ever persisted — it is a point-in-time answer, same as a health
scan, and can go stale the moment something else touches the destination.

#### Confirmed delivery after a queued render

Queuing a render is not the same as knowing it worked. `apply-plan` accepts
`waitForCompletion` (and a bounded `timeoutMs`, default 5 minutes, capped at
30): with it on, a `rerender_and_deliver` action follows its render job
through the existing render manager to one of these final outcomes, rather
than returning `queued` and leaving the rest to hope —

- **completed** — rendered, delivered, and (if the same call also included
  the track's bundle action) the release bundle is current too.
- **render_failed** / **cancelled** — the render never reached delivery;
  a dependent bundle action is reported `blocked`, never run.
- **delivery_failed** — the render succeeded but the copy afterward failed;
  the newly rendered canonical export is kept, so a later apply can retry
  delivery alone without rendering again.
- **timed_out** — this call stopped waiting; the render itself was **not**
  cancelled and may still finish on its own. Re-run the fix plan to confirm.

Two apply calls for the same track and format converge on one render job,
never two — the render manager's own dedup decides that, the same guarantee
an ordinary render queue already gives. A confirmed `completed` result
includes `healthConfirmed`, from one narrow health check scoped to exactly
the tracks this call fixed, never the whole catalogue.

Without `--wait`, the CLI reports `[queued]` and stops, exactly as before.
With it, the CLI polls the same in-process render manager purely to print
progress, then makes one more call once the render settles to get the
confirmed result:

```console
$ npm run destination-fix-plan -- --track ghetto-geek --apply --wait
Applying 2 safe action(s)...

Waiting up to 300s for 1 render(s)...
  [preparing] Re-render and deliver ghetto-geek / YouTube 16:9
  [rendering 42%] Re-render and deliver ghetto-geek / YouTube 16:9

  ✓ [completed] rerender_and_deliver — ghetto-geek / youtube-16x9
  ✓ [completed] regenerate_release_bundle — ghetto-geek
```

The UI panel follows the identical shape, but for live progress it reuses
the existing per-job SSE stream (the same one the render panel already
shows) instead of polling: Apply's first call reports a job id for anything
queued, the panel shows that job's real status inline, and once it settles
the panel automatically re-applies with `waitForCompletion` to get the
confirmed result. It never implies success while an action is only queued.

### Editing metadata while something else changes it

Saves are conditional. The API reports a `metadataRevision` for each track, the
UI sends it back as `If-Match`, and a save based on a revision that is no longer
current is refused with `METADATA_CONFLICT` (412) rather than overwriting the
other change. Omitting `If-Match` keeps the plain merge behaviour, so the CLI
and any script are unaffected.

The form will not discard what you are typing: a refresh that carries no change
leaves it alone, and if `metadata.json` does change on disk mid-edit, your text
stays and a warning appears instead of the field silently reverting.

### Project structure

The track logic lives in a reusable core with adapters around it, so the CLI,
the API and the web app are thin layers over it, and a new renderer or host
(a batch service, a Premiere Pro or After Effects integration) can reuse the
same code instead of re-implementing it. [ARCHITECTURE.md](ARCHITECTURE.md)
covers the layers, the dependency rules (enforced by
`tests/architecture.test.mts`) and how to add an adapter.

```
core/                   Platform-independent: no node:*, React or Remotion.
  domain/               Safe to import anywhere, including the composition and
                        browser code.
    tracks/             types · errors · paths · metadata · validation · slug
    video/              compositionConfig · renderPresets — the export formats,
                        defined once and read by everything · visualizerProps —
                        the render input every renderer consumes
  ports/                renderEngine — the interface a renderer implements

services/               Node only. The single owner of filesystem and ffmpeg
                        access; renders through whichever RenderEngine it's given.
  tracks/               trackLocations · inspectTrack · listTracks ·
                        createTrack · updateTrackMetadata · prepareTrackAudio ·
                        prepareTrack · buildTrackProps · audioDuration
  render/               renderTrackVideo · publishExport — staged video/manifest publication
  tracks/               exportCoverage · exportManifest — freshness and cached fingerprints
  workflows/            Planners, health/fix plans, library and history queries,
                        and the render job manager, shared by the API and the CLI
    render-worker.mts   Runs one render in its own process.

adapters/remotion/      The Remotion renderer.
  remotionRenderEngine.mts   RenderEngine: bundle, Chromium, encoding settings
  BeatVisualizer/       The composition. Props in, pixels out.
  index.ts              Studio / bundle entry point (see remotion.config.ts)

scripts/                CLI entry points: parse args, call a service, format
                        output, pick an exit code.

server/                 Local HTTP API over the same services (see below).

ui/                     The local web app. Calls the API and renders what comes
                        back; it re-implements no validation, slug rules or path
                        building of its own.
  api/                  typed client · public-asset URLs
  components/           track list · detail · metadata form · upload zones ·
                        prepare · preview · render progress
  hooks/                useAsync · useRenderJob (SSE) · useWindowFocus
  styles/               tokens.css (brand) · app.css (layout)

index.html              Vite entry for the UI.
vite.config.ts          Vite root is the project root, so publicDir defaults to
                        public/ and ui/ can import the composition directly.
```

Conventions worth knowing before changing anything here:

- **`core/` never imports `node:*`, or any package.** It's part of the Remotion
  bundle's module graph (the composition imports it) and of the browser UI, so
  it has to stay platform-independent. Anything touching the filesystem belongs
  in `services/`.
- **Paths have one owner.** `core/domain/tracks/paths.ts` defines every
  `public/`-relative path (`tracks/<slug>/cover.png` and friends);
  `services/tracks/trackLocations.ts` turns those into absolute paths. Don't
  hand-build these strings anywhere else.
- **The API's wire format is declared once**, in `core/domain/api/views.ts`. The
  server implements those types and the UI consumes them, so a change that
  breaks one end fails to compile rather than failing in the browser.

The CLI commands above are unchanged and remain the supported way to work with
tracks.

## Local API server

A small local-only HTTP API exposes the same services to tooling (and to a
future local UI). It is not required for any of the CLI workflow above.

```console
npm run server
```

It binds to `127.0.0.1:4600` only — no auth, no remote access, no database.
Set `TOSHI_API_PORT` to use a different port. Port 4600 deliberately avoids
3000–3100, which Remotion Studio and Remotion's internal render server use.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness check |
| GET | `/api/renderers` | Each render engine and whether it can run here: `ready`, `unavailable` or `not_configured`, with the reason |
| GET | `/api/tracks` | List all tracks with asset/validation status |
| POST | `/api/tracks` | Create a track from `{"title":"..."}` |
| GET | `/api/tracks/:slug` | Full detail: metadata, assets, validation, render |
| PATCH | `/api/tracks/:slug/metadata` | Update title/artist/key/bpm/subtitle/exportPresets/renderer/deliveryFolder (`renderer: null` clears the engine preference) |
| PUT | `/api/tracks/:slug/cover` | Upload `cover.png` (raw PNG body) |
| PUT | `/api/tracks/:slug/beat` | Upload `beat.wav` (raw WAV body) |
| POST | `/api/tracks/:slug/validate` | Structured validation result |
| POST | `/api/tracks/:slug/prepare` | Validate + refresh `analysis.wav` |
| GET | `/api/tracks/:slug/preview` | Composition config + `inputProps` + duration |
| POST | `/api/tracks/:slug/render` | Start a render, returns a job id immediately; optional `{"preset":"...","engine":"remotion"}` |
| POST | `/api/tracks/:slug/reveal` | Show the selected format in Finder (macOS); optional `"engine"` picks whose export |
| GET | `/api/renders` | All render jobs, newest first |
| GET | `/api/renders/:jobId` | Job status and progress |
| GET | `/api/renders/:jobId/events` | Live progress (Server-Sent Events) |
| GET | `/api/renders/:jobId/logs` | Recent log lines for the job |
| POST | `/api/renders/:jobId/cancel` | Cancel a queued or running render |
| POST | `/api/export-missing` | Plan/queue missing or stale intended exports (optional `mode`) |
| POST | `/api/render-batches` | Queue many track/format pairs at once; each target may name an `engine` |
| GET | `/api/render-batches` | All batches, newest first |
| GET | `/api/render-batches/:batchId` | Batch totals, progress and member jobs |
| GET | `/api/render-batches/:batchId/events` | Live batch aggregate (Server-Sent Events) |
| POST | `/api/render-batches/:batchId/cancel` | Cancel a batch's unfinished renders |
| GET | `/api/delivery/settings` | Destination folder, availability and auto-deliver |
| PUT | `/api/delivery/settings` | Set `{"root":"/abs/path"}` (or `null` to turn it off) / `{"autoDeliver":true}` |
| POST | `/api/delivery/deliver` | Plan/copy current exports; `{"tracks":[...]}` or `{"catalogue":true}`, optional `dryRun` |
| POST | `/api/delivery/reveal` | Show the destination in Finder (macOS); takes a slug, never a path |
| POST | `/api/release-bundles` | Write release.json/release.md; `{"tracks":[...]}` or `{"catalogue":true}`, optional `dryRun`/`force` |
| GET | `/api/delivery-history` | Read the destination's delivery log; `track`, `preset`, `from`, `to`, `limit`, `order` |
| POST | `/api/delivery-history/reconcile` | Append events for deliveries whose receipts exist but were never recorded |
| GET | `/api/destination-health` | Compare the destination against current records; `track` may repeat for a named subset, omitted scans the catalogue |
| POST | `/api/destination-health/plan` | Dry-run remediation plan for current drift; `{"tracks":[...]}` or `{"catalogue":true}` |
| POST | `/api/destination-health/apply-plan` | Run named safe action ids, revalidated against a freshly re-derived plan; same body plus `"actionIds"`, optional `"waitForCompletion"`/`"timeoutMs"` |

Successful responses are `{"ok":true,"data":...}`. Failures are
`{"ok":false,"error":{"code","message","path?"}}`, where `code` is the shared
domain error code (`TRACK_NOT_FOUND`, `AUDIO_MISSING`, `METADATA_INVALID`,
`RENDER_TARGET_LOCKED`, …) mapped onto a matching HTTP status.

No delivery endpoint accepts a destination path for an operation: the root is
configured once and validated, and every delivery names tracks and formats while
the server resolves where those go.

### Examples

```console
curl http://127.0.0.1:4600/api/health
curl http://127.0.0.1:4600/api/tracks
curl http://127.0.0.1:4600/api/tracks/ghetto-geek

curl -X POST http://127.0.0.1:4600/api/tracks \
  -H 'content-type: application/json' -d '{"title":"Midnight Rider"}'

curl -X PATCH http://127.0.0.1:4600/api/tracks/ghetto-geek/metadata \
  -H 'content-type: application/json' -d '{"bpm":102,"key":"F Minor"}'

curl -X POST http://127.0.0.1:4600/api/tracks/ghetto-geek/prepare
```

Uploads are raw `PUT` bodies — no multipart form, and no filename is sent,
because the endpoint decides which file is written:

```console
curl -X PUT --data-binary @cover.png \
  -H 'content-type: image/png' \
  http://127.0.0.1:4600/api/tracks/midnight-rider/cover

curl -X PUT --data-binary @beat.wav \
  -H 'content-type: audio/wav' \
  http://127.0.0.1:4600/api/tracks/midnight-rider/beat
```

### Render job lifecycle

```
queued -> preparing -> rendering -> completed
                                 \-> failed
                    (any stage)  \-> cancelled
```

Starting a render returns immediately; the render itself runs in a separate
process. Every job reports its `engine` (default `remotion`). Naming an engine
that is unknown (`INVALID_RENDERER`) or not installed (`RENDERER_UNAVAILABLE`)
is a 400, and nothing is queued. An `after-effects` job whose template is not
configured fails with `RENDERER_NOT_CONFIGURED` in its job error. **Only one render runs at a time** — a render already uses three
Chromium tabs, and running two at once would thrash rather than finish sooner.
Further requests queue.

```console
# start a render — returns a job id straight away
curl -X POST http://127.0.0.1:4600/api/tracks/ghetto-geek/render

# poll status
curl http://127.0.0.1:4600/api/renders/<jobId>

# cancel
curl -X POST http://127.0.0.1:4600/api/renders/<jobId>/cancel
```

### Following progress with SSE

```console
curl -N http://127.0.0.1:4600/api/renders/<jobId>/events
```

Event names are `status`, `progress`, `log`, `completed`, `failed` and
`cancelled`. `progress` carries real values reported by Remotion:

```
event: progress
data: {"progress":0.42,"framesRendered":2331,"totalFrames":5555,...}
```

The stream replays the job's current state and log history on connect, then
closes itself once the job reaches a terminal state.

One honest caveat worth showing in any UI: each of the three render workers
decodes `analysis.wav` once before its first frame, so `progress` legitimately
sits near zero for a while at the start. Surface the `status`/log phase during
that window rather than a bar that looks stuck.

## Commands

**Install Dependencies**

```console
npm i
```

**Start Preview**

```console
npm run dev
```

**Render video**

```console
npx remotion render
```

**Upgrade Remotion**

```console
npx remotion upgrade
```

**Checks**

```console
npm run lint    # eslint + tsc across src scripts services server ui tests
npm test        # node:test regression suite (no browser, no render)
```

The suite covers the concurrency, error-containment, malformed-request and
render-queue behaviour that is easy to break by accident; each test pins a
defect that was reproduced before being fixed. It touches the filesystem under
`public/tracks/` using uniquely named fixture tracks and removes them
afterwards.

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Help

We provide help on our [Discord server](https://discord.gg/6VzzNDwUwV).

## Issues

Found an issue with Remotion? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
