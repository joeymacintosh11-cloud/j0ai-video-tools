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
**§35 covers multi-format export and batching; §36 covers export-what's-missing
and is the newest.**
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

---

*End of handoff. If anything in this document conflicts with the live
repository, the repository is correct — verify with §31 before proceeding.*
