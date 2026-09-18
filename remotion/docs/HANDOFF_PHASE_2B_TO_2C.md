# Toshi Visualizer — Handoff: Phase 2B → Phase 2C

**Written:** 2026-09-17
**Author context:** Written by a Claude Code session (Sonnet 5) at the end of
Phase 2B, because the conversation's context window was nearly full. A new
Claude Code session with zero prior context is expected to read this file,
verify it against the repo, and continue with Phase 2C-A.

**How to use this document:** Section 0 tells you the one thing to check
before anything else. Sections 1–22 are reference material (what exists and
why). Sections 23+ are the actual handoff — limitations, decisions, and exact
next steps. Everything here was verified against the live repository at
write time; where the original project brief (given to the author of this
document) turned out to disagree with the repo, that's called out explicitly
in §23a rather than silently corrected.

---

## 0. Read this first

**Sections 1–34 describe the project as it stood at the end of Phase 2B.**
**§38 (stale exports / re-export detection) is the newest state.**
§35–37 cover formats, batching, export-missing and per-track intent.
Phases 2C-A, 2C-B, a stability hardening pass and a multi-format/batch feature
set have all landed since. Where an older section disagrees with the code, the
code wins — and **§35 onwards is the current state**. Read §35 before acting on
anything in §23 (limitations), §26–30 (Phase 2C plans, now delivered) or §34
(git, now resolved).

Specifically, these earlier statements are **no longer true**:

- The git warning that used to be here: everything is committed, and the repo
  has a remote (`joeymacintosh11-cloud/j0ai-video-tools`). §34's "nothing is
  committed" text is historical.
- §23's "no file uploads" and §26's "no UI exists": both were delivered in
  Phase 2C-A.
- Renders no longer go to `out/<slug>.mp4`. See §35.2.
- The composition is no longer 1920×1080 only. See §35.1.

---

## 1. Executive Summary

This is a local, agentic video-rendering tool for **Toshi**, a music
production / beat-licensing brand. It takes a beat (WAV), cover art (PNG),
and metadata (title/artist/key/BPM/subtitle), and renders a branded,
audio-reactive "YouTube visualizer" video (1920×1080, 30fps) entirely on one
Mac, with no cloud dependency.

The project has gone through four completed phases of work (informally
numbered in this codebase's own history):

1. **Visualizer creation** — the Remotion composition itself, iteratively
   designed and polished to match the Toshi brand.
2. **Track system** — the `public/tracks/<slug>/` contract, a CLI
   (`new-track` / `prepare-track` / `validate-track` / `render-track`), and
   the `analysis.wav` performance optimization.
3. **Phase 2A** — extracted CLI business logic into a shared, reusable
   domain/service layer (`src/domain/`, `services/`).
4. **Phase 2B** — added a local-only HTTP API (`server/`) over those same
   services, with asynchronous render jobs, real SSE progress, and
   cancellation.

**Current state: stable, tested, working.** The CLI and the API both render
`ghetto-geek` to `out/ghetto-geek.mp4` correctly, in ~3–3.5 minutes, and the
two paths were verified in this session to produce **byte-identical decoded
video** and audio that differs only due to pre-existing AAC encoder
non-determinism (proven with a same-code-path control test — see §11).

**What's next:** Phase 2C is the frontend. No React code, no upload
handling, and no UI of any kind exist yet in this repo. That is the explicit
scope of Phase 2C-A (see §26–27).

---

## 2. Product Goal

- Add a beat → add cover art → enter title/artist/key/BPM/subtitle → prepare
  waveform analysis → preview → render → get a branded MP4 locally.
- Long-term direction: a local desktop-style web app on top of the existing
  render engine described here.
- **Not** a SaaS product, cloud rendering service, multi-user platform, or
  authenticated web app. Stays local-first, simple, fast, reliable.

---

## 3. Hardware / Local Environment

- MacBook Pro 14", **Apple M5**, **16 GB unified memory**, 1 TB SSD.
- This is the binding performance constraint for everything render-related:
  conservative concurrency, no unnecessary Chromium/Node workers, avoid
  multiple heavy dev processes running at once (Remotion Studio + API server
  + a render job + VS Code + Chrome all compete for the same 16 GB).
- Observed during a real render (this session): total CPU utilization spiked
  to ~774% (out of 1000% max on 10 cores) during rendering — expected and
  fine, not a problem to fix.

## 4. Toolchain (verified live, this session)

| Tool | Version |
|---|---|
| Node | v26.8.2 (native TypeScript stripping — no `ts-node`/`tsx` needed) |
| npm | 11.19.1 |
| ffmpeg | 9.0.1 (Homebrew) |
| ffprobe | 9.0.1 (bundled with ffmpeg) |
| TypeScript | 5.9.3 |
| Remotion | 4.0.525 (pinned exactly across all `@remotion/*` packages) |
| React | 19.2.3 |

GitHub CLI is authenticated as `joeymacintosh11-cloud` (HTTPS protocol,
verified via `gh auth status`). A separate sibling repo,
`~/Documents/toshi-website`, exists and was the source of the real brand
assets copied into this project — it is not otherwise part of this codebase.

---

## 5. Repository Layout

**Project root:** `~/Documents/j0ai-video-tools/remotion` — this is where
every command in this document should be run from. It lives inside the
parent git repo `~/Documents/j0ai-video-tools` (not its own nested repo —
confirmed no `.git` inside `remotion/`).

Full current source tree (verified via `find`, excluding `node_modules`,
`out/`, and the bundled Remotion skill docs under `.agents/`/`.claude/`):

```
remotion/
  package.json                    scripts, deps — see §32
  tsconfig.json                   strict, resolveJsonModule, allowImportingTsExtensions
  remotion.config.ts              rspack + jpeg images + overwrite (Studio-CLI only, NOT the Node API path — see its own header comment)
  eslint.config.mjs               -> @remotion/eslint-config-flat

  public/
    Ghetto Geek.wav                ⚠ STRAY, 49MB, unreferenced — see §23b
    toshi-brandguide.png           ⚠ unreferenced design reference — see §23b
    brand/toshi/
      toshi-logo-light.png
      toshi-icon-mark.png
      toshi-horizontal-lockup.png  (present but not currently imported by any code)
    tracks/ghetto-geek/
      cover.png
      beat.wav
      metadata.json
      analysis.wav                 gitignored, regenerable

  out/
    ghetto-geek.mp4                gitignored render output

  src/
    index.ts                       registerRoot(RemotionRoot)
    Root.tsx                       renders <ToshiBeatVisualizerComposition />
    Composition.tsx                registers the "ToshiBeatVisualizer" Remotion composition
    BeatVisualizer/                 the composition itself — DO NOT REDESIGN (§25)
      BeatVisualizer.tsx
      Background.tsx
      Grain.tsx
      CoverArt.tsx
      TrackInfo.tsx
      Waveform.tsx
      BrandMark.tsx
      theme.ts
    domain/                        PURE — no node:*, safe for the browser bundle
      package.json                 {"type":"module"} shim (Node-side warning suppression only)
      video/compositionConfig.ts   COMPOSITION_ID, FPS, width/height, secondsToFrames()
      tracks/
        types.ts                   TrackMetadata, TrackStatus, TrackInspection, etc.
        errors.ts                  TrackErrorCode, TrackIssue, TrackError
        paths.ts                   public/-relative path builders (single source of truth)
        slug.ts                    slugify, isValidSlug, assertValidSlug
        metadata.ts                parse/validate/serialize/default metadata
        validation.ts              asset validation, warnings, status derivation

  services/                        Node-only. Owns fs/ffmpeg/Remotion-renderer access.
    package.json                   {"type":"module"} shim
    tracks/
      trackLocations.ts            absolute-path resolver (derives PROJECT_ROOT from its own file location)
      inspectTrack.ts               non-throwing full track inspection
      listTracks.ts                 enumerates public/tracks/*
      createTrack.ts                new-track scaffolding logic
      updateTrackMetadata.ts        validated + atomic (tmp-file + rename) metadata PATCH
      prepareTrackAudio.ts          ensureAnalysisAudio() — the ffmpeg wrapper
      prepareTrack.ts               orchestrates: validate -> ensureAnalysisAudio -> build props
      buildTrackProps.ts            TrackMetadata -> BeatVisualizerProps mapping
      audioDuration.ts              probeAudioDurationInSeconds() via ffprobe (for preview only)
    render/
      renderTrackVideo.ts            THE single renderMedia() call site — CLI and API both use this

  scripts/                          CLI entry points, thin wrappers around services/
    package.json                    {"type":"module"} shim
    cli.ts                          runCli() error->exit-code wrapper, shared print helpers
    new-track.mts
    prepare-track.mts
    render-track.mts                also implements --validate-only

  server/                           Local HTTP API (Phase 2B). Node-only.
    package.json                    {"type":"module"} shim
    index.mts                       http.createServer, 127.0.0.1:4600, SIGINT/SIGTERM shutdown
    app.ts                          router (manual path-segment matching, no framework)
    types.ts                        RenderJobStatus, RenderJobView, WorkerEvent/WorkerCommand (IPC protocol)
    render-worker.mts                forked child process; runs ONE render; talks to parent via IPC
    http/
      json.ts                       sendJson/sendOk/readJsonBody (256KB body cap)
      errors.ts                     TrackErrorCode -> HTTP status map, sendErrorForException
      sse.ts                        minimal hand-rolled SSE stream (heartbeat, close handling)
    routes/
      tracks.ts                     all /api/tracks* handlers
      renders.ts                    all /api/renders* handlers
    services/
      renderManager.ts               job registry + single-slot queue + fork() lifecycle
    views/
      trackView.ts                   TrackInspection -> JSON API shape

  docs/
    HANDOFF_PHASE_2B_TO_2C.md       this file
```

**Not present anywhere in the repo:** any `ui/`, `frontend/`, `client/`,
`web/` directory; any React component outside `src/BeatVisualizer/`; any
`vite.config.*`; any upload-handling code; any WebSocket code; any database
or ORM; any auth code.

---

## 6. Brand / Visual Direction

**Brand:** Toshi — music production / beat licensing.

**Aesthetic:** early-2000s hip-hop soul, boom bap, trap/drill energy, latin
rhythm. Gritty, nostalgic, record-sleeve/poster feel. Premium but
underground. Explicitly **not** generic modern SaaS, **not** neon tech.

**Tagline** (used as the default `subtitle` in scaffolded tracks):
> "Boom bap soul, trap bounce and latin heat."

**Palette** (verified live in `src/BeatVisualizer/theme.ts`):

| Name | Hex | Usage |
|---|---|---|
| Off Black | `#0b0b0b` | background |
| Warm Cream | `#f4e8d0` | title, stat values |
| Vintage Gold | `#b8860b` | accents, borders, labels |
| Deep Red | `#7a1e1e` | artist label, waveform gradient bottom |
| Olive Green | `#2d3a2e` | subtle background glow only |

**Typography** (verified live): headline = **Bebas Neue**, label/UI =
**Oswald** (weights 400/600), both loaded via `@remotion/google-fonts`. The
original brief also mentioned Inter/Manrope for body/UI — those are **not**
used anywhere in the current code; Oswald covers that role.

**Design reference:** `public/toshi-brandguide.png` — the original panel
that most directly inspired the visualizer layout was labeled "YouTube
Visualizer Thumbnail" in that sheet (large title, dark background, Toshi
identity, waveform accent, poster hierarchy). This PNG is not imported by
any code; it's a static reference asset only.

---

## 7. Asset Structure

```
public/brand/toshi/
  toshi-logo-light.png        used by BrandMark (top of composition)
  toshi-icon-mark.png         used by CoverArt (small badge, bottom-right of cover)
  toshi-horizontal-lockup.png present on disk, not currently referenced by any code
```

These paths are hardcoded once, in `src/domain/tracks/paths.ts`
(`BRAND_ASSET_PATHS`) — not duplicated anywhere else.

An earlier, FFmpeg-cropped icon file (`public/toshi-icon.png`) was
superseded by the real `toshi-icon-mark.png` asset and **no longer exists on
disk** (verified — `ls` returns "No such file or directory"). Do not
reintroduce a generated/cropped icon; the real asset is the source of truth.

---

## 8. Track Contract

```
public/tracks/<slug>/
  cover.png        required — square cover art
  beat.wav         required — original audio, used for final rendered audio AND duration
  metadata.json    required — see §8a
  analysis.wav     generated — waveform-analysis-only copy, gitignored, regenerable
```

The **only** existing track right now is `public/tracks/ghetto-geek/`, with
all four files present (`analysis.wav` was (re)generated multiple times
during this session's testing and is current).

**Slug is folder-based and immutable.** Editing `title` in `metadata.json`
via `PATCH /api/tracks/:slug/metadata` never renames the folder — enforced
in `services/tracks/updateTrackMetadata.ts` (the slug is a function
parameter used only for path resolution, never written back).

### 8a. metadata.json shape

```json
{
  "title": "Ghetto Geek",
  "artist": "Toshi",
  "key": "F Minor",
  "bpm": 100,
  "subtitle": "Boom bap soul, trap bounce and latin heat."
}
```

Validation rules (`src/domain/tracks/metadata.ts`):
- `title`, `artist`, `key` — required non-empty strings
- `bpm` — required positive finite number
- `subtitle` — optional string

**Draft state, by design:** `new-track` deliberately scaffolds
`key: ""`, `bpm: null`. This is not invalid data waiting to be fixed by a
future version — it's the intentional "empty form" state. `TrackStatus`
(`src/domain/tracks/types.ts`) has four values precisely to distinguish
this:

- `ready` — fully valid, renderable
- `draft` — scaffolded, still waiting on key/bpm (this is *not* an error state in the UI)
- `incomplete` — a required **file** (cover/beat/metadata.json itself) is missing
- `invalid` — metadata.json exists but is genuinely malformed (wrong types, not just placeholder values)

A future UI must render `draft` differently from `invalid` — see §29 open
question.

### 8b. Historical note on stray root-level audio

`public/Ghetto Geek.wav` (with a space, 49MB) predates the track-folder
system and is **confirmed unreferenced** by any current code (`grep` across
all `.ts`/`.tsx`/`.mts` files returns nothing). The canonical audio is
`public/tracks/ghetto-geek/beat.wav`. This stray file was left in place
because this handoff task was instructed not to modify anything — flagging
it for cleanup in Phase 2C or a dedicated cleanup pass. See §23b.

---

## 9. Visualizer Architecture

**Composition:** `ToshiBeatVisualizer` (constant: `COMPOSITION_ID` in
`src/domain/video/compositionConfig.ts`). 1920×1080, 30fps
(`COMPOSITION_CONFIG`), duration computed dynamically per-render.

**Component tree** (`src/BeatVisualizer/BeatVisualizer.tsx`):

```
<AbsoluteFill>
  <Background />              radial gradients + <Grain/> (procedural SVG feTurbulence, opacity 0.12, mixBlendMode:"screen")
  <Audio src={beat.wav} />    ALWAYS the original beat.wav, never analysis.wav
  <AbsoluteFill (padded column)>
    <BrandMark />              logo, height 112px
    <Row>
      <CoverArt />             520px, breathing scale + parallax, badge overlay
      <TrackInfo />            artist / title / subtitle / Key+BPM stat chips
    </Row>
    <Waveform />               64-bar reactive spectrum, reads waveformAudioSrc (analysis.wav) if provided, else falls back to audioSrc
  </AbsoluteFill>
</AbsoluteFill>
```

**Props contract** (`BeatVisualizerProps`, exported from
`BeatVisualizer.tsx`):

```ts
{
  title: string;
  artist: string;
  musicalKey: string;
  bpm: number;
  subtitle?: string;
  coverSrc: string;          // public/-relative, e.g. "tracks/ghetto-geek/cover.png"
  audioSrc: string;          // same — beat.wav
  waveformAudioSrc?: string; // same — analysis.wav; falls back to audioSrc if absent
  brandLogoSrc: string;
  brandBadgeSrc: string;
}
```

**Critical implementation detail — where `staticFile()` is called.** All
`*Src` prop values are **plain paths relative to `public/`** (e.g.
`"tracks/ghetto-geek/cover.png"`), never pre-resolved URLs.
`BeatVisualizer.tsx` itself calls Remotion's `staticFile()` on each one at
render time. This was a deliberate fix during Phase 2B: `staticFile()`
resolves differently in a Node script (no prefix) vs. inside the actual
browser bundle (uses `window.remotion_staticBase`). Calling it too early
(in Node, before bundling) silently produced 404s during programmatic
`selectComposition`/`renderMedia` calls. **Do not move `staticFile()` calls
into `services/` or any Node-side code** — they must stay inside the React
component tree.

### 9a. Visual polish history (current final state — do not redesign)

The following are the *current, settled* values, confirmed live in the
code:

- Waveform: 64 bars, height 130px, `opacity: 0.85`, `maxWidth: 8px` per bar,
  gradient `vintageGold → deepRed` top-to-bottom, positioned in its own row
  below the cover/title row with `marginTop: 20`.
- Title: `fontSize: 158`, `lineHeight: 0.9`, `textShadow` for depth, max
  width 940px.
- Key/BPM: rendered as "stat chips" (`Stat` component in `TrackInfo.tsx`) —
  a left gold border, small-caps gold label above a large cream value —
  not plain text.
- Cover: 520px square, `border-radius: 28`, gold 2px border, a static blurred
  gold glow behind it (`inset: -60, blur(30px)`), and a **breathing +
  parallax** animation: `scale` oscillates ±1.5% over a 9-second sine cycle,
  combined with a ±4px `translateY` — both driven by the same
  `cyclePosition` so they stay in phase (`CoverArt.tsx`).
- Cover badge: 20% of cover size, bottom-right, same gold-bordered circular
  treatment, overlapping the cover's corner by 25% of its own size.
- Grain: inline SVG `feTurbulence` (no external texture asset, no new
  dependency), `opacity: 0.12`, `mixBlendMode: "screen"`.
- BrandMark logo height: 112px.

**None of this should change in Phase 2C unless explicitly requested.**

---

## 10. Audio / FFmpeg Pipeline

**The performance problem (historical, now solved):** the original
`beat.wav` for Ghetto Geek is a **24-bit** WAV. Decoding 24-bit PCM in
Chromium's Web Audio API for the audio-reactive waveform (`useWindowedAudioData`
+ `visualizeAudio` from `@remotion/media-utils`, in `Waveform.tsx`) triggered
a very expensive **one-time decode cost per render worker tab** — empirically
measured in an earlier session at **~7 minutes per tab** for this file
(confirmed via a diagnostic in a prior session: 300 frames at concurrency 1
took 430s total, with frame 0 alone taking ~414s and the remaining 299
frames taking ~16s combined — i.e., almost the entire cost is one decode,
not per-frame work).

**The fix:** `services/tracks/prepareTrackAudio.ts` (`ensureAnalysisAudio`)
runs `ffmpeg` to produce `public/tracks/<slug>/analysis.wav`:

```
ffmpeg -y -i beat.wav -vn -ac 1 -ar 22050 -c:a pcm_s16le analysis.wav
```

- **mono** (`-ac 1`)
- **16-bit PCM** (`pcm_s16le`)
- **22.05 kHz** sample rate (`-ar 22050`)

For Ghetto Geek this shrinks 49MB → ~8.16MB (verified live).

**Regeneration logic** (mtime comparison, in the same file): if
`analysis.wav` doesn't exist, or its mtime is older than `beat.wav`'s mtime,
it's regenerated. Otherwise it's left alone (verified in this session: a
`touch beat.wav` correctly triggered regeneration on the next
`prepare-track` call; running `prepare-track` twice in a row without
touching anything correctly skipped regeneration both times).

**Hard invariant, enforced by design, not just convention:**
`BeatVisualizer.tsx`'s `<Audio>` element always uses `audioSrc` (→
`beat.wav`). Only `<Waveform>` uses `waveformAudioSrc ?? audioSrc`. The
`calculateBeatVisualizerMetadata` function (duration calculation) also
always uses `audioSrc`, never the analysis file. **Never wire
`analysis.wav` into the `<Audio>` element or duration calculation.**

`services/tracks/audioDuration.ts` (`probeAudioDurationInSeconds`) is a
*separate* ffprobe-based duration reader, added in Phase 2B purely so the
`/preview` API endpoint can report `durationInFrames` instantly without
spinning up a browser. It is not used by the actual render's duration
calculation (`calculateBeatVisualizerMetadata` in `BeatVisualizer.tsx`,
which uses `getAudioDurationInSeconds` from `@remotion/media-utils` inside
the browser, unchanged since before Phase 2A).

---

## 11. Performance Findings (all verified live, this session)

| Metric | Value |
|---|---|
| Ghetto Geek duration | 185.143741s source → 5555 frames @ 30fps (185.2s reported) |
| CLI render time (pre-optimization, historical) | 10+ minutes |
| CLI render time (current, `analysis.wav` optimization) | **~3:13–3:15** (multiple runs this session: 193.43s, 195.42s) |
| API render time (same code path, via render-worker) | **189.6s** (3:09) — no regression vs CLI |
| `POST /api/tracks/:slug/render` response latency | **16ms** — proven non-blocking |
| Render concurrency | `3` (hardcoded in `services/render/renderTrackVideo.ts`) — do not raise casually |
| Render timeout per frame | `15 * 60 * 1000` ms (15 min) — generous headroom for the one-time worker decode |

**Video output determinism — proven, not assumed.** In this session:
1. Rendered via the API, saved a copy.
2. Rendered via the CLI, saved a copy.
3. `ffmpeg -map 0:v -f md5` on both → **identical hash**
   (`094c36432da2eb824791209145adbf6d`) — the decoded pixel stream is
   byte-for-byte identical regardless of which path rendered it.
4. Audio stream hashes *differed* between the two. To rule out a real bug,
   ran a **control**: two CLI renders back-to-back (same unmodified code
   path) also produced **different** audio hashes from each other
   (`954799dd…` vs `0947a75f…`), while their video hashes matched. Further
   analysis: the two audio streams are bit-identical for the first ~76
   seconds, then diverge with no time offset — the signature of AAC encoder
   non-determinism (likely psychoacoustic model timing/threading), not a
   content change. **Conclusion: this is pre-existing behavior, unrelated to
   Phase 2A/2B, safe to ignore.** Worth knowing if a future session ever
   checksums renders and gets confused by it.

**Process cleanup — verified, not assumed.** Tested: cancel a queued job,
cancel a mid-render job, and SIGINT the server mid-render. In all cases:
zero orphaned `render-worker` processes and zero *new* orphaned Chromium
processes afterward (confirmed via `pgrep`/`ps -o ppid,etime`). Also
discovered (and left alone, per instructions not to kill arbitrary
processes): **4 pre-existing orphaned `chrome-headless-shell` processes**
(~88MB RSS total), parent PID 1, running since a diagnostic session ~19+
hours prior — unrelated to any Phase 2A/2B work, but a real-world example of
what can happen if a render process is killed uncleanly outside this
project's own lifecycle handling. A user may want to `killall
chrome-headless-shell` manually at some point; this codebase's own
shutdown/cancel paths do not produce this kind of leak.

**Bundle caching was explicitly deferred.** Estimated gain ~5–10s/render;
not worth the invalidation complexity before the UI exists. Every render
(CLI or API) currently calls `bundle()` fresh.

---

## 12. CLI Workflow (all four commands verified working, this session, immediately before writing this doc)

```console
npm run new-track -- "Midnight Rider"
npm run prepare-track -- midnight-rider
npm run validate-track -- midnight-rider
npm run render-track -- midnight-rider
```

- `new-track` — slugifies title, refuses if `public/tracks/<slug>/` already
  exists (`TRACK_ALREADY_EXISTS`), writes `metadata.json` template, never
  touches an existing folder.
- `prepare-track` — validates cover/beat/metadata presence, runs
  `ensureAnalysisAudio`, validates metadata content, prints a summary.
- `validate-track` — literally `render-track --validate-only` under the
  hood (`package.json`: `"validate-track": "node scripts/render-track.mts
  --validate-only"`), runs full preparation but stops before rendering.
- `render-track` — runs `prepareTrack`, then `renderTrackVideo`, outputs to
  `out/<slug>.mp4`.

All four remain fully functional after both Phase 2A and Phase 2B — this is
a hard requirement that was re-verified, not assumed, at the end of each
phase.

---

## 13. Shared Domain Architecture

Two layers, with one hard rule between them:

- **`src/domain/`** — zero `node:*` imports, anywhere. It's part of the
  Remotion bundler's module graph (imported by `src/Composition.tsx` and
  transitively by the whole composition), so it must stay valid to run in a
  browser bundle. Contains types, error codes, path-string builders,
  metadata validation, and the pure `slugify`/`isValidSlug` functions.
- **`services/`** (top-level, sibling to `src/`, *not* `src/services/`) —
  Node-only. Owns every `fs`, `child_process`, and `@remotion/bundler`
  /`@remotion/renderer` call in the project. This placement (outside `src/`)
  was a deliberate architectural decision made in Phase 2A specifically to
  prevent Node-only code from ever being pulled into the browser bundle by
  an accidental import.

Both layers, plus `scripts/` and `server/`, each have their own
`package.json` containing only `{"type":"module"}` — a workaround for
Node's native-TypeScript loader needing to know module type per-directory
when files use explicit `.ts` extensions in import specifiers (required by
`allowImportingTsExtensions` in `tsconfig.json`). This is cosmetic (silences
a `MODULE_TYPELESS_PACKAGE_JSON` warning) with zero effect on the Remotion
bundler, which resolves modules through its own pipeline regardless.

---

## 14. Phase 2A Summary (completed)

**Goal:** extract business logic out of CLI scripts into reusable
domain/service modules, without changing CLI behavior or visual output.

**What it produced:** everything listed in §13, plus the specific modules
enumerated in §5's tree under `src/domain/tracks/` and `services/tracks/`.

**Structured error codes introduced** (`src/domain/tracks/errors.ts`,
`TrackErrorCode` union — this is the *actual current* list, confirmed live,
16 codes total):

```
TRACK_NOT_FOUND · TRACK_ALREADY_EXISTS · INVALID_TRACK_NAME · INVALID_SLUG ·
INVALID_REQUEST · COVER_MISSING · AUDIO_MISSING · METADATA_MISSING ·
METADATA_INVALID · METADATA_WRITE_FAILED · ANALYSIS_STALE ·
FFMPEG_NOT_FOUND · ANALYSIS_GENERATION_FAILED · RENDER_FAILED ·
RENDER_JOB_NOT_FOUND · RENDER_NOT_CANCELLABLE
```

(`INVALID_SLUG`, `INVALID_REQUEST`, `METADATA_WRITE_FAILED`,
`RENDER_FAILED`, `RENDER_JOB_NOT_FOUND`, `RENDER_NOT_CANCELLABLE` were added
during Phase 2B for the API layer; the rest are Phase 2A originals.)

**Verification performed at the time:** TypeScript, ESLint, all four CLI
commands, all documented error cases (missing track/cover/beat/metadata,
malformed JSON, draft metadata, creation collision), a full render, and a
frame-level visual diff against a pre-refactor reference render (confirmed
pixel-identical). Render time unaffected (~3:15).

---

## 15. Local API Architecture

`node:http` only — **no Express, no Fastify, no framework of any kind.**
Manual path-segment router in `server/app.ts`. Render jobs run in a forked
child process (`node:child_process.fork`, native `.mts` support confirmed
working via a throwaway test before committing to this architecture) talking
to the parent over the built-in IPC channel (`process.send`/`.on('message')`
— not stdout parsing for the actual event data, though stdout/stderr are
*also* captured into the job's log buffer as a catch-all).

**Zero new npm dependencies were added for the entire server.** `@remotion/renderer`'s
`openBrowser`, `selectComposition`, `renderMedia`, `makeCancelSignal` were
already present (used by the CLI already, or trivially available since
`@remotion/renderer` was already a devDependency for `render-track.mts`).

---

## 16. Phase 2B Summary (completed)

**Goal:** local HTTP API exposing Phase 2A's services, with real async
render jobs, SSE progress, and cancellation — no frontend.

**What it added**, concretely:

- `server/` (see §5 tree) — router, render manager, worker, SSE, error
  mapping, view serializers.
- `services/render/renderTrackVideo.ts` — extracted the actual
  `renderMedia()` invocation out of `scripts/render-track.mts` into a shared
  function, so the CLI and the API worker call **the exact same code**, not
  parallel implementations. `scripts/render-track.mts` was rewritten to call
  this shared function via callbacks (`onPhase`/`onResolved`/`onProgress`)
  instead of inlining the render.
- `services/tracks/updateTrackMetadata.ts` — new; atomic (temp-file +
  rename) metadata PATCH with full re-validation before write.
- `services/tracks/audioDuration.ts` — new; ffprobe-based duration for the
  preview endpoint.
- `src/domain/video/compositionConfig.ts` — new; consolidated
  `1920×1080@30fps` + composition id, which had previously been duplicated
  as literals in `Composition.tsx`, `BeatVisualizer.tsx`, and would have
  been duplicated a third time in the new server preview route. Also
  removed the standalone `FPS` export from `BeatVisualizer/theme.ts` in
  favor of this.
- `src/domain/tracks/slug.ts` — extended with `isValidSlug`/`assertValidSlug`
  (regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 100 chars) — the API's only
  defense against path traversal, since every slug-taking service function
  calls this before touching the filesystem.

**Verification performed, this session** (see §11 for the numbers): server
start, all 14 endpoints exercised with curl, invalid-metadata-doesn't-corrupt
test (3 different invalid patches, file byte-identical after each), path
traversal rejected before filesystem access, render-on-invalid-track
rejected with 400 before a job was even created, full render via API with
live SSE capture (5,589 real progress events), cancel on queued/rendering/at
-shutdown (all clean), graceful SIGINT both idle and mid-render, CLI-vs-API
output equivalence (§11), and `npm run lint` (eslint + tsc) clean across
`src scripts services server`.

---

## 17. API Endpoint Reference (verified live from `server/app.ts` and `server/routes/*.ts` — this is the actual current router, not a plan)

All responses: `{"ok":true,"data":...}` or
`{"ok":false,"error":{"code","message","path?","details?"}}`.

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | `/api/health` | inline in `app.ts` | `{"ok":true,"service":"toshi-visualizer"}` |
| GET | `/api/tracks` | `handleListTracks` | array of `TrackSummaryView` |
| POST | `/api/tracks` | `handleCreateTrack` | body `{"title":"..."}`; 409 on collision |
| GET | `/api/tracks/:slug` | `handleGetTrack` | full `TrackDetailView` (metadata, assets, validation, render, `previewEndpoint`) |
| PATCH | `/api/tracks/:slug/metadata` | `handleUpdateMetadata` | body: any of title/artist/key/bpm/subtitle |
| POST | `/api/tracks/:slug/validate` | `handleValidateTrack` | `{slug,status,validation,assets}` |
| POST | `/api/tracks/:slug/prepare` | `handlePrepareTrack` | `{slug,status,metadata,validation,analysis:{path,generated,alreadyUpToDate},elapsedMs}` |
| GET | `/api/tracks/:slug/preview` | `handleTrackPreview` | `{slug,composition,durationInFrames,durationInSeconds,inputProps,analysisAvailable,studioUrlHint}` — **`inputProps` is ready to hand directly to `<Player inputProps={...}>`** |
| POST | `/api/tracks/:slug/render` | `handleStartRender` | 400 if track invalid; else `{jobId,status,job}`, returns immediately |
| GET | `/api/renders` | `handleListRenders` | all jobs, newest first |
| GET | `/api/renders/:jobId` | `handleGetRender` | `RenderJobView` |
| GET | `/api/renders/:jobId/events` | `handleRenderEvents` | **SSE** — see §19 |
| GET | `/api/renders/:jobId/logs` | `handleGetRenderLogs` | `{id,slug,status,logs}` |
| POST | `/api/renders/:jobId/cancel` | `handleCancelRender` | 409 if already terminal |

**Explicitly absent — confirmed by reading the router, not inferred:** no
upload endpoint of any kind. `readJsonBody` in `server/http/json.ts` caps
request bodies at 256KB specifically because uploads are out of scope for
this phase. Phase 2C-A must add upload handling (see §26 item 4, §29).

---

## 18. Render Job Lifecycle

```
queued -> preparing -> rendering -> completed
                                 \-> failed
                    (any stage)  \-> cancelled
```

`RenderJobView` shape (`server/types.ts`, this is the literal current
type):

```ts
{
  id: string;
  slug: string;
  status: RenderJobStatus;
  progress: number;              // 0..1, real Remotion progress
  framesRendered: number | null;
  totalFrames: number | null;
  fps: number | null;
  elapsedMs: number;
  startedAt: string | null;      // ISO
  queuedAt: string;              // ISO
  finishedAt: string | null;     // ISO
  outputPath: string | null;     // absolute path
  outputLabel: string | null;    // "out/<slug>.mp4"
  error: RenderJobError | null;  // {code, message, path?, details?}
}
```

**Concurrency: one render at a time, globally**, enforced in
`server/services/renderManager.ts` (`activeJobId` + a FIFO `queue` array).
This is deliberate for the 16GB memory budget — do not add parallel job
execution without re-testing memory headroom first (§26/§29).

---

## 19. SSE / Progress

`GET /api/renders/:jobId/events`. Hand-rolled (`server/http/sse.ts`), no
library. Sends `event: <name>\ndata: <json>\n\n`, a `: ping\n\n` comment
heartbeat every 15s (`.unref()`'d so it doesn't keep the process alive), and
replays the job's current status + full log buffer immediately on connect
(so a client that connects late — e.g. after refreshing the browser mid
-render — isn't stuck showing 0%). The stream closes itself once the job
hits a terminal status.

Event names: `status`, `progress`, `log`, `completed`, `failed`,
`cancelled`. All progress numbers come straight from Remotion's own
`onProgress` callback in `renderMedia()` — **nothing is synthesized**.
Verified this session: 5,589 real progress events captured for one render,
monotonically increasing, frame counts matching the final `framesRendered:
5555` exactly.

**One documented UX caveat, worth repeating in any future UI:** each of the
3 concurrent render workers pays a one-time audio-decode cost before its
first frame lands, so `progress` can sit near 0% for some seconds at the
very start even though work is genuinely happening. A UI should show the
`status`/log phase (`"preparing"` → `"rendering"`) during this window rather
than implying the bar is stuck.

---

## 20. Cancellation / Process Lifecycle

**Cancel flow:** `renderManager.cancelRender(jobId)` →
- If job is `queued`: removed from the queue array, immediately marked
  `cancelled`. No process was ever spawned.
- If job is `preparing`/`rendering`: sends `{type:"cancel"}` over IPC to the
  worker. The worker calls Remotion's `cancel()` (from `makeCancelSignal()`),
  which lets `renderMedia()` abort and clean up Chromium properly. A 20-second
  grace timer (`CANCEL_GRACE_MS`) then `SIGKILL`s the process if it hasn't
  exited on its own.
- Previously completed renders (`out/<slug>.mp4`) are never touched by a
  cancel — verified: cancelled a render for `ghetto-geek` while a prior
  completed `out/ghetto-geek.mp4` existed; the file was untouched afterward.

**Server shutdown** (`server/index.mts`, `SIGINT`/`SIGTERM` handlers):
1. `server.close()` — stop accepting new HTTP connections.
2. `renderManager.shutdown()` — cancel queued jobs synchronously, send
   `cancel` to any active worker, wait up to 20s for it to exit gracefully
   before `SIGKILL`.
3. `server.closeAllConnections()` — also terminates open SSE streams.
4. `process.exit(0)`.

Verified both idle and **mid-render** in this session: clean exit code 0,
zero orphaned worker or Chromium processes afterward (only the pre-existing,
unrelated 19-hour-old orphans remained — see §11).

**Known limitation, honestly stated:** cancellation relies on
`renderMedia()`'s own `cancelSignal` cooperating (a documented, standard
Remotion API) and on the 20s grace window being sufficient. If a future
Remotion version's cancel path hangs, the `SIGKILL` fallback still fires —
but a `SIGKILL`'d Chromium *can* in principle leave grandchild processes
behind if Remotion's own process-tree handling changes. Not observed in
testing, but not something this project's code can fully guarantee beyond
what `@remotion/renderer` itself provides.

---

## 21. Error Model

Single error class, `TrackError` (`src/domain/tracks/errors.ts`), carrying
a `code: TrackErrorCode`, `message`, and optional `path`. Every service
function throws this (or lets a genuinely unexpected error propagate, which
the CLI/`cli.ts`'s `runCli()` and the server's `sendErrorForException`
both catch and print/report as "unexpected", never as a bare stack trace
alone — always with a friendly message plus the stack as `details`).

HTTP status mapping (`server/http/errors.ts`, `STATUS_BY_CODE` — this is the
literal current map, all 16 codes covered, none fall through to the `?? 500`
default):

```
404: TRACK_NOT_FOUND, RENDER_JOB_NOT_FOUND
409: TRACK_ALREADY_EXISTS, RENDER_NOT_CANCELLABLE
400: INVALID_TRACK_NAME, INVALID_SLUG, INVALID_REQUEST, COVER_MISSING,
     AUDIO_MISSING, METADATA_MISSING, METADATA_INVALID, ANALYSIS_STALE
500: METADATA_WRITE_FAILED, FFMPEG_NOT_FOUND, ANALYSIS_GENERATION_FAILED,
     RENDER_FAILED
```

---

## 22. Filesystem Safety

- **Slug validation is the only gate, and it's applied everywhere a slug
  crosses a trust boundary.** `assertValidSlug` (regex
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`) is called in `updateTrackMetadata`,
  `renderManager.startRender`, and every route handler that takes a `:slug`
  param, before any path is built. Verified: `../../../etc` as a slug
  returns `400 INVALID_SLUG` and never reaches `fs`.
- **No arbitrary paths accepted anywhere.** Every filesystem path the server
  touches is built from `trackLocations(slug)`
  (`services/tracks/trackLocations.ts`), which always joins under
  `PUBLIC_DIR`/`OUT_DIR`, both derived from `import.meta.url`, never from
  request input directly.
- **Atomic metadata writes.** `updateTrackMetadata` writes to
  `<file>.tmp-<pid>` then `rename()`s over the real file — verified this
  session that 3 different invalid PATCH bodies left `metadata.json`
  byte-identical to its pre-request state, with no leftover temp files.
- **Bound to `127.0.0.1` only**, never `0.0.0.0` — verified in
  `server/index.mts`.
- **Request bodies capped at 256KB** (`server/http/json.ts`) — irrelevant
  once uploads exist; will need a completely different (streaming) approach
  for those (§29).

---

## 23. Current Known Limitations

Numbered for easy reference from Phase 2C planning.

1. **No file uploads.** Confirmed by reading every route handler — there is
   no multipart parsing, no streaming write, nothing. A track's `cover.png`
   and `beat.wav` currently only get onto disk by the user manually copying
   files into `public/tracks/<slug>/` (the CLI/API workflow assumes this).
2. **No filesystem watching.** The API re-reads the filesystem on every
   request (this is intentional — filesystem is the source of truth, see
   §13 of the original brief / this doc's design throughout), but a UI has
   no way to be told "a file changed" without polling `GET /api/tracks` or
   `GET /api/tracks/:slug` itself.
3. **No optimistic-concurrency guard on metadata writes.** The write is
   atomic (won't corrupt the file), but `updateTrackMetadata` does a plain
   read-modify-write with no mtime precondition — a concurrent external
   edit (e.g. someone editing `metadata.json` in a text editor at the same
   moment) could be silently overwritten by an API PATCH. Low risk for a
   single local user, but worth knowing.
4. **Bundle is not cached across renders.** Each render pays a fresh
   `bundle()` call (~5–10s). Deferred by explicit decision (§11), not an
   oversight.
5. **Only one render job globally, and no persistence of job history across
   server restarts.** All job state lives in an in-memory `Map` in
   `RenderManager` — restarting the server loses all job history (completed
   renders on disk are unaffected; only the *job records* are lost).
6. **`GET /api/renders` has no pagination or cap on how long job history
   accumulates in memory** within a single server run (each job object is
   small — id/status/≤200 log lines — so this is unlikely to matter in
   practice for a single-user local tool, but noting it for completeness).

### 23a. Discrepancies found between the original brief and the actual repo

The task that produced this document included a detailed historical/context
brief. Cross-checking that brief against the live repository surfaced a few
differences, noted here rather than silently "corrected" in place:

- **No GitHub remote is configured for this project's repo.** `git remote
  -v` in `~/Documents/j0ai-video-tools` returns nothing. The brief mentions
  GitHub CLI auth and a *different*, separately cloned repo
  (`toshi-website`) as the source of brand assets — that repo does exist as
  a sibling directory and `gh auth status` does confirm the
  `joeymacintosh11-cloud` login — but **this project's own repo has never
  been pushed anywhere.** See §34.
- **Body/UI typography.** The brief's brand direction mentions
  Inter/Manrope for body/UI text. The actual code uses **Oswald** for all
  label/UI text (`src/BeatVisualizer/theme.ts`) — Inter/Manrope are not
  imported anywhere. Not a bug, just worth knowing if brand guidelines are
  consulted again later.
- **Endpoint list.** The brief's endpoint list was very close to accurate
  but incomplete versus the real router — actual total is **14 routes**
  across health/tracks/renders (the brief didn't mention `GET
  /api/tracks/:slug/preview`, `GET /api/renders`, or `GET
  /api/renders/:jobId/logs` explicitly, though it gestured at "possibly a
  logs endpoint"). §17 above is the verified, complete list.
- Everything else in the brief (track contract, CLI commands, palette,
  concurrency=3, analysis.wav format, render timing improvement, SSE choice
  over WebSockets, single-render-at-a-time, no-database/no-auth/local-only
  constraints) **matches the live repository exactly** as verified in this
  session.

### 23b. Stray files (not modified, per this task's instructions — flagged for a future cleanup decision)

- `public/Ghetto Geek.wav` — 49MB, unreferenced, predates the track-folder
  system (§8b).
- `public/toshi-brandguide.png` — unreferenced design reference sheet
  (harmless to keep, but worth knowing it's not "live" in any code path).

Neither is gitignored, so both would be committed if `git add -A` is run
carelessly. Recommend deciding explicitly (delete vs. keep vs. gitignore)
before the first real commit — see §34.

---

## 24. Important Technical Decisions (with rationale, so Phase 2C doesn't accidentally re-litigate or violate them)

1. **`services/` lives outside `src/`, not inside it.** Prevents Node-only
   code from ever entering the Remotion browser bundle via an accidental
   import chain. This was identified as a risk *before* it became a bug.
2. **`staticFile()` is called inside the React component, never in
   Node/services.** Fixes a real bug found and fixed in Phase 2B (silent
   404s from resolving paths too early). See §9.
3. **`renderTrackVideo` is the single call site for `renderMedia()`.** CLI
   and API worker both call it — proven (not assumed) to produce identical
   video output (§11).
4. **SSE, not WebSockets.** Progress is one-directional (server→client);
   SSE needed zero new dependencies (`node:http` alone) versus a WebSocket
   library.
5. **`child_process.fork()`, not worker_threads or a separate long-lived
   render service.** Isolates a Chromium crash/hang from taking the API
   server down, makes cancellation a real OS-level operation, and required
   zero new dependencies (verified `.mts` + `fork()` + IPC works natively
   before committing to this design).
6. **Single global render slot.** 16GB RAM budget; a render already uses 3
   Chromium tabs.
7. **No ORM/database.** Filesystem (specifically `metadata.json` per track)
   is the single source of truth. The API is a read-through/write-through
   layer over it, not a cache with its own state to keep in sync.
8. **Path building has exactly one owner per layer**
   (`src/domain/tracks/paths.ts` for relative paths,
   `services/tracks/trackLocations.ts` for absolute ones) — no other file
   hand-builds a `tracks/${slug}/...` string.
9. **`compositionConfig.ts` centralizes width/height/fps/id** — added in
   Phase 2B specifically because the server's `/preview` endpoint would
   otherwise have been a *third* place hardcoding `1920`/`1080`/`30`.

---

## 25. Things That Must Not Change (carried forward verbatim as hard constraints)

- `ToshiBeatVisualizer` composition ID, its visual design, and its current
  polish state (§9a).
- The waveform's current appearance and behavior (reads `analysis.wav` when
  available, falls back to `beat.wav`).
- Real brand assets in `public/brand/toshi/` as the source of truth (never
  regenerate/crop a substitute).
- Dynamic duration calculation (`calculateBeatVisualizerMetadata`, reads
  `beat.wav` via the browser's `getAudioDurationInSeconds`).
- **`beat.wav` is always the final rendered audio.** `analysis.wav` is
  never wired into `<Audio>` or duration calculation.
- The `analysis.wav` optimization itself (mono/16-bit/22.05kHz, mtime-gated
  regeneration).
- `concurrency: 3` in `renderTrackVideo` — don't raise without re-measuring
  memory headroom on this specific 16GB machine.
- The track contract (`cover.png`/`beat.wav`/`metadata.json`/`analysis.wav`
  under `public/tracks/<slug>/`).
- All four CLI commands, their names, args, and output-to-stdout behavior.
- `out/<slug>.mp4` output naming.
- Filesystem-as-source-of-truth (no database layer).
- Local-only architecture (127.0.0.1, no auth, no cloud).
- SSE for render progress (not WebSockets).
- The cancellation design (graceful IPC signal → grace period → SIGKILL).
- The structured error model (`TrackError`/`TrackErrorCode`) and its HTTP
  status mapping.
- Track folder slugs never change when `title` is edited.

---

## 26. Phase 2C Goals (frontend, not yet started — confirmed nothing exists)

Per the original product brief, a local UI that supports:

1. **Track browser** — list from `GET /api/tracks`, show status badges
   (cover/audio/metadata/analysis/render presence — all fields already exist
   in `TrackSummaryView`).
2. **Track detail** — `GET /api/tracks/:slug` already returns everything
   needed: metadata, per-asset paths, validation result, render presence +
   output path.
3. **Metadata editing** — `PATCH /api/tracks/:slug/metadata` already exists
   and is fully validated/atomic. Slug must never be edited or derived from
   title changes in the UI.
4. **New track creation with uploads** — `POST /api/tracks` (title only)
   already exists. **Cover/beat upload endpoints do not exist yet** and are
   Phase 2C-A's responsibility to add (see §29 for the open question on
   how).
5. **Prepare button** — `POST /api/tracks/:slug/prepare` already exists,
   returns everything needed for a status display.
6. **Preview** — `GET /api/tracks/:slug/preview` already exists and returns
   `inputProps` shaped exactly for `<Player inputProps={...}>` from
   `@remotion/player` (not yet a project dependency — needs adding). Must
   work for *any* track, never hardcode `ghetto-geek` (the API itself
   already has no hardcoding here — this constraint is really about the
   frontend not baking in assumptions).
7. **Render + progress + cancel** — `POST /api/tracks/:slug/render`, SSE at
   `GET /api/renders/:jobId/events`, `POST /api/renders/:jobId/cancel` all
   exist and were verified working end-to-end in this session.
8. **Logs panel** — `GET /api/renders/:jobId/logs` exists; also arrives live
   via the `log` SSE event.
9. **Reveal output** — `outputPath` (absolute) is already returned by both
   `GET /api/tracks/:slug` (`render.outputPath`) and `RenderJobView`
   (`outputPath`). **No "reveal in Finder" endpoint exists yet** — Phase
   2C-A needs to add one (likely `child_process.execFile("open", ["-R",
   path])` on macOS, gated by the same slug/path-safety approach used
   elsewhere — never accept an arbitrary path from the client, only ever
   use the path the server itself computed).

---

## 27. Phase 2C-A Recommended Architecture (not yet built)

The original brief suggests splitting Phase 2C into 2C-A (architecture/
integration, higher-effort model) and 2C-B (visual polish, lower-effort
model). This handoff does not prescribe a specific frontend framework choice
beyond what's implied by the API already being framework-agnostic JSON+SSE
— that decision is explicitly left open for whoever starts Phase 2C-A (see
§29). What *is* fixed by the existing API design:

- The frontend **must not** re-implement validation, path-building, slug
  rules, or any domain logic already in `src/domain/`/`services/` — it
  calls the API and renders what comes back.
- State management: no heavy library needed unless the next session finds a
  concrete reason. The filesystem/API is authoritative; after any mutating
  call (`POST`/`PATCH`), re-fetch the affected track rather than trusting
  client-side optimistic state.
- SSE client: standard `EventSource`, listening for the 6 named events
  (§19). No polling needed while a job is active; polling `GET
  /api/renders/:jobId` is a reasonable fallback if SSE is unavailable.
- Preview: `@remotion/player` (not yet installed — check current pinned
  version against the rest of `@remotion/*` at `4.0.525` before adding) fed
  by `GET /api/tracks/:slug/preview`'s `inputProps` + `durationInFrames` +
  `composition` fields directly.
- Uploads: needs new server-side work first (§29) — this is not purely a
  frontend task.

---

## 28. Phase 2C-B Styling Direction (not yet relevant until 2C-A produces a working UI to style)

Internal creative production tool aesthetic — dark, compact, tactile,
branded. Explicitly **not** generic SaaS/admin-panel/glassmorphism/enterprise
-analytics look. Use the existing palette (§6) and the existing visualizer's
own treatment (gold accent borders, stat-chip pattern, grain/vignette
texture) as the design language reference — the visualizer itself is the
best existing example of "what Toshi software should feel like." Prioritize
workflow clarity over decoration.

---

## 29. Open Questions / Decisions Needing Explicit Approval Before Phase 2C-A Code Is Written

These were identified while writing this handoff and are **not yet
decided** — flag them to the user, don't just pick one silently:

1. **Frontend framework/tooling choice.** Nothing in the repo commits to
   React+Vite vs. anything else. The brief's product mockup and the
   existing `@remotion/player` dependency (React-based) both point toward
   React, but the build tooling (Vite? something else?) is undecided and
   would add the *first* new dependencies of the whole project so far.
2. **Upload mechanism.** Needs a real decision: multipart form parsing (new
   dependency, or hand-rolled), raw binary `PUT` with filename in a header/
   query param (zero new dependencies, simpler), or something else. Also:
   max file size, whether to stream-to-disk vs. buffer in memory (the brief
   explicitly warns against reading full WAVs into memory).
3. **"Reveal output" implementation.** `open -R <path>` via
   `child_process.execFile` is the obvious macOS-only choice, but should be
   confirmed as in-scope (it's a step outside the pure API/render domain
   this project has stuck to so far).
4. **Optimistic concurrency on metadata writes** (§23 item 3) — worth fixing
   now (cheap: add an `If-Match`-style version check) or acceptable risk for
   a single local user?
5. **What happens to the two stray files** (§23b) — delete, keep, or
   gitignore?
6. **Git remote / first push** (§0, §34) — needs the user's explicit
   go-ahead before anything is pushed anywhere, per this project's own
   "confirm before actions with real-world side effects" norm.

---

## 30. Exact Recommended Next Steps

1. **Commit and back up the current state** (§34) — before any Phase 2C
   code is written. This is the single highest-priority action.
2. Resolve open question §29.6 (remote/push) with the user.
3. Resolve open question §29.1 (frontend tooling) with the user — this gates
   everything else in Phase 2C-A.
4. Resolve open question §29.2 (upload mechanism) — needed before "create
   track with cover/beat" can be built.
5. Build Phase 2C-A read-only first (track list + detail + preview), since
   every endpoint needed for that already exists and works — this gets a
   visibly working UI fastest with zero new backend risk.
6. Add upload endpoints + wire up "new track" creation flow.
7. Wire up render start + SSE progress + cancel (all backend pieces already
   proven working).
8. Add "reveal output" endpoint + button.
9. Hand off to Phase 2C-B for styling once the above is functionally
   complete, per the model-split recommendation in the original brief.

---

## 31. Verification Checklist for a New Session

Run these before writing any Phase 2C code, to confirm the repo matches
this document (all commands run from `~/Documents/j0ai-video-tools/remotion`):

```console
# 1. Toolchain
node --version && npm --version && ffmpeg -version | head -1

# 2. Install (only if node_modules is missing/stale)
npm i

# 3. Static checks
npm run lint          # eslint + tsc, must be clean

# 4. CLI still works
npm run validate-track -- ghetto-geek

# 5. API still works (run in background/another terminal)
npm run server
curl http://127.0.0.1:4600/api/health
curl http://127.0.0.1:4600/api/tracks
curl http://127.0.0.1:4600/api/tracks/ghetto-geek
curl http://127.0.0.1:4600/api/tracks/ghetto-geek/preview

# 6. Confirm git state matches §0/§34
cd .. && git status
```

If any of these fail or disagree with this document, **trust the repo, not
this document** — it may have drifted since this was written.

---

## 32. Key Commands

```console
# CLI (from remotion/)
npm run new-track -- "Track Name"
npm run prepare-track -- <slug>
npm run validate-track -- <slug>
npm run render-track -- <slug>
npm run render-track -- <slug> --validate-only   # same as validate-track

# Local API server
npm run server                                    # binds 127.0.0.1:4600
TOSHI_API_PORT=5000 npm run server                # override port

# Quality
npm run lint                                      # eslint src scripts services server && tsc

# Remotion Studio (separate from the API server; binds 3000-range)
npm run dev
```

Full current `package.json` `scripts` block (verified live):

```json
{
  "dev": "remotion studio",
  "build": "remotion bundle",
  "upgrade": "remotion upgrade",
  "lint": "eslint src scripts services server && tsc",
  "server": "node server/index.mts",
  "new-track": "node scripts/new-track.mts",
  "prepare-track": "node scripts/prepare-track.mts",
  "validate-track": "node scripts/render-track.mts --validate-only",
  "render-track": "node scripts/render-track.mts"
}
```

---

## 33. Key Paths

```
~/Documents/j0ai-video-tools                      parent git repo root
~/Documents/j0ai-video-tools/remotion             THE project (this document's subject)
~/Documents/toshi-website                         sibling repo, source of brand assets (not part of this codebase)

remotion/public/tracks/ghetto-geek/                the only existing track
remotion/public/brand/toshi/                       shared brand assets
remotion/out/ghetto-geek.mp4                       last render output (gitignored)

remotion/src/BeatVisualizer/BeatVisualizer.tsx      the composition — visual source of truth
remotion/src/domain/tracks/paths.ts                 public/-relative path builder — single source of truth
remotion/services/tracks/trackLocations.ts          absolute-path resolver
remotion/services/render/renderTrackVideo.ts        the one renderMedia() call site
remotion/server/services/renderManager.ts           render job orchestration
remotion/server/app.ts                              API router
remotion/scripts/render-track.mts                   CLI render entry point
remotion/README.md                                  user-facing docs, kept current through Phase 2B
```

---

## 34. Git / Commit Recommendation

**Current state (verified this session):**

```
$ cd ~/Documents/j0ai-video-tools && git status
On branch main
Untracked files:
  (use "git add <file>..." to include in what will be committed)
	remotion/

nothing added to commit but untracked files present (use "git add" to track)

$ git log --oneline --all
9385543 Create new Remotion video

$ git remote -v
(empty — no remote configured)
```

The single existing commit tracks only a dead, empty `create-video`
scaffold at the parent repo root (`src/Composition.tsx` there is the
`MyComp`/`MyComponent` placeholder, nothing like the real project). The
entire `remotion/` directory — everything described in this document — has
never been committed.

**Recommended sequence** (do not execute without the user's explicit
go-ahead, per this project's own working norms around actions with
real-world side effects — but this is what should happen):

```console
cd ~/Documents/j0ai-video-tools

# Decide first: keep the dead root scaffold, or remove it? (recommend removing
# it in its own commit, separate from adding the real project, so history stays
# legible)

git add remotion/
git status   # review carefully — confirm out/, node_modules/, analysis.wav are excluded per .gitignore

git commit -m "Add Toshi Beat Visualizer: composition, track system, CLI, and local API

Phases completed: visualizer composition and brand polish, track contract
and CLI (new-track/prepare-track/validate-track/render-track), Phase 2A
shared domain/service extraction, Phase 2B local HTTP API with async render
jobs, SSE progress, and cancellation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

# Only if/when the user confirms a remote should exist:
# gh repo create ... (or push to an existing empty remote)
# git push -u origin main
```

Before that `git add`, double check `.gitignore` is doing what's expected
(verified live, current content):

```
node_modules
dist
.DS_Store
.env
out
public/tracks/*/analysis.wav
```

This correctly excludes `out/ghetto-geek.mp4` and the regenerable
`analysis.wav`, but does **not** exclude the two stray files from §23b
(`public/Ghetto Geek.wav`, `public/toshi-brandguide.png`) — resolve §29.5
before committing, or they'll be included.

---

## 35. Current State — Multi-Format Export and the Batch Render Queue

Written after the feature set that followed the hardening pass. Everything here
was verified against the live repository and by rendering.

### 35.1 Export formats

`src/domain/video/renderPresets.ts` is the single definition of what the tool
can export. It is pure and browser-safe, so the composition, the render
service, the API, the CLI and the UI all read the same numbers.

| id | label | size | fps | aspect | layout |
|---|---|---|---|---|---|
| `youtube-16x9` | YouTube Landscape | 1920×1080 | 30 | 16:9 | landscape |
| `vertical-9x16` | Reels / Shorts | 1080×1920 | 30 | 9:16 | portrait |
| `square-1x1` | Square | 1080×1080 | 30 | 1:1 | square |

`youtube-16x9` is the default, so anything that does not name a format behaves
exactly as it did before presets existed. `compositionConfig.ts` now derives its
width, height and fps from that default rather than repeating them.

**One composition covers every format.** `calculateBeatVisualizerMetadata`
returns `width` and `height` alongside `durationInFrames`, taken from the
`presetId` carried in the props — so `selectComposition` with a different preset
yields that format's canvas. There is no second registration and no duplicated
visualizer. Do not add one.

Layout is chosen by the preset's **shape**, not its id (`LAYOUTS` in
`src/BeatVisualizer/layouts.ts`), so a fourth 9:16 format would reuse the
portrait arrangement for free. `landscape` keeps cover and copy side by side
with the waveform beneath; `portrait` and `square` share one centred column —
logo, cover, title, metadata, waveform. Nothing is cropped or letterboxed from
the landscape design. `TrackInfo` takes its type sizes as a prop, defaulting to
the landscape values.

**16:9 is byte-identical and must stay that way.** The landscape numbers are the
composition's original literals and the landscape branch is the original markup.
Verified twice: frame 900 rendered from before and after the change hashed the
same (`0ceb655d8be1a4ffdc206fe4db93df0a`), and the full render's decoded video
stream is still `094c36432da2eb824791209145adbf6d` — the same value recorded in
§11. **Re-check that hash after any composition change.**

### 35.2 Output paths

```
out/<slug>/<preset-id>.mp4      e.g. out/ghetto-geek/vertical-9x16.mp4
```

A folder per track, a file per format. `outputRelativePath()` and
`trackOutputLocation()` own this; nothing hand-builds it.

The pre-preset path `out/<slug>.mp4` is **still read** — an older render is
found and reported rather than vanishing from the UI — but nothing writes there
and no file at that path is ever modified or deleted. `TrackInspection` reports
`renderedPresets` and `legacyOutputExists`; `TrackDetailView.render` carries a
per-format `outputs` array plus `legacyPresent`, with the older
`outputLabel`/`outputPath` fields kept pointing at the default format for
callers that predate this.

### 35.3 Batch render queue

`RenderManager` now tracks batches beside jobs. A job carries a `presetId` and a
`batchId` (null for a single render).

Execution is unchanged where it matters: **one render at a time**, FIFO, one
forked worker each. Do not raise this — a render already uses three Chromium
tabs and 16 GB is the binding constraint.

- **Deduplication is per track *and* format.** The three formats of one track
  queue happily; a second request for a pair already queued or running is
  refused (`RENDER_ALREADY_ACTIVE`, 409) for a single render, and *skipped* for
  a batch, with the skipped pairs returned. Duplicates inside one request are
  collapsed the same way.
- **Order is deterministic** — targets keep the order given.
- **Validation happens before anything is queued**, so a bad slug or preset
  cannot leave a half-created batch.
- **Aggregate numbers are derived, never stored**: counts per status, plus the
  mean of the jobs' real progress with a completed job counting as 1. A failed
  or cancelled job keeps the progress it reached, so a batch containing one
  settles below 100%. That is deliberate — the counts alongside explain it.
  Nothing is synthesized.
- A failed or cancelled job does not stop the batch; the next one starts.
- Cancelling a batch cancels only its own unsettled jobs.

Batches live in memory, so a server restart forgets them (the rendered files do
not care). A client that loses track re-reads `GET /api/render-batches`.

### 35.4 New endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/render-batches` | Queue `{"targets":[{"slug","preset"}]}`; max 50 |
| GET | `/api/render-batches` | All batches, newest first |
| GET | `/api/render-batches/:batchId` | Aggregate + member jobs |
| GET | `/api/render-batches/:batchId/events` | Live aggregate (SSE) |
| POST | `/api/render-batches/:batchId/cancel` | Cancel its unsettled jobs |

`POST /api/tracks/:slug/render` and `/reveal` now accept an optional
`{"preset":"..."}` body; an empty body still means 16:9.

New error codes: `INVALID_PRESET` (400), `RENDER_BATCH_NOT_FOUND` (404).
Still SSE, still no WebSockets.

### 35.5 CLI

```console
npm run render-track -- <slug>                          # 16:9, as always
npm run render-track -- <slug> --preset vertical-9x16
npm run render-track -- <slug> --all-formats
npm run render-all-formats -- <slug>
```

Existing invocations are unchanged apart from the output path. `--all-formats`
renders sequentially and reuses the analysis audio prepared once.

### 35.6 UI

The toolbar holds one format selection, shared by the single-track button and
by batching, so there is one answer on screen to "what am I exporting". At least
one format stays selected.

With 16:9 alone selected, Render starts a single job exactly as before —
**the single-track workflow is intact and nobody is forced to batch.** Selecting
more formats turns the same button into a batch. Track rows gained a checkbox
that is purely additive: clicking a row still opens it; ticking several and
pressing "Add to render queue" queues every ticked track × every ticked format.

The queue drawer only exists while a batch is being followed, so the layout is
otherwise untouched. It subscribes to the batch SSE stream rather than counting
anything itself. Preview follows the selected format, taking dimensions from the
shared preset module rather than a request per format.

### 35.7 Audio and performance

Unchanged and verified, not assumed:

- `beat.wav` is the final audio in **every** format — all three renders measured
  the same mean volume (−20.5 dB).
- `analysis.wav` is waveform-only, and is **not regenerated per format**:
  `prepareTrack` is per track and mtime-gated, so the second and third formats
  reuse it. Verified — its mtime was unchanged across a three-format batch and
  all three jobs logged "already up to date".
- Duration is identical across formats (185.216s, 5555 frames each).
- `concurrency: 3` inside one render is unchanged.

Timings on the M5/16 GB machine, three formats back to back in one batch:
16:9 ≈ 185s, 9:16 and 1:1 similar; the whole batch finished a little over 9
minutes. 9:16 is by far the largest file (195 MB vs 81 MB for 16:9) because a
1080×1920 canvas carries more moving detail.

### 35.8 Tests

`npm test` is now **55 tests** (`node --test`, no new dependency), adding:

- **presets**: every preset's shape has layout numbers behind it; the declared
  canvases; `compositionConfig` not drifting from the default preset; unknown
  ids rejected as `INVALID_PRESET` with the options named; an absent preset
  resolving to the default; per-format output paths distinct; the legacy path
  still expressible and distinct; duration agreeing across formats.
- **batches**: deterministic order with one active; repeated and already-running
  pairs skipped; an invalid target rejecting the request without queueing
  anything; an empty batch refused; a failed or cancelled job letting the next
  start; batch cancellation leaving unrelated renders alone; aggregate progress
  a real mean that settles below 100% after a failure; subscribers silent after
  unsubscribing; unknown batch ids reported; a preset-less single render
  reporting the default.

The fork harness lives in `tests/managerHarness.mts`, shared by both manager
test files.

### 35.9 Known limitations

1. **Batch and job history are in memory.** A server restart forgets them.
2. **A failed job leaves the batch below 100%** by design; read the counts.
3. **A `SIGKILL`'d render can orphan Chromium.** Observed while testing: killing
   a `render-track` process left 14 `chrome-headless-shell` processes, cleaned up
   by hand. The app's own cancel and shutdown paths do not do this — only an
   abrupt external kill. If you ever kill a render rudely, check `pgrep -f
   chrome-headless-shell`. Completed outputs survive it (Remotion only moves the
   file into place at the end).
4. **No cross-track batch progress persistence**, no retry of a failed job, and
   no reordering of a queued batch. All deliberate omissions, not oversights.
5. `GET /api/renders` and `/api/render-batches` are still uncapped in memory.
6. Portrait and square have only been eyeballed with one cover and one title
   length. A very long title will wrap differently; `titleMaxWidth` per layout
   is the dial.

### 35.10 Recommended next step — **delivered, see §36**

The "export everything that's missing" action recommended here has been built.
§36 is the current state; the limitations in §35.9 are superseded by §36.7.

---

## 36. Current State — Export What's Missing

The newest layer. Read this after §35; where the two disagree, this wins.

### 36.1 Export coverage — one definition of "exported"

`services/tracks/exportCoverage.ts` answers, per track and format: the output
path, whether it is rendered, its size and its modified time. `inspectTrack`
uses it, the API view uses it and the planner uses it, so the UI, the API and
the planner cannot drift apart on what counts as an export.

**The filesystem is the source of truth for finished exports — never the job
history**, which is in memory and forgotten on restart. A finished export whose
job record has been trimmed is still an export.

**Health check (Feature E), deliberately shallow:** a file that exists but has
**zero bytes** is the tell-tale of an interrupted or failed write, and is
reported as *not* rendered, so it will be produced again. Nothing is deleted;
the next render simply overwrites it.

Anything deeper — decoding the MP4, checking its duration or dimensions — would
mean opening every file on every listing. That is far too expensive for
browsing and is **documented rather than built**. If it is ever wanted, it
belongs behind an explicit "verify exports" action, not in the list.

### 36.2 The planner

`server/services/exportPlan.ts` → `planMissingExports({ slugs, presetIds })`
returns five lists:

| list | meaning |
|---|---|
| `missing` | no file, and nothing in flight — these need rendering |
| `skippedExisting` | the file is already on disk |
| `skippedQueued` | a render is already waiting |
| `skippedActive` | a render is running right now |
| `invalid` | the track cannot be rendered, with the reason |

Those three "skipped" reasons are kept apart because they need different
answers from a user. An unrenderable track is reported **once with its reason**
rather than producing one doomed job per format.

**Ordering is deterministic**: tracks keep the order asked for, formats always
take canonical preset order, and duplicate tracks and formats are collapsed. The
same request twice yields the same plan.

Queue state is an optional `inFlight` parameter. **Superseded in §37**: it no
longer defaults to the render manager, and the planner no longer imports it.

### 36.3 API

```
POST /api/export-missing
{ "tracks": ["ghetto-geek"], "presets": ["youtube-16x9"], "dryRun": true }
```

`presets` may be omitted to mean **every** format. **Superseded in §37**:
omitting it now means each track's own declared intent, which for a track that
declares nothing is still every format. The response carries `missing`,
`queued`, the three `skipped*` lists, `invalid`, `batchId` and `nothingToDo`.

Two details worth keeping:

- **`missing` and `queued` are different fields.** `missing` is what needs
  rendering and is filled in either way; `queued` is what was actually
  enqueued, so it is empty on a dry run. The first cut only had `queued`, which
  made a dry run report nothing missing when two exports were — the preview was
  useless. Do not merge them again.
- **Nothing missing is a successful no-op**: no batch is created, `batchId` is
  null and `nothingToDo` is true. An empty batch would just be noise.

It reuses `startBatch`, so queueing, dedup, SSE and cancellation are the
existing machinery.

### 36.4 UI

Per-format marks appear on every track row — a tick for a file on disk, and
distinct marks for queued, rendering and the zero-byte case, so a broken
leftover never reads as a finished export. The detail panel shows the same with
labels.

**"Export missing" is two steps.** The first click is a dry run, so the summary
shown (X missing, Y already rendered, Z queued, N invalid) is the server's own
plan rather than something assembled in the browser from stale state. Only the
confirm enqueues. With nothing missing it says *"All selected exports already
exist"* and offers no button.

One panel serves both the single track in the detail view and every ticked
track from the toolbar. **The existing single-render controls and "Add to
render queue" are untouched** — nobody is pushed into this path.

Per-format state lives on `TrackSummaryView.exports` (the detail view inherits
it), replacing the near-identical `render.outputs`. One shape for one fact.

### 36.5 Job history retention (Feature G)

Settled records are trimmed oldest first: **200 jobs, 50 batches**. Never
dropped: anything queued or running, and any job still belonging to a retained
batch — otherwise that batch could not list its members. Trimming runs only
when a job settles. Memory only; **no persistent storage was added**, and files
on disk are untouched.

### 36.6 Long titles (Feature F)

Rendering short, medium and long titles across all three formats found a real
bug: a 45-character title at the landscape base size wrapped onto four lines and
**pushed the waveform completely off the bottom of the 16:9 frame**.

Titles now step down in size once long enough to need it (`titleSizeSteps` per
layout in `layouts.ts`). **The first step is each layout's existing base size**,
so a title short enough to have always fitted is drawn exactly as before.
Portrait and square also lost some `titleMaxWidth`, which had equalled the full
content width and ran a wrapped title into the padding.

**Existing output is provably unchanged**: real Ghetto Geek props rendered at
frame 900 from before and after, in all three formats, are pixel-identical.
"Ghetto Geek" is 11 characters, so it takes the first step.

`titleSizeSteps` is the dial for this. Do not redesign the layouts for a long
title — adjust the steps.

### 36.7 Known limitations

1. Only the **zero-byte** health check exists. A truncated-but-non-empty MP4
   still counts as an export. Deeper validation is deferred by design (§36.1).
2. **Retention is in memory only.** A restart forgets all job and batch history;
   coverage is unaffected because it reads the disk.
3. Export planning **stats three files per track**, so a very large catalogue
   makes the track list slightly heavier. Negligible at this scale; if it ever
   matters, cache by directory mtime.
4. **No "re-export" action.** A finished export is never overwritten
   automatically, and there is deliberately no UI to force one — delete the file
   and render again.
5. Long titles were checked at three lengths with one cover. A title of extreme
   length still shrinks rather than truncating.
6. `GET /api/renders` and `/api/render-batches` remain unpaginated, now bounded.

### 36.8 Tests

`npm test` is **71 tests**, adding 16 for coverage, planning and retention —
listed in the commit message for `32e829b`. Two of them changed the code rather
than the reverse: the shared fixture writes metadata only (correctly invalid for
planning), and the planner's queue state became injectable so tests need not
fork render processes.

### 36.9 Verification performed

- Lint, tsc and 71 tests clean.
- `validate-track` and `prepare-track` exit 0.
- The live API checked across every path: all-exist no-op, a mixed request
  separating a 16-byte export, a 0-byte one, an absent one and a malformed
  track, and queue-then-immediately-re-ask reporting one active, one queued and
  one existing.
- The UI driven in a real browser for both the nothing-missing and
  three-missing cases.
- **16:9 output still hashes to `094c36432da2eb824791209145adbf6d`.**

No full render was needed this time: the render pipeline itself is unchanged,
and the only composition change was proven pixel-identical at frame level.

### 36.10 Recommended next step

**Per-track export presets.** Built — see §37, which supersedes parts of this
section (the planner's signature and the `/api/export-missing` contract both
changed).


---

## 37. Current State — Per-Track Export Presets and the Catalogue Workflow

The newest layer. Read this after §36; where the two disagree, this wins.

The workflow this completes: **new beat → choose its formats once → save →
Export missing → only the intended missing outputs are queued.**

### 37.1 The `exportPresets` metadata field

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

Optional, and written last. Every id is validated against
`src/domain/video/renderPresets.ts` — **there is no second list of format
strings anywhere**, in the metadata layer, the API, the planner, the CLI or the
UI. The helpers live with the registry itself:

| helper | job |
|---|---|
| `parseExportPresetList` | strict read; collects *every* problem, does not throw |
| `coerceExportPresetList` | best-effort read for prefilling an editor |
| `canonicalPresetOrder` | canonical order, duplicates dropped |
| `resolveExportPresets` | declared list, or every format when undeclared |

Rules, all enforced before anything is written:

- unknown id → `METADATA_INVALID` naming the ids that do exist
- repeated id → `METADATA_INVALID` (not silently collapsed)
- empty array → refused; leaving the field out is how you say "undeclared"
- not an array → refused
- saved in **canonical preset order**, so files do not churn on rewrite

### 37.2 Backwards compatibility — the decision that matters

**Absent `exportPresets` means every supported format.**

That is exactly what "export what's missing" meant before intent existed, so:

- every metadata.json already on disk stays valid, unchanged and correct;
- **nothing is migrated**, at startup or ever (Feature I);
- Ghetto Geek, which declares nothing, still resolves to all three formats.

The alternative — reading absent as "16:9 only" — was rejected: it would have
invented an intent the user never expressed *and* quietly narrowed what the
existing endpoint does.

Normalisation is opt-in and visible: a metadata PATCH writes the field **only
when it names it**, so editing a title cannot materialise an intent. The UI
form does send it, and shows the resolved formats ticked with a hint saying so,
which is how an undeclared track becomes declared — by someone looking at it.

### 37.3 Planning from intent

`planMissingExports({ slugs?, presetIds?, inFlight? })`:

| input | meaning |
|---|---|
| `slugs` omitted | **catalogue mode** — every track under `public/tracks/`, slug order |
| `slugs: []` | an error, never a catalogue |
| `presetIds` omitted/null | each track's own intent, resolved per track |
| `presetIds: [...]` | overrides intent for this request |

**Intent is never flattened.** A catalogue run where A ships 16:9 and B ships
16:9 + vertical plans `A/16:9`, `B/16:9`, `B/vertical` — not three formats for
both.

Returns the five lists from §36.2 plus `intendedTargets` (every pair intended,
in whatever state — the sum of `missing` and the three `skipped*`), `tracks`
and `catalogue`.

`inFlight` is now **always passed in** and defaults to empty; the planner does
not import the render manager at all. The API route supplies the live map; the
CLI, a separate process with no view of a running server's queue, supplies
nothing.

### 37.4 API

```
POST /api/export-missing
{ "tracks": ["ghetto-geek"], "dryRun": true }   # this track, its own formats
{ "catalogue": true, "dryRun": true }           # every track, each its own
{ "tracks": [...], "presets": ["square-1x1"] }  # override intent
```

- `tracks` and `catalogue` are **mutually exclusive**, and one is required.
  The catalogue has to be asked for outright, so a request that merely forgot
  its `tracks` array is a 400 rather than a catalogue-wide queue.
- `presets` omitted → per-track intent. Present → overrides it.
- Response adds `intendedTargets`, `tracks` and `catalogue` to the §36 shape.
- Nothing missing is still a **successful no-op**: no batch, `batchId: null`,
  `nothingToDo: true`.

`TrackSummaryView` gained `exportPresets` (the declared list, or `null` when
undeclared), and each `RenderOutputView` gained `intended`.

### 37.5 UI

- **Metadata editor** — an "Intended exports" row built from the shared preset
  list, saved through the existing conditional-write path. An undeclared track
  shows every format ticked and says it is not declared yet.
- **New track panel** and **`new-track --presets`** — formats chosen at
  creation, so no one has to hand-edit JSON. Default: `youtube-16x9`.
- **Intent is displayed apart from coverage** everywhere: the detail panel
  names the intended formats, and a format the track does not ship in is dimmed
  with its own mark (`◦`) in the track list, the export row and the file
  checklist. Marks: `✓` rendered, `●` rendering, `·` queued, `!` empty file,
  `—` intended but missing, `◦` not intended.
- **Export missing** (single track and ticked tracks) now uses intent rather
  than the toolbar formats. The toolbar still drives Render, preview and "Add
  to render queue". Explicit-format export-missing remains available on the API
  and CLI.
- **"Export missing for catalogue"** sits in the toolbar, always available,
  behind the same two-step dry run. Nothing missing reads "Catalogue is fully
  exported"; otherwise the summary is the server's own plan:
  `3 tracks · 7 intended exports · 3 already rendered · 4 missing`.

### 37.6 CLI

```bash
npm run render-missing -- <slug>              # that track's intended formats
npm run render-missing -- <slug> --dry-run    # plan only
npm run render-missing -- <slug> --preset square-1x1   # override
npm run render-catalogue-missing              # every track, each its own
npm run render-catalogue-missing -- --dry-run
npm run new-track -- "Title" --presets youtube-16x9,vertical-9x16
```

Both commands use **the same planner as the API** — no business logic is
duplicated in `scripts/`. Renders run one after another, as
`render-track --all-formats` already did; concurrency is unchanged. A track is
prepared once and its `analysis.wav` is reused by every format after it.

Every pre-existing command is untouched.

### 37.7 A bug this found

The metadata form never re-seeded after its **own** successful save, so the
refresh that followed arrived with a changed revision while the form was still
dirty — the exact shape of an external edit — and the user was warned of a
conflict with their own change, with the form stuck on "Unsaved changes".

Pre-existing: reproduced against `d66bca7` in a worktree before anything was
altered. Fixed by seeding from the write's own response, which is the
authoritative post-write state.

### 37.8 Limitations

- **A catalogue run inspects every track folder.** Fine at this scale
  (three `stat` calls per track); it has not been tested against hundreds.
- **The CLI cannot see a running server's queue**, so a render started in the
  app and one started with `render-missing` can overlap on the same target. The
  usage text says so. Use one or the other for a given track.
- **An unknown id in `exportPresets` makes the whole track invalid**, which is
  consistent with every other malformed field but means the UI form locks and
  the JSON has to be fixed by hand. The error names the valid ids.
- Intent does not affect **rendering** — `render-track` still renders whatever
  format it is asked for, intended or not. Intent decides what is *missing*,
  not what is *allowed*.
- The zero-byte health check from §36.1 is unchanged: a truncated but non-empty
  MP4 still counts as exported.

### 37.9 Verification performed

- Lint, tsc and **97 tests** clean; the full suite run 8 times consecutively.
- `validate-track`, `prepare-track` and `render-track` usage unchanged, exit 0.
- Per-track intent proven at planner, API and browser level: A/16:9 +
  B/16:9 + B/vertical, never flattened.
- The UI driven in a real browser: undeclared hint, intent marks, catalogue dry
  run, confirm button, a save that changes intent and lands on disk in
  canonical order.
- Optimistic concurrency re-checked with intent in the patch: fresh revision
  accepted, stale refused with `METADATA_CONFLICT`, invalid ids refused without
  touching the file.
- **`render-missing` proven end to end on a real render** — a synthesised
  3-second probe track declaring `square-1x1` produced a 1080×1080 MP4 with
  audio, and a second run was a no-op. The probe and its output were removed.
- **No full render of Ghetto Geek was needed**: `git diff --name-only d66bca7
  HEAD` shows **no composition or render-pipeline file changed at all**, so the
  16:9 reference output cannot have moved. Its hash remains
  `094c36432da2eb824791209145adbf6d`.

### 37.10 Recommended next step

**Export destinations / post-render delivery** — once a track knows which
formats it ships in, the missing half is where they go: a per-track or global
output folder (a synced Dropbox/Drive path, a dated release folder), so a
finished render lands where it is actually used instead of in `out/`. It reuses
coverage and the planner unchanged and needs no new concepts, only a
destination in metadata and a copy step after a successful render.

Not started.


## 38. Current State — Stale Export / Re-export Detection (2026-09-18)

**This section supersedes existence-only coverage and the “delete to re-export”
limitation in §36–37.** No composition, layout, presets, brand sources, final
audio routing or render concurrency changed. No dependencies were added.

### 38.1 Persisted contract

Each successful render writes alongside the existing format path:

```text
out/<slug>/<preset-id>.mp4
out/<slug>/<preset-id>.manifest.json
```

Manifest schema (the hashes below are illustrative placeholders):

```json
{
  "schemaVersion": 1,
  "slug": "ghetto-geek",
  "presetId": "youtube-16x9",
  "renderedAt": "2026-09-18T12:00:00.000Z",
  "inputFingerprint": "<sha256>",
  "inputs": {
    "metadata": "<sha256>",
    "cover": "<sha256>",
    "audio": "<sha256>",
    "preset": "<sha256>",
    "visualizer": "<sha256>"
  },
  "output": {"bytes": 12345, "mtimeMs": 1234567890, "ino": 12345}
}
```

`services/tracks/exportManifest.ts` owns hashing, manifest parsing and input
comparison. `src/domain/video/exportFreshness.ts` is browser-safe: version
constants, modes, freshness/reason types and user-facing reason labels.
`trackOutputLocation()` owns the manifest path as well as the MP4 path.

Schema version validates the persisted format. **`VISUALIZER_VERSION` currently
`toshi-1` is the explicit render/template version. Bump it whenever a meaningful
composition/layout/font/encoding change should invalidate old exports.** Restart
the API after changing render code or presets; it is not a hot-reloaded service.
UI-only styling, README edits and unrelated source files require no bump.

### 38.2 Fingerprinting and exact render inputs

- Metadata hash: title, artist, musical key, BPM, subtitle (absent and empty
  subtitle normalize together). Only values actually passed to the composition
  are used. `exportPresets` describes intent, not pixels, and is excluded.
- Cover and original beat: SHA-256 content hashes.
- Preset: id, width, height, fps, layout and aspect ratio. Label-only changes
  do not change the render fingerprint.
- Visualizer: explicit template version plus the content hashes of the two
  actual brand assets (logo and badge). Unused brand files are excluded.
- `analysis.wav` is derived, so is deliberately excluded. It remains the
  waveform source, while original `beat.wav` remains the audible source.

For **recording a render**, hash the copied assets under the Remotion bundle's
`public/`, not the live source directory at completion. Metadata comes from the
exact input props supplied to the render. Editing live track files while a
render runs therefore makes its eventual export stale instead of certifying
new inputs that were never rendered. The pinned bundler copies public files by
default; do not enable `symlinkPublicDir` without revisiting this assumption.

For **browsing**, source content hashes are cached in process by path + device,
inode, size, mtime and ctime. Cache is bounded at 256 file entries. File reads
use a 1 MiB buffer rather than loading a large WAV into RAM. Stats are checked
every time and before/after hashing; no database or persisted cache is added.
Missing/legacy outputs require no expensive source hashing. Inspection's old
presence flags remain cheap, separate from full freshness checks in views/plans.

Tradeoff: first reads (or cache eviction/restart/changed stats) hash synchronously
and can briefly occupy the API event loop. A very large catalogue exceeding the
cache may rehash across refreshes. This implementation targets the current small
local catalogue; benchmark before expanding it. It trusts normal filesystem stat
identity, not adversarial editing with perfectly restored metadata. MP4 integrity
is a size/mtime/inode check, not a full media decode or video content hash.

### 38.3 Coverage/status semantics

`trackExportCoverage` remains the one coverage service. Its presence fields are
backward-compatible, with additive `freshness` and `staleReasons`:

- `missing`: no nonempty regular MP4; includes zero-byte leftovers.
- `current`: a valid matching manifest, matching source inputs and matching
  output identity.
- `stale`: an MP4 exists but inputs changed, its manifest is absent/invalid, or
  its output identity changed externally.
- `invalid`: inputs cannot establish freshness; normal validation explains
  missing/invalid track data.

Typed reasons: `metadata_changed`, `cover_changed`, `audio_changed`,
`preset_changed`, `visualizer_changed`, `manifest_missing`, `manifest_invalid`,
`output_changed`. Multiple reasons are retained.

API `RenderOutputView` adds the same fields plus `status`: active/queued work
wins as `rendering`/`queued`, otherwise invalid track validation wins, otherwise
freshness. **`present` does not mean current.** `intended` remains independent.
History retention or a server restart cannot make a disk export disappear.

### 38.4 Legacy policy

No migration. Existing nonempty per-format MP4s without manifests are
`stale / manifest_missing`, remain revealable and are skipped by default
missing-only planning. Re-exporting explicitly creates the first manifest.
The older single-file `out/<slug>.mp4` is still displayed as an unverified
legacy file. It is not attributed to a preset and is never touched.
Ghetto Geek's existing exports were deliberately left unchanged during this work.

### 38.5 Replacement publication, failure and cancellation

`services/render/publishExport.ts` stages in a unique `.render-*` directory
inside the output directory. The shared `renderTrackVideo` sends Remotion there,
closes its browser, checks cancellation, verifies a nonempty regular MP4 and
writes a complete staged manifest. Only then does publication start.

Before the two atomic renames, hard links preserve the previous video/manifest
without copying their bytes. The short commit section is synchronous: a
cooperative cancellation cannot interrupt its two renames. If manifest rename
fails, the previous video is restored; its manifest has remained in place.
Staging is removed on success/failure/cancel. A rollback failure retains recovery
files and reports the directory instead of deleting the only recoverable copy.

**OS/process crashes are not a two-file transaction.** A crash between the two
renames can leave a new MP4 with an old manifest; output identity mismatch makes
that stale, never current. A `.render-*` directory may remain after a hard kill.
Do not auto-delete it: inspect `previous.mp4`/`previous.manifest.json` for manual
recovery, stop all writers, restore the pair if needed. No automatic cleanup of
unknown directories or source assets was added. This is not fsync/power-loss
transaction durability. Existing SIGKILL/Chromium limitations still apply.

`renderTrackVideo` is still the sole encoding call site for CLI and API. It now
cleans up its own completed bundle directory after the render. H.264, JPEG,
concurrency 3, dynamic audio duration, one browser and existing progress callbacks
are unchanged. The manager, worker IPC protocol and SSE layer did not change.

### 38.6 Planner/API extension

Same endpoint: `POST /api/export-missing`; no redundant endpoint introduced.

```json
{"catalogue":true,"mode":"missing-and-stale","dryRun":true}
```

Modes: `missing` (omitted default, old behavior), `stale`, `missing-and-stale`.
The planner adds `mode`, `current`, `stale`, `selected`. `missing` still reports
missing work; `selected` is the subset for this mode. `queued` is actual enqueue
results, always empty for a dry run. `skippedExisting` remains the compatibility
presence list (current or stale); never use it to count current exports.

Queue/active targets are skipped before disk freshness. Per-track intent and
explicit preset overrides work as before. Catalogue plans preserve each track's
own formats. Current outputs are never selected. Invalid tracks are reported
rather than queued. A final live queue check handles a second request arriving
while asynchronous inspection ran; concurrent requests cannot create duplicate
jobs or an empty no-op batch. No selected work -> `batchId:null` success.

Dry-run plans are not reservations: execution rereads disk/queue state. The mode
and scope are the explicit operation; a newly stale target in that scope can be
included when confirming. No persistent plan token/state layer was added.

### 38.7 UI and CLI

Existing export status/checklist components show current, stale with reasons,
missing, queued/rendering and invalid. The original Toshi CSS is retained with a
small stale-color/text addition. Existing panel now offers all three actions for
single tracks, selections and the catalogue. One plan summary lists new outputs
and replacements, explicitly says previous exports survive until success, then
one confirmation queues the batch. No dialogs per file.

```console
npm run render-missing -- ghetto-geek --mode stale --dry-run
npm run render-missing -- ghetto-geek --mode stale --replace
npm run render-catalogue-missing -- --mode missing-and-stale --dry-run
npm run render-catalogue-missing -- --mode missing-and-stale --replace
```

The CLI reuses the exact API planner. Replacement execution requires `--replace`
unless dry-running. Existing CLI invocations keep missing-only defaults;
`render-track` remains an explicit render and now writes manifests automatically.
No new package scripts or packages were necessary.

**Superseded in §39:** CLI and API now share a filesystem render-target lock,
so the same track/format can no longer be rendered by both at once. The rest of
this paragraph — single-slot UI renders, in-process publication locking — still
holds.

### 38.8 Verification and performance

- `npm run lint` (ESLint + TypeScript), 135 tests, and Vite production build pass.
  Vite still reports the existing >500 kB bundle advisory; no dependency was added.
- `validate-track -- ghetto-geek` and `prepare-track -- ghetto-geek` pass; analysis
  was already up to date. No source assets or existing MP4s were changed.
- 38 added tests: `tests/export-freshness.test.mts` and additions to API tests.
  Cover success/current, each rendered metadata field, cover/WAV mutations,
  analysis/unrelated/intent exclusions, preset/schema changes, absent/empty/
  legacy/corrupt/incompatible manifests, output identity, all planner modes,
  catalogue intent, active/queued dedup, failed/cancelled/empty replacements,
  publication rollback, input editing during render, cached reads and CLI consent.
- A disposable real three-second, 24-bit source probe rendered **90 square frames
  in 3.37 seconds**, wrote a matching current manifest, then had its replacement
  cancelled after frames began. Previous MP4 and manifest remained byte-identical;
  edited metadata was reported stale. Probe assets/output were removed afterward.
- Browser inspection confirmed visible stale/reason labels and all three actions
  on the existing responsive Toshi layout. Confirmation/execution semantics also
  exercised by API tests; no full Ghetto Geek render was triggered.
- Ghetto Geek's cold source fingerprint: **19.47 ms**. Mean of 100 warm source
  fingerprints: **0.017 ms**. Mean of 100 current catalogue plans (one real track,
  legacy outputs): **0.094 ms**. These are small-catalogue measurements, not a
  promise for hundreds of large tracks. Warm checks stat files, do not read WAVs.
- Final cleanup: no regression fixture directories, render workers or headless
  Chromium remained. Temporary verification API/Vite processes were stopped.
- Composition/layout/preset/audio-preprocessing/worker/manager files have no diff
  from `14190e7`. No intentional pixel/audio output change. Full-track timing and
  decoded-video hash were not rerun; prior reference remains historical evidence.

Commits for this milestone:

- `4bc1641` — manifest/fingerprint model, safe publication, coverage/planner/API
  foundation and 34 regression cases.
- `256a89a` — UI/CLI re-export workflow, API concurrency check and four more tests.
- Documentation follow-up: `Document export freshness, safe replacement and verification`.

All commits are local only. **Do not push without a new instruction.**

### 38.9 Recommended next major feature

**Export destinations / post-render delivery.** Built — see §39, along with the
cross-process render lock that closes the limitation noted in §38.7.


---

## 39. Current State — Cross-Process Render Locks and Local Delivery (2026-09-18)

**Supersedes §38.7's cross-process limitation.** No composition, layout,
presets, brand sources, final audio routing or render concurrency changed. No
dependencies were added.

### 39.1 Why a filesystem lock

The render manager dedupes jobs inside one server process, but the CLI is a
separate process with no view of that queue. A CLI render and an API render
could therefore both produce and publish the same `slug + presetId`. Publication
was atomic, so neither would see a torn file — but the loser's work was wasted
and which version survived was a race.

### 39.2 Lock mechanism

```text
out/.locks/<slug>__<preset-id>.lock
```

`services/render/renderLock.ts`. **Exclusivity is `openSync(file, "wx")` —
O_EXCL creation — and nothing else.** There is deliberately no "check, then
create": whoever creates the file owns the target. Metadata is written to that
same descriptor afterwards and is used only for reporting and recovery
decisions, so a truncated or hand-edited lock file can never admit two owners.

Lock contents: `schemaVersion`, `slug`, `presetId`, `pid`, `hostname`,
`createdAt`, `jobId` (null for a CLI render) and a random `token`.

Locks are **per target**. `ghetto-geek/square-1x1` says nothing about
`ghetto-geek/youtube-16x9`, so a batch rendering three formats of one track does
not serialize on the first, and there is no global render lock.

`out/` is gitignored, so lock files never reach git. Nothing enumerates `out/`,
so a dot-directory there is invisible to the rest of the app.

### 39.3 Lifecycle

Acquired inside **`renderTrackVideo`** — the one place both the CLI and the
render worker pass through. One acquisition therefore covers bundling,
composition resolution, rendering and publication, and a second process fails
fast instead of spending seconds on a bundle it will not be allowed to publish.
Released in a `finally`, so success, failure and cancellation all release.

The lock is held by the **worker process**, not the server, because the worker's
liveness is what matters for recovery. A SIGKILLed worker cannot release
anything; that is what stale recovery is for.

Release is **token-checked**: a lock is only removed if it is still the one this
handle created. Without that, an owner whose lock had already been reclaimed as
abandoned could come back and delete its successor's.

### 39.4 Stale-lock recovery policy

Deliberately one-sided, and the reasoning matters:

- **A dead PID on this machine** is the only thing that permits reclaiming.
- PID reuse can make a dead owner look **alive** — costing a stuck lock, which
  is recoverable by hand — but never make a live owner look **dead**, which
  would cost two renders publishing one file. The safe direction is the only one
  taken.
- `EPERM` from `kill(pid, 0)` counts as alive (the process exists, it is just
  not ours).
- A lock whose `hostname` differs is **never** reclaimed: PID liveness says
  nothing about another machine.
- A **malformed or unreadable** lock is never reclaimed either, for the same
  reason — we cannot tell whether something live is behind it.

Reclaiming is itself atomic: the stale lock is `rename`d aside and then removed,
so of several processes racing to reclaim, exactly one wins the rename and the
losers simply retry the creation.

For everything that cannot be proved dead there is an **explicit** path:

```console
npm run render-locks                                      # list
npm run render-locks -- --release <slug> <preset-id>      # clear one
```

It takes a slug and a format, **never a path**, so it can only remove a file
this module would have created. The listing marks which locks would be reclaimed
automatically and which need a decision.

### 39.5 Contention behaviour

| Caller | Behaviour |
|---|---|
| `POST /api/tracks/:slug/render` | **409 `RENDER_TARGET_LOCKED`**, naming the holding pid, host, job and start time. No job is queued. |
| `POST /api/render-batches` | The contended target is left out and returned in `locked`; every other target still queues. |
| `POST /api/export-missing` | Same, reported as `lockedElsewhere`. |
| CLI (`render-track`, `render-missing`) | `TrackError` → message plus exit 1. |

The manager's check before queueing is a **courtesy, not the authority** — it
exists so a request that cannot succeed is refused immediately rather than
starting a worker that fails. The authoritative acquisition is still inside the
render, which is why the advisory check being racy is harmless. This server's own
renders never appear in it: the worker child holds the lock, and in-memory
deduplication (`RENDER_ALREADY_ACTIVE`) has already rejected those. **In-memory
deduplication and the batch queue are unchanged**; the lock is an additional
layer, not a replacement.

### 39.6 Delivery: what it is and is not

Optional post-render copying to a local folder. A Movies folder, a release
folder, or a locally synced Dropbox or Drive folder — from here all of these are
ordinary directories. **No cloud SDK, no credentials, no upload, no watcher.**

`out/<slug>/<preset>.mp4` plus its manifest remains the source of truth:

- the canonical file is **never moved**;
- the destination copy is **never** consulted for freshness;
- a failed delivery leaves a successfully rendered export completely untouched.

**"Render: current, delivery: failed" is a real state** and is reported as one.

### 39.7 Configuration model

Split by what travels:

| Where | What | Why |
|---|---|---|
| `delivery.local.json` (gitignored) | `root` (absolute), `autoDeliver` | Machine-specific; an absolute path in git would leak one person's folder layout and break on any other machine |
| track `metadata.json` | `deliveryFolder` (portable folder name) | Travels with the track |

A track with no `deliveryFolder` delivers into a folder named after its slug. A
project with no configured root behaves **exactly** as before delivery existed,
and does no filesystem work for it.

The root is validated once, hard, when configured: a non-empty string, absolute,
existing, a directory, and **outside the project** (delivering into `out/` would
have the tool copying its own output back into its own input tree). It is stored
`realpath`-resolved, so later containment checks are made against the real
location. It is re-checked at delivery time too, because a synced or external
destination can vanish between the two.

### 39.8 Path safety

- **No endpoint accepts a destination path for an operation.** The root is
  configured once and stored; every delivery names tracks and formats and the
  server resolves where those go.
- `deliveryFolder` is the only user-authored text that reaches a path. It must be
  a single ordinary directory name: no separators, no leading or trailing dot, no
  control characters, none of `/ \ : * ? " < > |`, at most 80 characters.
- Slug and preset are validated by the existing guards.
- After all of that, the resolved destination is asserted to start with the
  resolved root — so no future change to any of those rules can turn this into an
  escape.
- Copying uses `fs.promises.copyFile` and `rename`. No shell, ever.

### 39.9 Destination layout

```text
<root>/<track folder>/<slug>-<preset-id>.mp4

Toshi Exports/
  Ghetto Geek/
    ghetto-geek-youtube-16x9.mp4
    ghetto-geek-vertical-9x16.mp4
```

Centralised in `src/domain/delivery/deliveryPaths.ts` (browser-safe), so the
server, the CLI and the UI all describe the same destination and no folder
naming is scattered across call sites. The folder is human-chosen because that
is the part someone browsing a synced folder reads; the filename stays canonical
kebab-case so a file still says what it is once it has been moved elsewhere, and
so nothing downstream has to quote it.

### 39.10 Atomic delivery

1. Only a **current** export is delivered. Copying a stale one would put content
   at the destination the tool already knows should be re-rendered.
2. The export's identity (manifest fingerprint, inode, size, mtime) is captured.
3. `mkdir -p` inside the trusted root, then `copyFile` to
   `.deliver-<uuid>.mp4.tmp` **inside the destination directory** (same
   filesystem, so the rename is atomic).
4. Freshness and identity are **re-read**. If the export changed underneath, the
   staged copy is discarded and the target is reported `source_changed`.
5. `rename` into place — the previous delivered file is replaced in one step and
   survives until then.
6. `stat` the published copy and write the receipt.
7. The staged file is removed on every path, so nothing partial is ever left.

**Racing with replacement publication** is handled by step 4 rather than by
holding the render lock across the copy. A `rename` into place swaps a directory
entry, so a read already in progress keeps the version it opened: the bytes
copied are always one coherent export, never a mixture. Delivery therefore holds
no render lock at all.

### 39.11 Delivery freshness and receipts

`out/<slug>/<preset>.delivery.json`, beside the canonical pair — **not** at the
destination, which may be a folder other people look at. Contents:
`schemaVersion`, `slug`, `presetId`, `sourceFingerprint` (the manifest's
`inputFingerprint` at delivery time), `destinationRoot`,
`destinationRelativePath`, `deliveredAt`, `bytes`, `mtimeMs`.

That is enough to answer both questions from a `stat`, with **no hashing of a
delivered video**: the fingerprint says whether the copy is of the current
export, and the size and mtime say whether it is still the copy we made.

Status, derived from disk on every read, in this order:

| Status | When |
|---|---|
| `not_configured` | no root set — delivery is off |
| `pending` | no receipt, or an unreadable one |
| `outdated` | root or folder changed; destination file missing or modified; canonical export not current; or the canonical export changed since delivery |
| `delivered` | the copy is of the current export and is still the copy we made |
| `failed` | **only ever reported by a delivery attempt**, never persisted |

`failed` is deliberately not stored: browsing re-derives everything from disk, so
a stale "failed" can never be shown as if it were still true.

**The stale workflow, modelled explicitly and verified end to end:**

| Canonical | Delivery | Reported |
|---|---|---|
| current, delivered | matches | `delivered` |
| goes stale (cover/audio/metadata changed) | unchanged | `outdated / export_not_current`, and **not deliverable** |
| re-rendered → current | still the old copy | `outdated / export_changed` |
| delivered again | matches | `delivered` |

Nothing is ever deleted to express any of this.

### 39.12 API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/delivery/settings` | root, availability, problem, autoDeliver, settings path |
| PUT | `/api/delivery/settings` | `{root?, autoDeliver?}` — the **only** place a path is accepted; `root: null` turns delivery off |
| POST | `/api/delivery/deliver` | `{tracks?} \| {catalogue:true}`, optional `presets`, optional `dryRun` |
| POST | `/api/delivery/reveal` | `{slug?, preset?}` — reveals the file, else its folder, else the root |

`tracks` and `catalogue` are mutually exclusive and one is required, exactly as
for `/api/export-missing`, so a request that merely forgot its `tracks` array is
a 400 rather than a catalogue-wide operation. Delivery status is folded into the
existing track views rather than given its own endpoint: `RenderOutputView.delivery`
and `TrackSummaryView.deliveryFolder`, so the UI gets it with data it already
fetches. `RenderOutputView` also keeps `freshness` separate from `delivery` —
they answer different questions. `CreateRenderBatchView.locked` and
`ExportMissingView.lockedElsewhere` were added for lock contention.

### 39.13 CLI

```console
npm run deliver-track -- <slug> [--preset <id>] [--dry-run]
npm run deliver-track -- --set-root "/Users/you/Movies/Toshi Exports"
npm run deliver-track -- --show
npm run deliver-catalogue [-- --dry-run]
npm run render-locks [-- --release <slug> <preset-id>]
```

Both delivery commands use **the same planner and the same delivery service as
the API** — there is no copying or path logic in `scripts/`. A partially failed
run exits non-zero and says outright that the exports in `out/` are unaffected.
Every pre-existing command is unchanged.

### 39.14 UI

- **Delivery** button in the header opens a settings panel: destination folder,
  auto-deliver toggle, Reveal in Finder. A typed path rather than a native folder
  picker — a picker needs a desktop shell this project deliberately does not
  have, and the server validates the path regardless. **It is the only place in
  the app where a path is entered.**
- Per track, a **Delivery** section: the folder, each intended format's state,
  a two-step Deliver action and Reveal destination. It appears only once a
  destination is configured.
- The track list gets **one badge** per track ("sent" / "n to send"), because a
  second row of per-format marks there would make delivered and rendered look
  like the same fact.
- **Deliver current catalogue exports** sits beside the existing export actions.
- Delivery marks cover only intended formats, plus any unintended format that
  has actually been delivered, so an existing copy never disappears from view.
- A failed delivery says outright that the rendered exports are unaffected.
- `deliveryFolder` is editable in Track info. Phase 2C-B styling is reused
  throughout — the delivery marks share the export row's shape and the existing
  status colours.

### 39.15 Auto-delivery

Opt-in (`autoDeliver`), off by default, because a tool that quietly started
writing into a synced folder would be a surprise. It runs in `renderTrackVideo`
**after the target lock is released**, so both the CLI and the API worker get it
from one call site with no duplication, and it never holds a lock across a copy.
It cannot fail a render: the export is already published and verified, and a
delivery problem comes back as an outcome that is logged (worker log line, CLI
line) and nothing more.

### 39.16 Performance

- **Delivery off costs nothing.** With no root configured, no destination is
  stat'd at all.
- With delivery on, a listing resolves settings **once per request** and stats
  each export's destination once: 3 stats per track. Measured at **0.10 ms per
  listing** of the current catalogue — indistinguishable from the 0.125 ms with
  delivery off, i.e. inside the noise.
- **No delivered MP4 is ever hashed.** Freshness is a recorded fingerprint plus
  a stat.
- Copies use `fs.copyFile`, which is a filesystem-level copy (APFS clone where
  possible); no video is ever read into JS memory.
- Deliveries run one after another: these are large files on one disk, and
  copying several at once would only contend for the same bandwidth.
- No watchers, no recursive destination scans, no new processes, no new
  dependencies. Delivery is idle when unused.
- Lock acquisition is one `open` plus one small write.

### 39.17 Tests (43 added, 178 total)

`tests/render-lock.test.mts` (16) and `tests/delivery.test.mts` (24) use **real
filesystem primitives in temp directories**, because what is being checked is
what the filesystem does — a mocked filesystem would prove nothing about O_EXCL
or an atomic rename. Notably: a failed copy is a genuinely unwritable directory,
not a stubbed error, and the previously delivered file is read back byte for byte
afterwards. Twelve concurrent acquisitions are raced, and exactly one wins.

Three additions to `tests/api-integration.test.mts` cover settings refusing an
unusable root without writing anything, delivery naming tracks rather than
paths, reveal refusing a traversal slug, and a locked target answering 409 with
no job queued.

Delivery tests always pass settings explicitly, so none of them reads or writes
the project's own `delivery.local.json`.

### 39.18 Verification performed

- `npm run lint` (ESLint + TypeScript) and **178 tests** clean; the full suite
  run 5 times consecutively after the final change.
- `validate-track` and `prepare-track` on `ghetto-geek` exit 0. Vite production
  build passes (the pre-existing >500 kB advisory is unchanged).
- **Cross-process contention proved with real processes**, not just unit tests:
  a CLI render was started, its lock file inspected, and a second CLI render of
  the same target refused naming the first's pid; with a lock held by a separate
  live process, `POST /render` answered 409 and a two-target batch queued the
  other format while reporting the locked one.
- **Lock release proved in the real world**: a completed CLI render released its
  lock, and a cancelled API render released its own while leaving the previous
  export `current` and the cancelled format still `missing`.
- **Delivery proved end to end on a real render**: a synthesised 3-second probe
  track rendered, delivered, and was byte-identical to its canonical export,
  which was itself unchanged. The whole freshness cycle was then walked —
  stale → not deliverable, re-render → `export_changed`, deliver → `delivered` —
  and auto-delivery was switched on and confirmed to copy into a changed
  per-track folder while leaving the old copy alone.
- The UI was driven in a real headless browser: settings panel, an invalid path
  refused without changing stored settings, per-format delivery marks, the
  "1 to send" badge, a two-step delivery actually copying a file, and the
  catalogue summary.
- **Ghetto Geek was not re-rendered and its files were not touched.** Its
  exports predate manifests, so they read as `stale / manifest_missing` and are
  correctly reported as needing a re-render before they can be delivered.
- Final cleanup: no render workers, no headless Chromium, no leaked locks, no
  temp delivery destinations, no probe fixtures, no stray temp files.

### 39.19 Limitations

- **A lock is advisory across machines.** PID liveness is meaningful only on the
  host that wrote the lock, so a lock from another hostname is never reclaimed
  automatically and needs `render-locks --release`. This is a single-machine
  local tool; a shared network `out/` was not designed for.
- **PID reuse can leave a lock stuck**, never shared. Deliberate, and the safe
  direction — the fix is the explicit release command.
- **`prepareTrack` is not locked.** Locks are per `slug + presetId` as
  specified; two processes rendering *different* formats of one track can both
  regenerate `analysis.wav`. That was already true and is unchanged; the writes
  are deterministic and produce identical bytes.
- **A hard kill leaves a lock file behind** until the next render reclaims it.
  Harmless, and visible in `render-locks`.
- **Delivery is not transactional across targets.** Each copy is atomic on its
  own; a catalogue run can deliver nine of ten and report the tenth.
- **A delivered copy is verified by size and mtime, not by hash.** Someone who
  replaced it with a file of identical size and timestamp would not be detected.
- **`failed` is not persisted**, so a failure is visible in the response that
  produced it and not after a refresh — where the state re-derives to `pending`
  or `outdated`.
- **No native folder picker.** Paths are typed or pasted, and validated
  server-side. A picker would need a desktop shell this project does not have.
- **Delivery never deletes anything**, including copies left behind by a changed
  folder or root. That is deliberate; tidying the destination is the user's.

### 39.20 Commits for this milestone

- `5a2c023` — cross-process render target locks, manager integration, recovery CLI.
- `9070101` — delivery configuration, atomic delivery, receipts, API and CLI.
- `a168c3f` — delivery settings, status and actions in the app.
- `1edd387` — 43 tests for locking and delivery.
- Documentation follow-up: this section and the README.

All commits are local only. **Do not push without a new instruction.**

### 39.21 Superseded by §40

§40 is a hardening pass over this milestone. Where the two disagree, §40 wins:
the lock mechanism, recovery policy, delivery/publication coordination and
analysis-audio publication all changed. The destination layout, configuration
model, API surface, CLI commands and UI are unchanged.

### 39.22 Recommended next major feature (not started)

**A release bundle per track** — a manifest of what shipped where, generated
alongside delivery: the delivered files, their formats, durations, byte sizes and
delivery timestamps, written as one human-readable file (Markdown or CSV) into
the track's destination folder. It answers "what did I send, in which formats,
and when" without opening the folder, reuses the receipts and coverage already
in place, and needs no new concepts — only a formatter and an opt-in setting.
It would also give the destination folder something a collaborator can read.


---

## 40. Current State — Ownership, Delivery and Preparation Hardening (2026-09-18)

**Supersedes §39's lock mechanism, recovery policy and delivery coordination.**
No composition, layout, presets, brand sources, final audio routing or render
concurrency changed. No dependencies were added. The destination layout,
settings model, API paths, CLI commands and UI are as §39 describes them.

### 40.1 What this pass inherited

A previous session (Codex) began this hardening and stopped partway. What was
already on disk and **correct**:

- the guard-based lock rewrite, closing a real bug: reading a lock and then
  renaming its path is not atomic, so a process that had read an abandoned lock
  could destroy a *successor's* lock;
- `assertOwned` / `commit` / `commitAsync` on the lock handle, and
  `publishExport` fenced by the lock instead of an in-process mutex;
- delivery taking the target lock, and re-reading live metadata after copying;
- receipts recording the exact published file (`sourceOutput`), with the schema
  version bumped to 2;
- the pinned-working-directory copy helper, and its identity checks;
- atomic publication of `analysis.wav`;
- real-process lock regression tests, including displaced owners.

What was **incomplete or wrong**, and was corrected here:

1. **The mid-copy metadata test was broken and hung the whole suite.** Its
   helper returns parsed metadata under the same name as the fixture's metadata
   *path*, so `writeFileSync` was handed an object. The resulting exception was
   thrown inside the IPC listener registered ahead of the copy helper's own,
   which meant the staged-copy handler never ran: the helper waited for a
   decision forever while delivery held the target lock. `npm test` never
   finished.
2. **Waiting on the copy helper was unbounded**, which is the same failure
   without a test to trigger it: any helper that stopped answering would hold
   the target lock until the process restarted.
3. **An abandoned guard made a target permanently unusable**, including by the
   manual recovery command, which needs the same guard.
4. **`release()` could throw**, which would report a finished render as failed.
5. The lock path's containment assertion had been dropped.
6. `analysis.wav` staging files were not gitignored.
7. `deliverExport` still accepted a `metadata` input that execution ignored, and
   took a lock even when no destination was configured.

### 40.2 Ownership invariant

A process that no longer owns a target lock never deletes or replaces a
successor's lock, and never publishes a video, a manifest or a receipt.

Enforced by three things together:

- **A guard file** (`<lock>.guard`) held across every mutation of a lock —
  acquisition, recovery, release — and across publication. Ownership only ever
  changes hands while it is held, so there is no read-then-act window.
- **Token identity.** A lock records a random token; a release removes the file
  only if the token *and* the file's dev/inode still match.
- **`assertOwned()` immediately before each destructive step.** `publishExport`
  re-checks before each of its two renames; delivery re-checks before the copy
  is renamed into place and again before the receipt is written.

The guard's metadata is written to a private file and `link`ed into place. Link
is atomic and fails with `EEXIST`, so a guard is never visible without complete
metadata — which is what makes "unreadable guard" a sound signal of corruption
rather than of a live holder caught mid-write.

`release()` never throws: it runs in a `finally` around real work, and a lock
that cannot be removed is recoverable whereas a discarded result is not. A
guard-release failure is surfaced only when the work itself succeeded, so it
cannot mask the caller's real error.

### 40.3 Recovery policy

| Situation | Automatic | Manual (`render-locks -- --release`) |
|---|---|---|
| Lock owner dead on this host | reclaimed | released |
| Lock owner running on this host | refused | refused |
| Lock from another hostname | refused | refused |
| Unreadable lock metadata | refused | refused |
| Guard held by a running local process | refused | refused |
| Guard whose holder is dead, foreign or unreadable | **refused** | **cleared** |

Still one-sided, for the same reason as before: PID reuse can make a dead owner
look alive — a stuck lock, recoverable by hand — but never make a live owner
look dead, which would mean two renders publishing one file.

Automatic acquisition never clears a guard. Guessing wrong in the one section
where ownership changes hands is precisely what would admit two owners. The
manual path may clear one, because the operator has asserted nothing is
rendering, and because otherwise a process killed inside that section would
brick the target forever. Recovery remains target-scoped: a slug and a preset,
never a path.

Residual, accepted: two operators running the manual repair simultaneously could
both clear the same guard. It is a human-invoked action on a single-user local
tool, and the liveness check runs first.

### 40.4 Delivery coordination

Delivery holds the target lock **for its whole duration**, not only for the
commit. That is a deliberate choice over §39's narrower design:

- the copy is bounded, and the lock is per-target, so unrelated work is
  unaffected;
- it removes the class of "the source moved while we were reading it" races
  rather than detecting them afterwards;
- canonical publication of the same export is excluded outright, which is
  verified: `publishExport` attempted during a delivery is refused with
  `RENDER_TARGET_LOCKED`.

The copy and its receipt are published together under `commitAsync`, with
ownership re-asserted on both sides, so a displaced owner cannot leave a receipt
claiming a file it did not publish.

After copying, and before publishing, delivery re-reads from disk: the manifest
fingerprint, the canonical file's identity, the resolved destination root, and
the destination path implied by **live** metadata. Any difference discards the
staged copy as `source_changed`. A delivery of a target another process holds is
reported as busy and writes nothing.

Delivery with no destination configured takes no lock at all, so it cannot be
refused merely because a render is running, and creates no lock file.

### 40.5 Receipts identify the exact export

A receipt records `sourceOutput` — the canonical file's bytes, mtime and inode —
alongside the input fingerprint. A re-encode from identical inputs produces a
different inode, so the destination copy is correctly reported as `outdated /
export_changed` rather than as still matching.

Schema version is **2**. A version-1 receipt is refused and reads as never
delivered, which is recoverable by delivering again. There were no v1 receipts
in the repository when this shipped.

### 40.6 Directory-swap behaviour

Destination writes happen in a helper process whose working directory is pinned
to the validated folder. Node has no `openat`, and changing the server's own
working directory is not an option, so a short-lived child is the only way to
make writes resolve through a kernel-held reference to the directory that was
checked. Renaming or symlinking the pathname afterwards cannot redirect them.

The helper refuses to publish unless, at that moment: its own `.` and `..`
identities still match the validated folder and root, the root still resolves to
itself, and the named folder path still resolves to the same inode. It copies
with `COPYFILE_EXCL`, so a planted symlink at the staging name cannot be
followed.

Every wait on the helper is bounded — the staged copy generously, the commit
round trip briefly, and stopping it too. Stopping prefers disconnecting the IPC
channel, which the helper treats as an abort and cleans up after itself; a kill
is the last resort, and then its staged temp file may survive, which is better
than this process deleting a path it can no longer identify. Completion is the
helper's **exit**, not its stdio `close`: once both ends have disconnected the
channel, that close event may never arrive at all.

Verified against: a folder renamed and replaced by a symlink after staging, the
root deleted mid-copy, the root replaced by another directory mid-copy, a
symlinked destination folder, a destination inside the project, and traversal
attempts in the folder name.

### 40.7 Metadata changing mid-delivery

The delivery folder lives in track metadata, so metadata decides where bytes
land. A caller's snapshot can be arbitrarily stale by the time a copy is
published, so `deliverExport` no longer accepts one at all: it reads metadata
itself under the lock, and reads it again after the copy.

If the destination the live metadata resolves to differs from the one that was
validated, or if the export has gone stale because its metadata changed, the
staged copy is discarded (`source_changed`) and nothing is published. The
canonical export is untouched; delivering again after the edit does the right
thing.

Both cases have deterministic regression tests, driven from the moment the
helper reports its staged copy rather than from a timer.

### 40.8 Shared preparation concurrency

`analysis.wav` is derived and shared by every format of a track. Two renders of
*different* formats are two processes preparing it at once, and the target lock
deliberately does not cover that — they are different targets, and serializing
them would defeat the point.

Each producer now converts into a private `analysis.wav.tmp-<uuid>.wav` sibling
and renames it into place, so a reader only ever sees a complete file. The
source's identity is re-checked after conversion and an empty result refused, so
a beat edited mid-conversion cannot certify audio that was never fully read.
Nothing serializes across tracks.

Because the conversion is deterministic, concurrent producers write identical
bytes and whichever publishes last is indistinguishable from any other. Proven
with four competing real processes, plus a reader sampling the published path
throughout a re-conversion.

### 40.9 Fail-closed error handling

- Filesystem and copy errors become delivery *outcomes*, so a catalogue run
  reports the one target that failed and still delivers the rest.
- Destination problems are `TrackError`s, so the API answers 4xx rather than 500.
- A failed copy never replaces the previously delivered file, and its staging
  file is removed.
- A failed publication restores the previous video and leaves the previous
  manifest, and removes its staging directory.
- A failed lock metadata write removes only the inode it exclusively created.
- A failed analysis conversion leaves the previous `analysis.wav` intact.
- Cancellation and worker failure both release the lock and the guard.

### 40.10 Tests

**207 total, 29 added in this pass** (178 → 207, of which Codex had written 16).

`tests/lock-safety.test.mts` (13) — eight competing real processes reduced to a
single owner, simultaneous recovery after an owner is killed mid-hold, displaced
owners refused at commit and release, release after ownership loss, publication
after ownership loss preserving the previous pair, corrupt pid/target/host
metadata, a failed metadata write cleaning up only its own file, cancellation and
worker failure releasing everything, manual guard recovery, a live guard refusing
manual recovery, path containment, and a finished render not being reported as
failed when a lock lingers. `tests/lock-process.mts` is the competing-process
helper.

`tests/delivery.test.mts` (36, up from 24) — plus symlinked destination folders,
a destination inside the project, a folder swapped after staging, the root
deleted or replaced mid-copy, live metadata edits mid-copy (title and folder),
canonical publication refused while a delivery holds the target, a canonical
export replaced behind the lock, a same-input re-encode invalidating a receipt,
an older receipt schema being distrusted, and invalid folder drafts not breaking
track views.

`tests/analysis-concurrency.test.mts` (4) with `tests/analysis-process.mts` —
competing processes converging on one complete file, no partial file ever
observable, a failed conversion preserving the previous file, and independence
across tracks.

Concurrency and path tests use real filesystem primitives in temporary
directories, and real forked processes where the claim is about processes.

### 40.11 Verification performed

- `npm run lint` (ESLint + TypeScript) clean; **207 tests pass**, and the full
  suite was run four times consecutively with no flakes.
- Vite production build passes (the pre-existing >500 kB advisory is unchanged).
- `validate-track` and `prepare-track` on `ghetto-geek` exit 0.
- A synthetic 3-second probe rendered in 3.5 s through the rewritten publication
  path, wrote a matching manifest, and delivered a byte-identical copy with a v2
  receipt naming the exact published inode. The canonical file was unchanged.
- Cross-process fencing re-proved with real processes against the rewritten
  lock: with a lock held by a separate process, `POST /render` answered 409
  naming the holder, `render-locks` listed it as running, and both the API and
  the CLI refused to deliver that target — writing nothing, and the CLI exiting
  non-zero.
- Manual guard recovery re-proved end to end: an abandoned lock plus its guard
  refused automatic acquisition with an actionable message, then
  `render-locks -- --release` cleared both.
- Final state: no leaked locks, no leftover fixtures, no staging or temp files,
  no orphaned copy helpers, no render workers, no Chromium. Ghetto Geek's assets
  and exports were not touched, and it was not re-rendered.

### 40.12 Remaining medium and low findings

- **Medium.** A guard is held across `commitAsync` during the delivery commit,
  which spans an await. A process killed exactly there leaves a guard needing
  manual recovery. The window is a rename plus a small write.
- **Medium.** Delivery holds the target lock for the whole copy, so a re-render
  of that one export waits for the copy to finish. Bounded and per-target, and
  accepted in exchange for eliminating the source-moved race.
- **Medium.** A delivered copy is still verified by size and mtime, not by
  hash. A replacement with identical size and timestamp would not be detected.
- **Low.** `takeGuard` parks with `Atomics.wait` for up to 200 ms total under
  contention, which blocks the event loop of whichever process is waiting. Only
  reachable while another local process is inside its own short ownership
  section.
- **Low.** A track whose metadata is invalid reports delivery as
  `not_configured` rather than a dedicated state, because no destination may be
  derived from unvalidated metadata. The UI hides the delivery section in that
  case, and validation errors dominate the panel anyway.
- **Low.** Killing the copy helper as a last resort can leave one
  `.deliver-*.mp4.tmp` file in the destination folder. Not swept automatically,
  because temp names are random and two formats of one track share a folder, so
  a sweep could delete a concurrent delivery's staging file.
- **Low.** A hard kill during analysis preparation can leave one
  `analysis.wav.tmp-*.wav` sibling. Gitignored, harmless, and replaced on the
  next preparation.
- **Unchanged from §39.** Locks are advisory across machines; PID reuse can
  leave a lock stuck rather than shared; `out/` on a shared network volume was
  never designed for.

### 40.13 Commits

- `e79d84c` — fence render ownership through publication.
- `52df748` — fence delivery against publication and path swaps.
- `6248426` — publish shared analysis audio atomically.
- Documentation follow-up: this section.

All commits are local only. **Do not push without a new instruction.**

### 40.14 Recommended next step

The release bundle proposed in §39.22. **Built — see §41.** Nothing in this
hardening pass is unfinished.


---

## 41. Current State — Release Bundles (2026-09-18)

Every delivered track now describes itself. No composition, layout, presets,
brand sources, final audio routing, render concurrency, locking or delivery
behaviour changed. No dependencies were added.

### 41.1 What a bundle is

Two small files written into the track's own destination folder, beside the
delivered videos:

```text
Toshi Exports/
└── Probe Beat/
    ├── zz-probe-youtube-16x9.mp4
    ├── zz-probe-square-1x1.mp4
    ├── release.json     ← machine-readable
    └── release.md       ← human-readable
```

They answer one question: what shipped, in which formats, when, and what is
still missing.

### 41.2 Schema

`src/domain/delivery/releaseBundle.ts` is browser-safe and holds the schema, the
fingerprint input and the Markdown rendering, so the server, the CLI and the UI
describe a bundle identically.

```json
{
  "schemaVersion": 1,
  "bundleId": "<sha256>",
  "generatedAt": "2026-09-18T17:32:57.670Z",
  "track": { "slug": "...", "title": "...", "artist": "...", "key": "...", "bpm": 100, "subtitle": "..." },
  "folder": "Probe Beat",
  "intendedPresets": ["youtube-16x9", "square-1x1"],
  "deliveries": [ { "presetId": "...", "label": "YouTube 16:9", "filename": "...mp4",
                    "width": 1920, "height": 1080, "fps": 30,
                    "status": "delivered", "reason": null,
                    "durationSeconds": 4, "durationFrames": 120,
                    "bytes": 416219, "deliveredAt": "...",
                    "exportFingerprint": "<sha256>" } ],
  "outdated": [ ... ],
  "missing":  [ ... ]
}
```

- **`deliveries` / `outdated` / `missing`** are three separate arrays of the same
  entry type, in canonical preset order. Delivered means a copy is at the
  destination *and* is of the current canonical export; outdated means a copy is
  there but does not represent what should ship; missing means nothing is there.
  Those stay three distinct answers everywhere.
- **No absolute path anywhere.** A bundle travels with its folder, so it records
  the folder's own name and the filenames beside it — never the machine-local
  root. Asserted by a test that greps the written file.
- **`bytes` and `deliveredAt` only on a confirmed delivery.** For anything else
  the receipt may describe a file that has since been replaced, and a wrong
  number is worse than none.
- A missing format still names the `filename` it would have, so a reader knows
  what to expect.
- Schema version is **1**. Nothing existed before it, so there is no migration.

### 41.3 Fingerprint and freshness

`bundleId` is a SHA-256 over a fixed serialization of the facts a bundle
asserts: schema version, slug, folder, the rendered metadata (title, artist,
key, BPM, normalized subtitle), the intended preset ids, and per format — in
canonical order — its status, reason, canonical export fingerprint, delivered
timestamp, delivered size, and the identity of the exact canonical file the
delivery was made from.

Deliberately **not** the document itself: `generatedAt` moves on every run, so
hashing the bundle would make it instantly stale. Deliberately **not** a
modification time: touching or hand-editing a bundle cannot make it look
current.

| Freshness | When |
|---|---|
| `not_configured` | no destination root, so there is nowhere for a bundle |
| `missing` | no readable bundle in the folder, or the track cannot be described |
| `outdated` | a bundle is there but its id differs from the current state, or the pair disagrees |
| `current` | `release.json` and `release.md` both carry the current id |

A bundle therefore becomes outdated when metadata changes, the intended preset
list changes, a delivery happens, a re-render changes delivery freshness, the
delivered file is replaced, or the delivery folder changes. All verified.

Freshness costs one small file read plus the export coverage the track view
already gathers — `trackExportCoverage` is now computed once per track and
shared, rather than read twice. **No video is hashed or decoded.**

### 41.4 Media metadata

- **Dimensions and fps** come from the render preset, which is already the
  authority for them.
- **Duration** comes from one `ffprobe` of the track's `beat.wav` — a header
  read, not a decode — put through the composition's own
  `secondsToFrames(seconds, fps)`. So the reported length is the one that was
  *rendered*, not a re-measurement of the output. Verified against a real
  render: the bundle reported 120 frames / 4.000s / 1920×1080 / 30fps, and
  `ffprobe` of the MP4 reported exactly the same.
- One probe per track per generation, shared by every format. A track whose
  audio cannot be read still gets a bundle, with the duration left out.
- **Size** comes from the delivery receipt, which `deliveryStateFor` has already
  confirmed against the file. No extra stat, no read.

### 41.5 Publication

Two files cannot be renamed into place together, so the order is chosen and the
limitation is faced rather than hidden:

1. **`release.md` first**, staged in the destination folder and renamed.
2. **`release.json` second**, likewise. It is the file freshness is read from,
   so it is the commit point.

A crash between them leaves the *old* id in the JSON, so the bundle reads as
outdated and regenerating repairs it. Publishing the JSON first would instead
have a bundle claim to be current while its readable half was stale — strictly
worse. Both files carry the same id (the Markdown carries its first 12
characters), so **a disagreeing pair is detected** rather than trusted, and a
missing `release.md` also reads as outdated.

Neither file is touched until its replacement is fully written, so a previous
valid bundle survives any failure; temp files are removed on every path. Proven
by sampling both files throughout a real replacement and finding only whole,
parseable documents.

Paths reuse the delivery layer's own fencing: `assertDeliveryDestination`
constrains `<root>/<folder>/release.json` exactly as it does a delivered video,
and the root's dev/inode identity is captured up front and compared again
immediately before writing. The track folder is created **non-recursively**
inside a re-verified root, so a destination that has been deleted or unmounted
is never silently recreated — a bug found by the test for it.

### 41.6 Partial releases

A bundle never requires a complete release. Two of three formats delivered is a
valid, first-class result, and a track with nothing delivered yet still gets a
bundle saying so. The Markdown distinguishes "nothing has been delivered yet"
from "nothing here is current — re-render, then deliver again", because a folder
holding out-of-date copies has not delivered nothing.

Nothing at the destination is ever deleted for being outdated.

### 41.7 release.md

```markdown
# Probe Beat — Toshi

Key: F Minor
BPM: 100

Boom bap soul, trap bounce and latin heat.

## Delivered

- YouTube 16:9 — 1920×1080 — 0:04 — 0.4 MB

## Missing

- Square 1:1 — not rendered yet

---

Generated 2026-09-18 19:32 · bundle `b583fe714b45`
```

Fixed section order, fixed formatting, canonical preset order, and empty
sections left out entirely. Sizes are decimal MB (what Finder shows) and
durations `m:ss`. The generating clock is injectable, so a test can pin it and
assert the document is byte-identical for identical state.

### 41.8 API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/release-bundles` | `{tracks?} \| {catalogue:true}`, optional `dryRun`, `force` |

One endpoint for a track and for the catalogue, so both behave identically.
`tracks` and `catalogue` are mutually exclusive and one is required, matching
the delivery and export endpoints. No path is accepted: bundles go into each
track's own folder, resolved from stored settings.

Status is **folded into the existing track views** rather than given its own
endpoint — `TrackSummaryView.releaseBundle` carries freshness, the portable
relative path, the published `generatedAt`, and delivered/outdated/missing
counts. `DeliverView` gained `releaseBundles`, which is empty unless
auto-update is on. `DeliverySettingsView` and its PUT body gained
`autoUpdateReleaseBundle`.

### 41.9 CLI

```console
npm run release-bundle -- <slug> [--dry-run] [--force]
npm run release-bundles [-- --dry-run] [--force]
```

Same planner and same generation service as the API, so "outdated" means one
thing in both places and there is no formatting or path logic in `scripts/`. A
run with failures exits non-zero and says outright that delivered files are
unaffected.

### 41.10 UI

- The **Delivery** section shows the bundle's freshness as a badge plus its
  counts, and a two-step action — dry run, then confirm — labelled "Generate"
  or "Update" depending on whether one exists.
- The **catalogue** gets "Update release bundles" beside the existing delivery
  action.
- Each **track row** carries a badge, so an incomplete release is visible
  without opening the track. Hidden entirely when no destination is configured.
- **Delivery settings** gained an "Update release bundles" toggle.
- Phase 2C-B styling is reused: the badge shares the delivery badge's shape and
  the existing status colours.

### 41.11 Catalogue behaviour

`planReleaseBundles` buckets every track into current / outdated / missing /
unavailable. Only **missing and outdated** are written by default, so running it
over a settled catalogue does no work and rewrites nothing; `--force` is there
when a rewrite is wanted. Tracks with no destination, or that cannot be
described at all, are set aside rather than counted as work.

Each track is contained: a folder that cannot be written reports its own
failure and **the rest of the catalogue still gets bundles**.

### 41.12 Races and locking

No new lock primitive was needed, and no global catalogue lock exists.

- **Two generations of the same track.** Serialized in-process by
  `withFileMutation` on the JSON path. Across processes the document is a *pure
  function of what is on disk*, so racing generators write the same bytes and
  whichever renames last is still correct. Proven by three concurrent forced
  generations converging.
- **Delivery during generation, or metadata changing mid-generation.** Whatever
  is written describes one coherent state and carries that state's own id, so
  newer state simply makes the bundle outdated and regenerating catches up. A
  bundle is never left claiming to be current when it is not.
- **Destination changing mid-generation.** Caught by the identity re-check
  before writing (§41.5).
- **Catalogue overlapping a manual track generation.** Same mutex, same
  purity argument.
- **No render lock is taken.** A bundle is a description; it has no business
  holding a render target. Auto-update runs after the delivery has finished and
  released its lock.

### 41.13 Auto-update after delivery

`autoUpdateReleaseBundle`, machine-local, **off by default** — nothing starts
writing into a synced folder unannounced. When on, a track's bundle is rewritten
after a successful delivery: once per track rather than once per format, after
the target lock is released, and it never throws. A bundle that could not be
written leaves the delivered files exactly where they are, so "delivered, bundle
not updated" is reported in the response and printed by the CLI rather than
turned into a failed delivery.

### 41.14 Performance

- Freshness: one small file read per track, plus coverage the view already had.
  No video touched.
- Generation: one `ffprobe` header read per track, two small text writes.
- No watchers, no recursive destination scans, no MP4 hashing or decoding, no
  Chromium, no new dependencies. Idle when unused, and entirely absent when no
  destination is configured.

### 41.15 Tests (28 added, 235 total)

`tests/release-bundle.test.mts` uses real directories in a temp root and passes
settings explicitly, so no test reads or writes the project's own
`delivery.local.json`.

Covers: a complete release; partial releases and one with nothing delivered;
no destination; an MP4 without a receipt not counting as shipped; a stale
canonical export; a re-render leaving the previous delivery outdated and
re-delivery restoring it; freshness following metadata, intent, delivery and
folder changes; a hand-edited or touched bundle not reading as current; a
half-updated pair; deterministic JSON ordering and byte-identical Markdown;
fingerprint stability under a forced rewrite; schema version; size, duration,
dimensions and fps; both files never observed partially written; a failed
publication preserving the previous bundle; temp cleanup; path traversal;
no absolute paths in `release.json`; catalogue skip-current and per-track
failure containment; tracks without a destination; concurrent generation;
metadata and destination races; and auto-update in all three states.

### 41.16 Verification performed

- `npm run lint` (ESLint + TypeScript) clean; **235 tests pass**, suite run
  three times consecutively.
- Vite production build passes (the pre-existing >500 kB advisory is unchanged).
- `validate-track` and `prepare-track` on `ghetto-geek` exit 0.
- A synthetic 4-second probe was rendered in one of its two intended formats,
  delivered, and bundled: the JSON parsed, the Markdown read cleanly, the
  partial state was reported correctly, and the reported duration matched the
  real render exactly. Rendering and delivering the second format made the
  bundle outdated, and regenerating completed it.
- The API exercised for a track, the catalogue, dry runs, and every refused
  request shape. The UI driven in a real headless browser: badges in the track
  list, the Delivery section's status line, and the two-step flow writing an
  outdated bundle and returning it to current.
- Auto-update proved end to end through the API: outdated → deliver → bundle
  rewritten to current, reported in the delivery response.
- **Ghetto Geek was not re-rendered and its assets were not touched.** Its
  exports predate manifests, so they read as stale and its bundle correctly
  reads as not written.
- Final state: no leaked locks, no leftover fixtures, no temp files, no orphaned
  workers or Chromium.

### 41.17 Limitations

- **The two files are not atomically published together.** Faced rather than
  hidden: the order is fixed, both carry the same id, a disagreeing pair reads
  as outdated, and regenerating repairs it.
- **Cross-process generation is not mutually excluded**, only in-process. It is
  safe because the document is a pure function of disk state, so racers write
  identical bytes; the residual is that the *later* rename wins, which is
  correct either way.
- **A bundle can be outdated the instant it is written** if a delivery lands
  during generation. Self-healing by design, and visible as `outdated`.
- **Duration needs ffprobe.** Without it the duration fields are null and the
  Markdown shows `—`; everything else still works.
- **`bytes` is only reported for confirmed deliveries**, so an outdated entry
  shows no size even though a file is sitting there.
- **Bundles are not deleted.** A changed delivery folder leaves the old
  folder's bundle in place, describing what is still in that folder. Tidying the
  destination is the user's.
- **Bundle writes are not fenced by a pinned working directory** the way the
  delivery copy is. They are small text writes with a sub-millisecond window,
  validated and identity-checked immediately before writing; forking a helper
  for two text files would be disproportionate.
- **No per-track bundle lock file.** Considered and rejected as unnecessary
  given the purity argument above; it would be the first thing to add if
  generation ever stopped being deterministic.

### 41.18 Commits

- `4177dca` — bundle schema, fingerprint, freshness, generation and publication.
- `62d41ef` — API endpoint, catalogue planner and CLI.
- `72a4563` — UI: status, badges, catalogue action.
- `15668f3` — opt-in auto-update, destination re-check fix, remaining tests.
- Documentation follow-up: this section.

All commits are local only. **Do not push without a new instruction.**

### 41.19 Recommended next major feature (not started)

**A delivery log per destination** — an append-only `delivered.log` (or a small
rolling JSON) at the destination root recording each delivery as it happens:
timestamp, track, format, bytes, export fingerprint. Release bundles describe a
*current* state per track; a log answers "what went out this week, across
everything", which is the one question the current model cannot. It reuses
receipts and the delivery service unchanged, needs no new concepts, and is
append-only so it has none of the two-file atomicity awkwardness. Keep it
bounded, and keep it out of git.

## 42. Current State — Append-Only Delivery History (2026-09-18)

Every delivery to a destination is now recorded as it happens. No composition,
layout, presets, brand sources, final audio routing, render concurrency,
locking, delivery or release-bundle behaviour changed. No dependencies were
added.

### 42.1 What it is, and what it is not

```text
Toshi Exports/
├── delivery-log.jsonl        ← history: events, append-only
├── delivery-report.md        ← optional, regenerated on request
└── Probe Beat/
    ├── zz-probe-youtube-16x9.mp4
    ├── release.json          ← current state of this track
    └── release.md
```

| | Release bundle | Delivery log |
|---|---|---|
| Question | what does this track ship? | what went out, and when? |
| Scope | one track | the whole destination |
| Shape | current state, recomputed | events, appended once |
| Rewritten | every time it changes | never |

They share types and helpers and neither is the other's source of truth. A
missing or damaged log changes nothing about delivery state, which is derived
from receipts and manifests; a release bundle never reads or writes an event.
Verified by damaging the log and regenerating a bundle to the identical
`bundleId`.

### 42.2 Why JSON Lines

Appending one line is a single write with no read of what came before, so a
growing history never has to be rewritten and an append cannot rewrite an
earlier event even by accident — which is the property an append-only record
needs. A crash can damage at most the final line, it is readable by anything,
and it can be streamed if it ever outgrows a single read. A single JSON array
would fail all four: every append would rewrite the whole history.

### 42.3 Event schema

```json
{
  "schemaVersion": 1,
  "eventId": "9940b96c-7835-414d-84dc-cf4293449047",
  "kind": "delivery",
  "source": "delivery",
  "deliveredAt": "2026-09-18T19:00:54.951Z",
  "track": { "slug": "zz-probe", "title": "Probe Beat", "artist": "Toshi",
             "key": "F Minor", "bpm": 100, "subtitle": "…" },
  "preset": { "id": "square-1x1", "label": "Square 1:1",
              "width": 1080, "height": 1080, "fps": 30 },
  "path": "Probe Beat/zz-probe-square-1x1.mp4",
  "bytes": 363466,
  "exportFingerprint": "<sha256>",
  "deliveryId": "<sha256>"
}
```

`src/domain/delivery/deliveryHistory.ts` is browser-safe and holds the shape,
the validation rules, the filters, the summaries and the report rendering.

- **A snapshot, not a reference.** The track and the format are recorded as they
  were. Renaming a track, changing its BPM, or retiring a preset does not reach
  back into what history says shipped. `preset.id` is a plain string for the
  same reason: an event must stay readable after the preset it names has gone.
- **No absolute path.** The log sits at the destination root, so `path` is
  relative to it and the machine-local root is never repeated. Asserted by a
  test that greps the written file, and confirmed by hand.
- **`eventId`** is a `crypto.randomUUID()` — unique per appended event, never an
  index or a line number.
- **`deliveryId`** is a SHA-256 over the *receipt*: slug, preset, path,
  timestamp, size, the delivered file's mtime, the export fingerprint and the
  canonical file's identity. It is the identity of one completed delivery.
- **`source`** is `delivery` or `reconciled` (§42.9).
- **Only a completed delivery is an event.** Rendering, cancelling, a failed
  copy, a failed receipt, or writing a release bundle never append one. A
  re-delivery does, because "was this re-delivered?" is one of the questions
  this exists to answer.

### 42.4 Append strategy

POSIX says a write to a descriptor opened with `O_APPEND` seeks to the end and
writes with no intervening modification, and a sub-block write to a local
filesystem does land whole in practice. "In practice" is not what an audit
record deserves, so appends are serialized four ways:

1. within this process, by `withFileMutation` on the log path;
2. across processes, by exclusive `O_EXCL` creation of `.delivery-log.lock` at
   the destination root;
3. as one `write()` of one complete line to an `O_APPEND` descriptor, so an
   append that somehow bypassed the lock still could not interleave;
4. `fsync`ed before the lock is released, so a recorded event has reached the
   disk before anything is told it was recorded.

The lock is **per destination root** — two destinations never block each other,
and nothing global is taken. It is held for one small write, never for a copy.
Stale-lock recovery is the same one-sided policy as the render lock: only a dead
PID *on this host* permits reclaiming, and a live or unreadable owner is left
alone. Waiting is bounded at 5s with jittered retries, because the caller is a
delivery that has already published its file and must be able to return.

**Proven with real processes**, not an in-process mutex: six separate processes
append eight events each, released together, and all 48 lines come back whole,
unique and parseable. Two destinations run concurrently without interference.

### 42.5 Crash and tail recovery

An append is one write of one line ending in a newline, so a *final* line with
no newline is an interrupted append. That distinction drives everything:

| Status | Meaning |
|---|---|
| `missing` | no log at this destination yet — not a problem |
| `complete` | every line parsed |
| `recovered_tail` | only the final line was incomplete; every event before it is intact |
| `unsupported` | at least one line came from a newer version of the tool |
| `corrupt` | damage somewhere other than the final line, which a crash cannot cause |

Every problem carries its 1-based line number. Readable events are always
returned, so history is never lost to one bad line — but the status says plainly
that something is wrong, and middle corruption is treated as the serious case.

**`npm run delivery-history -- --repair-tail`** drops an incomplete final line
and refuses everything else: it can only ever remove bytes that were already
unparseable, it prints what it discarded, and it holds the append lock while it
rewrites (an appender holding the old inode would otherwise write into an
orphan). It is never automatic.

**A bug found here.** Appending straight onto an unterminated line spliced the
new event onto the fragment and lost it. An append now terminates the fragment
first, so the event always lands whole — at the cost of the fragment becoming a
mid-file malformed line and the log reading `corrupt`. That is the honest trade:
nothing is lost and the damage is visible. Repairing promptly avoids it.

### 42.6 Schema versioning

Every event carries `schemaVersion`. A line declaring a *newer* version is
reported as `unsupported` rather than as damage — it is well-formed, this
version simply does not know it — earlier events stay readable, and nothing is
rewritten. Reconciliation refuses to append onto an `unsupported` or `corrupt`
log, because appending onto damage would bury it. A version of 0, a
non-integer, or a missing one is malformed.

### 42.7 Transaction boundary

The order is fixed and never otherwise:

1. the canonical export is current;
2. the copy is published atomically at the destination;
3. the delivery receipt is committed;
4. **then** the event is appended.

Recording is last because it is the only step that cannot undo anything. The
converse is the real limitation and it is reported rather than hidden: a crash
between 3 and 4, or a log that cannot be written, leaves a real delivery with no
event. The delivery is still a delivery — the file is there and its receipt says
so — so `DeliveryOutcome.historyProblem` carries the reason, the CLI prints it
with the recovery command, and the delivery panel says "not recorded in the
delivery log" beside the path. It is never turned into a failed delivery.

Ordering with the rest: history is appended inside the per-target lock, after
the receipt; release bundles are updated after every copy has finished and the
lock is released. Nothing takes a render lock to write history.

### 42.8 Duplicate prevention

The duplicate check reads the log under the same lock the append is made under
and compares `deliveryId`, so a retried completion step cannot record the same
delivery twice. A genuine re-delivery writes a new receipt with a new timestamp
and a new file mtime, so it is a different delivery and correctly gets its own
event. Verified by replaying an identical completion.

### 42.9 Reconciliation

`npm run delivery-history-reconcile`, or `POST /api/delivery-history/reconcile`.
Conservative by construction:

- reads **receipts only**, never the destination's contents;
- never invents a timestamp, a size or a fingerprint — all three are recorded on
  the receipt;
- skips a receipt naming a different destination, because a path is relative to
  the root its log sits in;
- **cannot** reconstruct metadata as it was at delivery time, because nothing
  records that. A reconstructed event carries *current* metadata and is marked
  `source: "reconciled"` (shown as "reconstructed" in the UI and the CLI) rather
  than passed off as a contemporaneous record. A track whose metadata can no
  longer be read is reported as unreconcilable instead of guessed at;
- is idempotent, because `deliveryId` comes from the receipt.

**It can only recover the most recent delivery per target**, since a receipt is
overwritten by the next delivery of the same export. Earlier lost events are not
recoverable, and that is stated rather than papered over.

Verified end to end: a delivery made with the log unwritable, then reconciled to
exactly one appended event, then reconciled again to none.

### 42.10 Query service

`server/services/deliveryHistory.ts`. Filters by track, format, `from`
(inclusive) and `to` (exclusive), with a limit and an order. Adjacent ranges
therefore never double-count. Sorting is by delivery time with append order as
the tie-break, so two deliveries in the same millisecond keep the order they
happened in.

Summaries: total, today (since **local midnight**, which is what someone means
by it), last 7 days, distinct tracks in the last 7 days, last delivery, and
counts by track and by format. The summary is always of the **whole log** — "6
deliveries today" is a fact about the destination, not about whatever is
filtered. Re-deliveries are identified against the whole log too, because a page
of recent events cannot tell whether something older came before it.

The full-file read is encapsulated in `readDeliveryLog`, which hands back events
and a status rather than a file handle, so a streaming reader can replace it
without a single caller changing.

### 42.11 API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/delivery-history` | `track`, `preset`, `from`, `to`, `limit`, `order` |
| POST | `/api/delivery-history/reconcile` | append events for receipts that have none |

No path is accepted anywhere: the destination comes from stored settings, as it
does for delivery and release bundles. Every parameter is validated before the
log is touched, and the limit is bounded (default 50, max 500) whether or not
one is given, so no request can ask for an unbounded response. `from` and `to`
accept an ISO instant or a relative period (`7d`, `24h`).

A `preset` filter is deliberately **not** checked against the known presets: an
event records the format as it was, so filtering by one since renamed must still
work. It is only ever compared against recorded strings, never used to build a
path. A `track` filter is still validated as a slug.

`DeliveryOutcomeView` gained `historyEventId` and `historyProblem`.

### 42.12 CLI

```console
npm run delivery-history
npm run delivery-history -- --track ghetto-geek
npm run delivery-history -- --preset square-1x1 --since 7d
npm run delivery-history -- --since 30d --limit 100 --oldest
npm run delivery-history -- --since 7d --report
npm run delivery-history -- --repair-tail
npm run delivery-history-reconcile
```

Same query service as the API, so a filter means one thing in both places and
there is no parsing or business logic in `scripts/`. `--report` writes
`delivery-report.md` at the destination — a *view* of the range, regenerated in
full each time and never read back.

### 42.13 UI

- **History** in the header (only once a destination exists) opens the view: the
  destination's counts, three filters (track, format, period) and a
  reverse-chronological list. No charts; there is nothing here to chart.
- Each row shows time, track, format, size and the relative path, tagged
  **re-delivered** where it is not the first time that track and format went
  out, and **reconstructed** for a reconciled event.
- The **track panel** shows its last five deliveries, answering "when did I last
  ship this?" without repeating the global view's filters or summary.
- A log that cannot be read whole says so in a warning with the line numbers,
  and still lists what could be read. **Repair is CLI-only** — the file should be
  looked at before it is rewritten.
- **Reconcile with receipts** is the one write offered, and it only appends.
- Phase 2C-B styling reused: the export list's grid, the existing status colours,
  and the delivery badge's shape for the tags.

### 42.14 Performance

Measured on this machine, with events of ~500 bytes:

| Log size | On disk | Read + filter + summarise |
|---|---|---|
| 100 events | 50 KiB | 0.24 ms |
| 1 000 events | 501 KiB | 1.62 ms |
| 5 000 events | 2.5 MiB | 7.55 ms |

An append is **5.15 ms** on a small log and **9.41 ms** at 5 000 events —
dominated by `fsync`, which is the point of it. It happens once per delivered
file, after a copy that takes far longer.

No watchers, no recursive destination scans, no video hashed or decoded, no
Chromium, no new processes for an append, no new dependencies. Entirely absent
when no destination is configured. Browsing does not read the log: history is
only read when the history view is open or a track panel asks for its own last
five.

### 42.15 Tests (44 added, 280 total)

`tests/delivery-history.test.mts` and `tests/history-process.mts` use real
directories in a temp root and real forked processes, and always pass settings
explicitly so nothing reads or writes the project's own `delivery.local.json`.

Covers: a first delivery, a re-delivery, several formats; a failed copy and a
failed receipt each recording nothing; a log that cannot be written leaving the
delivery successful and saying so; unique ids and an exact key order; a metadata
snapshot surviving later edits; a format recorded in full surviving the preset
list; no absolute path; six concurrent processes and two independent
destinations; an abandoned lock reclaimed and a live one refused; missing, empty,
blank-only, truncated-tail, mid-file-malformed and future-schema logs; repair
doing only the one safe thing; filtering by track, format and date; ordering,
limits and the hard ceiling; summary counts and the local-midnight boundary;
relative periods; re-delivery detection across the whole log; reconciliation
appending once, being idempotent, and reporting what it cannot reconstruct;
release-bundle independence under a corrupt log; the report being deterministic;
and no temp files or locks left at the destination.

One API-integration test covers every refused query shape, the reported bound,
and the methods each route accepts. The CLI is tested on the two paths that do
not depend on machine-local settings (`--help`, a bad `--limit`); the configured
paths were exercised by hand, because a test that wrote `delivery.local.json`
would race every other test in the suite.

### 42.16 Verification performed

- `npm run lint` (ESLint + TypeScript) clean; **280 tests pass**.
- Vite production build passes (the pre-existing >500 kB advisory is unchanged).
- `validate-track` and `prepare-track` on the probe exit 0; `git diff --check`
  clean.
- A real synthetic sequence: a 4-second probe rendered in 16:9, delivered,
  modified at the destination and delivered again, then rendered and delivered
  in 1:1 — **three events**, with the two 16:9 deliveries carrying distinct
  `deliveryId`s. A failed delivery (read-only folder) added nothing. The release
  bundle stayed current with the log deliberately corrupted, and regenerated to
  the same `bundleId`.
- Truncated tail detected with its line number, repaired, and the repair refused
  a second time and on a mid-file-damaged log.
- Reconciliation recovered a delivery made with the log unwritable, then added
  nothing on a second run.
- The API exercised for every filter, every refusal shape, the reported bound
  and both methods. The UI driven in a real headless browser: the history view,
  its filters, the re-delivered and reconstructed tags, the track panel's
  compact list, the damage warning with its line number, and reconciling from
  the panel.
- **Ghetto Geek was not re-rendered and its assets were not touched.**
- Final state: no leaked locks, no leftover fixtures, no temp files, no orphaned
  workers or Chromium, and `delivery.local.json` back to not existing.

### 42.17 Limitations

- **A crash between committing a receipt and appending its event loses the
  event.** Reconciliation recovers it, but only the most recent delivery per
  target, because a receipt is overwritten by the next one.
- **A reconstructed event's track snapshot is current metadata**, not metadata as
  it was. Marked `source: "reconciled"` rather than guessed at silently.
- **Appending after a truncated tail escalates the log to `corrupt`.** Nothing is
  lost and it is visible; repairing the tail first avoids it.
- **`--repair-tail` handles only an incomplete final line.** Damage anywhere else
  is deliberately left for someone to look at.
- **The duplicate check reads the whole log on every append**, so append cost
  grows with history. 9.4 ms at 5 000 events; the read is encapsulated so a tail
  scan can replace it.
- **The whole log is read for a query.** Fine at this scale, and behind one
  function so streaming can replace it.
- **`.delivery-log.lock` is a hidden file at the destination**, briefly. A lock
  from another host, or one whose contents cannot be read, is never reclaimed —
  a stuck lock costs a warning on a delivery that already succeeded.
- **No retention policy, by design.** An append-only audit log should not
  silently discard events, and the log is small: ~500 bytes per delivery, so a
  thousand deliveries is half a megabyte. If it ever matters, archive by moving
  the file aside rather than truncating it.
- **History is per destination.** Changing the destination root leaves the old
  log describing what went to the old place, which is correct but means there is
  no single lifetime view.
- **The log is not encrypted or signed**, and is not intended as tamper-proof: it
  is a local record in a folder the user owns.

### 42.18 Commits

- `efef757` — the event, its snapshot semantics and the reading rules.
- `86d4e1c` — safe append, read, repair and the report writer.
- `1127cf2` — recording a delivery once it is genuinely a delivery.
- `e479d09` — API, CLI and the client.
- `13bcc32` — UI: history view, track panel, tags, warnings.
- `b0ab5e7` — tests against real files and real processes.
- `c75830b` — surfacing "delivered but not recorded".
- Documentation follow-up: this section.

All commits are local only. **Do not push without a new instruction.**

### 42.19 Recommended next major feature (not started)

**Destination health and drift detection.** The tool now knows what should ship
(intent), what has been rendered (manifests), what was copied (receipts), what a
folder says about itself (bundles) and what went out (history) — all from its own
records. What it has never done is look at the destination and ask whether it
still holds what those records claim: a file deleted by a sync client, a folder
renamed by hand, a stray export from a preset no longer intended. One
`stat`-only sweep per track folder, no hashing, reporting drift as a list of
"this is at the destination and should not be" and "this should be and is not",
with no automatic deletion — the user decides. It reuses every existing record,
needs no new persisted state, and closes the one remaining gap between what the
tool believes and what is actually on the disk.

---

*End of handoff. If anything in this document conflicts with the live
repository, the repository is correct — verify with §31 before proceeding.*
