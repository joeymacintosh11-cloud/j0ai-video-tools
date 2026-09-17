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
```

This creates `public/tracks/midnight-rider/` with a `metadata.json`
template and prints the next steps. It refuses to run if that track folder
already exists — it never overwrites or deletes anything.

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
  "subtitle": "Boom bap soul, trap bounce and latin heat."
}
```

- `title`, `artist`, `key` — required strings
- `bpm` — required positive number
- `subtitle` — optional string; if present it's shown under the title, if
  omitted the layout simply skips it

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
`out/<track-slug>.mp4` (e.g. `out/ghetto-geek.mp4`).

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

### Project structure

The track logic lives in shared modules, so the CLI is a thin layer over it
and anything added later (a local app, a batch script) can reuse the same
code rather than re-implementing it.

```
src/domain/             Pure, no filesystem. Safe to import anywhere, including
                        the composition and browser code.
  tracks/               types · errors · paths · metadata · validation · slug
  video/                compositionConfig — id, size and fps, in one place

services/               Node only. The single owner of filesystem, ffmpeg and
                        Remotion-API access.
  tracks/               trackLocations · inspectTrack · listTracks ·
                        createTrack · updateTrackMetadata · prepareTrackAudio ·
                        prepareTrack · buildTrackProps · audioDuration
  render/               renderTrackVideo — the one place that encodes video

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
| PATCH | `/api/tracks/:slug/metadata` | Update title/artist/key/bpm/subtitle |
| PUT | `/api/tracks/:slug/cover` | Upload `cover.png` (raw PNG body) |
| PUT | `/api/tracks/:slug/beat` | Upload `beat.wav` (raw WAV body) |
| POST | `/api/tracks/:slug/validate` | Structured validation result |
| POST | `/api/tracks/:slug/prepare` | Validate + refresh `analysis.wav` |
| GET | `/api/tracks/:slug/preview` | Composition config + `inputProps` + duration |
| POST | `/api/tracks/:slug/render` | Start a render, returns a job id immediately |
| POST | `/api/tracks/:slug/reveal` | Show `out/<slug>.mp4` in Finder (macOS) |
| GET | `/api/renders` | All render jobs, newest first |
| GET | `/api/renders/:jobId` | Job status and progress |
| GET | `/api/renders/:jobId/events` | Live progress (Server-Sent Events) |
| GET | `/api/renders/:jobId/logs` | Recent log lines for the job |
| POST | `/api/renders/:jobId/cancel` | Cancel a queued or running render |

Successful responses are `{"ok":true,"data":...}`. Failures are
`{"ok":false,"error":{"code","message","path?"}}`, where `code` is the shared
domain error code (`TRACK_NOT_FOUND`, `AUDIO_MISSING`, `METADATA_INVALID`, …)
mapped onto a matching HTTP status.

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

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Help

We provide help on our [Discord server](https://discord.gg/6VzzNDwUwV).

## Issues

Found an issue with Remotion? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
