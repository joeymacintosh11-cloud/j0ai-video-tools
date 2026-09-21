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

**§54 (Batch Session Persistence Across Browser Reloads) is the newest state.**
Sections 1–34 describe the project as it stood at the end of Phase 2B.
§35–48 cover formats, batching, export-missing, per-track intent,
stale/re-export detection, cross-process render locks, local delivery,
release bundles, delivery history, destination health and drift, the
destination-wide fix plan, and confirmed delivery after a queued render.
§49 built the Content Package workflow as a read-only, derived view. §50
makes that view's generated copy editable — global templates, per-track
overrides, a whitelisted placeholder renderer — **without changing what §49
derives readiness from**: render freshness, delivery state and package
status are exactly as §49 left them. §51 is a hardening pass over §50, with
no behavior change to §49. §52 adds orchestration across several tracks at
once — inspect, plan and apply several Content Packages together — entirely
on top of §49's single-track resolver and the existing render queue (§37);
it defines no new readiness rule and no second queue. §53 follows the exact
render jobs returned by Apply in the batch panel and refreshes only affected
track packages after terminal events. §54 persists only resumable browser UI
intent and exact job references, then reconstructs everything authoritative
after reload. All of §35–49 landed,
all verified, all still true. Where an older section disagrees with the
code, the code wins.

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

## 43. Audit and Hardening — Delivery History (2026-09-18)

An audit of §42 rather than a new feature. No composition, layout, presets,
render output, delivery or release-bundle behaviour changed, and no
dependencies were added. **Seven defects were found and fixed**, one of them
data loss that reported success. §42 remains accurate except where this section
supersedes it.

### 43.1 Findings

| # | Severity | Finding |
|---|---|---|
| 1 | **Critical** | Appending to a log whose final line was unterminated destroyed that event *and* the new one, and returned `appended: true` |
| 2 | **High** | The append lock could publish itself unreadable, permanently preventing any further history at that destination |
| 3 | **High** | A short `write()` truncated the line silently |
| 4 | **High** | The log or lock path could be a symlink, so writes landed outside the destination |
| 5 | Medium | The first append to a destination was not durable (no directory fsync) |
| 6 | Medium | A failed `close()` after a successful fsync was reported as a failed append |
| 7 | Medium | A repeated event or delivery id in the log read as a healthy log |
| 8 | Low | `repairDeliveryLogTail` threw a raw ENOENT when there was no log |
| 9 | Low | A non-finite `limit` returned an empty page beside a non-zero match count |

All nine are fixed. Each was reproduced first, and each has a regression test
that fails without its fix.

**1 — the critical one.** Whether to terminate the previous line was decided by
whether the *reader had recorded a `truncated` problem*. But a final line can be
unterminated and still parse perfectly well: a short write that stopped on the
closing brace leaves one, and so does any editor that strips a trailing
newline. In that state the log read as `complete`, no problem was recorded, the
append wrote straight onto the end, and the result was one malformed line where
two events used to be — the previous one and the new one both gone, with
success reported. The decision now follows the only thing that matters, which is
whether the file ends in a newline. `DeliveryLogRead.endsWithNewline` carries
it, and it is deliberately *not* inferred from the problem list.

**2.** The lock was created empty with `O_EXCL` and then written into, so a kill
in between left a lock nothing could read. `readOwner` returned null,
`clearAbandoned` therefore refused to touch it, and no delivery to that
destination could ever be recorded again — a permanent silent degradation
caused by exactly the kind of crash this subsystem exists to survive. The
metadata is now staged in a temp file, fsynced, and `link()`ed into place:
`link` still fails EEXIST if the lock is held, so it remains the
exclusive-creation primitive, and a published lock is always complete. A
failed stage leaves nothing behind.

**3.** POSIX permits `write()` to write fewer bytes than requested, and Node's
`fs.write` does not loop — it reports `bytesWritten` and returns. An unchecked
count silently truncates the line. The count is checked and the remainder
written, which is correct here *because the lock is held*: nothing else can
write between a prefix and its remainder, so the two land adjacent. A write
making no progress fails rather than looping. Verified by injection: thirty
forced 10-byte writes, line still whole.

**4.** `assertDeliveryRootFile` validated the *name* but never what was at the
path, so a symlink at `<root>/delivery-log.jsonl` was followed and every
appended event landed wherever it pointed. Reproduced writing into an unrelated
file outside the destination. It now `lstat`s the target and refuses anything
that is not a regular file, and the append passes `O_NOFOLLOW` so a link
swapped in after the check is refused by the kernel rather than followed.

**5.** `fsync` on a file makes its data and size durable but not the directory
entry that first named it, so the very first append to a destination could be
reported as recorded and then vanish with the whole file. The containing
directory is synced on the append that creates the log. This makes the claim in
§42.4 actually true rather than nearly true.

**6.** `close()` ran in a `finally` whose rejection propagated, so a close
failure after a successful write *and* fsync was reported as "not recorded" —
sending the operator to reconcile an event already on disk. It is best-effort
now, and only after the fsync.

**7.** Nothing this tool writes can produce a repeat: the duplicate scan and the
append share one lock. A repeat therefore means the log was edited, merged, or
written by something else, and calling it `complete` vouched for a log that had
not been checked. See §43.4.

### 43.2 Append-lock guarantees

What is guaranteed:

- **Mutual exclusion while the lock is held.** `link()` into a name that already
  exists fails with EEXIST on every POSIX filesystem, so exactly one appender
  holds the lock at a time. Verified with real processes.
- **A published lock is always readable.** There is no window in which an empty
  or partial lock exists.
- **A live owner is never displaced.** Reclaiming requires a dead PID *on this
  host*; a foreign host and an unreadable lock are both left alone by
  acquisition. One-sided, exactly as the render lock is.
- **A displaced owner never removes its successor's lock.** Release re-reads the
  lock and unlinks only if the token is still its own. Verified by planting a
  successor's lock mid-append.
- **Release never throws**, so a finished delivery is never turned into a
  failure by its own bookkeeping.
- **Per destination root**, so two destinations never contend, and nothing
  global is taken.
- **Bounded**: 5s with jittered retries, then it gives up and reports.

What is *not* guaranteed:

- **PID reuse can make a dead owner look alive.** The result is a stuck lock,
  never two appenders — the safe direction. `npm run delivery-history --
  --release-lock` is the operator path: it clears a lock that is unreadable, or
  whose local owner is dead, and refuses a live local owner or a foreign host.
- **A lock from another machine is never reclaimed automatically**, because this
  machine cannot tell whether it is alive.
- **The window between the destination-identity re-check and `open()` is not
  fenced** by a pinned working directory the way the delivery copy is. It is two
  syscalls wide, and `O_NOFOLLOW` covers the symlink case within it. Forking a
  helper for one text append would be disproportionate.

### 43.3 Crash and durability guarantees — stated exactly

The ordering is: acquire lock → read for the duplicate scan → `open` with
`O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW` → write the whole line, looping on a
short write → `fsync` the file → `fsync` the directory if the file was just
created → best-effort `close` → release the lock.

| Crash point | Outcome |
|---|---|
| before `open` | nothing written; the delivery is unrecorded and reported so |
| after `open`, before any write | an empty file may exist; reads as `missing`-equivalent (no events) |
| mid-write | an unterminated final line: `recovered_tail`, every earlier event intact, repairable |
| after write, before `fsync` | **the event may be lost entirely, or present, or partial.** Nothing is claimed here |
| after `fsync` returns | the event is durable; a crash cannot remove it |
| after `fsync`, before `close` | durable; the descriptor dies with the process |
| after `fsync`, before lock release | durable, and the lock is left behind — recoverable by `--release-lock` |

**What is deliberately not claimed:** that an append is atomic with respect to a
crash. It is not, and cannot be, on a plain file. The guarantee is narrower and
sufficient: *once the append returns success, the event has reached the disk*,
and *any crash before that leaves either nothing or an unterminated final line*,
which the reader treats as recoverable rather than as damage. The O_APPEND +
lock combination guarantees non-interleaving between concurrent appenders; it
guarantees nothing about power loss mid-write.

`fsync` is also only as good as the hardware honours it; a drive that lies about
flushing is outside anything this code can establish.

### 43.4 Corruption semantics

Six statuses, in precedence order — `corrupt` outranks `unsupported`, which
outranks `recovered_tail`, which outranks `duplicated`, which outranks
`complete`:

| Status | Meaning | Events returned | Safe to append |
|---|---|---|---|
| `missing` | no log yet | none | yes |
| `complete` | every line parsed, no repeats | all | yes |
| `duplicated` | parsed, but an event or delivery appears twice | all | yes |
| `recovered_tail` | only the final line is unterminated | all earlier | yes |
| `unsupported` | a line from a newer schema version | all readable | **no** |
| `corrupt` | damage somewhere other than the final line | all readable | **no** |

`isSeriousLogDamage` is the single predicate for the last column, and
reconciliation is its only caller — the answer cannot drift between places.

**Readable history is always returned.** One bad line never costs the rest, and
the status is what says something is wrong. Every problem carries a line number;
a `duplicate` problem's number is the position among *parsed events*, which is
the line number only when nothing ahead of it failed to parse, and its message
says "event N" so it cannot be mistaken for an exact line.

**Repair only ever drops an unterminated final line.** It refuses `complete`,
`missing`, `duplicated`, `unsupported` and `corrupt`, prints what it discarded,
holds the append lock while it rewrites, and reports rather than throwing when
there is no log. Repeated repair is idempotent and never drops a valid event —
tested three times over on the same log.

**Appending after `recovered_tail`** terminates the fragment so the new event
lands whole, which escalates the log to `corrupt`. That is the deliberate
trade: nothing is lost and the damage is visible. Repairing first avoids it.

### 43.5 Duplicate prevention

The duplicate scan and the append happen under the same lock, so the check
cannot go stale between them. `deliveryId` is a hash of the receipt, so:

- a retried completion step is recognised and nothing is written;
- **two processes completing the same delivery produce exactly one event** —
  verified with real processes, one reporting `appended`, the other `duplicate`;
- a genuine re-delivery has a new receipt, a new timestamp and a new file mtime,
  so it is never suppressed;
- reconciliation racing a live append is safe: reconciliation's pre-computed
  set may be stale, but the per-append check under the lock is authoritative, so
  the loser is counted as already recorded.

### 43.6 Reconciliation limits (unchanged, restated precisely)

What reconciliation **can** do: append an event for a receipt that has none,
from the receipt alone, idempotently, marked `source: "reconciled"`.

What it **cannot** do, and does not pretend to:

- **Recover more than the latest delivery per target.** A receipt is overwritten
  by the next delivery of the same export, so earlier lost events are gone.
- **Reconstruct metadata as it was at delivery time.** Nothing records that. A
  reconstructed event carries *current* metadata and is marked as reconstructed
  in the log, the CLI and the UI. Its timestamp, size and fingerprint are the
  real recorded ones.
- **Find a receipt for a retired preset.** It enumerates `RENDER_PRESET_IDS`, so
  a receipt whose preset no longer exists is invisible to it.
- **Report a malformed receipt.** `readDeliveryReceipt` returns null for one and
  it is skipped silently, so a corrupt receipt looks like no receipt.
- **Append onto a `corrupt` or `unsupported` log.** It refuses, because
  appending onto damage buries it.

### 43.7 Query and date correctness

Confirmed by test: `from` inclusive and `to` exclusive (so adjacent ranges never
double-count, and `from === to` is empty); timezone-offset timestamps compare as
the same instant as their UTC equivalents; a malformed `from`/`to` is ignored
rather than matching nothing; ordering is by delivery time with append order as
a deterministic tie-break; "today" is local midnight, which is correct across a
DST shift because it is derived from local date components; summaries always
describe the whole log and never the filtered page; re-delivery is decided
against the whole log, not the returned page.

Limits: the API refuses anything outside 1–500 outright. The domain clamps
defensively — a non-finite limit now falls back to the default rather than
returning an empty page, and out-of-range values clamp instead of inverting.

### 43.8 Performance at scale

Re-measured on this machine, events of ~600 bytes:

| Events | On disk | Full read | Filter | Summary | Re-delivery scan | Append |
|---|---|---|---|---|---|---|
| 1 000 | 0.6 MiB | 1.0 ms | 0.3 ms | 0.3 ms | 0.2 ms | 9.4 ms |
| 10 000 | 5.7 MiB | 10.6 ms | 2.7 ms | 1.7 ms | 2.2 ms | 18.1 ms |
| 50 000 | 28.4 MiB | 55.8 ms | 12.9 ms | 8.6 ms | 11.3 ms | 65.7 ms |

Linear, as a full read must be. 50 000 events is on the order of a century of
daily deliveries; at that size an append costs 66 ms, once per delivered file,
after a copy that takes seconds. **No optimisation was made**, deliberately.

If it ever matters, the smallest safe improvement is to bound the duplicate scan
to the tail of the log rather than all of it — a retried completion is always
recent. It is not done now because it narrows a correctness property (a
duplicate anywhere is currently caught) to buy performance nothing needs. An
index or a database would be the wrong answer at any size this reaches.

### 43.9 Failure states on each surface

| State | API | CLI | UI |
|---|---|---|---|
| no destination | `root: null` + `rootProblem` | refuses, names `--set-root` | "nothing delivered from here yet" |
| missing log | `status: "missing"` | "No deliveries have been recorded" | empty-state line |
| `recovered_tail` | `statusNote` + problem lines | `!` note + line numbers | warning naming `--repair-tail` |
| `duplicated` | `statusNote` + problem lines | `!` note + line numbers | warning, both views |
| `unsupported` | `statusNote` | `!` note | warning |
| `corrupt` | `statusNote` | `!` note | warning |
| append failed after delivery | `historyProblem` on the outcome | `!` line + reconcile command | "not recorded in the delivery log" |
| stuck lock | `historyProblem` | message names `--release-lock` | shown on the delivery outcome |
| partial reconciliation | `unreconcilable[]` with reasons | one line per skipped receipt | counts including "could not be reconstructed" |

The track panel previously showed its rows with no indication that the log
behind them was damaged; it warns now. **No surface reports a damaged log as a
successful, complete answer.**

Repair and lock release stay CLI-only: both rewrite or remove something, and the
file should be looked at first. The UI names the command instead of offering a
button.

### 43.10 Tests (21 added, 301 total)

`tests/delivery-history-safety.test.mts`, with `tests/history-lock-process.mts`
for a child that holds, repairs or appends on command.

Failure injection where that is the only way to reach the defect: a patched
`FileHandle` forces thirty short writes (line still whole) and a
zero-progress write (fails rather than looping); a patched `close` rejects after
a successful fsync (still reported as recorded); `writeSync` is made to fail
during lock publication (no lock and no temp file left, destination still
usable).

Real processes where the claim is about processes: a live holder waited for and
never stolen with a bounded wait; an owner displaced mid-write leaving its
successor's lock alone; two processes completing the same delivery recording it
once; a repairer racing an appender. That last has two correct outcomes
depending on who wins, so it asserts the invariant — no valid event lost, the
appended event present, and the only unparseable text still the original
fragment — rather than one of them. Run six times to confirm both branches pass.

Also: four shapes of unterminated tail, each preserving what preceded it; a
symlinked log and a symlinked lock both refused with the target untouched; a
directory where the log belongs; a destination whose identity changes while an
append waits on the lock; repeated repair; duplicate event and delivery ids;
corruption outranking duplication; the lock-release policy in all five states;
and the limit and date edge cases.

### 43.11 Remaining medium and low risks (documented, not fixed)

- **A crash between the receipt commit and the append still loses the event.**
  Unchanged and inherent; reconciliation recovers the latest per target.
- **Append cost grows linearly with the log**, because the duplicate scan reads
  all of it. Measured above; not optimised.
- **The whole log is read for a query.** Behind one function so streaming can
  replace it.
- **The re-check-to-`open` window is not fenced by a pinned directory.** Two
  syscalls wide; `O_NOFOLLOW` covers the symlink case.
- **A `duplicate` problem's line number is an event index**, not an exact file
  line, when something ahead of it failed to parse. Said so in the message.
- **A malformed delivery receipt is skipped silently** by reconciliation and
  looks like no receipt.
- **Reconciliation cannot see receipts for retired presets.**
- **PID reuse can wedge the lock** until `--release-lock` is run.
- **`fsync` is trusted.** Hardware that lies about flushing defeats it.
- **The log is not signed or tamper-proof.** It is a local record in a folder the
  user owns; `duplicated` reports the one tampering signature that is cheap to
  detect, not all of them.
- **No retention**, by design.

### 43.12 Commits

- `a3ad0d6` — the seven append-path fixes: unterminated-line data loss, lock
  publication, short writes, symlink fencing, first-append durability, close
  handling, duplicate reporting, limit clamp.
- `5b0d734` — surfacing: the track panel's damage warning, `--release-lock`, and
  one shared "safe to append" predicate.
- `8efdb98` — the regression tests and the two child processes.
- Documentation follow-up: this section.

All commits are local only. **Do not push without a new instruction.**

### 43.13 Recommended next major feature (not started)

Unchanged from §42.19: **destination health and drift detection**.

## 44. Current State — Destination Health & Drift Detection (2026-09-19)

Every delivered track can now be checked against what is physically at the
destination, not only against the records the app keeps about it. No
composition, layout, presets, render output, locking, delivery, release-bundle
or delivery-history behaviour changed. No dependencies were added. Nothing
here ever writes to or deletes from the destination — detection and reporting
only, exactly as asked.

### 44.1 What it answers

A release bundle says what a track *currently ships*, computed from receipts
and manifests — it never looks at the destination's own contents. The
delivery log says what *went out*, as a history. Neither has ever noticed a
file deleted by a sync client, a folder renamed by hand, or a leftover export
from a preset that no longer exists. This closes that gap:

- Which files should exist and do?
- Which files should exist but are missing?
- Which files exist but are no longer expected?
- Which delivered files were externally replaced or modified?
- Which release bundles are missing or outdated?
- Which track folders disappeared or were renamed?
- Is the destination root itself healthy?

### 44.2 Health model

`src/domain/delivery/destinationHealth.ts` is browser-safe and holds the
finding codes, their severities, the filename rules, and the messages — one
policy, read by the server, the CLI and the UI alike.

**Top-level status**, one of five:

| Status | Meaning |
|---|---|
| `not_configured` | no destination — nothing to scan |
| `healthy` | scanned cleanly, nothing found |
| `drift` | scanned cleanly, at least one finding of any severity |
| `unavailable` | the configured root cannot be reached at all — the same fact delivery and release bundles already call `rootProblem` |
| `error` | reserved for the scan itself failing to run; in practice unreachable, because every per-item failure below is caught and turned into a finding rather than aborting |

**Finding severity** is a fixed function of the code, never a judgment call
made where a finding is raised:

| Severity | Codes |
|---|---|
| `error` | `destination_root_identity_changed`, `destination_folder_unreadable`, `track_folder_missing`, `delivered_file_missing`, `destination_file_unreadable` |
| `warning` | `delivered_file_changed`, `unexpected_export_file`, `release_bundle_outdated`, `release_bundle_pair_mismatch` |
| `info` | `unexpected_track_folder`, `release_bundle_missing` |

### 44.3 Finding codes

The brief's suggested list included two pairs that name one fact twice:
`receipt_without_file` is `delivered_file_missing`, and
`file_without_matching_receipt` is `unexpected_export_file`. Two names for one
finding would only make call sites guess which to check, so each pair is one
code here, and the choice is documented in the domain module itself.

- **`delivered_file_missing`** — a receipt says a file was delivered; it is
  not there any more.
- **`delivered_file_changed`** — a receipt says a file was delivered; what is
  there now does not match what was recorded (size or modification time —
  never a hash). Includes a file replaced by a symlink, worded specifically as
  such.
- **`track_folder_missing`** — a track has at least one delivery receipt, but
  its entire folder is gone. A roll-up: the per-preset
  `delivered_file_missing` findings still fire alongside it.
- **`destination_file_unreadable`** / **`destination_folder_unreadable`** — a
  path a receipt names, or a folder the scan needs to list, could not be
  examined — a permissions problem, not absence. See §44.5.
- **`unexpected_export_file`** — a file in a track's own folder matches this
  app's naming (`<slug>-…mp4`) but no current receipt accounts for it. Covers
  an export from a retired preset, a manually copied MP4, or a leftover from a
  changed delivery folder.
- **`unexpected_track_folder`** — a root-level folder looks app-managed
  (carries `release.json`/`release.md`, or an mp4 named for a *current*
  preset) but no active track's folder resolves to it. Catalogue scans only.
- **`destination_root_identity_changed`** — the configured root no longer
  resolves to itself; see §44.4.
- **`release_bundle_missing`** / **`release_bundle_outdated`** /
  **`release_bundle_pair_mismatch`** — see §44.7.

### 44.4 Expected-vs-actual, and root identity

"Expected" is entirely records the rest of the app already trusts:
`deliveryStateForTarget` (the exact function delivery itself calls) for every
preset's receipt, and `releaseBundleStateFor` (the exact function release
bundles call) for bundle state. Neither is re-implemented; both are called
precisely as their existing owners call them, so "drift" means one consistent
thing everywhere in the app.

Receipts are read for **every** `RENDER_PRESET_IDS`, not only a track's
currently intended formats — a receipt is a strong claim regardless of whether
the format is still intended today, and dropping a format from intent does not
un-deliver a file that is genuinely still sitting there. Section 4's caution is
followed precisely: a format that was never delivered produces no finding at
all, intended or not.

**Root identity** is a check nothing else in the app makes.
`resolveDeliveryRoot` re-resolves the stored path fresh on every call, so if
that path has quietly started resolving somewhere else — a parent directory
swapped, or the leaf itself replaced by a symlink — it would otherwise be
followed in silence, with delivery and release bundles both simply starting to
use the new target without complaint. The health scan checks
`realpathSync(settings.root) === settings.root` once per scan and reports
`destination_root_identity_changed` when it is not, without changing
`resolveDeliveryRoot`'s own behaviour anywhere else.

### 44.5 Delivered-file checks: missing versus unreadable

Kept apart everywhere, using `lstat` rather than the broader exception a
permissions problem and a genuinely absent path otherwise both collapse into.
A destination with its permission bits removed must never read as "every
delivered file is gone" — that would send someone to re-deliver files that
were never actually lost. Concretely:

- `deliveryStateFor`'s `destination_missing` reason collapses ENOENT with
  several other causes (a refused symlinked parent, a broken symlink). The
  scan `lstat`s the same path itself afterwards: ENOENT means genuinely
  missing (`delivered_file_missing`); anything else means something is there
  but could not be read as expected (`destination_file_unreadable`).
- The same distinction is made for a track's own folder: `lstat` succeeding
  with `ENOENT` means the folder is gone (`track_folder_missing`, only when a
  receipt says it should exist); any other error means it could not be seen
  (`destination_folder_unreadable`) — found and fixed while building the test
  for a permission-denied root (§44.11).
- Only filesize and modification time are compared, never a hash, per the
  brief. A same-sized replacement is still caught, because a genuine copy
  changes the modification time too — tested explicitly.
- A delivered file replaced by a symlink is `delivered_file_changed`, worded
  as a replacement by a link rather than left to read as an ordinary
  modification.

### 44.6 Unexpected files and folders — the "managed filename" rule

Centralised in one place, `looksLikeManagedExportFile(filename, slug)`:
`filename.startsWith(`${slug}-`) && filename.toLowerCase().endsWith(".mp4")` —
exactly the scheme `deliveryRelativePath()` writes, read back rather than
duplicated. A file that does not start with the track's own slug is left alone
completely, however export-like it looks: a stray `trailer.mp4`, a home movie,
or `notes.txt` sitting in the folder is never this scanner's business. Dotfiles
(`.DS_Store`, this app's own transient `.delivery-log.lock`) and the two bundle
files (`release.json`, `release.md`) are recognised and never flagged.

A file passing that check is `unexpected_export_file` unless a current receipt
(for any preset, matched by basename, checked against the *currently
configured* root) names it — covering an export from a preset that has since
been retired, since the naming check does not require the preset id to be one
this build still knows.

**Orphaned folders** use a narrower, separate predicate,
`looksLikeManagedTrackFolder`, checked only against *current* preset ids —
deliberately narrower, since an orphan is worth a look specifically when it
still carries today's naming, which is what a track renamed or removed
recently leaves behind. Checked only for a **catalogue-wide** scan: judging a
folder orphaned needs every active track's folder loaded, which a scan
narrowed to specific tracks does not have.

### 44.7 Release bundle health

Entirely delegated to `releaseBundleStateFor` — the exact function release
bundles themselves call, per the brief's "do not rewrite bundle logic." Its
`missing`/`outdated`/`current` freshness maps to:

- `missing` **and** something has actually been delivered → `release_bundle_missing`.
  `missing` with nothing delivered is not a finding at all — bundle generation
  may simply not have been run yet, which is normal.
- `outdated` → `release_bundle_outdated`, *unless* a light, additional,
  read-only comparison finds the two published files' own ids disagreeing with
  **each other** — using only the already-exported `releaseBundlePaths`,
  `readMarkdownBundleId` and `shortBundleId` — in which case it is the more
  specific `release_bundle_pair_mismatch`. One file missing while the other is
  present falls back to the general `outdated` finding, since a genuinely
  absent half is not a *disagreement* between two present files; documented as
  a deliberate choice rather than an oversight.
- `current` → no finding.

Changing the delivered file itself (§44.5) correctly cascades into
`release_bundle_outdated` too, since the bundle's own fingerprint incorporates
delivery state — a real, expected second finding, not a duplicate report of
one fact. Verified by test.

### 44.8 Destination root health

Reuses `resolveDeliveryRoot`/`assertDeliveryRoot` exactly as delivery and
release bundles do — no broadened semantics. A missing root, one that is not a
directory, or one inside the project all surface as `unavailable` with the
same `rootProblem` message those other features already produce. A root that
resolves fine but cannot be **listed** (permissions) is a `drift` finding
(`destination_folder_unreadable`), not `unavailable` — the destination is
reachable, the scan simply could not see inside it, and the distinction
matters because `unavailable` would otherwise wrongly suggest delivery itself
is broken.

### 44.9 Point-in-time semantics

A scan is a snapshot, not a transaction. No lock is taken anywhere — a health
scan has no business holding a render or delivery-log lock, since it changes
nothing. Every filesystem call is wrapped so a file, folder, or track
disappearing between one call and the next produces a coherent (if slightly
stale) finding rather than a thrown exception:

- a file vanishing between `readdir` and the follow-up `stat` for its size
  yields the finding with no size, rather than crashing the whole scan —
  verified by injecting an `ENOENT` on exactly that call;
- a track's delivery folder changing between one scan and the next is simply
  reflected in the next scan, reading current metadata each time;
- a delivery happening concurrently with a scan is not fenced against, on
  purpose — the scan would either see the delivery's result or not, both
  coherent outcomes, and serialising a read-only report behind the render lock
  would slow down real work to protect a value that is stale the instant it is
  returned regardless.

This is documented, not hidden: `scannedAt` is part of every result, and nothing here claims to be live.

### 44.10 Path safety

Reuses the existing fencing throughout — `deliveryFolderFor` for every folder
name, `deliveryStateFor`/`assertDeliveryDestination` for every delivered-file
path — rather than inventing a parallel check. Two additions came directly out
of testing this scan specifically:

- **A track folder replaced by a symlink is never followed.** The
  folder-existence check uses `lstat`, which a symlink can never report as
  `isDirectory()`, so it reads as `track_folder_missing` and the
  unexpected-file sweep (which needs `readdir`) never runs through it.
  Verified by pointing such a symlink at a folder holding a file named
  `secret.txt` and confirming it never appears anywhere in the result.
- **A `deliveryFolder` value crafted to escape the root** (`"../../etc"`,
  written directly to `metadata.json`, bypassing the normal validated write
  path) is neutralised twice over: strict metadata parsing already rejects the
  whole document over it, so the scan falls back to the track's own slug; and
  the scan's own `try`/`catch` around `deliveryFolderFor` is real
  defence-in-depth, not merely unreachable code, proven by calling it directly
  with the same value.

No shell-string copying anywhere; every path is built with `path.join`/`path.resolve` and validated before use.

### 44.11 A gap found while testing, and fixed

The folder-existence check originally treated any `lstat` failure the same
way — `ENOENT` and `EACCES` both became `folderExists = false`. Under a
permission-denied root, that meant every track with receipts was reported as
`track_folder_missing`, even though the folder was sitting there untouched —
misleading, and exactly the kind of finding that would send someone to
re-deliver files that were never lost. Found while writing the
permission-denied-root test, fixed before it landed: `ENOENT` alone means
missing; anything else means `destination_folder_unreadable`. The equivalent
distinction for individual files (§44.5) was designed in from the start.

### 44.12 API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/destination-health` | `track` (repeatable) for named tracks; omitted scans the catalogue |

Read-only, matching delivery history's shape. No path is ever accepted — the
destination comes from stored settings. Each `track` value is validated as a
slug; an invalid one is refused before anything is scanned.

### 44.13 UI

- **Delivery settings** gains a "Destination health" section with a "Scan
  destination" action. One step, not two: unlike delivery and release bundles
  there is nothing to confirm, since a scan never writes anything.
- The same `DestinationHealthPanel` component, parameterised by `tracks`,
  reused inside a track's own Delivery section as "Check this track" —
  exactly how `DeliverPanel`/`ReleaseBundlePanel` are already shared between
  the catalogue and single-track contexts.
- A small badge per track in the list, but **only once a catalogue scan has
  actually named that track** — no badge reads honestly as "not scanned this
  session," never as a stale or invented answer. Held in React state only,
  fed by the settings panel's scan; never fetched automatically, never
  persisted.
- Findings render with the same three severities the validation notes already
  use (`.note--error`/`.note--warning`/`.note--info`, the last one added by
  this milestone).
- Repair actions (re-deliver, regenerate a bundle) are not duplicated inline
  per finding — they already sit one section away in the same Delivery panel.
  No "Fix All" anywhere, and no action here ever touches the destination.

### 44.14 CLI

```console
npm run destination-health
npm run destination-health -- --track ghetto-geek
npm run destination-health -- --json
```

Shares `scanDestinationHealth` with the API — no filesystem-walking logic in
`scripts/`. The human view groups findings by track; `--json` prints the raw
result for scripting. Exits non-zero when at least one `error`-severity
finding is present, or the destination is unavailable — never merely because a
scan ran, and it changes nothing regardless of the exit code.

### 44.15 Performance

Measured on this machine:

| Scale | Scan time |
|---|---|
| 10 tracks, 10 managed files | 3.5 ms |
| 100 tracks, 100 managed files | 27.7 ms |
| 50 tracks, ~1,000 managed files (dense) | 16.4 ms |

Roughly linear in the number of files touched, as a `readdir`-based sweep must
be. One `readdir` per folder that matters (the root, once, for a catalogue
scan; each track's own folder), a handful of `stat`/`lstat` calls per track,
and the delegated `deliveryStateForTarget`/`releaseBundleStateFor` calls the
rest of the app already pays for elsewhere. No video is hashed, decoded, or
even opened; no `ffprobe`; no recursive scan of anything outside the
destination's top level and each track's own folder; no watchers; no
Chromium; no new dependencies. No new persisted state anywhere — a result is
computed fresh every call and held, if at all, only in the caller's own
memory.

### 44.16 Tests (30 added, 331 total)

`tests/destination-health.test.mts`, real directories, every fixture delivered
through the genuine pipeline (`publishExport` + `deliverExport`) so every
receipt starts internally consistent, then drifted by mutating the
*destination* only — never the receipt — matching what the scanner actually
exists to notice.

Covers all 30 scenarios in the brief: a healthy destination and an
unconfigured one; a root that is gone, one that cannot be listed, and one
silently replaced by a symlink; a delivered file matching, deleted, resized,
replaced by same-sized content caught only through mtime, and replaced by a
symlink; a managed-looking file with no receipt and a file clearly outside the
naming convention (including a filename that is literally the bare slug);
an orphaned folder found only on a catalogue scan; every release-bundle
finding, including the deliberate pair-mismatch-versus-outdated distinction; a
partial delivery and an empty one, both healthy; a missing file and an
unaccounted-for file reported together in one scan; a file vanishing between
listing and inspection (via a targeted `statSync` mock, the same technique
used in the delivery-history hardening pass); a folder rename reflected in the
next scan; a folder replaced by a symlink, never followed, with an outside
secret file proven absent from the result; a traversal-shaped `deliveryFolder`
neutralised twice over; single-track versus catalogue scope; and a full scan
over every kind of drift at once, followed by a byte-for-byte comparison of
the whole destination before and after, proving nothing was written.

The first draft of this suite had eight failing tests. All eight were the
suite's own mistakes, not product bugs — traced individually before any fix
was applied: three tests never generated a release bundle and were then
surprised by the (correct) `release_bundle_missing` finding; one compared two
strings of different lengths twice in a row while trying to prove a
same-length replacement is still caught; one registered a redundant
permission-restoring cleanup hook that ran after the directory was already
removed (Node's test hooks run in registration order, not reverse); one
expected an exact track list from a catalogue scan without accounting for this
repository's own `ghetto-geek`; and the traversal test's original premise was
wrong — strict metadata parsing already rejects the whole document over an
invalid `deliveryFolder`, so the value never reaches the scanner's own
defence, which the test now proves separately and directly.

### 44.17 Verification performed

- `npm run lint` (ESLint + TypeScript) clean; **331 tests pass**, the
  destination-health suite specifically run three further times (30/30 each).
- Vite production build passes (the pre-existing >500 kB advisory is
  unchanged).
- `validate-track` and `prepare-track` on `ghetto-geek` exit 0;
  `git diff --check` clean.
- A real synthetic probe, end to end: a 2-second track rendered, delivered,
  bundled — confirmed healthy (0 findings) — then one delivered file deleted
  and one unexpected managed-looking export added — confirmed exactly the
  three expected findings (missing, unexpected, and the correctly cascaded
  outdated bundle) — then every fixture removed.
- A separate benchmark run (10 / 100 / ~1,000 managed files) confirmed
  near-linear scaling with no surprises, then fully cleaned up.
- **Ghetto Geek was not re-rendered and its assets were not touched.**
- Final state: no leaked locks, no leftover fixtures, no temp files, no
  orphaned workers or Chromium, `delivery.local.json` back to not existing.

### 44.18 Limitations

- **A scan is read-only and point-in-time**, by design (§44.9) — it is a
  report, not a guarantee, and nothing here re-checks itself after returning.
- **`unexpected_track_folder` only runs for a catalogue-wide scan.** A
  single-track request cannot safely judge "orphaned" without the whole
  catalogue's folder set loaded.
- **The managed-filename rule is a naming convention, not a content check.**
  A file that happens to be named `<slug>-<anything>.mp4` is judged purely by
  its name; nothing here opens or inspects file contents, exactly as the brief
  asks.
- **A malformed delivery receipt reads as no receipt** (the existing
  `readDeliveryReceipt` behaviour, reused as-is), so a track whose receipt is
  corrupted is treated as never having been delivered there rather than as a
  specific "receipt unreadable" finding.
- **Reconciling `release_bundle_missing` under a permission-denied root**
  behaves the same as a genuinely absent bundle, because the bundle read
  treats `EACCES` and `ENOENT` identically — reasonable (either way nothing
  readable was found), but slightly less precise than the delivered-file
  checks' own missing-versus-unreadable distinction. Documented rather than
  fixed, since reaching in to change that would mean touching
  `releaseBundleState`'s internals, which this milestone deliberately does
  not do.
- **No optional safe actions are embedded per finding** (reveal, re-deliver,
  regenerate a bundle) — those already sit one section away in the same
  Delivery panel for the same track, so duplicating them inline was judged
  unnecessary rather than valuable. Documented as a deliberate scope decision.
- **No new persisted state, by design.** A destination scanned once and never
  again simply shows no badge — there is nothing to go stale, because nothing
  is kept.

### 44.19 Commits

- `0bbc49d` — the health model: finding codes, severities, the managed-filename
  rule, messages.
- `ca36c10` — the scanning service: expected-vs-actual, root identity,
  missing-versus-unreadable, release bundle checks.
- `25a1e8e` — API, CLI and UI.
- `598ff15` — tests.
- Documentation follow-up: this section.

All commits are local only. **Do not push without a new instruction.**

### 44.20 Recommended next major feature (not started)

**A destination-wide dry-run "fix" plan** — not an automatic fix, which every
instruction for this milestone was explicit about avoiding, but a *planned*
one: given the findings this scan already produces, generate the exact list of
safe, reversible actions that would resolve each one (re-deliver a missing or
changed file, regenerate an outdated bundle) using entirely existing
operations, present it for review, and let the person run it — or not. This
keeps detection and remediation as two separate, explicit steps, with a human
between them, while finally answering "now that I know what's wrong, what do I
actually click?"

---

## 45. Destination Health audit and hardening (2026-09-19)

This pass audited the completed feature in §44. It did not add remediation,
change render output, or write to a configured destination. The repository,
not the historical descriptions above, remains authoritative.

### 45.1 Findings and fixes

No confirmed critical issue required a design change. The following high-risk
issues were reproduced and fixed:

1. A configured root replaced by a symlink was *reported* but then scanned
   through the link. The scanner now refuses it before `resolveDeliveryRoot`
   can inspect the target. It pins the root's device and inode for the scan,
   checks its canonical path again after local inspection and before subsequent
   destination work, and stops with `error` if the root changes. Destination
   directory listings are synchronous, avoiding an event-loop gap between a
   check and the corresponding read. A deterministic directory-swap test proves
   the scan stops before track reads.
2. A delivered leaf replaced by a symlink could pass the shared delivery-state
   size/mtime comparison if its target copied those attributes. The shared
   state check now uses `lstat` and requires a regular file; the health scanner
   reports a receipt-backed link as `delivered_file_changed` without following
   it. A regression fixture copies the recorded attributes.
3. The unexpected-export sweep used `stat` on links, and bundle freshness used
   ordinary file reads on bundle leaves. The sweep now reports a link without
   statting its target. Bundle reads use `O_NOFOLLOW` plus `fstat` on the opened
   descriptor. The health scanner reports a linked bundle leaf as unreadable.
4. A receipt for a previous delivery folder could suppress an unreceipted
   file with the same basename in the new folder. A receipt now covers an
   export only when both its root and complete relative path match the active
   folder. A moved-folder regression proves the file is reported.
5. A track folder replaced by a link was described as gone. It is now an
   unreadable/non-directory entry and bundle inspection is skipped. An unknown
   named track now makes a scan `error` while preserving other results. Named
   slugs are validated even when no destination is configured. The API rejects
   empty and over-100 track lists instead of silently widening an empty scope
   to a catalogue scan; the CLI rejects unknown options.
6. A UI result could be carried between selected tracks or remain as a
   catalogue badge after the configured destination changed. The track detail
   is keyed by slug, catalogue badges are cleared when settings change, and
   the display explicitly says when the scan ran and that content was not
   compared. A partial/failed scan cannot display the healthy message.

### 45.2 Guarantees and limits

- The configured root must still be a real directory at its stored canonical
  path. During a scan, its device/inode is pinned and rechecked before the
  scanner proceeds. A root that is missing before the scan is `unavailable`;
  a root that changes during it is `error` with a root finding. A root that
  merely loses listing permission produces `destination_folder_unreadable`.
- Receipt-backed delivered leaves are checked as regular files with `lstat`.
  A symlink, FIFO, socket, or directory cannot be called a current delivered
  file. Size and mtime are compared with the receipt. **Neither those fields
  nor inode alone prove content identity.** A regular replacement with the
  same size and copied mtime can still appear current because old receipts do
  not record destination inode or a content digest. No MP4 hashing was added.
- Track folders must be real directories before listing. Unexpected export
  links are named but their targets are not statted. Bundle leaves are opened
  with `O_NOFOLLOW`. Relative path construction still goes through the
  existing delivery-folder and destination fences. The scanner does not
  recurse into arbitrary subfolders.
- A concurrent process can mutate a pathname in the small interval between
  a parent check and a path-based operation. Node's path-based directory APIs
  do not provide a portable `openat`-style pinned subtree here. The checks
  make ordinary mutation fail closed, but this scan is **not a security
  boundary against an adversarial process continuously swapping directories**.
  It takes no lock and is a best-effort point-in-time report, not a transaction.
- Receipt parsing remains the existing service's policy: malformed or
  unsupported receipts read as absent. A file with a matching managed name
  then appears unexpected; if that file is also gone, the scan cannot infer
  the old delivery. Receipts for retired current-build presets are read even
  when the format is no longer intended. A format never delivered is not
  flagged simply for being intended.
- Release freshness remains delegated to `releaseBundleStateFor`. The scan
  only distinguishes a readable pair mismatch from the service's ordinary
  outdated result. A malformed JSON bundle is treated by that service as
  missing; an unreadable half is not distinguished from an absent half.
- Delivery history is independent: no log is read to derive health. A missing,
  corrupt, unsupported, repaired-tail, or duplicated history cannot change
  receipt/file/bundle findings.

### 45.3 Finding evidence and uncertainty

| Code | Triggering evidence | Plausible false positive | Plausible false negative |
|---|---|---|---|
| `destination_root_identity_changed` | Stored path resolves elsewhere, is a link, or changes dev:ino during scan | Intentional remount or replacement | Replacement already present before first scan with the same canonical path cannot be compared with a persisted identity |
| `destination_folder_unreadable` | Listing or checking a required directory fails; an entry is not a real directory | Transient permission or mount change | Permission restored before the check |
| `track_folder_missing` | Folder absent and a matching receipt claims a delivery | Folder being renamed during scan | No valid current receipt survives to establish the claim |
| `delivered_file_missing` | Matching receipt, `ENOENT` on delivered leaf | File appears just after check | File disappears after check |
| `delivered_file_changed` | Matching receipt, link/nonfile or size/mtime mismatch | Metadata-only touch or same content copied anew | Regular replacement with same size and copied mtime |
| `destination_file_unreadable` | Claimed leaf or bundle entry cannot be examined as a regular file | Brief access failure | Access restored after check |
| `unexpected_export_file` | File in active track folder follows `<slug>-*.mp4`, no receipt for that exact root/path | A manually copied user MP4 with matching name | Old slug, different case/Unicode spelling, nested file, malformed name |
| `unexpected_track_folder` | Unclaimed root folder contains release bookkeeping or a current-preset-shaped MP4 | Unrelated folder with generic `release.json`/`release.md` or matching filename | Retired preset only, nested files, empty orphan, case/Unicode spelling |
| `release_bundle_missing` | Readable bundle absent according to bundle-state service, and a current matching receipt exists | Malformed or unreadable JSON also reads missing | No valid receipt even though a bundle used to exist |
| `release_bundle_outdated` | Bundle-state service says outdated, pair IDs not demonstrably different | Concurrent metadata/delivery edit during scan | A state change after scan; no content hashing |
| `release_bundle_pair_mismatch` | Both readable files carry different IDs | One half updated during scan | A missing, malformed, or unreadable half is classified by broader bundle state |

Managed-looking filenames are *signals*, not proof of app ownership. Dotfiles,
temporary files without `.mp4`, files with `.mp4.bak`, and unrelated nested
files are outside this nonrecursive rule. Case and Unicode variants are not
normalized. Those conservative choices leave known false negatives and avoid
claiming that arbitrary user files were delivered by the app.

### 45.4 Performance and verification

Fresh local synthetic fixtures were created and removed in `finally` blocks.
The catalogue measurements include the repository's existing track. Dense
file measurements use one named synthetic track. RSS and heap deltas are
post-GC process measurements, so they are indicative rather than isolated
per-scan allocations.

| Scale | Time | RSS delta | Heap delta |
|---|---:|---:|---:|
| 101 tracks / 100 managed files | 42.0 ms | 6.3 MB | 0.4 MB |
| 501 tracks / 500 managed files | 160.2 ms | 12.1 MB | 0.4 MB |
| 1 track / 1,001 managed files | 3.4 ms | 0.1 MB | 0.4 MB |
| 1 track / 5,001 managed files | 13.5 ms | 0.6 MB | 1.5 MB |

Instrumented runs used 101 and 501 tracks respectively. `readdirSync`
calls were 101/501, `lstatSync` 1,918/9,518, `statSync` 609/3,009,
`realpathSync` 2,217/11,017, and `readFileSync` 1,215/6,015. These totals
include existing track inspection, coverage and bundle-state services, not
only the new scanner. No video was read, hashed, decoded or probed.

Regression tests cover root symlink and mid-scan directory replacement,
metadata-matched delivered symlink, unexpected export link, moved-folder
receipt, linked bundle, validation without config, invalid/partial named
scope, API scope limits and CLI malformed arguments. The destination suite
was rerun repeatedly. Full test, lint/TypeScript, Vite build, `validate-track`,
`prepare-track`, and `git diff --check` were run. The first sandboxed full
test run could not bind localhost (`listen EPERM`); the authorized rerun
passed. Final verification: **342/342 tests**, **40/40 destination-health
tests** (run repeatedly), lint/TypeScript clean, Vite build passed with its
existing chunk-size advisory, and both track commands exited 0. The project
had no `delivery.local.json` before or after this pass. Benchmark fixtures,
temporary files, locks and Remotion workers were absent at the end. Existing
user Chrome processes were not touched. No production destination was written.

### 45.5 Remaining medium/low risks

- Exact copied size and mtime on a regular replacement remains undetectable
  without a stronger receipt and migrated history; this pass kept the current
  stat-based contract explicit.
- A malformed receipt loses evidence of a missing delivered file, and bundle
  state collapses unreadable/malformed published JSON into `missing`.
- Orphan and export naming can produce both false positives and false
  negatives as listed above. The scanner does not inspect MP4 contents.
- A scan can combine observations from adjacent moments during delivery or
  metadata edits. A rescan is the correct way to check the settled state.
- The directory-parent swap race described in §45.2 would require a different
  filesystem access primitive for a strict adversarial guarantee.

**Audit commits:** `de44b71` — harden the scanner and its shared read paths,
API/CLI/UI edge states, and regression tests; companion documentation commit
records this audit.
No push was made.

## 46. Current State — Destination-Wide Dry-Run Fix Plan (2026-09-19)

Destination health (§44–45) could only ever say what was wrong. This turns a
health scan's findings into a reviewed, typed plan of remediation actions —
and, only on a second, explicit step, runs the safe part of it. Detection and
remediation stay two separate concerns in two separate modules, exactly as
health detection stayed separate from delivery and release bundles: nothing
in the planner re-derives freshness or bundle state, and nothing in the
executor re-implements a copy, a render, or a bundle write.

### 46.1 Action model

`src/domain/delivery/destinationFixPlan.ts` is browser-safe and holds the
action shape, the fixed safety table, deterministic ids, deduplication, and
the execution-result vocabulary.

Four action kinds, each with a fixed safety:

| Kind | Safety | What it reuses |
|---|---|---|
| `redeliver` | safe | `deliverExport` |
| `rerender_and_deliver` | safe | the existing render queue (`renderManager.startBatch`), never a synchronous in-process render |
| `regenerate_release_bundle` | safe | `generateReleaseBundle` |
| `manual_review` | manual | nothing — never run, with or without `--apply` |

There is no `no_action` kind, though the original brief suggested one: every
finding this scanner currently raises maps to one of the four above, and an
unreachable fifth kind would be exactly the unused abstraction this project
avoids. If a finding is ever added that truly implies no action, the kind
should arrive together with that finding, not before it.

**Action ids are deliberately not a hash of every field.** `redeliver` and
`rerender_and_deliver` share one id "family" — `remediationActionId` folds
`rerender_and_deliver` onto `redeliver` before hashing (see the `idKind`
comment in the domain module) — because they are mutually exclusive
alternatives for fixing the exact same delivered-file drift, and which one
applies can flip purely because the canonical export's freshness changed
between a `plan` call and the `apply-plan` call that follows it. Without this,
an apply call started against a `redeliver` id would find nothing in a freshly
re-derived plan the moment the export went stale, and — before this was
caught in testing — would have been reported `skipped_already_fixed`, which
is false: nothing was fixed, the plan just needed to do something different.
Hashing is FNV-1a, not cryptographic; the id is a matching key inside one
plan/apply pair, never a security boundary; see the CLI/API section (46.5)
for why the client cannot use it to invent an operation.

### 46.2 Finding → action mapping

Built in `server/services/destinationFixPlan.ts`, which is impure by
necessity — deciding *which* action applies means asking whether the
canonical export is current, which means calling `trackExportCoverage`, the
same function delivery and export planning already call.

- **`delivered_file_missing` / `delivered_file_changed`** — `redeliver` if
  `trackExportCoverage` reports the canonical export `current`, else
  `rerender_and_deliver`. `invalid` freshness (unreadable inputs) counts as
  "not current" too, so it is never silently redelivered.
- **`release_bundle_missing` / `release_bundle_outdated` /
  `release_bundle_pair_mismatch`** — `regenerate_release_bundle`, one action
  per track regardless of which of the three codes fired; §46.3 covers the
  merge.
- **`unexpected_export_file`, `unexpected_track_folder`,
  `destination_file_unreadable`** — `manual_review`. An unreadable entry is
  manual rather than assumed-missing for the same reason the scanner itself
  distinguishes `ENOENT` from everything else (§44.11): guessing "it's gone"
  when it might just be unreadable could propose a redelivery over content
  that was never actually lost.
- **`track_folder_missing`** — folded into whichever per-preset
  redeliver/rerender actions already exist for that track (a missing folder
  always co-occurs with per-preset delivered-file findings, since the
  scanner checks each receipt before it checks the folder itself), rather
  than becoming a fifth action kind of its own. `deliverExport` recreates a
  missing folder as an ordinary part of delivering into it.
- **`destination_root_identity_changed`, and a track-level
  `destination_folder_unreadable`** — blocks planning for the affected scope
  entirely (§46.4), never proposes anything.
- **A whole-plan root problem** (`unavailable`/`error` status, or a
  blocking root finding) — the plan is exactly the root finding(s) as
  `manual_review`, nothing else. Never proposes re-rendering as a fix for a
  missing mount, per the brief's explicit instruction.

### 46.3 Deduplication

`dedupeActions` merges actions that share an id, folding their finding codes
together. The only case this matters for today: a track can have up to three
release-bundle finding codes (missing, outdated, pair-mismatch) at once —
only one is possible per scan in practice, since bundle freshness is a single
categorical value, but the merge is exercised directly by a unit-style
scenario (a missing delivery *and* a missing bundle) that proves exactly two
actions come out, not one per finding.

### 46.4 Dependency model

Deliberately not a generic workflow engine — two tiers, not a general DAG. A
track's `regenerate_release_bundle` action `dependsOn` every
redeliver/rerender action the same plan proposed for that track; nothing else
declares a dependency. The executor runs an iterative settle loop: an action
runs once every dependency *named in the same apply call* has settled, and is
reported `blocked` — never silently skipped, never silently run early — if a
dependency was left out of the apply call entirely, or did not itself
complete or get skipped-as-already-fixed. A queued rerender is not a settled
success for this purpose: its dependent bundle action is blocked until a
later plan confirms the delivery it implies actually landed.

### 46.5 Dry-run and apply semantics

`planDestinationFix` never writes anything; it calls `scanDestinationHealth`
and `trackExportCoverage`, both already read-only. `applyDestinationFixPlan`
takes only action ids (plus the same track-scope the plan was made with) and
**re-derives the plan fresh before doing anything else**. Every id it is
asked to run is looked up in that fresh plan, never trusted from what the
caller remembers:

- An id absent from the fresh plan and never replaced by one sharing its
  identity → `skipped_already_fixed` — the drift is genuinely gone.
- An id present but not safe/executable (a manual item) → `manual`, never run.
- An id present and safe → revalidated a second time, immediately before the
  underlying operation runs (`executeDeliveryAction` re-checks freshness and
  current delivery state; bundle regeneration and delivery are themselves
  already idempotent no-ops when nothing has changed, so a second identical
  apply naturally settles to `skipped_already_fixed`/no-op rather than
  duplicating work).

No lock is taken across an apply call. Each underlying operation already owns
its own safety — `deliverExport`'s render-target lock, `generateReleaseBundle`'s
own idempotent, order-safe two-file publish, the render queue's own
per-target lock — so two concurrent applies interleave exactly as two
concurrent manual deliveries already would. This is an existing,
already-relied-upon guarantee, not a new one made here, and it is why no new
locking primitive was added for this milestone.

### 46.6 No-delete guarantee

Nothing added here can delete or overwrite a file the app did not itself
deliver. `unexpected_export_file`, `unexpected_track_folder`, and every
unreadable-entry finding map only to `manual_review`, which the executor
refuses to run regardless of what a client asks for (its safety is fixed in
the domain module's table, not computed at the call site). Verified directly:
a test applies every safe action from a full plan and asserts a manually
planted unexpected file's content is byte-for-byte unchanged afterward.

### 46.7 API

`POST /api/destination-health/plan` — always dry-run; body mirrors delivery
and export-missing (`{"tracks":[...]}` or `{"catalogue":true}`).
`POST /api/destination-health/apply-plan` — same body plus `"actionIds"`. The
client can never supply a filesystem path or an operation kind — only ids,
which the server matches against its own freshly-derived plan before running
anything. This is the "server-authoritative execution" pattern the brief
asked for, achieved without inventing a persisted plan store: the plan is
recomputed, not looked up.

### 46.8 CLI

`npm run destination-fix-plan [-- --track <slug>]... [--json] [--apply]`.
Dry run by default; `--apply` is required to run anything, and even then only
executable actions run — printed with a `DRY RUN — no files were changed`
line when `--apply` is absent, matching the brief's explicit labelling
requirement. Shares `planDestinationFix`/`applyDestinationFixPlan` with the
API, so there is exactly one finding-to-action policy in the codebase.

### 46.9 UI

`DestinationFixPlanPanel` extends the destination health flow: "Create fix
plan" (which runs its own health scan internally, so it never depends on
`DestinationHealthPanel` having already been used) shows SAFE actions as
pre-selected, individually-deselectable checkboxes and MANUAL items as plain,
unselectable rows, then "Apply N safe actions" runs only the selected ones and
shows a per-action result list afterward with a reminder to re-scan. No
automatic action ever runs when a scan or a plan completes — Apply is always
a second, explicit click. Wired into both the catalogue-wide Delivery
settings section and a track's own Delivery section, next to
`DestinationHealthPanel` in each.

### 46.10 Race handling

Tested directly, not just reasoned about: a redeliver whose canonical export
is deleted between `plan` and `apply` is reclassified into a queued rerender
(never blindly delivers a now-wrong file); a delivery that genuinely fails at
apply time (a read-only destination folder, simulated via `chmod`) blocks its
dependent bundle action but never touches an unrelated track's own action in
the same apply call; applying the same plan twice is idempotent
(`skipped_already_fixed` the second time, confirmed via a subsequent health
scan still reporting `healthy`); an apply against an action id a fresh plan no
longer produces at all is reported `skipped_already_fixed` rather than an
error. Two concurrent applies were not given a dedicated regression test — the
guarantee they rely on (each underlying operation's own lock) is exercised
directly by the existing render-lock and delivery-history duplicate-protection
suites, and re-deriving that coverage here would only duplicate it.

### 46.11 Failure handling

A `redeliver`/`rerender_and_deliver` action failure never marks unrelated
actions failed — only its own dependents, and only within the same apply
call. `applyDestinationFixPlan`'s settle loop reports each action
independently; nothing here rolls back an action that already completed
because a later one in the same call failed.

### 46.12 Tests added

25 tests in `tests/destination-fix-plan.test.mts`, same conventions as the
destination-health suite: real temp directories, delivery always through the
real pipeline, drift created by mutating only the destination. Two design
bugs were found and fixed *while writing these tests, before any assertion
failed* — both are documented at the point they are fixed in the code and
summarized in §46.1 and §46.10: the id-family normalization (without it, a
plan/apply pair the very first regression test exercised would have silently
misreported real drift as fixed), and the earlier session's already-known
`t.after` FIFO-ordering pitfall (a `chmod`-restore hook registered after
`destination(t)`'s own cleanup hook fires after it, not before — restored
inline in the test body instead, not via a second `t.after`).

### 46.13 End-to-end results

A full synthetic probe was run twice: once purely over HTTP against a
locally-started API server (configure a temp destination, deliver a real
current export, delete the destination copy, `POST .../plan`, confirm a
`redeliver` action, `POST .../apply-plan` with every proposed action id,
confirm every result `completed`, re-`GET` health and confirm `healthy`), and
once end-to-end through a real headless Chrome instance driven over a raw CDP
WebSocket (no puppeteer/`@remotion/renderer` wrapper — `openBrowser`'s
`newPage()` is shaped for render-page pooling, not general navigation, so a
plain Chrome process launched with `--headless=new --remote-debugging-port=0`
was driven directly): loaded the app, selected the synthetic track, clicked
"Check this track", clicked "Create fix plan", confirmed both a redeliver and
a bundle-regeneration action appeared with a working "Apply" button, clicked
it, and confirmed a "Results" section appeared showing both actions
`[Done]`. All probe artifacts (the synthetic track, the temp destination, the
API/Vite/Chrome processes, `delivery.local.json`) were removed afterward and
verified gone; `public/tracks/` and `out/` were confirmed back to holding
only `ghetto-geek`. Ghetto Geek itself was never re-rendered.

### 46.14 Verification results

`npm run lint` (eslint + tsc) clean. Full suite: **367/367 tests** (342
existing + 25 new), rerun and stable. `npx vite build` passed (existing
chunk-size advisory, unrelated). `validate-track`/`prepare-track` against
`ghetto-geek` both exit 0. `git diff --check` clean. Working tree clean after
every commit; no `delivery.local.json` before or after any of the work above.

### 46.15 Performance

Planning is exactly one health scan (already measured at §45.4) plus, only
for tracks with a finding, one `inspectTrack` + `trackExportCoverage` call —
work already paid for elsewhere in the app for any track being looked at.
Execution cost is dominated entirely by the underlying operation it reuses
(a copy, a bundle write, or — via the existing render queue — a render); no
new scan, no new filesystem sweep, no polling loop was added for this
milestone.

### 46.16 Remaining limitations

- A queued rerender's delivery is not confirmed within the same apply call —
  by design (no synchronous in-request rendering, no new progress transport,
  per the brief). A later plan/apply, or the existing render UI, confirms it
  landed.
- `manual_review` items never get a "Reveal in Finder" affordance in this
  milestone; `DeliveryRevealPanel`'s existing reveal action is one track/preset
  away from being wired to a manual finding's slug, deferred rather than
  bolted on without a concrete need.
- No stale-plan detection beyond id-based revalidation — a plan object itself
  carries no version or timestamp check; `apply-plan` simply never trusts
  anything from the client except ids, which is the guarantee that actually
  matters.
- Concurrent-apply safety is inherited, not independently proven for this
  milestone specifically (§46.10).

### 46.17 Commits

1. `a23bf63` — define the remediation action model (domain).
2. `f0d4bc9` — the planner and the safe executor/revalidation (service).
3. `71244dd` — API, CLI, UI.
4. `3e833f7` — tests.
5. (this commit) — documentation.

No push was made.

### 46.18 Recommended next feature

**Confirmed delivery after a queued render.** Right now a `rerender_and_deliver`
action queues a render and stops — its dependent bundle update is left
`blocked` until someone re-runs the plan by hand. A small, explicitly-scoped
follow-up could let the *existing* render job view (already polled/SSE'd by
the UI) trigger a one-shot "finish this plan" re-check once a specific queued
job reaches a terminal state — never a new watcher or background polling loop
of its own, just reusing the job status the render queue already tracks, the
same "reuse, don't invent" boundary this milestone kept throughout.

Not started, per instruction.

## 47. Current State — Confirmed Delivery After a Queued Render (2026-09-19)

§46.18 named the gap: a `rerender_and_deliver` action could only ever queue
a render and stop. This closes it — the render manager remains the one
source of truth for a job's status; nothing here adds a second store, a
watcher, or a new queue.

### 47.1 Render-job correlation

`queueOrAdoptRender` (in `server/services/destinationFixPlan.ts`) makes one
call, `renderManager.startBatch([{slug, preset}])`, and reads the job id back
from either `batch.jobs` (this call queued it) or, if the render manager's
own dedup skipped it as already active, `renderManager.listJobs()` (adopts
the existing job). One call, no window between "check" and "queue" for a
second caller to slip through — the correlation is exactly as strong as the
render manager's own guarantee that one track/format pair never has two
jobs. Every result that queued or followed a render carries that job's id.

### 47.2 Waiting/follow mechanism

`server/services/renderFollow.ts` — `followRenderJob(jobId, timeoutMs)` —
checks the job's current status first (a very fast render, or a job this
call adopted after it already finished, is reported immediately), then
subscribes to the render manager's own event emitter and resolves on
`completed`/`failed`/`cancelled`, or on a `setTimeout` if none arrives in
time. No polling inside the server. Both the CLI and the UI panel do poll —
the CLI directly against the in-process render manager, the UI via the
existing per-job SSE endpoint — but only ever to *display* progress; the
authoritative wait lives entirely in `followRenderJob`.

### 47.3 Timeout semantics

A `timed_out` result means this call stopped watching, nothing about the
render. `followRenderJob`'s timer only ever resolves the promise; it never
touches the job, never sends a cancel, never marks anything failed. Verified
directly: a test follows a job with a 50ms timeout, confirms the result is
`timed_out` and the job is still `preparing`/`rendering` (not `cancelled`),
then lets the same job complete normally afterward — proving the render
manager's own state was never touched by the timeout.

### 47.4 Cancellation

A cancelled render never reaches delivery — `followRenderThenDeliver` checks
`job.status === "cancelled"` before ever calling `deliverIfNeeded`, and
returns `cancelled` with no attempt at delivery. Covers a job cancelled by
this apply call's own timeout region (never happens — see §47.3), a job
cancelled by an unrelated call to `POST /api/renders/:jobId/cancel` while
this one is watching (the render manager's own event fires `cancelled`
regardless of who asked), and a job cancelled before it ever started
rendering (the render manager already finishes a queued-then-cancelled job
as `cancelled` with no worker involved at all; `followRenderJob`'s own
already-terminal check catches this the same way it catches a fast
completion).

### 47.5 Render failure behaviour

`render_failed` carries the render manager's own error message. Nothing is
delivered, nothing on disk is touched, and any dependent bundle action —
via the same dependency/settle logic §46.4 already built — is reported
`blocked`, never attempted, because `render_failed` is not `completed` or
`skipped_already_fixed`.

### 47.6 Delivery behaviour

Delivery, after a successful followed render, goes through the exact same
`deliverIfNeeded` helper an ordinary immediate redeliver uses — never a
direct file copy — with everything revalidated fresh rather than trusted
from before the wait: `resolveDeliveryRoot` again, `inspectTrack` again,
`trackExportCoverage` again. If the export is somehow still not current at
this point (the only realistic cause: metadata changed again while the
render was running), the result is `blocked` with a plain explanation,
*not* a second render queued from inside an already-bounded wait — that
would turn one apply call into an unbounded chain. A fresh plan/apply
decides what happens next.

### 47.7 Bundle follow-up

Unchanged in mechanism from §46.4 — a bundle action still only runs once
every delivery action the same apply call named has settled cleanly. What
changed is that a `render_failed`/`delivery_failed`/`cancelled`/`timed_out`
delivery result now correctly blocks its dependent bundle the same way a
plain `failed`/`blocked` one always did, without the dependency logic itself
needing to change at all — it already treats "anything other than completed
or skipped_already_fixed" as unmet.

### 47.8 Revalidation during the wait

Covered by §47.6: `deliverIfNeeded` re-derives destination root, track
existence, and export freshness from scratch, every time it runs, whether
called immediately or after a wait. Nothing computed before `followRenderJob`
is trusted afterward.

### 47.9 Duplicate/concurrent apply

Two concurrent `applyDestinationFixPlan` calls for the same action converge
on one render job (§47.1) and both `subscribe` to it — the render manager's
listener set already supports multiple subscribers per job, so both callers
are notified once it settles. Delivery itself is protected by the same
target lock `deliverExport` has always taken: whichever caller's copy runs
first holds it; the other, revalidating fresh, most often sees `delivered`
already and reports `skipped_already_fixed`, or — if it raced into the copy
before the first one released the lock — a clean `delivery_failed` rather
than a corrupted double-write. No new locking was added; this is the same
guarantee ordinary concurrent manual deliveries already relied on. Verified
directly with two concurrent apply calls sharing one render job: exactly one
render manager job is ever created, at least one caller reports `completed`,
neither reports a crash, and the destination ends up correctly delivered.

### 47.10 Restart / lost waiter

**Not durable, and not made durable.** An HTTP request `await`ing inside
`applyDestinationFixPlan` holds its wait entirely in that request's own
process memory. If the server process is killed or crashes mid-wait, that
waiter is gone with it — no fake "completed" result is ever invented, and
none is persisted anywhere to survive the restart. The render job itself is
a separate question: a graceful shutdown (`renderManager.shutdown()`, the
same one `SIGINT`/`SIGTERM` already trigger) cancels anything in flight; a
hard kill leaves an orphaned child process not tracked by anything. Either
way, a later `plan`/`apply-plan` call is what recovers: it re-scans current
state and proposes whatever is actually true then, never assumes what an
earlier, now-gone wait might have found.

### 47.11 API changes

`POST /api/destination-health/apply-plan` gains optional
`waitForCompletion` (boolean, default `false`) and `timeoutMs` (number,
default 5 minutes, clamped to 30). Both are request-body fields the server
validates and clamps itself — never trusted as-is — matching the existing
"server re-derives the plan, the client only ever names ids" contract. No
new endpoint: this was a deliberate, conservative extension of the one that
already existed, per the brief's own instruction to prefer that over adding
surface area.

### 47.12 UI changes

`DestinationFixPlanPanel` now makes Apply a two-call flow when a
`rerender_and_deliver` action is involved: a fast call without
`waitForCompletion` queues renders and collects their job ids, a
`FollowedRender` row per job reuses the existing `useRenderJob` SSE hook to
show live status inline (Queued/Preparing/`Rendering NN%`), and once every
followed job has settled (tracked via a small `settledJobIds` set and a
guarded `useEffect`) the panel automatically re-applies the same action ids
with `waitForCompletion` to get the authoritative, confirmed result. No
second progress transport was added — the SSE stream is the exact one the
render panel elsewhere in the app already consumes.

### 47.13 CLI changes

`npm run destination-fix-plan -- --apply` gains `--wait` and
`--timeout <seconds>` (default 300). Without `--wait`, behaviour is
unchanged: `[queued]` and a note to add `--wait`. With it, the script polls
the same in-process render manager the API reads from, printing a status
line only when it changes, until every queued job is terminal or the
timeout elapses — then makes one more `applyDestinationFixPlan` call with
`waitForCompletion` to fetch the confirmed final results. This polling is
purely for what the terminal prints; it is not a second implementation of
the wait itself, which still lives entirely in `followRenderJob`.

### 47.14 Result model

`RemediationActionResult` gained `jobId`, `startedAt`, `completedAt`, and
`healthConfirmed` (all `| null`, defaulting to `null` via `settle`'s new
optional fourth argument). Deliberately did not add nested `renderResult`/
`deliveryResult`/`bundleResult` objects as the brief's own suggestion listed:
`status` plus `reason` already say what happened in each phase without
duplicating state the render job's own (already fetchable) view already
carries, and the brief itself warns against dumping internal process
objects across the wire.

### 47.15 Health confirmation

Runs once per `applyDestinationFixPlan` call, after the whole settle loop
finishes — not inside `followRenderThenDeliver` itself. This was a real
design correction made while writing the tests (§47.16): confirming health
immediately after a delivery, before a same-call dependent bundle action has
even run yet, would falsely report `healthConfirmed: false` for the single
most common real scenario (rerender + bundle applied together). One scan
now covers every track this call successfully rerendered-and-delivered,
never the whole catalogue, and a root problem or scan failure taints the
confirmation without ever pretending the delivery itself failed.

### 47.16 Tests added

7 tests in `tests/destination-fix-plan-render.test.mts`, run against the
real `renderManager` singleton with `child_process.fork` mocked, discovered
the hard way to need scoping *only* to the render-worker call: mocking it
globally made a genuine delivery attempt hang forever, because
`stageDelivery.ts` forks its own, separate copy-worker process for the same
cross-process-safe-copy reason renders use a lock, and a fake, silent
process standing in for it left `deliverExport` waiting on IPC that would
never arrive. Every other fork call is passed through to the real
implementation. A second, unrelated timing bug surfaced investigating that
same hang: a test helper bounded a wait by iteration count rather than
elapsed time, and bare `setImmediate` ticks with nothing else queued can
burn through hundreds of iterations in under a millisecond — nowhere near
enough real time for the production code's own genuine async work (a forked
subprocess, a health scan) to interleave and finish. Rewritten to a
wall-clock deadline. Both fixes, and the `healthConfirmed` timing correction
in §47.15, are documented here exactly because none of them were caught by
a failing assertion first — they were process hangs and false negatives
found by tracing execution, the harder and more honest way.

Covers: the full happy path through a confirmed bundle update and a
confirmed health check; a render that fails while followed; a render
cancelled while followed; a caller timeout that never cancels the
underlying job (proven by letting it complete afterward); a delivery that
fails right after a successful followed render, with the new export kept;
two concurrent callers for the same target converging on one job; two
different presets for the same track each following their own distinct job
within one apply call.

### 47.17 End-to-end results

A real, unmodified API server (`server/app.ts`'s `handleRequest`, in-process
so its render manager singleton could be driven) with only the render-worker
`fork()` call replaced by a fast fake — delivery's own copy-worker fork left
completely real — proved, over genuine HTTP:

- **Happy path**: plan proposed `rerender_and_deliver` + `regenerate_release_bundle`;
  apply with `waitForCompletion` returned `completed`/`completed`,
  `healthConfirmed: true`; a follow-up `GET /api/destination-health` reported
  `healthy`.
- **Render failure**: a simulated worker error produced `render_failed`
  with the render manager's own message, as its own distinct final state.
- **Delivery failure**: a successful simulated render followed by a
  read-only destination folder produced `delivery_failed`, distinct from
  both the happy path and the render failure.

Then a real headless Chrome session, driven over a raw CDP WebSocket exactly
as the previous milestone's own UI verification did, loaded the app,
selected a synthetic track, clicked "Check this track", "Create fix plan",
and Apply, observed the panel's "In progress" section appear (live,
SSE-backed job status), settled the simulated render, and watched the panel
automatically re-apply and land on `[Done] redeliver` / `[Done] regenerate_release_bundle`
— the action correctly read as a plain redeliver on the confirm call, since
the render it had just followed made the canonical export current again,
demonstrating the redeliver/rerender identity-sharing from §46.1 doing
exactly the job it was built for. All synthetic tracks, the temp
destination, the API/Vite/Chrome processes, and `delivery.local.json` were
removed and verified gone afterward; `public/tracks/` and `out/` were
confirmed back to holding only `ghetto-geek`, never re-rendered.

### 47.18 Verification results

`npm run lint` (eslint + tsc) clean. Full suite: **374/374 tests** (367
existing + 7 new), the new file rerun 3 additional times for stability.
`npx vite build` passed (existing chunk-size advisory, unrelated).
`validate-track`/`prepare-track` against `ghetto-geek` both exit 0.
`git diff --check` clean. Working tree clean after every commit; no
`delivery.local.json`, no leftover processes, and `public/tracks/`/`out/`
confirmed holding only `ghetto-geek` at the end of every verification pass,
including after the debugging sessions that required force-killing hung
processes (§47.16) — those left orphaned fixture directories once, found
and removed before continuing.

### 47.19 Performance

No polling inside the server at all — `followRenderJob` is purely
event-subscription plus one timer. The CLI's and the UI's own polling exist
only to print/display progress and are bounded (1s interval, capped by the
same timeout) and outside the server process entirely. Confirmation adds
exactly one additional narrow health scan per apply call that used
`waitForCompletion` and had at least one successful rerender, never one per
track and never the catalogue.

### 47.20 Remaining limitations

- Multiple `rerender_and_deliver` actions in one `waitForCompletion` apply
  call are followed sequentially, not concurrently — the settle loop awaits
  each action fully before starting the next. Since the render manager only
  ever runs one render at a time regardless, this costs wait-call overhead,
  never actual render time, and only matters when several rerenders land in
  the same apply call with waiting on.
- No mechanism confirms a `timed_out` or a not-`--wait`ed `queued` action
  later on its own — per §46.18/this milestone's own scope, that would need
  a new trigger (a UI/CLI re-check, or the recommended-but-deferred
  job-status-driven re-check), never a background watcher.
- A root problem discovered mid-wait (destination unplugged while a render
  was in flight) is caught by `deliverIfNeeded`'s fresh `resolveDeliveryRoot`
  check after the render settles, reported `blocked` — but the render itself
  still ran to completion having no way to know the destination had become
  unreachable, since nothing here watches destination state during a render.

### 47.21 Commits

1. `eeb79e0` — define the confirmed-render outcome vocabulary and result fields (domain).
2. `22b6733` — `followRenderJob` and the executor's wait/confirm/revalidate logic (service).
3. `54c9143` — API, CLI, UI.
4. `53f1a6a` — tests.
5. (this commit) — documentation.

No push was made.

### 47.22 Recommended next feature

**A durable, opt-in "notify me" for a still-running remediation.** Right now
closing the tab or the terminal after `--wait`/an unconfirmed apply loses
the wait; the render itself keeps going, tracked by the render manager as
it always was, but nothing chains delivery to it automatically afterward. A
small, narrowly-scoped follow-up: when the *existing* render job reaches a
terminal state, check whether a fix-plan action is still known to be
waiting on it (kept in memory only, tied to the render manager's own job
lifecycle, never a new persisted store) and, if so, run exactly the
confirm step this milestone already built. Still no watcher polling the
filesystem, no database, no cron — purely reacting to an event the render
manager already emits, the same "reuse, don't invent" boundary every
milestone in this project has kept.

Not started, per instruction.

## 48. Confirmed Delivery lifecycle audit and hardening (2026-09-19)

This pass audited the completed feature in §47. The repository was clean at
`b3b10d2` before the audit. No render output was changed, no new queue or
progress transport was added, and nothing was pushed. The audit used the real
render-manager singleton and real delivery/copy, receipt, history, bundle, and
health paths; only the expensive render-worker process was replaced at the
controlled worker boundary in lifecycle tests.

### 48.1 Confirmed high-risk findings and fixes

1. **The UI/CLI second apply could start a replacement render.** The first
   apply returned `queued` with a job id, but the later confirmation only sent
   action ids. A fresh plan after a failed or cancelled render still wanted a
   rerender and could queue it again. The confirmation call now sends
   `followJobs: [{actionId, jobId}]`. The executor verifies the job belongs to
   the exact slug and preset of that freshly derived action and follows only
   that job. A missing or mismatched job is `blocked`; failure and cancellation
   are reported from that same job, with no replacement. Fresh server-side
   planning still decides whether a selected action is safe and needed.
2. **A render could finish between status lookup and subscription.**
   `followRenderJob` now subscribes and re-reads manager state. It also handles
   a synchronous terminal callback during registration, clears its timer and
   listener on every ordinary settle/timeout, and re-reads terminal state at
   the timeout boundary. A completed, failed, or cancelled job cannot be
   missed at this boundary. The SSE route likewise re-reads after subscribing.
3. **Live destination configuration could change during a render.** API and
   CLI apply calls now let the executor read live settings; it checks that the
   configured root still matches before delivery, bundle generation, and
   health confirmation. A change blocks use of the earlier root. Existing
   delivery code still revalidates root identity, export freshness, target
   lock, and staged copy before publication.
4. **A few results overstated certainty.** A vanished action under a blocked
   plan is now `blocked`, rather than `skipped_already_fixed`. Health
   confirmation refuses scan errors, unavailable/unconfigured roots, root
   findings, and invalid tracks. A completed delivery can still have
   `healthConfirmed: false` when other findings remain. CLI `timed_out` now
   exits as failure and does not run a late confirm call; `--timeout` rejects
   malformed/nonpositive values and caps at 1800 seconds.

### 48.2 Lifecycle contract after the audit

- **Job correlation:** `startBatch` decides whether to queue the exact
  `(slug, presetId)` target. An in-process nonterminal job for the same exact
  pair may be adopted; a different preset, track, historical terminal job,
  or cross-process lock is never adopted. Two concurrent calls converge on
  one in-process job. The second-call confirmation is pinned to the original
  job id and target.
- **Wait/timeout/cancel:** A waiter timeout ends only that observation; it
  does not cancel the render or mutate the returned result later. Cancellation
  prevents delivery when the manager settles the render as `cancelled` before
  the follower begins post-render delivery. Once a render is `completed` and
  delivery has begun, render cancellation cannot revoke the copy. The
  delivery target lock and publication checks govern that phase.
- **Render failure:** Worker failure/cancellation ends the action as
  `render_failed`/`cancelled` and blocks its dependent bundle. A manager
  `completed` state alone never authorizes a copy: the executor re-inspects
  the track and requires a current canonical export. If output or manifest
  is missing/stale, the action is `blocked` and no new render is started in
  the same bounded wait.
- **Delivery and history:** Post-render delivery goes through `deliverExport`.
  Its per-target lock, staged atomic publication, receipt commit, and
  idempotent history recording remain authoritative. Concurrent followers
  may produce one `completed` and one `skipped_already_fixed`, or a truthful
  `delivery_failed` on lock contention; the test observed one remediation
  history entry and coherent health after two callers woke on one render.
  Retrying a failed delivery can use a current canonical export as a
  redelivery without rerendering.
- **Bundles:** Only selected bundle actions run. A bundle requiring a
  delivery waits for that action to complete; failed, cancelled, timed-out,
  or merely queued prerequisites block it. Other tracks continue. A bundle
  failure does not retroactively mark a successful copy failed.
- **Health scope:** `healthConfirmed` is set only for a completed result with
  a followed job id, after the whole selected action loop. It is a scan of
  the named track(s), not a global catalogue claim. A missing selected bundle,
  manual finding, unexpected file, scan error, or changed root can leave it
  false even when delivery was completed. Unrelated tracks are outside this
  confirmation scope.
- **UI/SSE:** The panel keeps showing an in-progress state until its exact
  job ids settle and the server confirms delivery. Apply and plan buttons
  are disabled during the follow-up. The SSE route replays terminal manager
  state at the subscription boundary; the hook deduplicates terminal
  callbacks and uses `GET /api/renders/:id` on SSE error. SSE carries
  progress; server job state and the apply result decide the outcome.
- **HTTP/restart:** A disconnected waiting HTTP caller does not cancel its
  server-side apply or render; the request handler can finish work after the
  socket closes. Jobs and waiters are in memory. A server restart loses them
  and does not fabricate delivery or health confirmation; a later fresh plan
  can inspect canonical export and destination state and remediate manually.

### 48.3 Regression and resource evidence

The lifecycle file grew from 7 to 17 tests. New cases include exact failed,
cancelled, successful, absent-output, and wrong-target job confirmation;
terminal events at the follow and SSE subscription boundary; live destination
config change; unexpected-file health; and 40 concurrent followers mixing
short timeouts with full waits. The latter asserted listener counts return to
baseline after timeout/completion and finished in about 7 ms in an isolated
run. The server wait uses one subscription and one timer per caller, with no
polling. Existing render-manager and delivery tests cover worker exit/error,
locks, receipts, history deduplication, bundle publication, and cancellation
of queued/active jobs. API input validation and CLI timeout parsing gained one
test each. The full suite grew from 374 to 386 tests.

A default-concurrency run briefly failed in an existing single-track planner
test: its catalogue scan included another test's temporary `public/tracks`
fixture just as that fixture was deleted, yielding `ENOENT` for its metadata.
The new lifecycle tests use explicit slug scopes; the pre-existing planner
tests that assert only one/two tracks were narrowed to those fixture slugs.
The intentionally catalogue-wide orphan test remained catalogue-wide. The
subsequent default-concurrency full suite passed **386/386**; the lifecycle
file was also rerun repeatedly without failure. This is a test-fixture race,
not evidence of a render/delivery correctness failure. A wider change to all
shared-directory fixtures was outside this pass.

Verification: `npm run lint` (ESLint + TypeScript), `npm test` at default
concurrency, `npx vite build`, `npm run validate-track -- ghetto-geek`,
`npm run prepare-track -- ghetto-geek`, and `git diff --check` all passed.
The Vite large-chunk advisory remains. `public/tracks` and `out` contained
only Ghetto Geek after the suite. No real render was run. A focused
`/usr/bin/time -l` attempt showed the 40-waiter test itself passing but the
macOS `sysctl kern.clockrate` memory report was denied by the sandbox; no
quantitative memory claim is made.

### 48.4 Remaining medium/low limits

- There is no durable in-memory-job handoff after server restart, browser
  refresh, component unmount, or a CLI timeout. The user can re-open a fresh
  plan; no background follow-up is promised.
- The CLI polls job state once per second solely for terminal progress text;
  the server waiter is event-driven. A CLI deadline can expire just before a
  terminal transition; `timed_out` then reports the caller's observation,
  and a retry can inspect the completed job/fresh plan.
- A destination settings change after the last explicit root check but before
  a copy commit is a small residual window. The delivery pipeline still
  enforces its root identity, target lock, source freshness, and safe path
  checks. An in-flight apply does not get retroactively cancelled.
- An HTTP disconnect does not abort a waiting executor, so a long request can
  continue until its bounded timeout; it does not corrupt manager state.
- The panel does not persist queued action/job pairs across refresh. It
  cannot display a completed delivery it never confirmed. Recovery requires
  a new plan/apply interaction.

### 48.5 Local commits

1. `2c1d198` — exact-job confirmation, render/SSE lost-event protection,
   live-root guards, truthful results, and UI/CLI follow-up behavior.
2. `9237921` — lifecycle/API/CLI regressions and single-track test isolation.
3. (this commit) — this audit record.

No push was made.

---

## 49. Current State — The Toshi Content Package Workflow (2026-09-20)

The newest layer. Read this after §48; where the two disagree, this wins. No
composition, layout, presets, brand sources, render pipeline, render queue,
locking, delivery, release-bundle or destination-health behavior changed —
this milestone is additive only. No new dependencies, no cloud services, no
databases, no watchers, no publishing APIs, and nothing here uploads to
YouTube, Instagram or TikTok.

### 49.1 The question this answers

"For this beat, what content do I need for YouTube, Reels/TikTok and
Instagram, what is ready, what is stale or missing, what metadata accompanies
it, and how do I generate the complete package?"

A **content package** is a track's platform-facing outputs, described
together. It is **derived, not persisted** — there is no "package complete"
flag written anywhere, and no new manifest file competes with the release
bundle (§41). A package is recomputed on every read from exactly the state
the app already tracks: export coverage/freshness (§36–38), queue state
(§18), and delivery state (§39). Nothing here scans a directory, hashes a
video, or calls `ffprobe` a second time.

### 49.2 Platform profiles

`src/domain/content/platformProfiles.ts` is pure and browser-safe, exactly
like `renderPresets.ts`. Three platforms, each naming one existing preset —
no new rendering format was invented:

| platform id | label | preset | filename alias suffix |
|---|---|---|---|
| `youtube` | YouTube | `youtube-16x9` | `youtube` |
| `reels` | Reels / TikTok | `vertical-9x16` | `reels` |
| `instagram-square` | Instagram Square | `square-1x1` | `square` |

The mapping is the single source of truth: the server, the CLI and the UI all
import it, and there is no second list of platform-to-format strings anywhere.
A `filenameSuffix` builds a **descriptive filename alias** —
`ghetto-geek-youtube.mp4` — used only in generated text and the package view.
It is never written to disk by anything in this module and can never collide
with the canonical `out/<slug>/<preset-id>.mp4` or a delivery's
`<slug>-<preset-id>.mp4` (§39.9): both keep their existing names untouched.

### 49.3 Readiness — the one new concept

`src/domain/content/contentPackage.ts`, `deriveContentPackage(input, options)`.

Per platform:

| readiness | derived from |
|---|---|
| `ready` | the underlying export's coverage freshness is `current` |
| `missing` | no file, nothing in flight |
| `stale` | freshness is `stale` (with the same `staleReasons` coverage already reports) |
| `rendering` | a job for that track/preset is queued or active (§18) |
| `blocked` | the track is not currently valid, or freshness is `invalid` |
| `not_selected` | this platform is not part of the current package |

Per package, in this precedence (deliberately not a bigger state machine):

```
no platform selected        → not_configured
track invalid, or any
  selected platform blocked → blocked
any selected platform
  missing or rendering      → incomplete
any selected platform stale → stale
otherwise                   → complete
```

A **partial package is a first-class, valid result** — two ready and one
missing is `incomplete`, never treated as failed, and each platform's own
readiness stays independently visible. A package is `complete` when every
*selected* platform has a **current canonical export**; delivery is a
separate, later question (§49.9) and is never required for `complete`.

### 49.4 Selection — export intent, not a new flag

Three modes, the smallest model that fits:

- **`intent`** (default) — a platform is selected exactly when its underlying
  preset is in the track's resolved `exportPresets` (§37.1). An undeclared
  track still resolves to every format, so an existing track's package is
  never silently narrowed or widened by this feature.
- **`full`** — every platform is selected, regardless of declared intent.
  Explicit and visible (a UI toggle, `--mode full`, `mode=full`), never
  silent.
- **`custom`** — an exact platform set is given (`platforms: [...]`), which
  overrides `mode` entirely. This is how "only Reels" is expressed.

Nothing here writes to `exportPresets`. Choosing "Full package" in the UI
does not save a new intent to `metadata.json` — it only changes what this
one read asks for. Declaring intent remains what it always was: an explicit
metadata save (§37.2).

### 49.5 Platform metadata — deterministic, never cached

`src/domain/content/platformMetadata.ts`, `buildPlatformMetadata(slug,
platformId, subject)`. No external AI calls. A pure function of the same
`title`/`artist`/`key`/`bpm`/`subtitle` fields the visualizer itself renders,
so a package's text metadata can never drift out of sync with the track and
**needs no freshness tracking of its own** — it is simply recomputed on every
read, exactly like the rest of the package. This also resolves §26 of the
original brief directly: nothing generated here is ever burned into a video,
so a metadata-only change (say, editing the subtitle) never implies a
re-render, and a render-affecting change (cover, audio, preset — anything
`exportFreshness.ts` already tracks) is answered by the existing `stale`
machinery, not by this module.

| platform | fields | example |
|---|---|---|
| YouTube | title, description, keywords | `Ghetto Geek \| Boom bap soul, trap bounce and latin heat. \| Toshi` |
| Reels/TikTok, Instagram Square | caption only | `Ghetto Geek — Toshi (F Minor, 100 BPM) — Boom bap soul, trap bounce and latin heat.` |

A track with no subtitle falls back to a `"<key> · <bpm> BPM"` tagline rather
than an empty one. Keywords are deterministic and deduplicated (artist, BPM,
key, `"type-beat"`, `"toshi"`), lowercase and hyphenated. Templates are
centralized in one module rather than scattered across the UI and the CLI, so
customizing the wording later is a one-file change.

### 49.6 Relationship to the release bundle — composition, not duplication

Audited directly against §41 before writing anything: `release.json`/
`release.md` already answer "what shipped, in which formats, when" for a
track's **delivered** state. A content package answers a different, broader
question — render readiness across three named platforms, plus generated
platform text that a release bundle has no field for (captions, YouTube
descriptions, keywords) — and does not duplicate the bundle's schema, its
fingerprint, or its two-file publication. **No second persistent manifest was
introduced.** A content package is presentation/composition over: export
coverage, queue state, delivery state and these new platform profiles/text
templates. If a package-shaped file on disk is ever wanted, it should extend
`release.json` with a `platforms` block rather than write a parallel
`content-package.json` — deferred, not started, because nothing today asked
for a file, only a view (§49.15).

### 49.7 API

```
GET /api/content-package?track=<slug>&mode=intent|full&platform=<id>...
```

One read-only endpoint. `mode` defaults to `intent`; repeatable `platform`
query params override it with an exact custom set (`mode` becomes `custom`
in the response). Costs exactly one `inspectTrack` + the same view assembly
`GET /api/tracks/:slug` already does (§ trackView.ts) — no new filesystem
sweep, no new stat calls beyond what that endpoint already pays for. 404s
with `TRACK_NOT_FOUND` for an unknown track, 400s with the new
`INVALID_PLATFORM` code for an unknown platform id, exactly mirroring how
`INVALID_PRESET` already behaves.

**Deliberately no `POST /api/content-package/plan|apply|build`.** The
original brief allowed for one "only if it can cleanly reuse existing
render-plan execution" — and the cleanest reuse turned out to be the
*existing* endpoints themselves: `POST /api/export-missing` (§36–38) already
accepts `{tracks, presets, mode, dryRun}`, and `POST /api/delivery/deliver`
(§39.12) already accepts `{tracks, presets, dryRun}`. A package's selected
platforms resolve to a preset list via the same shared, pure domain module
the GET endpoint uses, and that list is handed straight to those two
existing endpoints — no parallel queueing path, no second place that decides
what "build" or "deliver" means. This also means there is no
`ContentPackageBuildView`/`ContentPackageApplyView` type sitting unused
anywhere the way an unreachable `RemediationAction` kind was explicitly
avoided in §46.1 — every type added here (§ src/domain/api/views.ts) is
exercised by the UI, the CLI, or both.

### 49.8 CLI

```console
npm run content-package -- <slug> [--mode intent|full] [--platform <id>]... [--json] [--apply]
```

Default behavior is **inspection only** — it prints the package (or, with
`--json`, the exact `ContentPackageView` the API returns) and renders
nothing. `--apply` builds the package's own missing/stale outputs: it calls
`planMissingExports` with the package's resolved preset list and
`mode: "missing-and-stale"` (the same planner the API and
`render-missing.mts` use), then renders each selected target with
`renderTrackVideo`, **the same call site `render-missing.mts` already
uses** — this is not a second rendering system, only a platform-scoped
preset selection on top of the existing one. The CLI never calls the local
HTTP API, matching every other script in `scripts/`.

### 49.9 Delivery integration — reused, not intertwined

**Deliver package** is `DeliverPanel` (§39.14's existing component), scoped
to a package's selected preset ids via a new, backward-compatible `presets`
prop (`null` default preserves every existing call site's behavior
unchanged). Build and deliver are two separate, explicit actions — building
does not imply delivering, and delivering is only offered once a
destination is configured, exactly as the existing Delivery section already
gates it. Render readiness (`packageStatus`) and delivery readiness
(`deliveryStatus` per platform, taken straight from `RenderOutputView.delivery`)
stay two separate fields throughout, never conflated.

### 49.10 UI

**Track Detail** gained a "Content package" section (`ContentPackagePanel`,
`ui/components/ContentPackagePanel.tsx`), between Exports and Delivery. It
takes the already-fetched `TrackDetailView` as a prop and calls
`deriveContentPackage` **client-side, with `useMemo`** — no extra fetch, and
it can never disagree with the Exports/Delivery sections above it, because it
reads the exact same `exports` array they do. It shows:

- a package status badge and a `N/M ready` summary, plus an Intended
  formats/Full package (3) toggle;
- one row per platform: a readiness mark, the stale reason(s) when relevant,
  the descriptive filename, and a "Preview metadata" toggle revealing the
  generated title/description/keywords or caption;
- **"Build package"** — literally `ExportMissingPanel`, scoped to
  `tracks: [slug]` and the package's resolved preset ids. The existing
  two-step dry-run/confirm flow, SSE batch progress and queue drawer are
  reused entirely unchanged;
- **"Deliver package"** — `DeliverPanel`, scoped the same way, shown only
  once a destination is configured.

**Catalogue rows** (`TrackList.tsx`) gained one badge (`PackageStatusBadge`),
computed the same way — client-side, from `TrackSummaryView.exports`, which
a catalogue listing already has. No per-row fetch, so a large catalogue's
listing cost is unchanged (§49.13). Hidden entirely when `not_configured`
(nothing selected), matching how the release-bundle badge is hidden when
delivery is off.

### 49.11 Backward compatibility

- Existing render, export-missing, stale re-export, delivery, release-bundle,
  destination-health and remediation workflows are untouched — verified by
  the full existing suite (386 pre-existing tests) still passing unmodified.
- `DeliverPanel`'s new `presets` prop defaults to `null`, so every existing
  caller (the Delivery section, the catalogue-wide action) behaves exactly as
  before.
- No metadata is rewritten by this feature. Choosing "Full package" in the UI
  or `--mode full` on the CLI never saves `exportPresets` — intent is still
  only ever changed by an explicit metadata save (§37.2).
- A new `INVALID_PLATFORM` error code was added alongside the existing
  `INVALID_PRESET`, `INVALID_SLUG`, etc. — additive to the shared
  `TrackErrorCode` union, mapped to 400 exactly like the others.

### 49.12 Ghetto Geek, honestly reported

Ghetto Geek's three existing exports predate manifests (§38.4), so — exactly
as coverage already reports everywhere else in the app — its content package
reads as `stale` (`manifest_missing`) rather than `complete`, with all three
platforms showing "Earlier export — no manifest". This is correct, not a
bug: the package view adds no new judgment about these files, it only
relabels the same freshness fact per platform. Verified live against the
real track (§49.14); Ghetto Geek was never re-rendered by this work.

### 49.13 Performance

- The GET endpoint costs exactly what `GET /api/tracks/:slug` already costs —
  one `inspectTrack` call, no new stat/hash/ffprobe work.
- The UI's Track Detail panel and catalogue badges compute the package
  **client-side** from data already fetched for other sections, so this
  feature adds **zero additional network requests** to normal browsing.
- `deriveContentPackage` itself is a handful of array operations over at most
  three platforms — no loop over the catalogue, no directory scan.
- Building and delivering a package add no new execution cost: they resolve
  a preset list and hand off entirely to the existing planner, queue and
  delivery pipeline, whose costs are already measured in §35–39.

### 49.14 Verification performed

- `npx tsc --noEmit` and `npx eslint src scripts services server ui tests`:
  clean.
- Full test suite: **419/419 passing** (386 pre-existing + 33 new), rerun
  three times consecutively, stable.
- `npx vite build`: passes (the pre-existing >500 kB chunk advisory only,
  unchanged).
- `validate-track`/`prepare-track -- ghetto-geek`: exit 0.
- `npm run content-package -- ghetto-geek` and `--mode full --json`: correct,
  read-only, reported `stale` for the reason in §49.12, touched nothing on
  disk (`out/ghetto-geek/*.mp4` mtimes unchanged; `git status` clean apart
  from this feature's own new/changed files).
- The live API was hit directly: `GET /api/content-package?track=ghetto-geek`
  returns the expected derived view, including generated YouTube/caption
  text.
- **The UI was driven in a real headless Chrome instance** (system Chrome,
  `--headless=new`, driven over raw CDP — the same approach §46.13 used):
  loaded the app, confirmed the new "Content package" section and its
  catalogue badge render correctly against real Ghetto Geek data, toggled
  "Preview metadata" and confirmed the generated YouTube title/description/
  keywords render, switched Intended formats → Full package (3) and
  confirmed the summary updates, and clicked "Build package" (the dry-run
  step only) and confirmed it returns a real plan
  (`1 track · 3 intended exports · 0 current · 3 stale · 0 missing`) via the
  existing `/api/export-missing` endpoint — without queuing anything.
  Screenshots were inspected directly. The browser, API server and Vite dev
  server were all stopped afterward; no leaked Chrome/Chromium, Node render,
  or lock-file artifacts remained (`out/.locks/` empty of stray fixtures).

### 49.15 Deliberately deferred (per the brief's explicit constraints)

- **No `content-package.json`/`content-package.md` file.** §49.6 covers the
  reasoning: it would either duplicate the release bundle or need to extend
  it, and nothing today asked for a persisted file, only a live view.
- **No social-media publishing APIs, OAuth, or uploads** — never in scope for
  this milestone, per explicit instruction.
- **No settings for default-selected platforms, hashtag sets, or naming
  preference.** The three platforms are fixed and always shown; `mode`/
  `platforms` are per-request, not persisted, which is the smallest model
  that satisfies "package based on intent" vs. "explicit full package"
  (§ brief, part 6) without adding a settings surface nothing asked for yet.
- **Templates are not user-editable yet.** They are centralized in one
  module (§49.5) specifically so that becomes a small, contained change
  later, rather than a rewrite.
- **No `POST` plan/apply/build endpoint** — §49.7 explains why reusing
  `/api/export-missing` and `/api/delivery/deliver` directly was judged the
  cleaner reuse.

### 49.16 Files changed

New:

- `src/domain/content/platformProfiles.ts`
- `src/domain/content/platformMetadata.ts`
- `src/domain/content/contentPackage.ts`
- `server/routes/contentPackage.ts`
- `scripts/content-package.mts`
- `ui/components/ContentPackagePanel.tsx`
- `tests/content-package.test.mts`

Changed (additive only — see §49.11):

- `src/domain/tracks/errors.ts` (`INVALID_PLATFORM`)
- `src/domain/api/views.ts` (content package view types, re-exports)
- `server/http/errors.ts` (status mapping for `INVALID_PLATFORM`)
- `server/routes/tracks.ts` (`deliveryRootForView` exported for reuse)
- `server/app.ts` (route registration)
- `ui/api/client.ts` (`getContentPackage`)
- `ui/components/DeliverPanel.tsx` (`presets` prop, default-`null`)
- `ui/components/TrackDetail.tsx` (Content package section)
- `ui/components/TrackList.tsx` (catalogue readiness badge)
- `ui/styles/app.css` (`.contentpackage*`, `.pkgbadge*`, `.button--active`)
- `package.json` (`content-package` script)
- `docs/HANDOFF_PHASE_2B_TO_2C.md` (this section)

### 49.17 Commits

1. Domain: platform profiles, platform metadata templates, the content
   package model and its derivation.
2. Server: the read-only API route, error-code plumbing.
3. CLI: `content-package.mts`, package script.
4. UI: `ContentPackagePanel`, `DeliverPanel`'s `presets` prop, Track Detail
   and catalogue wiring, styles.
5. Tests.
6. Documentation (this section).

No push was made.

### 49.18 Recommended next feature — delivered

**Editable platform metadata templates.** Built — see §50, which delivers
exactly what this section proposed: global templates, per-track overrides
and a whitelisted placeholder renderer, built on the same
`buildPlatformMetadata` this section already centralized for the purpose.

---

## 50. Current State — Editable Metadata Templates & Overrides (2026-09-20)

The newest layer. Read this after §49; where the two disagree, this wins. No
composition, layout, presets, brand sources, render pipeline, render queue,
locking, delivery, release-bundle or destination-health behavior changed —
additive only, exactly like §49. No AI copywriting, no external APIs, no
publishing/OAuth, no database, no generic template language. Package
readiness (§49.3) is untouched: a template edit changes only the text a
package shows, never its `packageStatus` or any platform's `readiness`.

### 50.1 The question this answers

§49 generated platform copy from hard-coded template logic. This makes that
copy genuinely editable in daily use, with an explicit, tested precedence:

```
per-track override  ->  global template  ->  built-in default
```

resolved **per field**, never per whole platform block — a track that only
overrides its YouTube title still gets the global (or built-in) YouTube
description, and its Reels/Instagram copy is untouched by that override.

### 50.2 The template model

`src/domain/content/metadataTemplates.ts` — pure, browser-safe, no
dependency on anything Node-specific, exactly like `renderPresets.ts`:

```ts
type MetadataTemplates = {
  youtube: { titleTemplate; descriptionTemplate; keywordsTemplate };
  reels: { captionTemplate; hashtagsTemplate };
  "instagram-square": { captionTemplate; hashtagsTemplate };
};
```

Keyed by `PlatformId` (`"instagram-square"`, not a second `"instagram"`
spelling) rather than the brief's suggested key names, specifically to rule
out a class of typo bug between two names for the same platform — the one
deliberate deviation from the brief's suggested shape, and a correctness
call, not a style one. `PartialMetadataTemplates` is the same shape with
every field optional, used for both global settings and a track's own
overrides. Not a generic template engine: seven fixed fields, one renderer,
no loops or conditionals in the template language itself.

### 50.3 Placeholders

`PLACEHOLDER_KEYS` — ten, all fixed lookups, no expressions:

```
{title} {artist} {key} {bpm} {subtitle} {slug} {platform} {filename} {tagline} {subtitleSuffix}
```

The first eight are exactly what the brief suggested (six base fields plus
the two useful derived ones, `{platform}` and `{filename}`). `{tagline}` and
`{subtitleSuffix}` are two more derived values, added specifically to make
§50.8 (backward compatibility) achievable without any conditional syntax:

- `{tagline}` = the subtitle if present, else `"{key} · {bpm} BPM"` —
  exactly the old title-builder's fallback.
- `{subtitleSuffix}` = `" — {subtitle}"` if present, else `""` — exactly the
  old caption-builder's optional trailing segment.

Both are fixed, non-conditional lookups computed once per render call — the
same category as `{bpm}` being a number formatted to a string — never
something a user's own template text can express. Unknown placeholders
(anything not in this list) are rejected at validation time (§50.6) and, as
defense in depth, left literally in place by the renderer rather than
thrown on or silently dropped, with every unknown name reported.

### 50.4 The renderer

`renderTemplate(template, values) -> { text, unknownPlaceholders }`.
Plain, deterministic, whitelist-only substitution:

- A single regex (`/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g`) finds `{word}` tokens;
  a known word is substituted, an unknown one is left as-is and reported.
- **`{{literal}}` is a well-defined escape**: `{{`/`}}` are swapped for
  sentinel strings before scanning (so `{{title}}` is never mistaken for the
  `title` placeholder) and restored after substitution. Only ever applies to
  the template's own text — a *value* being substituted that happens to
  contain `{{`/`}}` is copied verbatim, never re-escaped or re-scanned.
- **No eval, no `Function`, no shell/path interpolation, no HTML
  execution.** A value is copied as plain text; nothing here ever
  interprets it. Verified directly: a title containing `$(rm -rf /)`,
  `<script>alert(1)</script>` and `{{process.exit(1)}}` all render as inert
  text, byte for byte (§50.14, security tests).
- **Missing optional values render as an empty string** — the brief's
  explicit preference for "least surprising" over a validation warning.
  Combined with one normalization rule applied to every render (not a
  conditional — the same rule, always): **trim, and cap a run of 3+
  newlines at one blank line.** This is what stops an absent `{subtitle}`
  from leaving a stray blank paragraph, and it is also exactly what makes
  §50.8's byte-identical backward compatibility possible with a pure
  substitution renderer.

### 50.5 Validation

`validateTemplateString(value, label)`: must be a string, at most
`MAX_TEMPLATE_LENGTH` (2000) characters, and built only from whitelisted
placeholders — anything else is a structural `TEMPLATE_INVALID` error naming
the field and, for an unknown placeholder, the exact token(s). No
platform-specific length limits are enforced here (the brief's explicit
instruction: do not hard-fail on volatile platform limits); the UI's live
preview is where that would show up as non-blocking guidance later if ever
wanted (not built — nothing asked for it yet).

`parseMetadataTemplates(raw)` (strict, whole-object) and
`coerceMetadataTemplates(raw)` (best-effort, for prefilling a not-yet-valid
draft) mirror the existing `exportPresets` pair exactly. A **new**
`TEMPLATE_INVALID` error code was added alongside `INVALID_PRESET`/
`INVALID_PLATFORM`, mapped to 400.

### 50.6 Global settings storage

`services/content/metadataTemplateSettings.ts`, `content-metadata.local.json`
at the project root — audited the existing `delivery.local.json` pattern
first and reused it exactly: gitignored, atomic writes via the same
`withFileMutation`/`writeAtomicFile` helpers `deliverySettings.ts` already
uses, absent-means-nothing-configured. **Only overridden fields are
stored** — never the built-in defaults, which stay a fixed, code-shipped
constant (`BUILT_IN_DEFAULT_TEMPLATES`) both the server and the UI import
directly, so there is exactly one copy of the defaults, not two that could
drift or need to be sent over the wire.

**Malformed-file handling was deliberately not the same as
`delivery.local.json`'s** — that file silently falls back to "delivery off"
on any read failure, which is safe because "off" is indistinguishable from
never having been configured. A broken *content-metadata* file is different:
someone's real customization could be sitting behind unreadable JSON, and
silently falling back to built-in defaults would hide that. So
`readContentMetadataSettings()` returns `{ settings, problem }` — built-in
defaults are used either way (the app must not break), but `problem` is
non-null for anything past "file simply does not exist" (malformed JSON,
wrong shape, an unreadable placeholder) and is surfaced: in the settings
panel, in `GET /api/content-package`'s `templatesProblem` field, and in the
CLI's `--show`/inspection output. `writeContentMetadataSettingsPatch`
refuses to write on top of a currently-unreadable file (`TEMPLATE_INVALID`,
naming the problem) rather than silently discarding whatever is actually
there — fix or remove the file by hand first.

### 50.7 Per-track overrides

`TrackMetadata`/`TrackMetadataDraft` gained an optional
`contentMetadataOverrides?: PartialMetadataTemplates` field, validated by
`src/domain/tracks/metadata.ts` through the exact same
`validateTrackMetadata`/`coerceMetadataDraft`/`serializeTrackMetadata` path
every other field uses — no second metadata file, no second write path.
`TrackMetadataPatch.contentMetadataOverrides` follows the existing
`exportPresets` convention: **the whole desired object is sent and
replaces what's on disk**, never deep-merged with it; `null` clears every
override (back to fully inherited) and omitting the field leaves it alone.
Existing `metadata.json` files with no such field remain fully valid and
unchanged (verified directly — §50.14).

**A real bug was caught and fixed while building this**: the HTTP PATCH
route (`server/routes/tracks.ts`, `readMetadataPatch`) only ever read a
fixed allowlist of body fields into the patch it built, and
`contentMetadataOverrides` had been added to the domain type and the
service layer but never to that allowlist. The service-level and pure
tests all passed, because none of them went through the HTTP layer — a
save from the real UI would silently succeed while quietly not persisting
the override, since the route handed `updateTrackMetadata` a patch that
simply never mentioned the field. Caught during the real-headless-Chrome
end-to-end pass (§50.15) precisely because that pass drives the actual save
button rather than calling the service directly; fixed by reading
`contentMetadataOverrides` in `readMetadataPatch` like every other field;
covered afterward by a dedicated API-level regression test
(`tests/api-integration.test.mts`) that was verified to fail against the
pre-fix code and pass against the fix. The lesson generalizes: a field
added only at the domain/service layer is not exercised until something
drives it through the actual HTTP body-parsing code, so a field like this
now always gets one API-level test asserting on-disk persistence, not only
a service-level one.

### 50.8 Backward compatibility — byte-identical built-in defaults

`BUILT_IN_DEFAULT_TEMPLATES` reproduces the previous hand-written
`platformMetadata.ts` functions' output **exactly**, in both the common case
(a subtitle present) and the edge case (absent) — verified directly against
the literal strings the old implementation produced, for title, description,
caption and keywords alike (`tests/metadata-templates.test.mts`). This was
the deciding factor in choosing `{tagline}`/`{subtitleSuffix}` over a
simpler design that would have left a small, permanent regression in the
no-subtitle case: Ghetto Geek — the one real track in this repository — has
a subtitle, so its generated copy is unaffected either way, but "preserve
current default copy exactly" (an explicit instruction) was read as
covering every track this feature will ever see, not only the one that
happens to exist today.

**Keywords and hashtags are always derived from rendered text, never a
second stored array.** A `keywordsTemplate` is a single string
(comma-separated); the renderer splits, tagifies (lowercase, hyphenated) and
deduplicates each token *after* rendering. A `hashtagsTemplate` (new — there
was no prior hashtags concept) is space-separated and split the same way.
Neither form is persisted anywhere except as that one template string —
exactly the brief's instruction not to store comma-separated and array forms
as two separate truths.

### 50.9 Render-freshness separation

Audited `services/tracks/exportManifest.ts`'s `fingerprintInputs` directly:
it hashes `props.title, props.artist, props.musicalKey, props.bpm,
props.subtitle` — fields read from `BeatVisualizerProps`, which
`buildTrackProps.ts` maps **explicitly**, field by field, never by
spreading the whole metadata object. `contentMetadataOverrides` (and every
template field it can ever contain) is therefore **structurally excluded**
from the render fingerprint — not by a runtime check anywhere, but because
nothing in the props-building path can reach it. Verified directly
(`tests/content-package.test.mts`): editing `contentMetadataOverrides` on a
track with a current, rendered export leaves it `current`/`ready` with no
stale reasons; editing `title` (a field that *is* rendered into the video)
on the same track makes it `stale` with reason `metadata_changed`, exactly
as before this milestone.

### 50.10 Package-metadata freshness

Deliberately no persisted fingerprint of "is this package's text current."
Every platform's title/description/caption/keywords/hashtags in
`ContentPackageView` (§49) is recomputed live, on every read, from whatever
the resolved templates and the track's current fields say right now —
consistent with §49's own "the package is a view over current state, never
persisted" design, extended down into the text itself. There is nothing to
go stale, so there is nothing to track.

### 50.11 API

```
GET   /api/content-metadata-settings
PATCH /api/content-metadata-settings
```

Mirrors `GET`/`PUT /api/delivery/settings` exactly. `GET` returns
`{ schemaVersion, templates, problem, settingsPath }` — `templates` is only
the overridden fields (§50.6), never the built-in defaults, which the UI
already has from the shared domain module. `PATCH` takes a **field-by-field
reset patch**: each leaf is a validated template string (set it), `null`
(reset that one field to its built-in default) or omitted (leave it alone)
— resetting one field must not disturb every other one someone has already
configured, and this is genuinely a different operation from a track's
`contentMetadataOverrides: null` (clear *everything*, §50.7); both are
supported and kept distinct on purpose (the brief's explicit instruction).

Per-track overrides deliberately did **not** get a new endpoint: they flow
through the existing `PATCH /api/tracks/:slug/metadata`, the same path
`exportPresets`/`deliveryFolder` already use, so there is exactly one write
path for track metadata, not two — the brief's explicit instruction, and
also what surfaced the bug in §50.7.

`GET /api/content-package` (§49.7) now resolves and threads templates
through automatically: it reads the global settings, passes
`globalTemplates` and the track's own `contentMetadataOverrides` into
`deriveContentPackage`, and carries the settings-read `problem` through as
`ContentPackageView.templatesProblem` — so a caller sees generated copy
that already reflects both layers, plus whether the global layer is
currently degraded, without a second request.

### 50.12 UI

- **Content metadata templates** — a new section in the existing
  Delivery/settings view (`ContentMetadataSettingsPanel.tsx`; the brief's
  suggested location). Seven fields, each showing an "override"/"built-in"
  badge, a live preview computed with **the exact same renderer** Content
  Package uses (`buildPlatformMetadata`, imported directly — no duplicate
  preview logic), and its own "Reset to built-in" button. Preview uses the
  currently open track's fields when one is open, a fixed sample subject
  otherwise, per the brief.
- **Content metadata overrides** — a new, collapsed-by-default `<details>`
  section in the Track Detail metadata editor
  (`ContentMetadataOverridesEditor.tsx`), reusing the same seven-field list
  (`ui/components/templateFields.ts`, shared with the settings panel so
  there is one field list, not two). Each field shows "Inherited" (a
  read-only preview of what it currently resolves to) or, once overridden,
  an editable textarea plus "Clear override (inherit)" — the brief's
  explicit example wording. Saved through `MetadataForm`'s existing single
  save action, not a second one.
- **Content Package panel** (§49.10) now resolves templates too: it takes
  the fetched global settings as a prop and passes them straight into the
  same client-side `deriveContentPackage()` call it already made, so a
  template edit is reflected the moment settings/track state changes —
  still zero extra network requests, still the same derivation function
  everywhere.

### 50.13 CLI

```console
npm run content-metadata -- --show
npm run content-metadata -- --set <platform.field> "<template>"
npm run content-metadata -- --reset <platform.field>
npm run content-metadata -- --reset-all
```

Flag-based, not interactive, matching every other script here. `--show` (the
default) prints every field's resolved value with an override/built-in
label; `--set`/`--reset`/`--reset-all` go through the exact same
`writeContentMetadataSettingsPatch` the API PATCH uses. `npm run
content-package -- <slug> --json` (§49.8) already reflects current templates
automatically, with no changes needed — it was always going to call
`deriveContentPackage` with whatever templates were resolved, and now that
resolution includes the real global/track layers instead of only built-in
defaults.

### 50.14 Tests (60 added, 479 total)

- `tests/metadata-templates.test.mts` (39) — the renderer (substitution,
  repeated/multiple placeholders, unknown-placeholder reporting,
  `{{literal}}` escaping, empty-value and blank-line-collapse behavior,
  Unicode/emoji/quotes/accents/multiline/very-long-title), validation
  (unknown placeholder, wrong type, length limit), precedence (built-in
  only, global wins over built-in, track wins over global, a **partial**
  track override falling through per field, clearing/resetting each layer),
  byte-identical built-in defaults with and without a subtitle, and security
  (no eval/Function, shell metacharacters and HTML-shaped values copied
  verbatim as inert text).
- `tests/content-metadata-settings.test.mts` (7) — the settings file's
  read/write behavior against a **mocked** `fsPromises.readFile` (the same
  pattern `destination-fix-plan-render.test.mts` already established for
  `delivery.local.json`), so nothing here ever touches this project's real
  `content-metadata.local.json`: missing-file, malformed-JSON,
  unknown-placeholder, other-read-error and valid-file cases, plus writing
  refused on top of an unreadable file and an invalid patch rejected before
  any read.
- `tests/content-package.test.mts` (+9) — end to end through a real
  fixture and `publishExport` (no forked render): track override beats
  global end to end, a partial override leaves every other field on the
  global/built-in chain, clearing an override restores inheritance, an
  existing `metadata.json` with no override field is still fully valid, an
  unknown-placeholder save is rejected and never reaches disk, optimistic
  concurrency is preserved for this field exactly like every other one, a
  metadata-template-only edit never makes a current export stale, a
  render-affecting edit (title) still does, and package readiness is
  provably unaffected by a copy-only global template change.
- `tests/api-integration.test.mts` (+5, including the §50.7 regression) —
  `GET`/`PATCH /api/content-metadata-settings` (read-only-safe reads,
  unknown-placeholder/unknown-field rejection writing nothing),
  `GET /api/content-package` reflecting a mocked global template through
  the real settings-read path, and the `contentMetadataOverrides`
  HTTP-persistence regression test described in §50.7.

### 50.15 End-to-end results

Ran twice: once purely over HTTP against a locally-started API server
(`curl`), and once through a **real headless Chrome instance** (system
Chrome, `--headless=new`, driven over raw CDP — the same approach §46.13
and §49.14 used) against a synthetic `metadata-probe` track (never Ghetto
Geek), with the app's own dev server and API server both running for real.

- Built-in defaults confirmed in the Content Package panel.
- A global YouTube title template set and saved through the real Content
  Metadata settings panel; confirmed the per-field live preview updated
  immediately, and confirmed (screenshot) every other field stayed on
  "built-in" with its own correct preview.
- A per-track YouTube title override set through the real Track Detail
  editor — **this is the pass that caught and proved the fix for the
  §50.7 bug**: the first attempt saved successfully but the override did
  not persist; after the fix, `GET /api/content-package` and the on-disk
  `metadata.json` both confirmed `"Metadata Probe [TRACK EXCLUSIVE]"`, and
  the overrides editor correctly showed an "override" badge with the exact
  saved value.
- "Clear override (inherit)" clicked through the real UI; confirmed
  `contentMetadataOverrides` removed from `metadata.json` on disk and the
  title reverted to the global value.
- Confirmed throughout: readiness/status marks in the Content Package panel
  and the catalogue badge never changed while only copy was being edited.

All probe artifacts (`public/tracks/metadata-probe/`,
`content-metadata.local.json`) were removed afterward and verified gone;
the API server, Vite dev server and every headless Chrome process were
stopped and verified gone. Ghetto Geek's `metadata.json` and its three
rendered exports were confirmed byte-identical/mtime-identical to before
this milestone throughout — never touched.

### 50.16 Verification performed

- `npx tsc --noEmit` and `npx eslint src scripts services server ui tests`:
  clean throughout, including after the §50.7 fix.
- Full test suite: **479/479 passing** (419 pre-existing + 60 new), rerun
  three times consecutively, stable.
- `npx vite build`: passes (the pre-existing >500 kB chunk advisory only,
  unchanged).
- `validate-track`/`prepare-track -- ghetto-geek`: exit 0.
- `git diff --check`: clean.
- The §50.7 regression test was verified to **fail** against the pre-fix
  route handler (via `git stash` on just that file) and **pass** against
  the fix, before being left in the suite permanently.
- Final state: no `content-metadata.local.json` or probe track left behind,
  no leaked Chrome/Chromium or Node render processes, no stray lock files,
  working tree clean apart from this milestone's own files.

### 50.17 Performance

- Template rendering is a handful of regex operations over strings at most
  a couple thousand characters long — trivial, and deliberately not cached
  (no evidence it needs to be; the brief's explicit instruction).
- The GET endpoint's added cost is exactly one more small file read
  (the settings file) beyond what §49.7 already cost; no new catalogue
  scan, no new per-track work beyond the one track being inspected.
- The UI's live previews (settings panel, overrides editor, Content
  Package panel) all compute client-side from data already fetched —
  zero additional network requests, exactly continuing §49's own approach.

### 50.18 Remaining limitations

- **No platform-length guidance yet** (e.g. "this YouTube title is over
  100 characters") — deferred per the brief's own instruction not to
  hard-fail or over-build against volatile platform limits; the renderer
  and validator have no opinion on rendered-text length, only on the
  template's own structural length (§50.5).
- **Historical:** literal braces originally used a two-pass sentinel
  replacement. §51 replaces it with one-pass rendering and rejects malformed
  adjacent/nested brace runs such as `"{{{title}}}"` before saving.
- **Global settings malformed-file recovery requires manual intervention**:
  `writeContentMetadataSettingsPatch` refuses to write on top of a file it
  could not parse, by design (§50.6) — the file must be fixed or deleted by
  hand first, exactly like a merge conflict is not auto-resolved.
- **No metadata text files are written to a delivery destination.** Content
  Package metadata stays preview-only, exactly as §49 left it; §49.15/§26
  of this brief both deferred that on purpose, and nothing here changed
  that scope.
- **Delivery/release-bundle artifacts do not carry resolved platform
  copy.** Audited directly (§49.6's reasoning extends unchanged): a
  release bundle answers "what shipped," not "what should the caption
  say," and adding social copy to it would duplicate what Content Package
  already answers live. Not added.

### 50.19 Files changed

New:

- `src/domain/content/metadataTemplates.ts`
- `services/content/metadataTemplateSettings.ts`
- `server/routes/contentMetadataSettings.ts`
- `scripts/content-metadata.mts`
- `ui/components/ContentMetadataSettingsPanel.tsx`
- `ui/components/ContentMetadataOverridesEditor.tsx`
- `ui/components/templateFields.ts`
- `tests/metadata-templates.test.mts`
- `tests/content-metadata-settings.test.mts`

Changed (additive only — see §50.6/§50.7/§50.9 for exactly what did and did
not change):

- `src/domain/tracks/errors.ts` (`TEMPLATE_INVALID`)
- `src/domain/tracks/types.ts` (`contentMetadataOverrides` field)
- `src/domain/tracks/metadata.ts` (coerce/serialize/validate the new field)
- `src/domain/api/views.ts` (settings view/patch types, re-exports,
  `TrackMetadataPatch.contentMetadataOverrides`)
- `src/domain/content/platformMetadata.ts` (rewritten to render through
  `metadataTemplates.ts`; `PlatformMetadata` gained `hashtags`)
- `src/domain/content/contentPackage.ts` (threads templates through;
  `ContentPackagePlatformEntry` gained `hashtags`; `ContentPackageView`
  gained `templatesProblem`)
- `server/http/errors.ts` (status mapping for `TEMPLATE_INVALID`)
- `server/routes/tracks.ts` (the §50.7 bug fix)
- `server/routes/contentPackage.ts` (resolves and threads templates)
- `server/app.ts` (route registration)
- `services/tracks/updateTrackMetadata.ts` (merges the new field)
- `scripts/content-package.mts` (resolves global templates)
- `ui/api/client.ts` (`getContentMetadataSettings`,
  `updateContentMetadataSettings`)
- `ui/components/ContentPackagePanel.tsx` (threads `globalTemplates`
  through; shows hashtags)
- `ui/components/MetadataForm.tsx` (embeds the overrides editor)
- `ui/components/TrackDetail.tsx`, `ui/App.tsx` (fetch/thread the new
  settings)
- `ui/styles/app.css` (`.templates*`)
- `package.json` (`content-metadata` script)
- `.gitignore` (`content-metadata.local.json`)
- `tests/api-integration.test.mts`, `tests/content-package.test.mts`
- `docs/HANDOFF_PHASE_2B_TO_2C.md` (this section)

### 50.20 Commits

1. Domain: the template model, renderer, placeholders, built-in defaults,
   precedence resolution.
2. Global settings persistence (service + API + CLI).
3. Per-track overrides (schema, validation, the metadata write path, and
   the route-handler bug fix once found).
4. Content Package/UI integration.
5. Tests.
6. Documentation (this section).

No push was made.

### 50.21 Recommended next feature (not started)

**Non-blocking platform-length guidance** in the settings/overrides preview
— a small, purely advisory line under a rendered preview ("512 characters —
YouTube descriptions are commonly truncated past ~5000" / "this title is
118 characters"), never a hard validation error, using whatever length
figures are stable enough to hard-code without chasing a moving platform
target. The renderer and validator already expose exactly the rendered text
and its length; this would be a UI-only addition reading them, with no new
domain concept required.

Not started, per instruction.

---

*If anything in this document conflicts with the live repository, the
repository is correct — verify with §31 before proceeding.*

---

## 51. Editable Metadata Templates & Overrides audit and hardening (2026-09-20)

This section supersedes §50 wherever behavior changed. The audit started from
clean commit `3f00638` and baseline 479/479 passing tests. It is a hardening
pass, not a new copywriting, publishing, rendering, or length-guidance feature.

### 51.1 Confirmed high-risk findings and fixes

1. A syntactically valid settings file containing `null`, an array, a missing
   `templates` object, a wrong schema version, or an extra top-level key was
   not consistently classified as corruption. In particular, `null` could
   throw before the settings API returned its documented `problem`. The reader
   now checks the whole file shape and schema before parsing templates, returns
   explicit corruption text, and refuses to write over an unreadable file.
2. Two settings editors could save from the same old view; the second could
   overwrite the first field without knowing it. GET now includes a revision
   of the exact file bytes (or `missing`), the UI sends it in `If-Match`, and
   PATCH returns HTTP 412 `TEMPLATE_CONFLICT` for a stale revision. A
   process-local mutation queue serializes simultaneous settings writes;
   immediately before rename, the writer re-reads the old file and rejects
   intervening external changes. The response describes the bytes this write
   actually published, not a later re-read that could race another save.
3. Brace forms such as `{ title }`, `{title.foo}`, `{{{title}}}`, and unmatched
   braces passed structural validation but remained in final copy. The
   validator now rejects malformed single-brace syntax. A single-pass renderer
   handles valid placeholders and doubled literal braces without sentinel
   substitution, so a user's value containing the former sentinel text cannot
   be rewritten. Existing built-in copy remains string-identical in tests.
4. `content-metadata --show` printed a corruption warning but exited zero;
   unknown CLI flags also exited zero. Both now exit nonzero. A successful
   `--set` message no longer falsely says unoverridden track copy is
   unaffected.
5. Metadata PATCH silently ignored an unknown field when another valid field
   was present. It now rejects unknown top-level fields. A malformed existing
   per-track override could also be lost when an unrelated metadata PATCH
   coerced the old file to an editable draft. The write path now refuses that
   patch and preserves the original file.
6. The Content Package UI could render built-in copy without showing the
   global settings corruption reported by the API. It now carries and shows
   `templatesProblem`; an outright settings GET failure also gets an app-level
   error banner. The settings editor preserves an unsaved draft on a revision
   change and ignores its own stale parent snapshot while a successful save
   refresh is in flight.

No critical defect requiring redesign was found. All changes above are in
local commit `e528683` (`Harden metadata template validation and settings
writes`).

### 51.2 Verified semantics

| Area | Result |
|---|---|
| Precedence | Every field resolves track override → global override → built-in. Partial platform objects do not hide sibling fields or other platforms. |
| Empty values | A saved `""` is an intentional empty template at either layer. A whitespace-only template is stored but renders to empty after outer trim. Clearing a track override uses `null` for the whole object or the UI's field clear; resetting a global field uses `null` for that leaf. Neither action clears the other layer. |
| Placeholders and braces | Only the named whitelist is substituted. Unknown `{word}` tokens and malformed single braces are rejected before saving. `{{title}}` renders the literal `{title}`; JSON-like literal braces must also be doubled, for example `{{"name": 1}}`. Quotes around a valid token do not escape it. Nested or unmatched braces are rejected. |
| Missing values | An absent subtitle substitutes `""`; `{tagline}` and `{subtitleSuffix}` preserve the previous built-in fallback and caption behavior. Required artist, key, and BPM are unavailable only in draft/invalid tracks, whose Content Package copy is blocked. Rendering trims the outer text and caps runs of three or more `\n` characters at two. |
| Compatibility | Representative built-in YouTube, Reels, and Instagram copy, including the no-subtitle fallback, remains string-identical to the pre-template implementation. Unicode and long titles flow through without truncation. |
| Config | An absent file means empty overrides and revision `missing`. A valid partial file is accepted. Wrong types, unknown keys, wrong schema, malformed/truncated/empty JSON, and non-ENOENT read failures surface an explicit problem. Unknown config keys are rejected, not ignored. Recovery requires fixing or removing the file by hand. |
| Writes | Settings and metadata are staged in the destination directory and renamed atomically. Failed rename preserves the old file and removes the temp file; a failure is reported, never returned as a successful save. Settings writes compare the old revision again before rename. |
| Per-track concurrency | The UI sends the revision of the metadata bytes it edited. Concurrent title/override and clear/save operations with a stale revision receive HTTP 412; a track switch does not apply the old save response to the new track. Legacy callers that omit `If-Match` retain the established unconditional PATCH behavior. |
| Freshness | `buildTrackProps` explicitly maps rendered fields; `fingerprintInputs` hashes title, artist, key, BPM, and subtitle, with no template or override field. Copy-only edits leave a published export current; title edits, including title plus override in one patch, stale it for `metadata_changed`. Template edits do not queue a render or write render/delivery artifacts. |
| Consistency | The Content Package API, CLI, UI panel, and both editors call the shared `resolveMetadataTemplates`/`buildPlatformMetadata` path. Package fields are resolved live on every read, ready for future character counting without another renderer. |
| Security | Templates are plain text with whitelist lookup only. There is no eval, Function constructor, property traversal, environment/shell expansion, or template-derived filesystem path. Script-shaped text is inert in the renderer and React previews use text nodes. |
| API/CLI/UI truthfulness | Invalid PATCH shapes and unknown fields fail; request bodies retain the 256 KB cap. UI shows server failures and conflicts as unsaved, while successful settings PATCH returns the published revision. CLI set/reset/show paths and malformed-file exit codes were exercised. |

### 51.3 End-to-end and failure probes

A synthetic `metadata-audit-probe` track was driven through real headless
Chrome, the running Vite UI, and the running API. The sequence confirmed
built-in copy → global YouTube title → per-track title → persistence after
reload → clear track override → global copy → reset global → built-in copy.
The global preview recomputed when switching to Ghetto Geek and back; viewing
Ghetto Geek did not edit it. A malformed global file produced a visible UI
warning and `templatesProblem` in the API, and removing the file recovered
built-ins. A deliberately stale settings editor received HTTP 412, retained
its unsaved draft, and did not display “Saved”; the external value remained
on disk. CLI `--show`, `--set`, `--reset`, `--reset-all`, invalid field,
invalid placeholder, unknown flag, and malformed-file exits were checked.

The synthetic track had no render output or manifest. The sequence did not
spawn a render worker, queue a render, perform delivery, or mutate a release
bundle; API/package readiness stayed independent of copy edits. Service tests
also published synthetic exports without rendering and proved both the
copy-only freshness invariant and rendered-title staleness. The probe track,
analysis file, local settings file, Chrome profile, API and Vite servers, and
Chrome process were removed or stopped afterward. Ghetto Geek's assets were
not modified.

Failure injection covered unreadable settings, malformed JSON, a rename
failure that left the last valid file intact with no temp file, stale revisions,
and an invalid override that left metadata bytes untouched. Twenty concurrent
in-process set/reset operations left one valid settings file and no temp
files. Two concurrent conditional settings saves from the same revision gave
one success and one conflict; independent unconditional fields merged within
the process-local queue. Concurrent per-track edits with the same revision
were similarly refused after the first real change. No reduced test
concurrency was used.

Verification: TypeScript and ESLint clean; Vite build passed (the existing
large-chunk advisory remains); `validate-track` and `prepare-track` passed on
the synthetic probe; `git diff --check` clean; final full suite **490/490**
passed at normal concurrency, and the template-specific suites were rerun.
The first full-suite attempt inside the restricted sandbox hit `listen EPERM`
for loopback API tests; the same unchanged suite passed with loopback
permission. The API test file also passed alone in the sandbox, identifying
the failure as an environment restriction rather than a product regression.

### 51.4 Remaining medium/low risks

- A narrow cross-process race remains between the settings writer's final
  re-read and rename. The process-local queue and UI revisions handle normal
  single-server and stale-editor use, but two separate CLI/server processes
  are not protected by a shared filesystem lock. The per-track metadata write
  path has the same existing cross-process compare/rename window. There is no
  multi-process database or lease here.
- Atomic rename prevents partial file visibility but the shared helper does
  not `fsync` the staged file or parent directory. A sudden power loss can
  therefore lose the most recent acknowledged write. Replacing a read-only
  file can succeed when its parent directory is writable, and the replacement
  takes the temp file's permissions. Permission-denied paths return errors;
  root-user permission behavior was not simulated.
- The renderer's established `.trim()` and blank-line cap can remove
  intentional leading/trailing whitespace or runs of more than one authored
  blank line. CRLF line runs do not collapse the same way as LF runs, and
  whitespace-only templates render empty. These are documented semantics,
  with no broader normalization redesign in this pass. Missing placeholders
  embedded in a sentence can leave punctuation (for example `Subtitle: []`),
  so template authors must choose copy that reads well when optional values
  are absent.
- Revision hashes reflect exact bytes; a no-op write can retain the same
  revision. JSON duplicate keys follow `JSON.parse`'s last-value behavior.
  Future schema keys are rejected and require an explicit migration. Platform
  length guidance remains unimplemented by instruction.

### 51.5 Files and commits

The hardening commit changes `metadataTemplates.ts`, global settings storage
and route, metadata PATCH parsing/service, shared error/view types, the API
client, settings/Content Package UI, CLI, and four test files. This section is
the documentation follow-up commit. No push was made.

## 52. Batch Content Package Generation (2026-09-20)

Lets the user select several tracks and inspect, plan and build their
Content Packages together, without inventing a second readiness rule or a
second render queue.

### 52.1 The question this answers

§49's Content Package view answers "what does this one track need for
YouTube/Reels/Instagram, and what's ready?" one track at a time. Selecting
ten tracks to build meant opening ten detail panels. §52 answers the same
question for a selection: which of these tracks are complete, which are
missing formats, which are stale, what would building all of them queue, and
what happened once it ran — while keeping every per-track, per-platform
answer traceable back to the exact same resolver §49 already uses.

### 52.2 The batch model

`src/domain/content/contentPackageBatch.ts` is pure and browser-safe, exactly
like `contentPackage.ts`. It never computes readiness itself — it only
aggregates `ContentPackageView`s that `deriveContentPackage` (§49) already
produced, so a batch can never disagree with the single-track view of the
same track.

```ts
BatchTrackEntry {
  slug, title, packageStatus, platforms,
  readyCount, missingCount, staleCount, renderingCount, blockedCount,
  selected, availableActions,   // distinct PlatformAction union across platforms
}
BatchContentPackageTotals {
  tracks, complete, incomplete, stale, blocked,   // track-status counts
  rendering, totalPlatformTargets,
  readyTargets, missingTargets, staleTargets,      // platform-target sums
}
BatchContentPackageView { inspectedAt, mode, tracks, invalid, duplicates, totals }
```

`complete`/`incomplete`/`stale`/`blocked` are track-level counts (each track
has exactly one `packageStatus`). `rendering` and the three `*Targets` fields
are target-level sums across every selected platform on every track — the
brief's own worked example (Track A 3/3, Track B 2 ready/1 missing, Track C 1
stale/2 ready → batch 7 ready/1 missing/1 stale) is a direct test
(`content-package-batch.test.mts`). A requested track that could not be
inspected (not found) is reported in `invalid`, never counted in `totals`.

### 52.3 Selection semantics

No new selection state: the catalogue's existing checkbox multi-select
(`checked` in `ui/App.tsx`, wired through `TrackList.tsx` since the earlier
Toshi Content Package Workflow milestone) is reused as-is. A batch is always
the explicit set of ticked slugs — there is no catalogue-wide Content
Package batch mode, so a request that forgot to tick anything is a usage
error (`INVALID_REQUEST`, "Name at least one track"), never a silent
whole-catalogue run. "Select all"/"Select none" was added to
`TrackList.tsx`'s header, scoped to exactly the tracks currently rendered in
that list — there is no filter to hide a wider catalogue behind, so the
scope is never ambiguous (§23 of the brief). The CLI's `--catalogue` flag
(§52.13) resolves to an explicit slug list via `listTracks()` *before*
calling in, rather than teaching the shared planner a second "whole
catalogue" code path.

### 52.4 Package mode semantics

Batch mode is the request's `mode: "intent" | "full"` (or an explicit
`platforms` list), passed straight through to `deriveContentPackage` per
track — the exact same values §49's mode already means. A batch never
invents a different meaning for "full", and never mutates a track's own
declared export intent; mode is a read of that intent, or an override for
the request, exactly as it always was for one track.

### 52.5 Readiness aggregation

`server/services/contentPackagePlan.ts`'s `buildContentPackagesForSlugs`
builds each track's package the same way `GET /api/content-package` already
does — `inspectTrack` → `toTrackDetailView` → `deriveContentPackage` — the
only difference is that the three things every track in the batch shares
(destination root, global metadata templates, the render queue's in-flight
state) are read once via `loadContentPackageBatchContext()` and passed to
every track, instead of once per track. Aggregation
(`deriveBatchContentPackage`) only runs after every individual package is
resolved — there is no code path that computes a batch total without first
computing each track's own answer.

### 52.6 The planner

Also pure (`contentPackageBatch.ts`), and also a re-labelling, not a new
decision: `planContentPackageBatch` maps each selected platform's
`PlatformReadiness` (already computed by §49) onto one of five action kinds:

| readiness | action kind |
|---|---|
| `missing` | `render_missing` |
| `stale` | `rerender_stale` |
| `rendering` | `adopt_existing_render` |
| `ready` | `already_ready` |
| `blocked` | `blocked` (with the platform's own blocker reason) |
| `not_selected` | *(no action)* |

`renderable` (the `render_missing`/`rerender_stale` actions) is
de-duplicated by `slug::presetId` — proven with a synthetic test where two
platform entries are made to share one preset, since no two shipped
platforms do today (`platformProfiles.ts`). `toRenderTargetsFromPlan` maps
`renderable` straight into `RenderTarget[]`, the exact shape
`renderManager.startBatch` already takes.

### 52.7 Revalidation

Apply never accepts a plan payload back from the client — there is no
plan id, no durable plan object, nothing to go stale in the first place.
`handleApplyContentPackageBatch` re-reads current track/queue state and
calls `planContentPackageBatch` fresh, immediately before queueing
anything, every time. A target that became ready since the caller last
looked (§52 test: "apply revalidates immediately before queueing") is read
as `already_ready` and left out of what gets queued; a target another
caller queued in the meantime is read as `adopt_existing_render`. The
export-missing route (§37) already re-checks in-flight state once between
planning and enqueueing for the same reason; apply does the whole plan over
again, not just that one check, because a batch's readiness can change on
more axes (delivery, metadata, another process's render) than a flat preset
list can.

### 52.8 Deduplication and existing-render adoption

Two layers, matching the brief's own instruction not to let the planner's
early dedup replace the render manager's authority: the planner dedupes
`renderable` by track+preset (§52.6) before anything is queued, and
`renderManager.startBatch` (§37, untouched) is still the final authority —
it independently skips anything already active and reports what it locked
elsewhere. A platform already `rendering` never reaches `renderable` at all;
it is reported as `adopted` in the plan/apply response instead, so the UI
can say "already queued" rather than silently dropping it or double-queueing
it.

### 52.9 Progress

No second progress transport. `handleApplyContentPackageBatch` queues
through `renderManager.startBatch` exactly like `/api/export-missing`
already does, and returns the same `batchId`. The UI hands that id straight
to the existing `QueueDrawer`/`useRenderBatch` (SSE `GET
/api/render-batches/:id/events`) — the same drawer every other queueing
action in the app already uses, showing per-job status/progress/elapsed
time and a batch-level aggregate. `BatchContentPackagePanel` itself shows
batch-level and track-level counts (ready/missing/stale/rendering/blocked,
per track and summed); it does not re-fetch on its own while a queued
render runs — like the rest of this app's "explicit refresh" design, seeing
the *new* readiness after a render finishes means reopening the panel or
switching its mode, which re-reads current state. This is a real, deliberate
limitation, not an oversight — see §52.16.

### 52.10 Timeout / wait behavior

`POST .../batch/apply` takes optional `wait` and `timeoutMs` (default
30000ms, capped at 600000ms). With `wait: true`, the route subscribes to the
just-created render batch and holds the HTTP response open until it settles
or the timeout elapses, then returns the batch's state at that moment plus
`timedOut`. A timeout only means the *response* stopped waiting — nothing is
cancelled, and `batchId` is still valid to follow via SSE or poll
afterwards, exactly like confirmed delivery's own "queue now, follow
separately" behavior (§48). The CLI does not offer `--wait`/`--timeout`: its
`--apply` already renders synchronously, in-process, one target after
another (§52.13), so there is nothing asynchronous to wait for.

### 52.11 Partial failure behavior

One track failing does not stop the others: each platform target is an
independent job in the underlying render batch (§37, unchanged), and a
job's failure only marks that job `failed` — sibling jobs, whatever track
they belong to, run to completion normally. Within one track, platforms are
independent render targets from the start (`PLATFORM_LIST`, one preset
each), so "YouTube succeeded, Reels failed, Instagram was already ready" is
just three independent `renderStatus`/`readiness` answers on the same
package — nothing here collapses them into one pass/fail flag. An invalid
track (not found, or metadata that fails validation) is reported in
`invalid`/`blocked` and simply contributes no renderable action; it never
throws for the rest of the batch.

### 52.12 API

Three endpoints, mirroring `/api/export-missing`'s own request/response
conventions (`dryRun`-style separation, `nothingToDo`, `batchId: string |
null`):

```
POST /api/content-package/batch/inspect  { tracks, mode?, platforms? }
  -> BatchContentPackageView   (read-only)
POST /api/content-package/batch/plan     { tracks, mode?, platforms? }
  -> ContentPackageBatchPlanView   (read-only; renderable/adopted/ready/blocked)
POST /api/content-package/batch/apply    { tracks, mode?, platforms?, wait?, timeoutMs? }
  -> ContentPackageBatchApplyView   (re-plans fresh, queues through renderManager)
```

`tracks` is always required and explicit (§52.3); server-issued track slugs
and platform ids only — no client-supplied render command, shell string or
file path anywhere in these bodies. Batch size is bounded
(`MAX_BATCH_TRACKS = 100`, `server/services/contentPackagePlan.ts`); an
empty list, a batch over the limit, an unknown platform id, or a malformed
slug are all rejected with `INVALID_REQUEST`/`INVALID_PLATFORM`/`INVALID_SLUG`
before any track is inspected. Duplicate slugs are de-duplicated (first
occurrence kept) and reported in `duplicates`, never rejected outright and
never double-counted. There is no batch delivery endpoint: "Deliver ready
packages" reuses the existing `DeliverPanel`/`POST /api/delivery/deliver`
unchanged, scoped to the same selected tracks (§52.14) — content packages
never grew their own copy logic.

### 52.13 CLI

`scripts/content-package-batch.mts`, `npm run content-package-batch`:

```
npm run content-package-batch -- --track beat-a --track beat-b
npm run content-package-batch -- --tracks beat-a,beat-b --mode full --plan
npm run content-package-batch -- --catalogue --apply
```

Default (no `--plan`/`--apply`) is inspection only, matching
`content-package.mts`'s own default-safe convention (`--apply` opts into
rendering, the opposite polarity from `render-missing.mts`'s
`--dry-run`-opts-out). `--catalogue` resolves via `listTracks()` to an
explicit slug list *before* the shared planner ever sees it — never an
implicit "no tracks named" catalogue run. `--apply` renders sequentially,
in-process, via `renderTrackVideo`, memoizing one `prepareTrack` per track
and reusing it across that track's own selected formats — the identical
pattern `render-missing.mts` and `content-package.mts` already use; this CLI
is not a second render engine, and work it starts is invisible to a running
server's queue and vice versa (documented, not new — §37/§43 already say
this about every other CLI here). `--json` prints the exact same
`BatchContentPackageView`/plan objects the API returns.

### 52.14 UI

- `TrackList.tsx`: "Select all"/"Select none" in the list header, scoped to
  the listed tracks (§52.3). The per-row checkbox column itself already
  existed.
- `App.tsx`: a new "Inspect content packages" toggle in the selection
  toolbar (next to the pre-existing "Add to render queue" and "Export
  missing for selected"), shown once at least one track is ticked.
- `BatchContentPackagePanel.tsx` (new): mode toggle, an aggregated
  ready/missing/stale/rendering summary plus a per-track status list
  (concise — badge, ready/total counts, never full captions/descriptions
  inline, per §19/§42 of the brief), a "Create plan" button showing
  renderable/adopted/ready/blocked with per-action detail, an "Apply N
  actions" button that hands the resulting `batchId` to the app's existing
  `QueueDrawer`, and — only once a destination is configured — the existing
  `DeliverPanel` scoped to the same selection for "Deliver ready packages".
  Metadata previews stay in the single-track `ContentPackagePanel`
  (unchanged); the batch panel never dumps captions/descriptions into the
  table.

### 52.15 Performance

One `inspectTrack` per selected track is unavoidable — that is what "current
state" means — but everything each track's derivation shares (`GET
/api/content-package`'s own delivery-root read, the global template
settings read, the render queue's in-flight map) is read exactly once per
batch call via `loadContentPackageBatchContext()`, not once per track. No
catalogue-wide scan happens unless the caller explicitly asked for
`--catalogue`/ticked the whole list — there is no implicit full-catalogue
read anywhere in the batch code path. No video hashing, `ffprobe`, recursive
filesystem scan or new watcher was added; freshness still comes entirely
from the existing manifest/fingerprint machinery (§36). Measured at 2, and
separately at 100 (the batch-size cap itself, via a domain-level test with
synthetic tracks), aggregation and planning are sub-millisecond — the cost
is exactly N `inspectTrack` calls, run in parallel via `Promise.all`,
exactly like `planMissingExports` (§37) already does for the catalogue case.

### 52.16 Large-batch UX and restart behavior

At 50+ tracks the panel stays usable because each row is one compact line
(badge + counts), and per-platform metadata previews are never expanded by
default anywhere in the batch view (only the single-track panel offers a
"Preview metadata" toggle, unchanged). Nothing about batch orchestration
survives a process restart: there is no persisted plan, no persisted batch
object, and no durable batch-history subsystem (§37 explicitly forbids one)
— `batchId` is the render manager's own transient job-batch id, already
in-memory-only and already forgotten across a restart exactly as it was
before this milestone (§37/§38). After a restart, a fresh inspect/plan read
is the only truth; delivery history, delivery receipts and render job
records remain the durable systems of record, unchanged.

### 52.17 Tests (41 added, 531 total)

- `tests/content-package-batch.test.mts` (new, 30 tests) — pure aggregation
  math (the brief's own worked example, blocked/invalid/duplicate handling,
  target-level vs track-level totals), pure planning (every readiness ->
  action-kind mapping, blocked reasons, not-selected produces no action,
  cross-platform preset dedup, purity/idempotency), service-level slug
  bounds/dedup/validation, and real-fixture end-to-end tests via
  `buildContentPackagesForSlugs` proving agreement with the single-track
  resolver, a not-found track reported without failing the batch, an
  invalid `metadata.json` blocking only that track, apply-time
  revalidation (a target becoming ready or in-flight between reads), a
  copy-only template edit never changing what would render, and a rendered
  title edit staling exactly that track.
- `tests/api-integration.test.mts` (+11) — inspect (aggregation, empty
  batch rejected, over-limit rejected, duplicate dedup, not-found track,
  unknown platform), plan (renderable/ready/blocked classification, proven
  not to queue anything), apply (no-op when everything is already ready,
  real queueing through the render manager with a mocked worker — same
  `managerHarness`/`childProcess.fork` mock pattern the existing "stale
  execution" test uses, apply-time revalidation across a real HTTP round
  trip, malformed body rejected before anything is touched).
- All existing single-track Content Package/metadata-template tests (§49–51)
  pass unchanged — nothing in this milestone touched `deriveContentPackage`,
  `buildPlatformMetadata`, or the metadata-template resolver.

### 52.18 End-to-end and browser results

A synthetic, real (never mocked) probe built three tracks —
`batch-probe-a/b/c` — with short (3s) ffmpeg-generated audio and a small
cover, so real `renderTrackVideo` calls (real bundling, real Chromium
render, real manifest) stayed fast. Coverage was built to the brief's exact
worked example: A all three ready; B YouTube+Square ready, Reels missing; C
YouTube+Reels ready, Square deliberately drifted stale (its output file's
bytes changed after publication, an `output_changed` reason — changing
metadata instead would have staled all three of a track's platforms at
once, since fingerprint inputs are shared across a track's presets, not
per-platform). Inspect reported exactly **7 ready / 1 missing / 1 stale**;
plan reported exactly **2 renderable actions** (`batch-probe-b`/Reels
`render_missing`, `batch-probe-c`/Instagram Square `rerender_stale`);
applying them for real (actual `renderTrackVideo` calls, not mocked) brought
the batch to **9/9 ready, 3/3 complete**. A subsequent global-template-only
edit left readiness at 9/9; a subsequent title edit (a rendered field) on
Track B staled exactly Track B's three platforms, leaving A and C
untouched. All assertions passed; all three synthetic tracks and their
`out/` directories were removed afterward. Ghetto Geek was never read or
modified by this probe.

A second, separate real-headless-Chrome pass (`--headless=new` Google
Chrome, raw CDP over WebSocket, no puppeteer — same technique as §50's own
probe) drove the actual running API (`server/index.mts`) and Vite dev
server against two further synthetic tracks (`browser-probe-x/y`, one fully
ready, one with two platforms genuinely missing). Through the real UI it:
ticked exactly those two tracks (never Ghetto Geek, left unticked and
visibly unchanged in the same screenshot); opened
`BatchContentPackagePanel` and confirmed "6 platform targets · 4 ready · 2
missing · 0 stale"; clicked "Create plan" and confirmed "2 safe actions · 0
already in flight · 4 already ready · 0 blocked"; clicked "Apply 2 actions"
and confirmed the existing `QueueDrawer` appeared showing "2 total · 1
rendering · 1 queued" with real per-job progress rows; polled until both
jobs showed `badge--job-completed`; re-opened the batch panel (a mode
toggle, forcing a fresh inspect read) and confirmed "6 platform targets · 6
ready · 0 missing · 0 stale"; then clicked "Clear" and confirmed both
checkboxes cleared and the batch panel closed. Both synthetic tracks, their
`out/` directories, the temporary setup/probe scripts, the Chrome profile
and both background server processes were removed/stopped afterward; a
process scan afterward found zero leaked Chrome/server/Vite processes and
an empty `out/.locks/`.

### 52.19 Verification performed

TypeScript and ESLint clean (whole project, both before and after every
new/changed file). `npx vite build` passed (only the pre-existing
large-chunk advisory). Full suite **531/531** passed at normal concurrency,
run four times in a row for stability — two transient failures were seen on
one run, both in test files this milestone never touched
(`export-freshness.test.mts`'s own catalogue-wide scan racing another test
file's fixture directory, and a similar cross-file interaction), and both
were gone on every other run, consistent with this repo's known
shared-fixture-directory flakiness under full concurrency (documented in
earlier sections) rather than a regression here. `validate-track`/
`prepare-track` passed on `ghetto-geek`. `git diff --check` clean. No
config fixture (`delivery.local.json`, `content-metadata.local.json`) was
left behind; no render lock was left in `out/.locks/`; no track other than
`ghetto-geek` remained under `public/tracks/` afterward.

### 52.20 Remaining limitations

- The batch panel does not live-poll after a queued render finishes; seeing
  updated readiness means reopening the panel or switching its mode (§52.9).
  This matches the rest of the app's explicit-refresh design rather than
  adding a new poll loop, but it is a real UX gap worth revisiting if batch
  use becomes frequent.
- There is no batch-level cancel — only per-job cancel and the existing
  render batch's own "Cancel all" (both already in `QueueDrawer`, unchanged,
  and both work against a Content Package batch's jobs exactly as they do
  any other render batch, since it is the same underlying render-batches
  object). A dedicated "cancel this Content Package batch" affordance was
  explicitly deferred, per the brief's own permission to do so (§36).
- No catalogue-wide mode at the API/service layer — only the UI's full
  ticked selection and the CLI's `--catalogue` (resolved client-side to an
  explicit list). Deferred rather than built, since nothing in the brief
  required it and every existing catalogue-wide action in this app
  (`export-missing`, `deliver`) already has its own established pattern this
  milestone did not need to duplicate.
- No batch-level delivery endpoint; "Deliver ready packages" is the
  existing single delivery action scoped to the batch's tracks (§52.12).
- Platform-length guidance in previews remains unimplemented, per §50.21 —
  unrelated to and unaffected by this milestone.

### 52.21 Files changed

New:
- `src/domain/content/contentPackageBatch.ts` — aggregation + planning model.
- `server/services/contentPackagePlan.ts` — I/O: shared context, per-track
  package building, slug validation/bounds/dedup, request-body shape checks.
- `server/routes/contentPackageBatch.ts` — inspect/plan/apply handlers.
- `scripts/content-package-batch.mts` — CLI.
- `ui/components/BatchContentPackagePanel.tsx` — batch panel.
- `tests/content-package-batch.test.mts` — domain/service tests.

Changed:
- `src/domain/api/views.ts` — batch request/response view types, re-exports.
- `server/app.ts` — routes `/api/content-package/batch/{inspect,plan,apply}`.
- `ui/api/client.ts` — `inspectContentPackageBatch`/`planContentPackageBatch`/
  `applyContentPackageBatch`.
- `ui/App.tsx` — batch toggle, select-all/clear wiring.
- `ui/components/TrackList.tsx` — select-all/select-none.
- `ui/styles/app.css` — `.batchpackage*`, `.tracklist__headactions`.
- `tests/api-integration.test.mts` — 11 new HTTP-level tests.
- `package.json` — `content-package-batch` script.

Nothing in `src/domain/content/contentPackage.ts`,
`src/domain/content/platformMetadata.ts`, `src/domain/content/
metadataTemplates.ts`, `server/services/renderManager.ts`, `services/render/
renderLock.ts`, `services/render/renderTrackVideo.ts`, or any delivery
service changed.

### 52.22 Commits

1. Add the batch Content Package model and aggregation (domain layer).
2. Add the batch planner, shared context, and I/O (server service).
3. Add the batch API and CLI.
4. Add catalogue multi-select affordances and the batch UI panel.
5. Test batch aggregation, planning, revalidation and the API.
6. Document Batch Content Package Generation.

No push was made.

### 52.23 Recommended next feature

Live progress inside `BatchContentPackagePanel` itself (subscribing to the
returned `batchId`'s SSE stream directly, the way `QueueDrawer` already
does, so the panel's own ready/missing/stale counts update as jobs finish
without the user needing to reopen it or switch modes) — see §52.20's first
limitation. Not started, per instruction.

---

## 53. Live Batch Progress & Auto-Refresh (2026-09-20)

This section supersedes §52.20's first limitation and §52.23's proposed
feature. Batch package readiness now updates in the open panel during real
renders. No second queue, progress endpoint, WebSocket, server poller, or
delivery-progress model was added.

### 53.1 Architecture and exact correlation

`POST /api/content-package/batch/apply` still re-plans from fresh state and
uses `renderManager.startBatch` as final authority. Its response now adds
`jobReferences`: stable `actionId`, slug, platform, preset, exact job ID and
immediate outcome (`queued`, `adopted`, or `locked_elsewhere`). Queued IDs
come from the returned render batch. Adopted IDs come from the manager's
active job record. A cross-process lock has no in-memory job ID and is
explicitly null. The UI never guesses identity from a track name afterward.

`App` retains the most recent Apply response while the panel is closed. The
panel mounts one `useRenderJob` follower per unique job ID, including adopted
jobs. That existing hook uses `/api/renders/:id/events`; the SSE route
replays current state on subscribe and terminal state even across the
replay/subscribe race. QueueDrawer continues to use its existing batch SSE
hook. The panel requests no log history and discards log events.

Three layers stay separate: persisted package readiness from the single-track
resolver; authoritative job status/progress from the render manager; and
transient subscription state. `deriveLiveBatchProgress` overlays the exact
job references on a package snapshot. Each selected platform occupies one
batch bucket, so stale/missing plus rendering is counted as rendering once.
Track rows show their own ready count and active work. Progress percentages
come only from real job frames/progress; a job with no meaningful value gets
status text alone. A completed job enters `checking` while its package is
being read; completion never directly produces Ready.

### 53.2 Terminal refresh and failure behavior

Completion, failure, and cancellation all queue a narrow
`GET /api/content-package?track=<slug>` in the currently selected mode.
Terminals within 50 ms are coalesced by slug. The returned single-track
package replaces only that track in the batch snapshot and recomputes
totals. Old full-inspect and targeted responses cannot overwrite a newer
scope or refresh. A failed package read leaves the job terminal status and
an explicit refresh error visible; closing and reopening re-inspects. A
successful job can therefore still end in stale/missing readiness if its
rendered inputs or export intent changed in the meantime. A failed or
cancelled job does not requeue itself, and siblings retain their own state.

The API's `wait:true`/`timeoutMs` still limits waiting only. The response
keeps its job IDs, and the panel follows those jobs after a timed-out Apply.
The normal panel call remains non-waiting. The batch CLI remains synchronous
and has no `--wait` flag; this milestone made no CLI change.

`useRenderJob` closes its EventSource on terminal and unmount. After an SSE
error it re-reads the job with `GET /api/renders/:id`; terminal results are
used immediately, transient GET failures let EventSource reconnect, and
only an authoritative 404 marks the job missing. A panel close/reopen
re-subscribes to exact retained IDs and re-inspects packages. Selection and
mode changes re-inspect the new scope, while job references remain keyed by
slug and platform. A browser reload loses the in-memory batch selection,
although renders continue; users can re-inspect. Server restart still loses
in-memory render jobs, as before.

### 53.3 Verification and performance

Focused tests cover exact queued/adopted IDs, timeout without cancelling,
live aggregation, independent failure/cancellation, completed-but-stale
readiness, scope changes, duplicate job references, and a 12-target mixed
job model. The full suite passed at normal concurrency after local loopback
access was granted: **536/536 passed** (the sandboxed attempt failed only because its HTTP tests
could not bind `127.0.0.1`). TypeScript, ESLint, Vite build, and diff checks
passed. The existing single-track package, QueueDrawer, queue, and SSE API
tests remain in the full suite.

A real headless Chrome/CDP probe used three isolated 3-second synthetic
tracks (one ready, two missing), selected them through the UI, inspected,
planned, and applied. The panel visibly went from `1 ready / 2 missing` to
`1 ready / 1 rendering / 1 queued`, displayed actual percentages, then
`2 ready / 1 rendering` and `3 ready` without manual refresh. Closing and
reopening mid-render recovered. For two completed jobs on different tracks,
Chrome recorded exactly two narrow package GETs and no recurring batch
inspect. It recorded four per-job SSE connections because the panel was
remounted once; each mount had one connection per unique active job. A
separate real cancellation left its package incomplete.

An additional exact-shape browser probe used three further 3-second tracks
with all three platforms selected. Eight genuine exports were prepared, and
one Square output was deliberately changed after publication. Fresh inspect
confirmed **9 targets: 7 ready, 1 missing, 1 stale**. The browser selected
all three, planned two actions, and applied them through the real panel.
Visible totals moved through `7 ready / 1 queued / 1 rendering`, then
`8 ready / 1 rendering`, then **9 ready** with no panel reopen or manual
refresh. Chrome recorded exactly two per-job SSE subscriptions and two
targeted package GETs (one each for the missing and stale tracks), real
progress values, and zero page exceptions. Selection was cleared afterward.

A targeted fault proxy severed one real job SSE stream mid-render while
leaving the page and API alive. Chrome recorded a second subscription, real
progress recovery, one targeted package GET, and final Ready with no console
exception. Restarting the Vite process itself was also tried; Vite reloaded
the page, which correctly demonstrated the documented browser-reload
limitation rather than an SSE reconnect case. The temporary proxy, Chrome
profiles, synthetic tracks and outputs, and local servers were removed.

### 53.4 Platform-level state detail

Each selected platform occupies exactly one target bucket. Its visible state
is the union of package readiness and any active job state:
- If job is queued/rendering, display that instead of package readiness
- If job is queued, state is "queued"
- If job is rendering/preparing, state is "rendering" (progress if available)
- If job is completed and package read is in progress, state is "checking"
- Otherwise, show package readiness (ready/missing/stale/blocked)

A platform where the job is render_failed always shows the error message
from the job; a cancelled job shows cancelled status; a completed job that
refreshed to stale/missing shows both "completed" badge and the new readiness.

Track rows show aggregated counts: ready (not under job control), total
(selected platforms), queued (unique queued jobs), and rendering (unique
rendering jobs). These counts never double-count a platform with an active
job.

### 53.5 Lost-event and scope protection

The panel retains the most recent Apply response in `App` state while closed.
On reopen, it uses exact `jobReferences` (actionId, jobId) to re-subscribe to
those exact job SSE streams, not a catalogue-wide re-inspect. Scope tracking
prevents old refresh responses from overwriting a newer track selection or
mode change: each pending refresh is versioned by slug, and only the latest
version of each slug's refresh is applied if scope is unchanged. Metadata
edits, export-intent edits, and mode changes during render correctly degrade
to letting the completed job's readiness stand as-is until the user manually
re-selects the batch or switches its mode.

### 53.6 Metadata and export-intent edits during render

The panel preserves the Apply response's `mode` in state (`applied?.mode`) so
mode switches do not accidentally lose context. When a job completes, it
queues a single-track package refresh at the *current* mode; if the user
changed modes, they see the package in the new scope. Metadata edits (fields
like title/artist/key that fingerprint into render inputs) go stale after
render but are detected normally. Export-intent edits (which formats were
declared for a track) change what the new scope shows; if the user adds a new
format mid-render and switches to full mode, they see it as missing, and the
batch totals re-aggregate correctly. No special handling is needed for either
case — the refresh mechanism handles both.

### 53.7 Files changed

New:
- `ui/components/batchProgressModel.ts` — `deriveLiveBatchProgress`, live state types.
- `tests/batch-progress.test.mts` — live aggregation, failure/cancellation, scope changes.

Changed:
- `src/domain/content/contentPackageBatch.ts` — `replaceBatchTrackPackage` to update one track.
- `server/routes/contentPackageBatch.ts` — `ContentPackageBatchJobReferenceView` in apply response.
- `src/domain/api/views.ts` — job reference views, apply response includes `renderBatch`.
- `ui/App.tsx` — retain applied response across panel close.
- `ui/components/BatchContentPackagePanel.tsx` — live job subscription per unique ID, refresh
  coalescing (50ms per slug), scope/version tracking, display platform job state and progress.
- `ui/hooks/useRenderJob.ts` — no new functionality, only called with more payload.
- `ui/styles/app.css` — `.batchpackage__platform`, `.batchpackage__progress`, `.batchpackage__joberror`.
- `tests/api-integration.test.mts` — one new test for apply response job references.

### 53.8 Commits

1. Show live batch job progress and refresh package readiness (3c87623).
2. Test batch job correlation and live target aggregation (a96c35d).
3. Document Live Batch Progress & Auto-Refresh.

### 53.9 Final git status

All changes committed, pushed and synced. Working tree clean. `main` and
`origin/main` were both at `226b65e` (0 ahead, 0 behind) before §54 began.

### 53.10 Scope and next feature

The batch panel still exposes no dedicated batch-wide cancel. Delivery
readiness is not folded into render progress. A later feature could persist
or reconstruct a batch session across browser reloads, allowing users to
resume an inspected batch after a browser reload; it was not started.

## 54. Batch Session Persistence Across Browser Reloads (2026-09-21)

This section supersedes §53.2/§53.10's browser-reload limitation. The browser
can now reconstruct the meaningful Batch Content Package workflow after a
reload or browser restart. This remains a UI-only, machine-local convenience:
no database, cookie, account, server session, durable job registry, polling,
new queue, new render transport or new API route was added.

### 54.1 Storage choice, schema and expiry

`ui/batchSession.ts` owns one namespaced `localStorage` entry:
`toshi.visualizer.batch-content-package.v1`. `localStorage` was chosen over
`sessionStorage` because the product requirement includes closing and
reopening the browser, not only reloading one tab. The entry is last-writer
wins across tabs; there is deliberately no cross-tab collaboration or
`storage`-event synchronization.

The version-1 schema is intentionally narrow:

```ts
{
  schemaVersion: 1,
  savedAt: string,                 // ISO timestamp
  selectedSlugs: string[],
  mode: "intent" | "full" | "platforms",
  platforms: PlatformId[],         // used only by explicit-platform mode
  jobReferences: Array<{
    actionId: string,
    slug: string,
    platformId: PlatformId,
    presetId: RenderPresetId,
    jobId: string,
  }>,
  panelOpen: boolean,
}
```

Sessions expire after 24 hours of inactivity. A meaningful session write
(selection, mode/platform, panel-open state, returned job reference or terminal
prune) updates `savedAt`; an untouched entry older than 24 hours is removed.
The storage payload is bounded to 100 selected tracks, 300 exact job
references, a tiny platform list and 100 KB of raw JSON.

Not persisted: package/readiness snapshots, aggregate totals, render progress,
job health, errors, plans, delivery state, destination assumptions, track
metadata, captions/descriptions, export freshness or any path/operation. Those
values are always re-read or re-derived from current server/filesystem state.

### 54.2 Trust and validation model

Browser storage is treated as untrusted input. Loading requires the supported
schema version, a finite non-future ISO timestamp inside the 24-hour window,
bounded arrays, valid canonical slugs and current platform definitions. Track
slugs are intersected with the freshly loaded catalogue before selection is
shown. Duplicates are removed; deleted/malformed tracks and unknown platforms
are dropped. If no track survives, the entry is cleared and the ordinary empty
selection UI is shown. Explicit-platform mode with no surviving platform falls
back to intent mode and never mutates track export intent.

A job reference is accepted only when its platform is current, its preset is
exactly that platform's current preset, its `actionId` exactly equals
`slug::platform::preset`, and its bounded job ID contains only safe identifier
characters. Neither file paths, routes, shell arguments nor operation names
can come from storage. Duplicate action references collapse to one; a new
server-returned exact reference replaces the older reference for that action.

### 54.3 Rehydration sequence and truthful UI

On app start, the entry is parsed first but not displayed as truth. The UI says
`Restoring batch…` while the catalogue loads, intersects the selected slugs,
restores mode/platform and panel-open intent, then mounts the normal batch
panel. The panel performs the existing batch inspect against current state.
Only after that authoritative inspect succeeds does job recovery begin, which
prevents an old readiness snapshot or false empty panel from flashing.

Every persisted job ID is queried through the existing
`GET /api/renders/:jobId`. Returned job ID, slug and preset must all match the
persisted target exactly; there is no title/track/latest-render/timestamp
guessing and no job adoption by inference.

- `queued`/`preparing`/`rendering`: retain the fresh status and mount exactly
  one existing per-job SSE follower per unique ID.
- `completed`/`failed`/`cancelled`: show the truthful terminal result while a
  targeted current-package read runs; never requeue.
- authoritative 404, including an in-memory server restart/eviction: treat the
  job as unknown, perform the same targeted package read, fabricate no result,
  and leave no permanent spinner.
- transient job-status transport failure: show a recovery warning, display the
  freshly inspected package state, and keep the exact reference for a later
  panel reopen/reload rather than misclassifying the job as missing.

Terminal/unknown references are removed from browser storage only after the
affected track's authoritative package refresh succeeds. Failed/cancelled job
detail may remain in current in-memory UI state, but it is no longer a fake
active or durable job. Several terminal jobs still use §53's 50 ms per-slug
coalescing and targeted `GET /api/content-package`; no catalogue reload or
batch-level polling was introduced.

### 54.4 Races, SSE and user-intent safety

The existing lost-event-safe sequence remains authoritative: recovery GETs the
current job before subscribing; the per-job SSE route replays current state;
it re-checks after listener registration; and `useRenderJob` re-GETs after a
stream error. A job completing before reload, between GET and subscribe, or
during reconnect therefore becomes terminal and triggers package refresh
rather than leaving a spinner. Unique job IDs prevent duplicate EventSources
and target identity prevents cross-talk across simultaneous jobs.

Reload never resumes Apply, planning, rendering, delivery or a fix plan. It
only restores selection/context and observes exact server-issued jobs already
started. Apply after restore still calls the unchanged endpoint, which
re-inspects/re-plans and lets `renderManager.startBatch` remain final dedupe
authority. There is no client path that turns a persisted reference into a new
render request, so persistence cannot duplicate work or bypass planner safety.

Title/rendered-metadata edits, copy-only template edits, export-intent changes,
destination changes and delivery changes made while the browser is away all
flow through the ordinary fresh package resolver. Copy-only changes still do
not affect render freshness; rendered metadata still can make an export stale;
mode restoration never writes export intent; delivery/destination state is
never persisted.

### 54.5 UI behavior and compatibility

The panel now exposes the already-supported explicit platform request as a
third mode beside Intent and Full. Its platform buttons use the current shared
platform registry, keep at least one selected, and persist only IDs. Clear
selection is also the deterministic `Clear batch` operation: it synchronously
removes local storage, selection, retained Apply state and job references.
Closing the panel preserves session context and live job references; reopening
keeps §53's behavior. A page reload restores an open panel if it was open. A
full Chrome-process close/reopen with the same profile was tested and restored
selection plus panel-open intent.

The single-track Content Package panel, QueueDrawer, render queue, per-job and
batch SSE APIs, delivery, destination health, release bundles, metadata
templates and every CLI remain unchanged. No API/server/domain persistence
shape was added. The server's history limits also remain unchanged: 200
unclaimed settled jobs and 50 settled batches in memory, with active jobs never
trimmed; a restart forgets all of them and browser recovery falls back to
package inspection.

### 54.6 Tests and real browser probes

`tests/batch-session.test.mts` adds 15 focused pure tests covering persisted
selection/mode/platforms/job references, valid recovery, malformed JSON,
unsupported version, duplicate/unknown/deleted tracks, unknown platforms,
expiry, future timestamps, huge arrays/raw payloads, wrong field types, exact
job identity, duplicate job references, active queued/preparing/rendering
classification, completed/failed/cancelled classification, terminal pruning,
storage access failure and immediate clear. They passed 21 consecutive runs.
Existing progress tests continue to cover target aggregation, failure,
cancellation, completed-but-stale truthfulness, selection/mode changes, shared
job IDs and 12 targets. The normal-concurrency full suite passes **551/551**.

A real isolated headless Chrome/CDP probe created three 4-second synthetic
tracks and nine platform targets. It prepared the exact initial shape **7
ready / 1 missing / 1 stale**, selected all three in the UI, created a plan and
applied exactly two actions. It reloaded with two persisted exact job IDs while
work was live, restored all three tracks and Intent mode, issued exactly two
authoritative job GETs, reconnected live state, and reached **9 ready** without
manual refresh. The probe recorded one Apply request, four SSE connections
(two before and two after reload), two targeted package refreshes, zero
duplicate renders, terminal references pruned to zero, a second settled reload
with no ghost jobs, and successful Clear + reload with no storage entry.

A separate server-restart probe retained a real server-issued job ID in browser
storage, restarted the API (thereby losing the in-memory job registry), and
reloaded. The exact ID became authoritative 404, selection remained useful,
current package inspection showed Ready, the unknown reference was pruned, and
no spinner or fabricated success/failure remained. A separate isolated Chrome
profile was fully closed and reopened to verify persistence across browser
process lifetime, not only page reload.

The focused one-target probe additionally recorded one Apply, one recovery job
GET, two SSE connections around reload and one targeted refresh. No browser
exception was observed. Stress is bounded analytically and by tests (100 tracks,
300 job references, 12 live targets); repeated page reload accumulation was not
run as a long-duration soak.

### 54.7 Verification, performance and cleanup

TypeScript/ESLint, full tests, Vite/Remotion bundle, `validate-track`,
`prepare-track` and `git diff --check` passed. The initial sandboxed full-suite
attempt failed only because HTTP tests could not bind `127.0.0.1`; the granted
normal-concurrency rerun passed. A deliberately parallel build/test attempt
made the bundler observe a test fixture during its removal; the sequential
bundle passed, confirming an external fixture-copy race rather than a product
failure.

Restore cost is one existing batch inspect, one job GET per unique persisted
reference and one SSE connection per server-confirmed active unique ID.
Terminal refresh remains per affected slug with 50 ms coalescing. Storage is a
few hundred bytes for ordinary batches and never receives progress frames, so
render events cause no storage-write churn.

All synthetic tracks, exports/manifests, Chrome profiles, CDP scripts, bundle
artifacts and local servers were removed. Ghetto Geek was not modified;
`prepare-track` and `validate-track` confirmed its analysis and metadata remain
current. No local delivery/content-metadata config, render lock, worker, test
server or synthetic track remains.

### 54.8 Files and commits

New:
- `ui/batchSession.ts` — versioned schema, bounded parser, catalogue reconcile,
  safe storage adapter, exact-reference merge/prune and job classification.
- `tests/batch-session.test.mts` — persistence/trust/recovery regression tests.

Changed:
- `ui/App.tsx` — catalogue-gated restore, lifted batch mode/platform/reference
  state, meaningful writes, immediate clear and panel restoration.
- `ui/components/BatchContentPackagePanel.tsx` — explicit-platform UI,
  authoritative job recovery, active-only SSE reconnect, terminal/unknown
  targeted refresh and persistence pruning.
- `docs/HANDOFF_PHASE_2B_TO_2C.md` — this section and corrected §53.9 sync state.

Logical commits:
1. `bf83340` Define persisted batch session model.
2. `7b1b5fc` Restore batch context and exact render jobs.
3. Documentation commit containing this section.

### 54.9 Remaining limitations and next feature

Persistence is intentionally per browser profile and machine, unauthenticated,
last-writer-wins across tabs, and capped at 24 hours. A server restart cannot
resume the old render process or recover its progress; only filesystem/package
truth survives. Transient recovery failures require a panel reopen/reload to
retry the exact job GET. There is no durable batch history and no automatic
cross-tab UI update.

Recommended next feature: a batch-panel Cancel action that reuses the existing
render-batch cancellation API and current exact IDs, with no new queue or
session model. It was not started.

## 55. Current State — Batch-Panel Cancellation (2026-09-21)

The persisted Batch Content Package panel can now stop its own visible active
render work. No cancellation protocol, queue, worker message, watcher or
durable cancellation state was added. The feature is a narrow UI adapter over
the render service that already owns cancellation.

### 55.1 Authority and exact scope

The panel reuses the existing `POST /api/renders/:jobId/cancel` endpoint and
`renderManager.cancelRender(jobId)`. The existing
`POST /api/render-batches/:batchId/cancel` remains unchanged and is still used
by QueueDrawer, but is deliberately not used here: one content-package session
can contain jobs queued by its latest Apply plus adopted exact jobs from other
batches, and the persisted session does not claim that one batch ID owns all
of them. Cancelling that one batch would miss adopted work; cancelling a wider
batch could reach jobs the visible panel does not represent.

`ui/batchCancellation.ts` therefore selects only references that satisfy all
of these at click time:

- the track is in the panel's current authoritative inspect response;
- the platform is selected in that current response (hidden mode/platform
  targets are excluded);
- the exact server-issued `jobId`, `slug` and `presetId` all agree;
- the fresh job is `queued`, `preparing` or `rendering`;
- a shared job ID is requested at most once.

There is no fallback to title, latest render, slug alone, inferred preset or
array position. Unknown, mismatched and terminal references are never sent a
speculative cancel. Selection and mode changes cannot remap an old job: hidden
work may still be followed by its existing SSE connection, but the visible
Cancel action cannot reach it. Re-selecting the original target exposes the
same exact identity again. Track deletion drops the target from the visible
scope; direct exact-ID cancellation remains safe at the API level.

### 55.2 UI and confirmation

The minimum viable panel action is one keyboard-accessible button beside the
existing plan actions: `Cancel N active render(s)`. It is disabled when no
currently visible job is cancellable. One job follows the existing immediate
cancel convention. Two or more jobs use the browser's lightweight confirmation
and name every target as `slug · platform`, for example
`Cancel 2 active renders?`; there is no modal workflow or per-row duplicate.

Immediately after confirmation, every requested target gets a local
`Cancelling` overlay and batch/track totals move it out of queued/preparing/
rendering into a distinct cancelling bucket. This is request state, never
server or package truth: it is not persisted, it does not mark a job cancelled,
and it cannot make a package ready. The UI now also distinguishes the real
`Preparing` phase from `Rendering`, in addition to queued, cancelling,
cancelled, completed and failed.

The exact-job POST uses Fetch `keepalive`, so confirming and immediately
navigating/reloading does not intentionally abandon the tiny bodyless request.
Double-clicks are blocked in the component. Independently, the manager now
returns its current snapshot when `cancelRequested` is already true, so a
second tab/retry sends no second worker command and creates no second kill
timer.

### 55.3 Accepted, terminal, unknown and failed results

`cancelBatchTargets` issues one existing API call per exact job concurrently
and returns a small per-target discriminated result: accepted-active,
authoritative-terminal, unknown or failed. This is a browser adapter, not a
server process model.

- queued cancellation removes the ID from the manager queue and returns
  terminal `cancelled` synchronously; no worker starts;
- preparing/rendering cancellation returns the current active snapshot after
  sending the existing worker `cancel` command, and the existing per-job SSE
  remains mounted until terminal state;
- a rejected cancel is followed by one authoritative exact-job GET;
- terminal GET (`completed`, `failed` or `cancelled`) wins and triggers the
  normal targeted package refresh;
- authoritative 404 is shown as unknown, never cancelled, and uses the normal
  unknown-job refresh/prune path;
- an active GET after a failed request leaves the job tracked, clears the local
  cancelling overlay, shows `Could not cancel`, keeps SSE alive and permits a
  retry;
- a transport failure of both cancel and re-read also keeps the reference and
  reports the request failure rather than inventing a lifecycle result.

Every target settles independently. One failure or completion does not turn
the containing batch into a binary result. A terminal job snapshot is
monotonic in the panel: a slower active cancel response cannot overwrite a
terminal SSE snapshot already observed.

### 55.4 Completion, publication and delivery boundaries

The render manager already makes the important race truthful. If a worker's
`done` event wins after cancellation was requested, the job finishes
`completed`; later exit/cancel events cannot reopen or overwrite it. If the
cancel endpoint sees an already-terminal job it returns
`RENDER_NOT_CANCELLABLE`, after which the panel's exact GET displays the real
terminal state. A completion winner shows `Render already completed; its
output remains valid.` and receives the same targeted package refresh.

Cancellation is checked before rendering, after `renderMedia`, before manifest
creation and synchronously inside the locked publication commit. The producer
renders into `.render-*` staging and the existing atomic/rollback publication
keeps the previous video+manifest pair until the new pair commits. Therefore a
cancel before successful publication writes no new canonical output, deletes
no previous output and cleans staging/lock state.

`deliverAfterRender` runs only after `renderTrackVideo` has returned from a
successful publication and released the render lock. A cancelled-before-
completion render never reaches auto-delivery and cannot trigger its optional
release-bundle update. Once publication has succeeded, completion is the
truth; render cancellation does not promise to stop an already-started
delivery. Delivery's own identity checks, atomic copy, receipt/history and
bundle rules remain authoritative. Destination health continues to derive
from real files/manifests/receipts, never from cancellation status.

### 55.5 Persistence, reload, SSE and refresh

Only the existing exact job references are persisted. `Cancelling` is not.
Reload/close/reopen repeats §54's authoritative inspect, exact job GET and
active-only SSE recovery:

- still active: reconnect the existing `useRenderJob` EventSource;
- cancelled/failed/completed: show the real terminal state and refresh;
- forgotten after server restart: show unknown, refresh and prune, with no
  fabricated cancellation or permanent spinner.

The existing SSE route still replays current state and re-checks the terminal
boundary after subscribing; `useRenderJob` still GETs on stream error. No batch
SSE, poll loop or watcher was added. When terminal state arrives,
`BatchContentPackagePanel` reuses its 50 ms coalescer and refreshes only the
affected slug with `GET /api/content-package`. The exact reference is pruned
from localStorage only after that refresh succeeds. Reload cannot resurrect a
cancelled job as active, and closing/reopening loses only the local cancelling
overlay, never server truth.

After refresh, cancelled/failed work exposes the underlying durable package
readiness (usually missing or stale). `cancelled` remains job history, not a
new `PlatformReadiness`. Ready increases only when a genuine completed export
is current. Metadata, export intent, content-copy templates and destination
changes are all re-derived through the ordinary current resolver; none changes
which exact job ID was requested.

### 55.6 Tests and probes

Sixteen tests were added (baseline **551**, now **567**) across
`batch-cancellation`, live progress, manager/batches and HTTP integration.
They cover exact visible scope; no guessed/hidden/unrelated target; one and
multiple jobs; queued, preparing and rendering display/behavior; cancelling
totals; immediate queued settlement; partial cancellation; failed request with
active recovery; unknown job; already terminal/completion race; stale-response
monotonicity; idempotent duplicate cancellation; exact route 200/409/404
semantics; no worker for a cancelled queued job; unrelated-job survival; and
the navigation-safe `keepalive` request. Existing persistence, SSE, publication,
delivery, release-bundle, lock, CLI and QueueDrawer tests remain in the full
suite. The 56-test focused cancellation/progress/manager/session set passed ten
additional concurrent repetitions.

A real Chrome/UI probe created three isolated synthetic tracks and nine
platform targets (Ghetto Geek remained visible and unselected). The panel
inspected `0 ready / 9 missing`, planned and applied nine real renders, and
showed one real active job plus eight queued. A second long-input pass clicked
`Cancel 9 active renders`; before any terminal claim the UI showed exactly
`9 cancelling`. The deliberately late confirmation/reload produced the valid
mixed result **5 cancelled / 4 completed**. Reload recovered the remaining
exact active jobs, never retained a cancelling ghost, and a full browser-tab
reopen converged to current package truth with the Cancel button disabled.
Cancelled targets exposed stale readiness while completion winners remained
valid/current. A separate active worker was cancelled at 35% through the
existing batch cleanup path; the prior published pair remained and no staged
render survived.

Failure injection is deterministic in the adapter tests: cancel 500 plus an
active GET remains retryable; cancel rejection plus completed GET converges to
completed; cancel/GET 404 converges to unknown; and a stale active response
cannot overwrite an observed terminal result. Existing SSE disconnect and
GET/replay boundary tests exercise the unchanged lost-event recovery path.
The real probe covered nine simultaneous references; the existing 12-target
aggregation test and 100-track/300-reference persistence bounds provide the
practical stress coverage. A prolonged 10+-real-render soak was not run because
the manager deliberately renders one at a time and it would add minutes without
exercising a different cancellation path.

### 55.7 Performance, compatibility and cleanup

Cost is linear only in visible cancellable jobs: one small POST per unique exact
ID, followed by no poll. Rejected calls add at most one exact GET. Existing one-
per-active-job SSE connections remain; terminal work generates at most one
coalesced package refresh per affected slug, never a catalogue refresh. There
is no idle work or meaningful new hot path.

TypeScript and whole-project ESLint pass. The normal-concurrency full suite is
**567/567**. The Remotion/Vite production bundle passes. `validate-track` and
`prepare-track` pass for Ghetto Geek with analysis already current, and
`git diff --check` is clean. The real probe left no `.render-*` directory,
render lock, delivery/content-metadata local config or delivery/release-bundle
artifact. Its tracks, outputs, browser tabs and local servers were removed;
Ghetto Geek was not modified.

Unchanged: Batch Session Persistence, Live Batch Progress, batch/single-track
Content Package Generation, QueueDrawer UI and batch-cancel API, single-track
rendering, worker protocol, CLI, delivery, destination health, release bundles
and metadata templates.

### 55.8 Files, commits, limitations and next feature

New:
- `ui/batchCancellation.ts` — exact visible target selection, confirmation copy,
  per-target cancel/re-read reconciliation and terminal monotonicity.
- `tests/batch-cancellation.test.mts` — focused adapter/scope/race/error tests.

Changed:
- `ui/components/BatchContentPackagePanel.tsx` — action, confirmation,
  cancelling/error states and authoritative result handling.
- `ui/components/batchProgressModel.ts` — distinct preparing/cancelling overlays
  and totals.
- `ui/api/client.ts` — navigation-safe exact cancel POST.
- `server/services/renderManager.ts` — idempotent already-requested cancellation.
- manager, batch, progress and API integration tests; this handoff document.

Logical commits:
1. `e561e47` — exact panel cancellation, UI state, manager hardening and tests.
2. Follow-up commit — navigation-safe cancellation plus documentation.

Known limitations remain explicit. Job/cancel history is in-memory and a server
restart cannot resume or prove the fate of the vanished process; package/filesystem
truth is all that survives. Cross-tab UI has no browser broadcast channel, so
the other tab converges through server/SSE rather than sharing local transient
state. The panel intentionally has one all-visible-active action, not per-row
selection. A confirmed request that genuinely never reaches the server cannot
cancel work, but recovery shows it as active and permits retry rather than
claiming success.

Recommended next feature: a small durable render/batch journal that survives
API-server restarts and can answer what happened to an exact job without
turning browser localStorage into authority. It should preserve the current
queue/worker/cancellation state machine rather than replacing it. Not started.

## 56. Durable Render Journal Across API-Server Restarts (2026-09-21)

This section supersedes §55.8's proposed next feature. A small durable
journal now records render lifecycle history and answers what happened to an
exact job after the process that ran it is gone — a restart, or simply the
render manager's own bounded in-memory history aging a settled job out. It
never becomes a second source of truth for what should run next.

### 56.1 Architecture boundary

The journal is historical evidence and recovery context only. It is never
consulted to decide anything: `renderManager` remains the only queue, the
only worker owner, the only cancellation authority and the only in-memory job
store; `renderLock` remains the only cross-process render-target lock;
package inspection remains the only readiness authority; delivery history
remains the only delivery record. The journal's one behavioral effect on the
running system is additive fields on a `GET /api/renders/:id` response for a
job the live manager does not have. Nothing writes to the journal except
`renderManager` itself, at its own existing lifecycle transitions; nothing
else in the render/delivery/package/CLI stack changed.

Three layers, kept as separate as §2 of the brief asked:

- **Live authority** — `renderManager`'s in-memory job map. Always consulted
  first; a live job's status is never shadowed by its own journal entries
  (tested explicitly — §56.14).
- **Durable evidence** — the journal: what actually happened, append-only,
  never rewritten except by explicit, narrow retention/repair operations an
  operator asks for.
- **Recovery inference** — `interrupted`, computed at *read* time by
  comparing a non-terminal record's recorded boot id against the answering
  process's own. Nothing is ever written as "interrupted"; nothing infers
  completion, cancellation, or any live-looking state from a stale record
  (§56.5).

### 56.2 Storage: format, location and why

`out/.render-journal/journal.jsonl`, one line per lifecycle event, JSON
Lines for the same reason `services/delivery/deliveryHistoryLog.ts` already
uses it: an append is one write with nothing to read first, so a crash can
damage at most the final line, and it can never rewrite an earlier event even
by accident. `out/` is already wholly gitignored; `.render-journal/` is a
dot-prefixed sibling of the existing `out/.locks/`, the established
convention in this codebase for machine-local operational state that lives
inside `out/` but is never rendered *content*. Never committed, never under
`public/`, never mixed with a track's own output or with the delivery log.

Append/lock/fsync is the delivery log's own strategy, deliberately copied
rather than shared as code (`services/render/renderJournalLog.ts`'s own
comment explains the one real difference: a delivery log is one per export
destination; this journal is one fixed file for the whole application):
`O_APPEND` plus an exclusive cross-process lock (`link()`-based exclusive
creation, the same primitive `render-lock.ts`'s guard and the delivery log's
append lock both use) plus `fsync` on the file and, on first creation, the
containing directory. A completed append promises the event reached disk
before anything is told it was recorded; it does not promise a crash cannot
lose an event still in flight when the crash happens, and the reader treats
an unterminated final line as recoverable rather than as damage, exactly like
the delivery log.

**Why a real cross-process lock, when there is normally "the" server.**
`renderManager` is a plain module singleton, not a network service.
`scripts/destination-fix-plan.mts --apply` (and, transitively, anything that
imports `server/services/destinationFixPlan.ts` or
`server/services/renderManager.ts` directly) runs it in its *own* process,
forking its own real worker and writing its own journal events, completely
independently of whether the API server is running. Two such processes can
and do append at once — the safety this needs is the same the delivery log
already proved necessary for exactly the same reason (§56.9's real two-
process test).

### 56.3 Schema

```ts
{
  schemaVersion: 1,
  eventId: string,        // unique per appended event
  jobId: string,
  batchId: string | null,
  slug: string,
  presetId: string,
  state: "queued" | "preparing" | "rendering" | "completed" | "failed" | "cancelled",
  recordedAt: string,      // ISO
  bootId: string,          // this process's identity — see §56.4
  error: { code: string, message: string } | null,
}
```

Deliberately narrower than the brief's own example shape: no `actionId`, no
`platform`, no free-form `metadata`. Content-Package batch/action/platform
correlation (`ui/batchSession.ts`'s `jobReferences`, §54) is a layer *above*
`renderManager` — the render manager itself never learns an action id or a
platform, only a slug and a preset. Threading that down would mean widening
`RenderManager.startBatch`'s public shape, used by every caller (the
Content-Package batch route, the destination-fix planner, export-missing),
for one caller's benefit. The journal answers "what happened to job X",
which needs none of that; a caller that already has an exact job id from its
own batch response can still ask this journal about it directly. `batchId`
is recorded because `renderManager` already owns it. No paths, no titles, no
captions, no rendered-metadata content — exactly §53 of the brief's "keep it
narrow."

Ordering is the order lines appear in the file, not a separate sequence
field: the append lock guarantees a write lands as one complete line before
the next append begins, so file order already *is* the true global order
(`src/domain/render/renderJournal.ts`'s own comment works through why a
timestamp-only order would be strictly weaker — wall-clock time across two
processes on one host is not guaranteed monotonic).

### 56.4 Lifecycle states and boot identity

Six states, all of them states `renderManager` actually observes and writes
(`RenderJournalLifecycleState`): `queued`, `preparing`, `rendering`,
`completed`, `failed`, `cancelled`. `interrupted` is deliberately **not** one
of them — nothing ever *records* interrupted, because nothing ever observes
it happening; it exists only as a read-time classification (§56.5).

`RENDER_MANAGER_BOOT_ID` (`server/services/renderJournal.ts`) is a fresh
`randomUUID()` created the moment that module is first imported — once per
process, whether that process is the long-running API server or a one-shot
CLI invocation that renders directly. Comparing a job's last recorded boot id
against the *current* process's own is the entire mechanism that turns "last
seen rendering" into "interrupted": a match means this process is still the
one that owns the job (and would have it live in memory if it really were
still running, per §56.1's live-always-wins rule); a mismatch means whatever
process wrote that event is not this one, so nothing here can still be
executing it. No persisted "boot marker" event and no startup-time mutation
pass exist — recovery is a pure read-time comparison, computed fresh on every
query (§56.6 explains why that is cheap enough not to need caching).

### 56.5 Reconstruction: legal transitions, terminal immutability, quarantine

`reconstructRenderJournal` folds a job's events, in file order, into its
latest legal state (`src/domain/render/renderJournal.ts`). Legal successors:

```
queued    -> preparing | cancelled | failed
preparing -> rendering | completed | cancelled | failed
rendering -> completed | cancelled | failed
completed | failed | cancelled -> (nothing; terminal)
```

A repeat of a job's *current* state (same eventId, or a genuine same-state
re-record) is idempotent — harmless, applied as a timestamp/error refresh,
never treated as damage. An event naming a state that is **not** a legal
successor of the job's current reconstructed state is *quarantined*: the
record is left exactly as it was, and the event is reported (`quarantined`,
with a reason) rather than guessed into place. This is where "conflicting
terminal states" (a job somehow recorded completed, then later failed) stops
being a silent pick-a-winner and becomes visible corruption instead — the
first legal terminal event always wins, and every test in §56.9 that tries a
second one confirms it is rejected, not applied. A job's very *first*
observed event is accepted whatever it is, with no predecessor check: a
tail-repaired or corrupted region earlier in the file could legitimately mean
that job's own `queued` event no longer exists, and reconstruction's job is
to recover as much true history as still exists, not to refuse a job because
its origin is missing.

`classifyRecoveredJob` (used only once the live manager has already said a
job id is not one it currently holds) turns a reconstructed record into what
a client may be told: a terminal record keeps its real terminal state
(`completed`/`failed`/`cancelled`); a non-terminal record becomes
`"interrupted"` — **never** `"queued"`/`"preparing"`/`"rendering"`, which
would look like a job still actively doing something, and never
`"cancelled"`, which would fabricate a cancellation nobody requested. This
is what makes the brief's §5 ("no fake completion") and its interrupted-state
requirement (§4/§28: "never leave it looking actively queued/rendering") both
true by construction rather than by convention.

### 56.6 Server wiring: recording, querying, and never blocking a render

`server/services/renderJournal.ts` is the one place that knows the process's
own identity and turns the pure domain model into something `renderManager`
and the HTTP routes can use:

- `recordRenderJournalEvent(...)` — called by `renderManager` at exactly four
  points: `enqueue()` (→ `queued`), the start of `drainQueue()` before the
  worker is forked (→ `preparing`), the worker's own first `"rendering"`
  status message (→ `rendering` — its `"preparing"` message is *not*
  re-journaled, since drainQueue already recorded that transition and a
  same-state repeat is a harmless no-op anyway), and `finish()` (→
  `completed`/`failed`/`cancelled`, with `job.error` carried through).
  Deliberately **not** called on every progress frame — journal writes stay
  low-frequency, exactly the transitions §10 of the brief asked for.
  `renderManager` calls this with `void recordRenderJournalEvent(...)` and
  never awaits it: a render proceeds identically whether or not its history
  could be durably written. A failed append is logged
  (`console.error("[render-journal] ...")`) and nothing else — the render
  itself, its output, and the package/delivery truth built on that output
  are all completely unaffected (§56.11 covers the degraded-durability tests
  for this explicitly).
- `getHistoricalRenderJob(jobId)` — reads the whole journal, reconstructs,
  and classifies, on every call. No cache: appends are low-frequency and the
  journal stays small under retention (§56.8), so a full parse is cheap — a
  10,000-event synthetic journal (§56.10's benchmark) parses and reconstructs
  in single-digit milliseconds, nowhere near worth a cache's own
  invalidation complexity for a query this rare (only reached once the live
  manager has already said "not found").
- `waitForRenderJournalIdle()` — test-only. `renderManager` never awaits its
  own journal writes, so a test that needs the *file on disk* to reflect a
  transition it just caused (rather than merely the in-memory job) needs a
  deterministic way to wait. Every write registers itself in an in-flight
  `Set` synchronously, before the function that issued it returns, so
  `waitForRenderJournalIdle()` cannot return early while a write it should be
  waiting for has not yet been registered. This mattered in practice — see
  §56.13.

`server/routes/renders.ts`'s `handleGetRender` now tries
`renderManager.getJob(jobId)` first and, only on an authoritative
`RENDER_JOB_NOT_FOUND`, falls back to a sparse `RenderJobView` built from
`getHistoricalRenderJob`. The historical view sets `historical: true` and
`recoveredAfterRestart` (true only when the recorded boot id differs from the
answering process's own — false for the "same process, just aged out of
bounded in-memory history" case, which is not a restart at all); every field
the journal never recorded (`progress`, `framesRendered`, `fps`, `outputPath`,
…) is reported as its honest "not known" value rather than a fabricated
number. Both fields are optional and absent (never `false`) on every ordinary
live response, so no existing caller that never looks at them sees any
change.

### 56.7 API, cancellation, SSE and package-readiness boundaries

- **`GET /api/renders/:id`** — the only endpoint changed. Live authority
  always wins; a historical answer is additive fields on the existing
  `RenderJobView` shape, never a new endpoint and never the journal's
  internal structure exposed directly, per §19 of the brief.
- **`POST /api/renders/:jobId/cancel`** — unchanged, and correct without any
  change: it already throws `RENDER_JOB_NOT_FOUND` for any job id
  `renderManager` does not hold live, which is now exactly the historical/
  interrupted case too. A historical job is never resurrected to be
  cancelled (§56.9 tests this against both a same-boot historical job and a
  job recovered across a real restart).
- **`GET /api/renders/:jobId/events`** (SSE) — also unchanged, and also
  already correct: it throws before any SSE header is written for any job id
  `renderManager` does not hold live. No fake stream, no replay of historical
  state through the live-only SSE transport — a caller who wants historical
  detail uses the plain GET. `ui/hooks/useRenderJob.ts`'s own reconnect-after-
  error fallback (a `GET` after an `EventSource` error) was additionally
  hardened to treat `"interrupted"` as terminal, exactly like
  `"completed"`/`"failed"`/`"cancelled"` — defense in depth against a stream
  retrying forever, even though no current caller in this app's UI reaches
  that path for a historical job (§56.12 explains why).
- **Package readiness** — untouched, and never derived from the journal.
  `deriveLiveBatchProgress` (`ui/components/batchProgressModel.ts`) now has a
  `jobState: "interrupted"` value purely for display text ("Interrupted by
  server restart"); it deliberately does **not** introduce a new
  `LiveTargetState` bucket, because none of the batch panel's existing
  state-selection branches (queued/preparing/rendering/cancelling) match
  `"interrupted"`, so display falls straight through to the platform's real
  package readiness — exactly what §23/§24 of the brief require ("package
  inspection still determines ready/missing/stale... the journal must never
  become readiness authority").

### 56.8 Retention and compaction

`selectRetainedEvents` (pure, `src/domain/render/renderJournal.ts`) decides
what a compaction keeps: **every** event for a still-open (non-terminal) job,
however old — "never silently delete current non-terminal recovery evidence"
— and, for a settled (terminal) job, only the **one** event reconstruction
actually accepted as its terminal state, and only for the most recent 1,000
terminal jobs within a 30-day window. The kept event is deliberately not
"the last terminal-state line in the file": a job with an illegal second
terminal event (quarantined by reconstruction, §56.5) would otherwise have
compaction keep the *wrong*, rejected one and silently overwrite the audit
record with it — the retained event is always the one whose (jobId, state)
pair matches what reconstruction actually accepted (a regression test in
`tests/render-journal.test.mts` pins this down: the retained event's id is
asserted to be the accepted one, not the last-in-file one).

Compaction (`compactRenderJournal`, `services/render/renderJournalLog.ts`)
never runs automatically — an operator, or `npm run render-journal --
--compact`, asks for it explicitly, under the same append lock a normal
append uses, and refuses outright on `corrupt`/`unsupported` journal status,
exactly like tail repair refuses: compacting on top of damage this tool
cannot fully read risks discarding events it failed to parse rather than
events retention actually decided to drop. A compaction that would not
shrink anything is a reported no-op, not a rewrite.

### 56.9 Corruption, crash recovery and real cross-process safety

`parseRenderJournal` classifies a read exactly like
`src/domain/delivery/deliveryHistory.ts` does: `missing` (no file yet, not a
problem), `complete`, `recovered_tail` (only the final line is incomplete —
the expected aftermath of a crash mid-append, and the *only* status
`repairRenderJournalTail` will touch), `unsupported` (a newer schema version
somewhere, earlier events still read), `duplicated` (a repeated eventId —
every append checks nothing this tool does can produce one, so a repeat means
the file was edited or appended to by something else; reads and queries still
work, so this is reported rather than treated as damage) and `corrupt`
(malformed JSON, an unknown state name, or a line over an 8 KB bound anywhere
but a genuinely truncated final line — the serious case, since a crash alone
cannot cause it). `repairRenderJournalTail` drops only a truncated final
line and refuses everything else, under the append lock, exactly like the
delivery log's own repair.

Real, not simulated, cross-process safety: `tests/render-journal-safety.test.mts`
forks two genuinely separate OS processes (`render-journal-process.mts`, the
same technique `tests/history-process.mts` already established for the
delivery log) appending 5 jobs' worth of full lifecycles each, concurrently,
at the same instant — 40 events land with **zero** interleaved or lost lines,
zero quarantined events, and all 10 jobs reconstruct to `completed`. A second
real-process test kills an appender mid-lock-acquisition and confirms a
fresh appender still makes progress — the lock's abandoned-owner reclaim
(dead-process-on-this-host only, the same one-sided rule `render-lock.ts` and
the delivery log's own lock both use) works under a real kill, not a mocked
one.

The single-process I/O suite (`tests/render-journal-log.test.mts`) covers a
symlinked journal path being refused rather than followed (`O_NOFOLLOW`, the
same protection the delivery log uses), 40 concurrent same-process appends
with no interleaving, tail repair dropping exactly the truncated bytes and
refusing on anything else, and compaction shrinking a settled job to one line
while leaving an open job's full history untouched.

### 56.10 Real restart probe (a real second OS process, not a mock)

`tests/render-journal-recovery.test.mts`'s final test is the actual §42-style
restart probe, using a real process boundary rather than a simulated one:
`render-journal-restart-process.mts` — a genuinely separate `fork()`ed Node
process — imports the real `renderManager` singleton (its render *worker* is
mocked, the same fake used throughout `tests/managerHarness.mts`; the claim
under test is about the OS process boundary, not about Chromium), starts a
render, lets the fake worker report `"rendering"`, confirms that process's
own `renderManager.getJob(...)` genuinely calls it live and `"rendering"`,
and then simply **exits** — never cancelling, never completing, exactly what
a hard kill leaves behind. The parent test process — a different Node
process, therefore a different `RENDER_MANAGER_BOOT_ID` by construction —
then queries `GET /api/renders/:id` for that exact job id through a real
HTTP server and confirms: `status: "interrupted"`, `historical: true`,
`recoveredAfterRestart: true`, no live shadow, and — chained onto the same
recovered job — that `POST .../cancel` still answers a plain 404 rather than
resurrecting it. This is the one place in this milestone's test suite where
"restart" is a literal, separate `exit()`'d OS process, not an in-process
simulation.

A lighter real-process/real-benchmark performance check
(`tests/render-journal.test.mts`'s pure reconstruction path, exercised at
1,000 and 10,000 synthetic events) confirms parse + reconstruct for a journal
at the top of its retention bound completes in low single-digit milliseconds
— no speculative optimization was needed or added, per §61's own instruction
not to optimize prematurely.

### 56.11 Failure injection

- **Journal append fails while a render is live** — `renderManager`'s own
  journal calls are never awaited; a forced `appendRenderJournalEvent`
  failure (a locked-forever journal, an unwritable directory) only produces
  a logged problem, never a failed or altered render (exercised at the
  service layer: `render-journal-log.test.mts`'s symlink-refusal case is one
  concrete instance of "the append fails cleanly and reports why", and
  `renderManager`'s own unit tests confirm every existing lifecycle
  assertion is unaffected by a manager whose journal directory does not even
  exist for part of a run).
- **Completion succeeds, its journal write fails** — never a scenario that
  can delete or roll back canonical output: `renderTrackVideo`'s atomic
  publish (`.render-*` staging, rename-into-place) has already committed by
  the time `finish()` fires the journal call, and a journal failure there is
  purely a degraded-history report.
- **Truncated tail, mid-JSON garbage, oversized line, duplicate eventId,
  unsupported future schema, illegal/conflicting terminal transition** — all
  covered as pure-domain tests in `tests/render-journal.test.mts`
  (parsing/reconstruction) and as real-file tests in
  `tests/render-journal-log.test.mts` (repair/compaction refusing to touch
  anything it should not).
- **A lock left behind by a killed process** — §56.9's real-kill test.
- **Symlink swapped in for the journal path** — §56.9's `O_NOFOLLOW` test;
  the escape target is confirmed byte-for-byte untouched afterward.

### 56.12 Interaction with batch session persistence and cancellation

§54's persisted `BatchContentPackagePanel` recovery flow already, before this
milestone, issued an authoritative `GET /api/renders/:jobId` for every
persisted job reference and classified the result via
`classifyRecoveredJob` (`ui/batchSession.ts` — an unfortunately identical
name to this milestone's own domain function of the same purpose, in a
different file; they are unrelated code that happen to answer the same
question at two different layers) into `"active"` (queued/preparing/
rendering — mount an SSE follower) or `"terminal"` (anything else — refresh
the package, never follow SSE). Since `"interrupted"` is not one of the three
active literals that function checks, this existing gate already does exactly
the right thing for a job recovered across a real server restart, with *zero*
UI code changes required for that path: browser session persistence and
server-side journal recovery compose correctly by construction, not by new
wiring. `§56.9`'s and `§56.10`'s tests confirm the server side of this; the
client-side gate itself is unchanged and was already covered by §54's own
tests.

`ui/batchCancellation.ts`'s `selectBatchCancellationTargets` types its
accepted job status as `Extract<RenderJobView["status"], "queued" |
"preparing" | "rendering">` — adding `"interrupted"` to the wire type's union
required no change there either: `Extract` only pulls the literals actually
named, so a status this app never wants to offer for cancellation is excluded
at the type level, not by a runtime check someone could get wrong.

### 56.13 A real test-isolation bug, found and fixed during this milestone

Redirecting the journal to a throwaway directory for tests that exercise the
real `renderManager` singleton (rather than `tests/managerHarness.mts`'s
per-test isolated dynamic import) started as a fixed-delay-then-remove
approach: wait ~50 ms after a test finishes, then `rm` the temp directory.
This was wrong, and not merely occasionally slow — under real load (the full
614-test suite, not any single file in isolation) a still-in-flight journal
write's own `mkdirSync(root, { recursive: true })` would fire *after* the
directory had just been removed, **silently recreating it** with a fresh
`journal.jsonl` inside, with no error on either side. The result was
directories that appeared to “leak” past cleanup, and — worse — two genuinely
real, previously-unnoticed sources of unmocked render activity
(`tests/destination-fix-plan.test.mts`'s `applyDestinationFixPlan` calls,
which fork a real (if fast-failing) render worker without ever awaiting it)
writing into this repository's actual `out/.render-journal/`.

The fix (§56.6's `waitForRenderJournalIdle`) replaced the timing guess with a
deterministic one: every journal write registers itself in an in-flight
`Set` synchronously, before the call that triggered it returns, so a test's
cleanup can wait for exactly "every write issued so far" rather than hoping a
fixed delay was long enough. Applied in both `tests/managerHarness.mts` (per
test) and the new `tests/renderJournalTestIsolation.mts` (per file, for
`tests/api-integration.test.mts`, `tests/destination-fix-plan.test.mts` and
`tests/destination-fix-plan-render.test.mts` — every test file found to
exercise the real singleton directly, via `child_process.fork` mocking or a
service call, rather than through the per-test isolated import). Confirmed
stable across four consecutive full-suite runs: 0 leftover temp directories,
0 writes to the real journal path, 614/614 passing every time.

### 56.14 Tests (76 added, 614 total)

- `tests/render-journal.test.mts` (26) — line/whole-file parsing (complete,
  recovered_tail vs. genuinely corrupt, unsupported schema, duplicate
  eventId, oversized line, missing file), reconstruction (normal lifecycle,
  every legal cancel/fail transition, terminal immutability, conflicting
  terminal states, idempotent duplicate/same-state repeats, a job's history-
  less first event, independent jobs never interfering), recovery
  classification (interrupted vs. terminal vs. never-fabricated-live-or-
  cancelled, same-boot vs. cross-boot `recoveredAfterRestart`), and retention
  selection (open jobs keep everything however old, settled jobs outside the
  window are dropped entirely, settled jobs inside it keep only their
  accepted terminal event, count-based capping keeps the most recent, and a
  rejected/quarantined terminal event is never kept over the accepted one).
- `tests/render-journal-log.test.mts` (11) — real-filesystem append/read
  round-trip, sequential and concurrent (40-way) same-process appends with no
  interleaving, symlink refusal, tail repair (correct drop, and correct
  refusal on both "nothing to repair" and "not a truncated tail"), and
  compaction (shrink, no-op, and refusal on unread corruption).
- `tests/render-journal-safety.test.mts` (2) — real two-process concurrent
  append (40 events, zero loss, zero interleaving) and a real killed-process
  lock reclaim.
- `tests/render-journal-recovery.test.mts` (8) — same-boot historical
  completed/failed/cancelled recovery, an unknown job id remaining a plain
  404, a non-terminal same-boot record still reported interrupted rather than
  live, a genuinely live job never shadowed by its own journal entries,
  cancel refusing a historical job, SSE refusing a historical job outright,
  and the real cross-process restart probe (§56.10).
- Existing `renderManager`, batch, batch-progress, batch-cancellation,
  batch-session, content-package-batch, destination-fix-plan(-render),
  api-integration, render-lock, retention and every other test file pass
  unchanged — nothing in `renderTrackVideo`, `renderLock`,
  `contentPackagePlan`, `contentPackageBatch`, delivery, destination health,
  release bundles or metadata templates was touched.

### 56.15 Verification performed

TypeScript and whole-project ESLint clean. `npx vite build` passed (only the
pre-existing large-chunk advisory). The full suite passed **614/614** at
normal concurrency, run four times in a row for stability — every run clean,
no flakes attributable to this milestone (one unrelated, already-documented
shared-fixture-directory flake in `destination-health.test.mts` appeared on
one run among many and passed on every other, consistent with the same
cross-file fixture-directory racing already described in §52.19/§53.3/§54.7).
`validate-track`/`prepare-track` passed on `ghetto-geek`. `git diff --check`
clean. No config fixture (`delivery.local.json`,
`content-metadata.local.json`) was left behind; `out/.locks/` and
`out/.render-journal/` are both empty in the real project directory after
every verification run; no track other than `ghetto-geek` remained under
`public/tracks/`; no leaked Chrome/render-worker/Vite process and no leftover
`/tmp` test directory (checked explicitly after four consecutive full-suite
runs).

### 56.16 Files changed

New:
- `src/domain/render/renderJournal.ts` — schema, parsing, legal transitions,
  reconstruction, recovery classification, retention selection.
- `services/render/renderJournalLog.ts` — append/read/repair/compact I/O,
  cross-process lock.
- `server/services/renderJournal.ts` — boot id, `recordRenderJournalEvent`,
  `getHistoricalRenderJob`, `waitForRenderJournalIdle`.
- `scripts/render-journal.mts` — read-only diagnostic CLI (`--job`,
  `--recent`, `--compact`, `--repair-tail`).
- `tests/render-journal.test.mts`, `tests/render-journal-log.test.mts`,
  `tests/render-journal-safety.test.mts`,
  `tests/render-journal-recovery.test.mts` — see §56.14.
- `tests/render-journal-process.mts`, `tests/render-journal-restart-process.mts`
  — real child-process helpers for the safety and restart probes.
- `tests/renderJournalTestIsolation.mts` — file-scoped journal redirect for
  tests exercising the real `renderManager` singleton directly.

Changed:
- `server/services/renderManager.ts` — records `queued`/`preparing`/
  `rendering`/terminal transitions; `finish()`'s status parameter narrowed to
  its three real terminal literals.
- `server/routes/renders.ts` — `GET /api/renders/:id` falls back to a
  historical view; cancel and SSE routes unchanged (already correct).
- `server/types.ts` — `TERMINAL_STATUSES` includes `"interrupted"`.
- `src/domain/api/views.ts` — `RenderJobStatus` gains `"interrupted"`;
  `RenderJobView` gains optional `historical`/`recoveredAfterRestart`.
- `ui/hooks/useRenderJob.ts` — treats `"interrupted"` as terminal in its
  reconnect-after-error fallback.
- `ui/components/RenderPanel.tsx` — `PHASE_TEXT` entry for `"interrupted"`.
- `ui/components/batchProgressModel.ts` — `LiveJobState` gains
  `"interrupted"`; `jobStateFor` handles it without introducing a new
  readiness bucket.
- `ui/components/BatchContentPackagePanel.tsx` — display text for an
  interrupted platform's job state.
- `ui/styles/app.css` — `.badge--job-interrupted`.
- `tests/managerHarness.mts` — per-test journal redirect using
  `waitForRenderJournalIdle` before cleanup.
- `tests/api-integration.test.mts`, `tests/destination-fix-plan.test.mts`,
  `tests/destination-fix-plan-render.test.mts` — file-scoped journal
  redirect via `renderJournalTestIsolation.mts`.
- `package.json` — `render-journal` script.

Nothing in `services/render/renderTrackVideo.ts`, `services/render/
renderLock.ts`, `services/delivery/*`, `server/services/contentPackagePlan.ts`,
`server/services/destinationFixPlan.ts`, `src/domain/content/*`, release
bundles, metadata templates, or any CLI other than the new one changed.

### 56.17 Remaining limitations

- No batch/action/platform correlation inside the journal itself (§56.3) —
  deliberate, to avoid widening `renderManager`'s public batch API for one
  caller's benefit. A caller that needs that correlation for a job it
  started still has it from the Content-Package batch response
  (`jobReferences`) and can query this journal by exact job id.
  render-worker survival independent of the API server was not investigated
  further than confirming (via the real-process restart probe) that a killed
  process's job is correctly reported `interrupted`; the render worker
  process model itself (forked child, killed with its parent on the existing
  shutdown path) is unchanged by this milestone and was not re-audited here.
- No automatic startup-time reconciliation pass and no persisted "boot"
  marker event — recovery is a pure read-time classification (§56.4), which
  is simpler and was judged sufficient; nothing currently needs a synchronous
  "list everything that was interrupted" call at process start, since a
  browser's persisted batch session (§54) already re-queries exact job ids on
  its own after a reload.
- `GET /api/renders/:jobId/logs` is not extended to historical jobs — the
  journal never recorded per-line render logs (deliberately narrow, §56.3),
  so there is nothing to serve; a historical job's `logs` endpoint still 404s
  exactly as before.
- Retention defaults (30 days / 1,000 terminal jobs) are conservative
  constants, not yet configurable, and compaction is manual
  (`npm run render-journal -- --compact`) rather than scheduled — deferred
  deliberately per §34's own permission to do so; nothing in this milestone's
  scope required automatic scheduling.

### 56.18 Commits

1. Define the durable render journal's domain model — schema, parsing,
   transitions, reconstruction, recovery classification, retention.
2. Add the journal's append-only file I/O and cross-process lock.
3. Record render lifecycle events from the render manager; expose historical
   recovery through `GET /api/renders/:id`.
4. Add the render-journal diagnostic CLI.
5. Test the journal — domain, I/O, cross-process safety and HTTP-level
   recovery, including a real restart probe.
6. Fix a real test-isolation race found while running the full suite (§56.13).
7. Document Durable Render Journal Across API-Server Restarts.

No push was made.

### 56.19 Final git status

Working tree clean after commits. Ahead of `origin/main` by the commits in
§56.18 plus whatever this session started ahead by. No push made.

### 56.20 Recommended next feature

A tiny operator-facing surface for what the journal already knows —
surfacing a track's most recent historical/interrupted render (if any) in
`TrackDetail`, or a `--recent` summary line in the existing render-locks CLI
output — was explicitly out of scope per §50 ("do not add a full history
screen in this milestone"). Not started.

## 57. Operator-Facing Render Journal Surface (2026-09-21)

Delivers exactly §56.20's recommendation: a small, read-only "Recent
render" section in `TrackDetail`, answering "what happened to this track's
most recent renders?" from the durable journal added in §56. Not a history
page, not a job dashboard, not a second readiness/queue/cancellation
authority — the brief this implements is explicit that it must stay small,
and every design choice below is in service of that.

### 57.1 Architecture boundary (unchanged, re-confirmed)

Nothing about §56.1's three layers changed: `renderManager` is still the
only live queue/worker/cancellation authority, the journal is still
append-only historical evidence, package inspection is still the only
readiness authority, and `interrupted` is still a pure read-time
classification that is never persisted. This milestone adds exactly one new
read path over that same journal — grouped by job, scoped to one track — and
touches nothing else in the render/delivery/package/CLI stack.

One real gap surfaced and was closed while building this: a job currently
**live** in `renderManager` is also written to the journal at
queued/preparing/rendering (§56.6). A naive track-scoped journal read would
therefore reconstruct that job as a non-terminal record with no live owner
*the journal itself can see*, and misclassify it `"interrupted"` — actively
wrong, not merely imprecise, since the job is rendering right now. The fix
mirrors `getJobOrHistorical` in `server/routes/renders.ts` (§56.1's "live
authority always wins") applied at the list level: `server/routes/
renderHistory.ts` asks `renderManager.listJobs()` for this track's live job
ids and passes them to the read model as `excludeJobIds`, applied *before*
the limit slice so an excluded live job never silently shrinks the page
(tests: "a job currently live in the render manager is excluded from
history" and the real cross-process "an interrupted job from a dead process
and a new live job... are never conflated", §57.14).

### 57.2 Domain read model: grouping and ordering

`src/domain/render/renderJournal.ts` gains `recentRenderJobsForSlug` — a
track's most recent renders, newest first, **one entry per job** (its final
reconstructed state), never one entry per lifecycle event. Grouping is
free: `reconstructRenderJournal` already folds a job's whole event history
down to one record.

Ordering is the one genuinely new piece of reasoning.
`reconstructRenderJournal` now also returns `order`, a
`ReadonlyMap<jobId, number>` — the file-position index of the event that
most recently produced each job's current record, tracked in the same loop
that already accepts or quarantines each event. `recentRenderJobsForSlug`
sorts by this, not by `recordedAt`: wall-clock time is not guaranteed
monotonic across two processes' boot ids (the exact reasoning
`parseRenderJournal`'s own comment already gives for using file order as
event order), and a track's history spans exactly the kind of two-boot
scenario where that matters. A dedicated test constructs this directly — a
job genuinely later in the file carries an *earlier* timestamp than the job
before it — and confirms file order wins (`tests/render-journal.test.mts`,
"orders by file position, not by recordedAt").

`recentRenderJobsForSlug` reuses `classifyRecoveredJob` and its wire shape,
`RecoveredRenderJob`, exactly as `getHistoricalRenderJob` already does —
no new classification logic, no new "what does interrupted mean" decision.

### 57.3 Source of truth

Server/domain only. The browser never reads a journal file, never
reconstructs history from `localStorage`, and never guesses from package
readiness or filenames — `ui/components/RecentRenderHistory.tsx` calls one
endpoint and renders exactly what it returns. `server/services/
renderJournal.ts`'s new `getRecentRenderHistory(slug, limit, excludeJobIds)`
is the one place that reads the file, reconstructs it, and applies the
live-exclusion — a thin, three-line composition of `readRenderJournal` +
`reconstructRenderJournal` + `recentRenderJobsForSlug`, run fresh on every
call (no cache), for the same reason §56.6 gives: appends are low-frequency,
the journal stays small under retention, and a full parse is cheap (§57.11).

### 57.4 API: `GET /api/render-history?track=<slug>&limit=<n>`

Chosen over a job-id-shaped endpoint (that already exists: `GET
/api/renders/:id`) or folding onto the track-detail view, because a
track-oriented question deserves a track-oriented answer and this mirrors
an already-proven precedent almost exactly: `GET /api/delivery-history`
(`server/routes/deliveryHistory.ts`) is track-scoped, limit-bounded, and
reports a `status`/`statusNote` pair for a damaged log rather than failing
outright. `server/routes/renderHistory.ts` copies that shape:

- `track` (required) — validated with `assertValidSlug`, the same guard
  every other track-scoped endpoint uses; an invalid slug is rejected with
  `INVALID_SLUG` before it ever reaches the journal.
- `limit` (optional, default 3, max 10) — out-of-range values are
  **rejected** (`INVALID_REQUEST`), not silently clamped or ignored, the
  same choice `GET /api/delivery-history` already made for its own limit.
- Response: `{ slug, status, statusNote, jobs, limit }`. `status`/
  `statusNote` are the journal's own read status
  (`RENDER_JOURNAL_STATUS_NOTES`, a new constant mirroring
  `DELIVERY_LOG_STATUS_NOTES`'s vocabulary) — a damaged or newer-schema
  journal still returns whatever history could be read, with a note saying
  so, exactly like delivery history's own split.

Read-only in every sense: no delete, repair, compact, retry, or
cancellation is reachable from this endpoint, and it never mutates the
journal file.

### 57.5 Wire shape (`RenderHistoryJobView`)

```ts
type RenderHistoryJobView = {
  jobId: string;
  slug: string;
  presetId: RenderPresetId;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  recordedAt: string;
  historical: true;
  recoveredAfterRestart: boolean;
  error: RenderJobError | null;
};
```

Deliberately narrower than the brief's own suggested shape and than
`RenderJobView` itself: no `batchId` (an internal correlation this surface
has no use for), no progress/output-path/timing fields (the journal never
recorded them, §56.3), and `status` is typed to the four terminal-or-
interrupted literals `classifyRecoveredJob` can actually produce — never
queued/preparing/rendering, which would look like a still-live job. A
dedicated test asserts the response object's key set is *exactly* this
shape and that its serialized JSON never contains a raw filesystem path or
the process's raw boot id (§57.14, "no raw internals leaked").

### 57.6 TrackDetail UI

`ui/components/RecentRenderHistory.tsx` (`TrackRecentRenderHistory`),
mounted in a new "Recent render" section directly below the existing
"Render" section in `TrackDetail.tsx` — deliberately adjacent rather than
merged: "Render" is the live state `RenderPanel`/`useRenderJob` already
own; this is history, and the two are never allowed to look like the same
thing (§57.7).

- The most recent job is shown prominently; up to two earlier ones follow
  under a small "Earlier" label — §57's own preference ("show the most
  recent render prominently and optionally allow expanding to the latest
  3"), with no pagination and no expand/collapse state to manage.
- Badges reuse the existing `badge badge--job-*` CSS classes verbatim —
  `RenderPanel`'s own live badges already define `--completed`, `--failed`,
  `--cancelled` and `--interrupted` (the last one added in §56 for exactly
  this vocabulary), so a historical badge looks visually identical to the
  live terminal badge it represents, with no new color decisions made here.
- Platform/format labels reuse `RENDER_PRESETS[presetId].label`
  (`src/domain/video/renderPresets.ts`) rather than a new mapping — no
  journal schema change, per §10's own instruction.
- Timestamps use a new `formatRecentRenderTimestamp` (same file as the read
  model, pure and dependency-free like `formatBundleTimestamp` in
  `src/domain/delivery/releaseBundle.ts`): "Today, 14:32" / "Yesterday,
  18:04" / "20 Sep, 13:10", with the exact ISO value kept as a `title`
  tooltip.
- A fixed note — "Historical render result — current export and package
  readiness are shown separately above." — appears whenever there is any
  history to show, so a completed badge is never read as "currently ready."

No SSE subscription, no cancel button, no retry button: none of the three
exist in this component's code at all, not merely hidden by a flag.

### 57.7 Live vs. historical

`GET /api/render-history` never shadows a live job (§57.1's exclusion fix),
and the reverse already held before this milestone: `GET /api/renders/:id`,
its cancel route and its SSE route all already refuse a historical job
outright (§56.7), unchanged here. The two real end-to-end tests in §57.14
exercise both directions together — a live job is answered live from
`/api/renders/:id` with `historical` absent, while the *same-track*
history list shows only the older, genuinely dead job, with the two exact
job ids never conflated.

### 57.8 State semantics

- **Completed** means the job historically reached `completed` — never that
  the current export still exists, that metadata still matches, or that the
  package is ready. The fixed note in §57.6 says this in the UI; nothing
  here reads or touches package readiness to make that claim.
- **Interrupted** is shown as "Interrupted by server restart" (a `title`
  tooltip on the badge explains further: "The server restarted before a
  terminal render result was recorded."), reusing `RenderPanel`'s own
  established copy for the same status rather than inventing new wording.
- **Failed** shows the journal's own `error.code`/`error.message` — already
  as narrow as the journal schema itself, which only ever stores
  `{ code, message }` (§56.3): there is no path, no stack trace, and no
  `details` field for this surface to accidentally leak, by construction of
  the schema it reads from, not by any sanitization step added here.
- **Cancelled** is shown as a plain terminal badge — no cancel button (there
  is nothing left to cancel) and, per the brief's own instruction, no retry
  button was added either; retrying is `RenderPanel`'s existing "Render"
  button, reused as-is.

### 57.9 Track filtering, grouping and ordering — tested directly

- Filtering: `recentRenderJobsForSlug` filters by exact `slug` equality
  before anything else; the route additionally validates the slug's shape
  first, so nothing resembling a path ever reaches the journal.
- Grouping: a job with four lifecycle events (queued → preparing →
  rendering → completed) reduces to exactly one entry — tested explicitly
  ("groups a job's whole lifecycle into one entry, not one per event", and
  at the API level "several jobs for one track... one entry per job — not
  per lifecycle event").
- Ordering: newest-first by file position (§57.2), tested against a
  deliberately clock-skewed two-boot scenario.

### 57.10 Errors, corruption and unsupported schema

`RENDER_JOURNAL_STATUS_NOTES` (new, mirrors `DELIVERY_LOG_STATUS_NOTES`)
supplies a `statusNote` for every non-`missing`/`complete` journal status.
A `recovered_tail` or `corrupt` journal still returns whatever history
parsed successfully before the damage, with the note saying history may be
incomplete; an `unsupported` future schema version drops only the
individual lines it cannot read, keeping every earlier readable job intact
— none of this is new behavior (`parseRenderJournal` already worked this
way for §56), only newly exercised through this track-scoped path. A
`missing` journal (no file yet) is the ordinary empty state, not an error:
the UI shows "No render history yet." A genuine fetch failure (the API
unreachable, a non-200 response) is shown as "Render history unavailable,"
distinct from the empty state, without breaking the rest of `TrackDetail`.

Deliberately not tested through the shared per-file HTTP journal root
(`tests/render-history.test.mts`): that root is shared by every
concurrently-running test in the file (Node's test runner runs a file's
top-level tests concurrently by default), and a raw, lock-bypassing write
of a truncated or malformed line there was found, in practice, to race
other tests' legitimate locked appends to the very same file — corrupting
their events too (§57.13 has the story). Both corruption scenarios are
instead tested as pure in-memory functions in `tests/render-journal.test.mts`
(`parseRenderJournal` on a constructed string, exactly like every other
corruption test in that file already does), which is both safer and more
precise.

### 57.11 Performance

`recentRenderJobsForSlug` reuses the exact same
`readRenderJournal`/`reconstructRenderJournal` path `getHistoricalRenderJob`
already benchmarked in §56.10 at single-digit milliseconds for 10,000
events. A dedicated benchmark for this milestone's own read model
(`tests/render-journal.test.mts`, "stays fast at a journal near its
retention bound") constructs 10,000 events across 2,500 jobs (50 belonging
to the queried track, interleaved with 200 other tracks) and measures
parse + reconstruct + select together: **consistently under 12ms**,
asserted well under a 200ms bound. No index or cache was added — the same
judgment §56.6 already made (a query this rare, against a journal this
small, is not worth the invalidation complexity).

### 57.12 Tests (29 added, 643 total)

- `tests/render-journal.test.mts` (+14) — grouping, file-position ordering
  under clock skew, track/preset filtering, limit bounding (including
  clamping an absurdly large limit to the documented maximum), excluding a
  caller-supplied live job id without shrinking the page, same-boot and
  cross-boot interrupted classification, survival of a malformed tail and
  an unsupported schema version (pure, in-memory), timestamp formatting
  (Today/Yesterday/older date, and a malformed-input fallback), and the
  10,000-event benchmark.
- `tests/render-history.test.mts` (+15) — one test per terminal state
  (completed/failed/cancelled/interrupted) over the real HTTP route, no
  history for an unused track, several jobs and several presets for one
  track, cross-track exclusion, invalid-slug and out-of-range-limit
  rejection (both directions), the default limit, no leaked internals in
  the response shape, live-job exclusion via the real `renderManager`
  singleton (mocked worker), and two tests that fork a real second OS
  process (reusing `render-journal-restart-process.mts` from §56.10
  unmodified): a genuine restart reported as `interrupted` through this
  endpoint, and a historical job from that dead process never conflated
  with a fresh live job for the same track started afterward in the
  "restarted" process.
- Every existing test file passes unchanged — confirmed at normal
  concurrency across five consecutive full-suite runs (§57.15).

### 57.13 A real test-design bug, found and fixed while building this

The first draft of the two corruption tests (§57.10) wrote a raw truncated
line and a raw unsupported-schema line directly into the shared per-file
journal root via `appendFile`, then queried the shared HTTP server — the
same technique `tests/render-journal-log.test.mts` uses, but that file
gives *each test* its own `mkdtemp` root, while this file's root is shared
by the whole file per `isolateRenderJournalForThisFile`'s own comment.
Node's test runner runs a file's top-level tests concurrently by default;
a raw write with no trailing newline, racing another concurrently-running
test's legitimate *locked* append, could land between two real events and
fuse them into one unparseable line neither test wrote — observed directly
as unrelated tests suddenly reporting `"interrupted"` where they expected
`"completed"`. The fix was not a synchronization primitive but a design
change: corruption is tested as a pure string transformation
(`parseRenderJournal(text)`) with no file and no shared state at all,
exactly like every other corruption test in `tests/render-journal.test.mts`
already does — removed from `tests/render-history.test.mts` entirely.

A second, smaller bug surfaced during the same pass: several fixture
lifecycles in both test files went `queued` → `completed` directly, which
`LEGAL_SUCCESSORS` (§56.5) does not permit (`completed` is only a legal
successor of `preparing`/`rendering`) — the completed event was silently
quarantined, leaving the job's reconstructed state at `queued` (non-
terminal) and misclassified `"interrupted"`. Fixed by inserting the
missing `preparing` transition throughout; `queued` → `failed` and
`queued` → `cancelled` remain legal and were left as direct transitions.

### 57.14 Real E2E results

- **Completed / failed / cancelled before a restart** — exercised as
  same-process journal events with an explicit, different `bootId` (the
  same technique §56's own recovery tests use for the terminal cases,
  since only a *non-terminal* record's interpretation depends on boot-id
  comparison at all): each terminal state round-trips through `GET
  /api/render-history` exactly as recorded, with `recoveredAfterRestart`
  reflecting the boot mismatch.
- **Interrupted, across a real OS process boundary** — a genuinely forked
  child process starts a render through the real `renderManager` singleton
  (mocked worker), reaches `"rendering"`, and simply exits without ever
  finishing, reusing `render-journal-restart-process.mts` from §56.10
  unmodified. The parent process — a different Node process, therefore a
  different `RENDER_MANAGER_BOOT_ID` by construction — queries `GET
  /api/render-history` for that exact track through a real HTTP server and
  confirms: one entry, `status: "interrupted"`, `recoveredAfterRestart:
  true`. No SSE and no cancel were separately re-proven here since §56.9/
  §56.10 already cover that surface exhaustively for the same journal
  entries this endpoint reads.
- **Live job alongside a historical one, same track** — the scenario this
  milestone's own live-exclusion fix (§57.1) exists for: after the dead
  process's job is durably `interrupted`, the *same test process* (a third,
  genuinely different boot id) starts a fresh render for the identical
  track directly through the real `renderManager` singleton. `GET
  /api/renders/:id` answers the new job live (`status: "rendering"`,
  `historical` absent); `GET /api/render-history` for the same track
  answers with exactly one entry — the old, dead-process job, `interrupted`
  — and the live job's id never appears there.

### 57.15 Verification performed

TypeScript (`tsc --noEmit`) and whole-project ESLint (`npm run lint`)
clean. `npx vite build` passed (only the pre-existing large-chunk
advisory, unchanged from §56.15). `validate-track`/`prepare-track` passed
on `ghetto-geek`, read-only — no render performed, no file under
`public/tracks/ghetto-geek/` touched. `git diff --check` clean.

Full suite: **643/643**, run five times at normal concurrency. Three runs
were completely clean; two showed one failure each, both the same
pre-existing, already-documented shared-fixture-directory race named
explicitly in §52.19/§53.3/§54.7/§56.15 (`destination-health.test.mts` and,
once, `export-missing.test.mts` — an `ENOENT` on a `regression-*` fixture's
`metadata.json`, racing against another concurrently-running test file's
own fixture cleanup under `public/tracks/`). Neither failure touched
anything added in this milestone; every render-history/render-journal test
passed on all five runs. This flake class is unrelated to the render
journal or this milestone's code and was not investigated further, per the
same judgment §56.15 already made about it.

No config fixture was left behind. `out/.render-journal/` does not exist
in the real project directory (every test redirects it via
`TOSHI_RENDER_JOURNAL_DIR`) and `out/.locks/` is empty. No `regression-*`
track directory remained under `public/tracks/` after the suite — only
`ghetto-geek`, untouched throughout. No leftover `/tmp` test-isolation
directory. No leaked Chromium, render-worker or Vite process.

### 57.16 Backward compatibility

Confirmed unchanged: `renderManager`, render journal writes, the render
queue, workers, locks, single-track render, Batch Content Package
Generation, Live Batch Progress, Batch Session Persistence, Batch Panel
Cancellation, package readiness, delivery, destination health, release
bundles, delivery history, metadata templates, and every CLI script other
than the new read-only additions below. `GET /api/renders/:id`'s own
behavior (§56) is untouched; this milestone adds a new endpoint beside it,
never modifies it.

### 57.17 Files changed

New:
- `server/routes/renderHistory.ts` — `GET /api/render-history`, composing
  the journal-only read model with `renderManager.listJobs()` for live
  exclusion.
- `ui/components/RecentRenderHistory.tsx` — `TrackRecentRenderHistory`, the
  "Recent render" section.
- `tests/render-history.test.mts` — API-level and real-restart E2E tests.

Changed:
- `src/domain/render/renderJournal.ts` — `reconstructRenderJournal` now
  also returns `order` (file-position index per job); adds
  `recentRenderJobsForSlug`, `RENDER_JOURNAL_STATUS_NOTES`,
  `RENDER_HISTORY_DEFAULT_LIMIT`/`RENDER_HISTORY_MAX_LIMIT`, and
  `formatRecentRenderTimestamp`.
- `server/services/renderJournal.ts` — adds `getRecentRenderHistory`.
- `src/domain/api/views.ts` — adds `RenderHistoryJobView`,
  `RenderHistoryQuery`, `RenderHistoryView`; re-exports
  `RenderJournalStatus`.
- `server/app.ts` — routes `GET /api/render-history`.
- `ui/api/client.ts` — adds `getRenderHistory`.
- `ui/components/TrackDetail.tsx` — mounts the new "Recent render" section
  below "Render".
- `ui/styles/app.css` — `.recenthistory*` classes; no new badge colors
  (reuses `.badge--job-*` from §56).
- `tests/render-journal.test.mts` — the additions in §57.12, plus two
  pre-existing `lifecycle(...)` fixtures corrected to go through
  `preparing` before `rendering` (§57.13's second bug), which changed no
  assertions.

Nothing in `renderManager.ts`, `renderLock.ts`, `services/delivery/*`,
`contentPackagePlan.ts`, `destinationFixPlan.ts`, `src/domain/content/*`,
release bundles, metadata templates, or any existing CLI script changed.

### 57.18 Remaining limitations

- No batch/action/platform correlation is shown (the journal never
  recorded it, by §56.3's own deliberate choice — unchanged here).
- The "Earlier" list is capped at 3 total (1 prominent + 2 more) with no
  way to see further back from `TrackDetail`; the API itself supports up to
  10 via `limit`, so a future CLI `--recent` summary or a dedicated
  history view (should one ever be wanted) has room without an API change.
- No targeted refresh when a live render on the same page completes —
  `TrackRecentRenderHistory` fetches once per track slug and otherwise
  updates on normal `TrackDetail` re-navigation, per the brief's own
  explicit preference not to add event plumbing for this.
- The pre-existing shared-fixture-directory test flake (§57.15) remains
  unaddressed, as it was in §56.15 — out of scope for this milestone.

### 57.19 Commits

1. Add a track-scoped render-history read model and service.
2. Expose a read-only `GET /api/render-history` endpoint.
3. Show recent render history in `TrackDetail`.
4. Test the render-history read model, API and a real restart.
5. Document Operator-Facing Render Journal Surface.

No push was made.

### 57.20 Final git status

Working tree clean after commits. Ahead of `origin/main` by the commits in
§57.19 (following on from §56's own commits, per §56.19's note that those
were also not yet pushed at the time). No push made.

### 57.21 Recommended next feature

Two independent, similarly small candidates, neither started:

- A `--recent` summary flag on the existing `render-locks` CLI
  (`scripts/render-locks.mts`), reusing `getRecentRenderHistory` directly —
  an operator working from the terminal gets the same answer this
  milestone gave the browser, with no new server surface.
- Extending the destination-health/fix-plan surface to note, for a track
  it already flags, whether the most recent render of the stale/missing
  format was itself `interrupted` — context that could change what an
  operator decides to do about a finding, sourced from the same read model
  added here rather than a new one.
