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

### Export formats

Three formats ship, all at 30fps, defined once in
`src/domain/video/renderPresets.ts`:

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
(`src/Composition.tsx`). It's only the default props for the live preview —
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
reclaimed automatically, because nothing here can prove it is dead:

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

The track logic lives in shared modules, so the CLI is a thin layer over it
and anything added later (a local app, a batch script) can reuse the same
code rather than re-implementing it.

```
src/domain/             Pure, no filesystem. Safe to import anywhere, including
                        the composition and browser code.
  tracks/               types · errors · paths · metadata · validation · slug
  video/                compositionConfig · renderPresets — the export formats,
                        defined once and read by everything

services/               Node only. The single owner of filesystem, ffmpeg and
                        Remotion-API access.
  tracks/               trackLocations · inspectTrack · listTracks ·
                        createTrack · updateTrackMetadata · prepareTrackAudio ·
                        prepareTrack · buildTrackProps · audioDuration
  render/               renderTrackVideo · publishExport — staged video/manifest publication
  tracks/               exportCoverage · exportManifest — freshness and cached fingerprints

src/BeatVisualizer/     The composition. Props in, pixels out.

scripts/                CLI entry points: parse args, call a service, format
                        output, pick an exit code.

server/                 Local HTTP API over the same services (see below).
  render-worker.mts     Runs one render in its own process.

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

Two conventions worth knowing before changing anything here:

- **`src/domain/` never imports `node:*`.** It's part of the Remotion bundle's
  module graph (the composition imports it), so it has to stay browser-safe.
  Anything touching the filesystem belongs in `services/`.
- **Paths have one owner.** `src/domain/tracks/paths.ts` defines every
  `public/`-relative path (`tracks/<slug>/cover.png` and friends);
  `services/tracks/trackLocations.ts` turns those into absolute paths. Don't
  hand-build these strings anywhere else.
- **The API's wire format is declared once**, in `src/domain/api/views.ts`. The
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
| GET | `/api/tracks` | List all tracks with asset/validation status |
| POST | `/api/tracks` | Create a track from `{"title":"..."}` |
| GET | `/api/tracks/:slug` | Full detail: metadata, assets, validation, render |
| PATCH | `/api/tracks/:slug/metadata` | Update title/artist/key/bpm/subtitle/exportPresets/deliveryFolder |
| PUT | `/api/tracks/:slug/cover` | Upload `cover.png` (raw PNG body) |
| PUT | `/api/tracks/:slug/beat` | Upload `beat.wav` (raw WAV body) |
| POST | `/api/tracks/:slug/validate` | Structured validation result |
| POST | `/api/tracks/:slug/prepare` | Validate + refresh `analysis.wav` |
| GET | `/api/tracks/:slug/preview` | Composition config + `inputProps` + duration |
| POST | `/api/tracks/:slug/render` | Start a render, returns a job id immediately; optional `{"preset":"..."}` |
| POST | `/api/tracks/:slug/reveal` | Show the selected format in Finder (macOS) |
| GET | `/api/renders` | All render jobs, newest first |
| GET | `/api/renders/:jobId` | Job status and progress |
| GET | `/api/renders/:jobId/events` | Live progress (Server-Sent Events) |
| GET | `/api/renders/:jobId/logs` | Recent log lines for the job |
| POST | `/api/renders/:jobId/cancel` | Cancel a queued or running render |
| POST | `/api/export-missing` | Plan/queue missing or stale intended exports (optional `mode`) |
| POST | `/api/render-batches` | Queue many track/format pairs at once |
| GET | `/api/render-batches` | All batches, newest first |
| GET | `/api/render-batches/:batchId` | Batch totals, progress and member jobs |
| GET | `/api/render-batches/:batchId/events` | Live batch aggregate (Server-Sent Events) |
| POST | `/api/render-batches/:batchId/cancel` | Cancel a batch's unfinished renders |
| GET | `/api/delivery/settings` | Destination folder, availability and auto-deliver |
| PUT | `/api/delivery/settings` | Set `{"root":"/abs/path"}` (or `null` to turn it off) / `{"autoDeliver":true}` |
| POST | `/api/delivery/deliver` | Plan/copy current exports; `{"tracks":[...]}` or `{"catalogue":true}`, optional `dryRun` |
| POST | `/api/delivery/reveal` | Show the destination in Finder (macOS); takes a slug, never a path |

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
process. **Only one render runs at a time** — a render already uses three
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
