# Architecture: a reusable core with adapters

The Toshi content engine (tracks, export formats, freshness, delivery,
release bundles, content packages, the content library) does not depend on
how a video is drawn or on which app is asking. Remotion is one renderer
plugged into it, and the web UI, the HTTP API and the CLI are hosts around it.
This file describes the layers, the rules between them, and how to add a new
renderer or host.

## Layers

```
core/                   Platform-independent. Pure TypeScript: no node:*, no
                        React, no Remotion, no packages at all.
  domain/               The business rules: tracks, presets, freshness,
                        delivery and release-bundle models, content packages,
                        the content library, the render journal, and the API
                        wire format (domain/api/views.ts).
    video/renderers.ts  Renderer ids (remotion, premiere, after-effects) and
                        the default (remotion).
    video/templateData.ts
                        The sidecar JSON template-driven renderers read.
  ports/                Extension points that adapters implement.
    renderEngine.ts     RenderEngine / RenderSession, CancelSignal.
    templateIdentity.ts Read-only current-template observation for freshness.
    rendererWorkspace.ts Read-only inventory and explicit dry-run maintenance port.
    renderEngineRegistry.ts
                        Looks engines up by renderer id, with clear errors.
    publishDestination.ts, publishDestinationRegistry.ts
                        The publishing destination contract and its registry.
    destinationCredentials.ts
                        The secrets boundary for future network destinations.

services/               The engine runtime on Node: the single owner of the
                        filesystem, ffmpeg, locks and append-only logs.
  tracks/ render/ delivery/ library/ content/ storage/
                        Building blocks, one subject each.
  workflows/            Multi-step operations shared by every host: planners
                        (export, delivery, release bundle, content package),
                        destination health and fix plans, library and history
                        queries, the render job manager, its journal and its
                        worker process.

adapters/               Implementations of core ports for one technology.
  renderEngines.mts     The engine registry: renderer id -> engine (lazy).
  publishDestinations.mts
                        The destination registry: destination id -> adapter (lazy).
                        These two registries are the only adapters/ modules a host imports.
  publishing/local-mock/ The deterministic local mock destination (no network).
  remotion/             The Remotion renderer.
    remotionRenderEngine.mts   RenderEngine via bundle/selectComposition/
                               renderMedia; owns the encoding settings.
    index.ts, Root.tsx, Composition.tsx, BeatVisualizer/
                               The composition itself (Studio entry point).
  after-effects/        The After Effects renderer (proof of concept), via aerender.
    afterEffectsRenderEngine.mts   RenderEngine: stage assets + sidecar, run aerender.
    aerenderDiscovery.mts          Finds aerender; the registry's availability probe.
    afterEffectsConfig.mts         Reads after-effects.local.json (project, comps).
    aerenderCommand.mts            aerender arguments and progress parsing (pure).
    templateContract.mts           Staged file names, required files, track text and marker, checks (pure).
    templateIdentity.mts           Canonical base hash + preparation version/mode; observation without Adobe.
    templatePreparation.mts        Validated per-track working-copy cache and locked promotion.
    stagingLock.mts                Guarded versioned ownership and confirmed-safe phases.
    workspace.mts                  Scoped inspection, recovery and bounded cache retention.
    afterEffectsScripting.mts      Node → osascript and token-specific JSON completion protocol.
    template/create-toshi-template.jsx
                                   One-time ExtendScript bootstrap of the minimal template.

server/                 Host: the local HTTP API. Routes and HTTP helpers only.
scripts/                Host: the CLI. Parse args, call a workflow, print.
ui/                     Host: the local web app. Talks to server/ over HTTP.
```

## Dependency rules

Dependencies point inward: hosts and adapters depend on `services/` and
`core/`, `services/` depends on `core/`, and `core/` depends on nothing.

| Layer | May import | Must not import |
| --- | --- | --- |
| `core/` | `core/` | any package (`node:*`, React, Remotion…), anything outside `core/` |
| `services/` | `core/`, `services/`, Node | `adapters/`*, `server/`, `scripts/`, `ui/`, Remotion |
| `adapters/<x>/` | `core/`, `services/` building blocks, its own technology | other adapters, hosts |
| `server/`, `scripts/` | `core/`, `services/`, the engine and destination registries (`adapters/renderEngines.mts`, `adapters/publishDestinations.mts`) | any specific engine, destination adapter or composition, Remotion packages; `scripts/` never imports `server/` |
| `ui/` | `core/`, the composition (for the `<Player>` preview) | `services/`, `server/`, `scripts/` |

\* `services/workflows/render-worker.mts` is the exception. It is a process
entry point, like a CLI script: it resolves each job's engine from the
registry, and imports nothing else from `adapters/`.

`tests/architecture.test.mts` enforces every row of this table, so a change
that breaks a rule fails `npm test`.

## The render contract

Two core types are all a renderer needs to know:

- **`VisualizerProps`** (`core/domain/video/visualizerProps.ts`) describes one
  track's video: title, artist, key, BPM, the public/-relative asset paths and
  the export preset. `services/tracks/buildTrackProps.ts` builds it. The
  Remotion composition's `BeatVisualizerProps` is an alias of it.
- **`RenderPreset`** (`core/domain/video/renderPresets.ts`) gives each format's
  canvas, frame rate and layout shape.

`services/render/renderTrackVideo.ts` runs every render, whatever the engine:

1. takes the per-target lock;
2. `engine.open()`, then fingerprints the inputs from `session.assetRoot`;
3. `session.resolve(props)` reports duration and canvas;
4. `session.render({ outputPath })` writes to a staging path, which is then
   published atomically with its manifest and recorded in the content library;
5. `session.close()`, always;
6. auto-delivers, if that's switched on, after the lock is released.

An engine therefore implements only steps 2–5. The lock, freshness,
publication, library and delivery come with it.

## Choosing the engine per job

Every render names a renderer id (`core/domain/video/renderers.ts`); naming
none means `remotion`, which is how every command and request behaved before.

```
CLI --engine <id>            ─┐
POST .../render { engine }   ─┼─> render job { slug, preset, engine } ─> registry.resolve(engine) ─> RenderEngine
POST /api/render-batches     ─┘      (render manager, journal, worker)     (adapters/renderEngines.mts)
     targets[].engine
```

- **Validation happens at the edge.** `registry.assertAvailable()` checks an id
  without loading anything: an unknown id is `INVALID_RENDERER`, and a reserved
  id with no adapter (`premiere` today) is `RENDERER_UNAVAILABLE`. An engine
  that needs software outside this project registers a *probe*, asked on every
  check: `after-effects` is available exactly when `aerender` is found, and
  otherwise `RENDERER_UNAVAILABLE` says what was searched and how to fix it.
  The CLI checks while parsing arguments and the API before queuing (HTTP 400).
  The worker resolves again, so a bad id that slips through becomes a
  structured job error rather than a crash.
- **The job carries it.** `RenderJobView.engine`, every render-journal event,
  and the worker's argv carry the id. Older journal events with no engine
  read back as `remotion`.
- **The export records it.** Content-library records store
  `template.renderer`. Older records have none and read back as `remotion`
  (`storedRendererId`).
- **Each engine has its own exports.** Remotion's stay at
  `out/<slug>/<preset>.mp4`, exactly where they always were. Every other engine
  writes `out/<slug>/<renderer>/<preset>.mp4` with its manifest beside it, so
  one engine never overwrites another's export. A job's per-target lock is
  still per slug and preset, so two engines rendering the same format are
  serialised.
- **Freshness distinguishes it.** `rendererFingerprintParts()` adds the renderer
  to an export's visualizer fingerprint; AE's engine-reported template
  (`ResolvedVideo.template`: composition + version) is a separate input. Both add
  nothing for Remotion, so every existing manifest keeps its exact fingerprint
  and stays current. Coverage, delivery and content packages use the preferred
  renderer explicitly. Release bundles and automatic destination repair retain
  their Remotion-only restriction.

### A track's preferred engine

A track may also *prefer* a renderer: `metadata.json` `"renderer"`
(`TrackMetadata.renderer`), set from the engine picker in Track info and
validated against `RENDERER_IDS` like any other metadata field. Absent is the
default (`resolveTrackRenderer()`), so no existing track changes or is
migrated.

```
GET /api/renderers  ─> registry.status()  ─> per id: ready | unavailable | not_configured, + reason
                         probe       (installed?)   — also feeds assertAvailable(), unchanged
                         configured  (usable config?) — status() only; AE: readAfterEffectsConfig()
```

- **Who applies it.** The UI Render panel names the track's engine in
  `POST .../render` and in batch targets (`ui/api/engineRequest.ts`). Catalogue
  queueing rereads each selected track's saved preference before building targets.
  The Render panel disables itself with the reason when `GET /api/renderers` says that engine
  is unavailable or not configured. Workflow planners read the saved preference
  and carry an optional `engine` on each target (omitted for legacy Remotion
  shapes). Direct CLI/API render requests naming none still get Remotion.
- **What it changes in the view.** `TrackSummaryView.exportsRenderer` is the
  resolved preference, and `exports[]` is `trackExportCoverage(slug, metadata,
  exportsRenderer)`: that engine's own folder, so a Remotion export never
  satisfies an After Effects track, or the other way round. The adapter registry
  wires a `TemplateIdentityReader` into `services/render/templateIdentity.ts`.
  Coverage reads that port to compare AE's explicit `inputs.template`, without
  importing an adapter, loading an engine or consulting prepared-copy caches.
  Missing readers/templates fail closed as unknown freshness. Metadata, cover,
  audio, format, visualizer/brand and file identity are checked too.
  Queue status uses `exportStatusKey(slug, preset, renderer)` through
  `inFlightExports()`, so only a matching engine marks an export queued/rendering.
  Pair-only `inFlightTargets()` and track/format locks remain contention checks.
- **Workflow support.** Export-missing and content-package planners carry engine
  identity through targets, adopted jobs and recovered batch sessions. Only
  matching-engine jobs satisfy in-flight status; pair locks still prevent
  simultaneous writes to the same track/format. Missing/stale exports require
  a locally ready engine; current exports can be packaged without one.
- **Delivery safety.** Coverage and receipts come from the preferred engine's
  folder. `deliverExport` pins that renderer, checks a planner/auto-delivery
  renderer constraint, and rereads metadata and source identity after staging
  before publish. Legacy receipts without a renderer mean Remotion. Destination
  health also reads old-engine receipts after a preference change, preserving
  evidence of previous deliveries. Release bundles and automatic destination
  repair still use `remotionOnlyProblem()` and require manual AE review;
  repair delivery is pinned to Remotion, so a preference switched while a
  repair render runs is refused rather than delivering the AE export. The
  content library keys versions by track, format and renderer; a re-export
  renders with the version's own renderer.
- **Serial execution.** The manager runs one worker globally and waits for its
  exit before starting another; CLI batches also run sequentially. AE sessions
  acquire an exclusive lock beside the configured data file before staging,
  across processes and aliases. The lock stays held until the Adobe child exits.
  An interrupted owner is not reclaimed automatically: confirm no aerender
  remains before manually removing `.toshi-ae-render.lock`. Queue logs identify
  serial AE execution; the drawer labels each AE job.

## Adding a renderer (e.g. Premiere Pro, After Effects)

1. Create `adapters/<name>/` and implement `RenderEngine` from
   `core/ports/renderEngine.ts`:
   - `open({ log })` connects to the host app or prepares a project, and
     returns a session whose `assetRoot` is the directory the renderer reads
     `public/`-relative assets from (the project's `public/` if it reads them
     in place). `log` takes diagnostics for the person running the render;
   - `resolve(props)` maps `VisualizerProps` onto the template and returns its
     frame count and canvas, plus `template: { composition, version }` when it
     renders an external template. `version` must change whenever the
     template's look can (a content hash), and must never be a path;
   - `render({ outputPath, cancelSignal, onProgress })` writes the video to
     `outputPath` and rejects if cancelled;
   - `close()` releases everything, and is idempotent.
2. Map fields, don't redefine them. Layout shapes come from
   `RenderPreset.layout`, brand assets from `BRAND_ASSET_PATHS`, frame math
   from `secondsToFrames`.
3. Register it under its renderer id in `adapters/renderEngines.mts`: a lazy
   loader, plus a `probe` if it depends on installed software, and a
   `configured` check if it needs local configuration (shown by
   `GET /api/renderers` and the engine picker; never part of
   `assertAvailable`). From then on
   `--engine <id>`, the API's `engine` field and the render worker all reach
   it, and its exports land in their own folder. Nothing in `services/`,
   `server/` or `scripts/` changes. A renderer id outside `RENDERER_IDS` also
   needs adding to `core/domain/video/renderers.ts`.
   Template-driven renderers should hand their template the shared sidecar
   (`buildTemplateData`, `core/domain/video/templateData.ts`).
4. `tests/render-engine-port.test.mts` shows how to drive `renderTrackVideo`
   with a stand-in engine, and `tests/render-engine-registry.test.mts` how
   resolution is tested. `npm run lint` already covers `adapters/`.

The engine's id and template are recorded with its exports and fingerprinted
(see *Choosing the engine per job*), so different renderers' and templates'
exports are never mistaken for each other.

## The After Effects adapter (proof of concept)

`adapters/after-effects/` drives After Effects' command-line renderer,
`aerender`, across a process boundary. It proves that a second renderer can
plug into `RenderEngine` without the core knowing anything about Adobe: no
`aerender`, `.aep` or output-module knowledge exists outside that folder (an
architecture test checks this).

```
render-track --engine after-effects
  -> registry probe: aerender found?            no  -> RENDERER_UNAVAILABLE (what was searched, how to set it)
  -> open(): after-effects.local.json valid?    no  -> RENDERER_NOT_CONFIGURED (what to put in it)
             hash the .aep -> canonical template version (full SHA-256 + prep version + mode)
  -> resolve(): composition for the format; frames from the track's audio (ffprobe)
             copy cover/audio/brand marks to fixed names beside the data file
             write the template-data sidecar (buildTemplateData) there
             project never mentions the data, cover or audio file? -> RENDERER_NOT_CONFIGURED
  -> render(): aerender -project -comp -output [-OMtemplate] -s 0 -e <frames-1> -close DO_NOT_SAVE_CHANGES
             PROGRESS lines -> progress; exit code / missing file / non-MP4 -> RENDER_FAILED
             ffprobe: no video or no audio stream -> RENDER_FAILED (never published)
             move the file into the staging path -> published to out/<slug>/after-effects/<preset>.mp4
  -> library record: renderer after-effects, composition, aep-sha256 version (no paths)
```

**Finding `aerender`** (first match wins; the source is logged):
`TOSHI_AERENDER_PATH`, then `"aerenderPath"` in `after-effects.local.json`,
then `aerender` on `PATH`, then `/Applications/Adobe After Effects */aerender`
on macOS, newest first. An explicit setting that points nowhere is reported,
never silently replaced by another install.

**The template contract** (`templateContract.mts`; the README has the
step-by-step). The adapter writes these files next to the data file (by
default the project's folder): `toshi-render-data.json`, `toshi-cover.png`,
`toshi-audio.wav`, `toshi-waveform-audio.wav`, `toshi-brand-logo.png` and
`toshi-brand-badge.png`. The `.aep` imports the images and audio as footage.
The cover and audio are required. After Effects reloads them every time
`aerender` opens the project, so they always follow the staged track. The audio
layer is time-remapped (`time - thisLayer.inPoint`) and runs to the end of the
composition, so any track length plays in full.

The text does not follow at render time. A real After Effects 2026 render found
`footage("toshi-render-data.json")` but got `null` for both `sourceData` and
`sourceText`, so expressions cannot read the sidecar. Instead the bootstrap
script reads the sidecar when it builds the template and writes the title,
artist, and key and BPM into the text layers (`templateText`). It records the
track's text marker (`templateTextMarker`: `toshi-text-` plus a 32-bit FNV-1a
of the three lines) in the composition's and the Title layer's comments. The
template is therefore built for one track.
Each format's composition has that format's canvas and frame rate and is at
least as long as the longest track: `aerender` renders frames `0..duration-1`.
The bootstrap's layers (`TEMPLATE_LAYERS`) are Audio, Brand Logo, Waveform,
Accent, Key BPM, Artist, Title, Cover and Background. The background is a
native radial Gradient Ramp (warm amber charcoal to off-black `#0b0b0b`), and
the waveform is the native Audio Waveform effect reading the Audio layer, so
both render in `aerender` without plugins or per-track setup.

Mechanisms considered: expressions alone cannot load images or audio, and
`aerender` cannot run scripts at render time, so the render path is fixed
file names for media. Expressions reading the JSON were tried and get `null`
under `aerender`, so the text is written in by the ExtendScript bootstrap
(`template/create-toshi-template.jsx`), rerun for each track in default manual
mode. Opt-in `templatePreparation: "auto"` prepares a per-track working copy
from a byte-for-byte base snapshot using the GUI's DoScriptFile interface.
Staging and GUI locks serialize shared mutations. Token-specific atomic JSON
status proves the script closed the project before promotion/rendering; missing
terminal proof retains locks and recovery files. Neither mode substitutes Remotion.

**Canonical identity and freshness.** Both modes report
`aep-sha256:<full base SHA-256>;prep:<PREPARATION_VERSION>;mode:<manual|auto>`.
This version describes the template, not the generated per-track project;
the selected composition participates in the separate `inputs.template` digest.
AE manifests append that digest to their aggregate input fingerprint. Remotion
keeps its original five-input fingerprint and schema compatibility.

Normal coverage compares this digest using the registry-wired observation port.
Base edits/replacements, preparation contract changes, mode and composition
changes produce `template_changed`. Legacy AE manifests missing the separate
input produce `template_identity_missing`; unreadable/unconfigured templates
produce `template_unavailable`. Both prevent current readiness/delivery and
never fall back across engines. A readable base can establish freshness even
without Adobe installed. The existing bounded file-content hash cache checks
device/inode, size, mtime and ctime each time, avoiding repeated full hashes
across a catalogue without retaining stale hashes after changes.

Prepared-project cache validation remains separate: it binds the full generated
project digest to track text/assets/base/version and protects reuse. Export
freshness never depends on a working copy's presence. External dependency or
plugin changes without a base/version change are not detected by this milestone.

**Checks.** Before `aerender` starts, the project's bytes must mention the
cover and audio file names: footage paths are stored as text in `.aep` and
`.aepx`, so an absent name is an unused file. This catches an empty or
unwired template in seconds. The bytes must also not carry another track's
text marker (`templateTextStatus`): "stale" stops the render with this track
already staged for the rebuild, and a project with no marker at all is only
warned about (`"templateCheck": false` opts out of both). After
`aerender`, ffprobe must find both a video and an audio stream, so a silent
render is never published. Two further findings are warnings only (`templateWarnings`):
the composition name not found in the project file (`aerender` reports a
genuinely missing composition itself, within seconds), and no Audio Waveform
effect.

**What it is not.** It is an adapter: Toshi starts `aerender` and reads its
exit code and files. A future Adobe *plugin* (UXP/CEP) would run inside After
Effects or Premiere Pro, driving the open application and its UI. It would be
a host talking to `server/` over HTTP, not a `RenderEngine`.

## Adding a host (a batch service, a desktop panel)

Call `services/workflows/*` and `services/*` directly, the same way
`scripts/` does. The planners return plain data shaped by `core/domain`, and
the render manager queues and runs jobs in worker processes. A host that
can't run Node (e.g. a UXP panel) talks to `server/` over HTTP instead, the
way `ui/` does, using the types in `core/domain/api/views.ts`.

## Remotion specifics

- `remotion.config.ts` sets the Studio/bundle entry point to
  `adapters/remotion/index.ts`.
- `@remotion/bundler` takes the project root, and so `public/`, from the
  `package.json` nearest the entry point. That's `remotion/package.json`, so
  don't add a `package.json` under `adapters/`. Node-side adapter modules use
  `.mts` so they load as ES modules without one.
- `ui/` imports the composition for the in-browser `<Player>` preview. That's
  a deliberate UI-to-Remotion dependency: the preview is the renderer's own
  output, not a second implementation.

## Renderer workspace housekeeping

`services/render/rendererWorkspace.ts` exposes a registered core port, wired by
`adapters/renderEngines.mts`. The API and CLI call this service; the UI consumes
its typed API response. Adobe paths, PID/host checks, status validation and cache
pair eviction stay in the AE adapter. Housekeeping does not participate in
export fingerprinting or renderer selection.

AE staging ownership spans resolve through confirmed child shutdown. Auto mode
also holds a workspace fence across preparation, cache use, rendering and
retention; GUI preparation has its existing shared machine-wide lock. Guarded
ownership mutations prevent recovery from racing release or acquisition; a
held guard is waited for briefly (`GUARD_WAIT_MS`), so a competing session's
refused acquire never fails a live owner's update or release.
Schema-2 records identify token, owner/host, phase, track, run and child. Dead
owners are not enough: only explicit safe phases or matching terminal status
permit recovery. Live children, uncertain Adobe completion, legacy ownership,
unknown artifacts and crashed mutation guards remain manual. Recovery never
promotes partial projects or kills an Adobe GUI it does not own.

Inventory reads only immediate known workspace locations and shallow run/log
sets; unchanged file hashes use the existing stat-aware memoization. Startup
is read-only. Explicit cleanup defaults to dry-run and revalidates under the
same workspace fence. UI apply additionally checks the preview path set.
Normal auto-session close enforces 20 validated pairs ordered by last use,
protecting the current project. Project and provenance move together into a
quarantine before deletion; rename failures roll back or retain manual evidence.
Invalid pairs are not recovery garbage. Cache eviction never affects existing
export freshness; the next use prepares again. Manual AE and Remotion keep their
existing paths. See README's AE housekeeping section for commands and limits.

### V2 production workflow integration

`tests/production-workflow.test.mts` connects saved metadata and intended formats
through export planning, the real render manager, `renderTrackVideo`, atomic
publication/library recording, freshness, content packages and local delivery,
receipts/history/destination health. `productionWorkflowHarness.mts` substitutes
only renderer output and the worker transport; it adds no production fake mode.
Delivery still forks its real copy worker with the original process options.
The suite includes mixed engines, three formats, duplicate submissions,
failure/cancellation preservation, retry, renderer changes and template changes.
Adobe-specific preparation/recovery remains covered by the adapter suites.

The track render panel adopts active work by slug **and renderer**, and by
format when recovering a duplicate single-render request. Changing preference
invalidates late UI responses for the old renderer; the existing job keeps its
original identity in the queue. A renderer change does not cancel another job
or make its export satisfy the new preference. Pair-level queue contention is
still deliberately shared across engines, independently of engine-specific
export status. The toolbar’s immediate formats are distinct from saved intended
formats used by missing-export and package planners.

Finished exports are authoritative on disk. Queue/job history alone cannot
make a package ready. Journal recovery is historical state, not a resumed
worker; workspace cleanup is a previewed ownership-fenced operation, not a
scheduler. V2 remains local: release bundles/destination repair are Remotion-only,
and Premiere, cloud rendering, analytics and general scheduling are future
work. V3 adds the publishing foundation (below); real platform uploads are
the next milestone. AE template canvas/frame-rate correctness remains an operator
setup requirement rather than a media-dimension check.

The recent-render endpoint excludes only active manager jobs, so settled jobs
appear immediately without waiting for in-memory retention eviction or restart.
The history panel refreshes with the track snapshot and names each renderer.
After applied workspace maintenance the UI performs a fresh inspection because
the maintenance response contains the preview’s pre-operation inspection.

AE’s default composition is restricted to the default 16:9 preset. Vertical and
square require explicit config mappings, checked before acquiring staging locks
or writing assets. Canonical identity uses the same selector, so an unmapped
format cannot be treated as a valid template for freshness/delivery either.
Explicitly mapped compositions still require operator verification of canvas,
frame rate and visual correctness.


## Publishing (V3 foundation)

### Rendering, delivery and publishing

| | Rendering | Delivery | Publishing |
| --- | --- | --- | --- |
| Does | turns a track into an export | copies a current export into a local folder | hands a current export + metadata to a destination |
| Through | `RenderEngine` (renderer registry) | the delivery copy worker | `PublishDestination` (destination registry) |
| Writes | `out/<slug>[/<renderer>]/<preset>.mp4` + manifest, library record | the copy, a delivery receipt beside the export, the destination's log | `out/.publishing/` only: jobs, receipts, the mock's workspace |
| Proof | export manifest | delivery receipt | publication receipt |

Publishing is strictly downstream. It consumes an existing, current export and
never renders, never modifies an export, its manifest, the content library,
delivery receipts or a content package (architecture tests forbid render,
delivery, library and content code from importing publishing at all). A later
workflow may chain render → publish explicitly; nothing does so implicitly.

### Model

```
core/domain/publishing/
  destinations.ts        destination ids (open set; youtube/instagram/tiktok reserved),
                         capabilities (formats → mode, metadata rules, cancel, recover,
                         idempotentPublish, accounts, network), status
  publicationSource.ts   PublicationSourceRef {slug, presetId, renderer} — renderer mandatory
                         PublicationSourceIdentity = ref + manifest fingerprint, renderedAt,
                         output {bytes, mtimeMs, ino}, outputLabel
  publicationMetadata.ts title, description/caption, tags, visibility, scheduledAt (data
                         only), thumbnail {source:"track-cover"}; generic + destination rules
  publishJob.ts          job, attempts, lifecycle table, certainty, transitions
  publicationReceipt.ts  receipt shape, strict parse, receiptMismatch(job, receipt)
  publicationHistory.ts  JSONL parse (damage/duplicates reported) and queries
  publishProblems.ts     lowercase reasons: destination_unknown, destination_unavailable,
                         destination_not_configured, format_unsupported, track_invalid,
                         export_missing, export_stale, source_changed,
                         publication_metadata_invalid, publish_failed, publish_cancelled,
                         recovery_required, receipt_invalid, already_published
```

Reasons describe states on plans, jobs and receipts (like `StaleReason`). Bad
*requests* are `TrackError`s: `PUBLISH_DESTINATION_UNKNOWN` (400),
`PUBLISH_JOB_NOT_FOUND` (404), `PUBLISH_JOB_CONFLICT` (409), plus the existing
`INVALID_REQUEST`/`INVALID_RENDERER`/`INVALID_PRESET`/`INVALID_SLUG`.

**Source decision.** Publish jobs consume a small normalised
`PublicationSourceRef`, not export records or content-package entries
directly. A content package is one way to arrive at one
(`publicationSourceFromPackage(view, platformId)` takes the package's own
renderer and the platform's preset, and refuses a platform that is not ready),
and `seedPublicationMetadata(entry)` turns the package's resolved copy into
starting metadata. Platform adapters never see a package or UI component, and
package derivation is unchanged.

### Destination contract and registry

`core/ports/publishDestination.ts`. Unlike `RenderEngine`, it is built around
certainty, because a publication is an external side effect that may succeed
without the caller finding out:

```
registry.status()/describe()   static descriptor + probe (installed?) + configured (account?) — loads nothing
validate(request)              destination-specific metadata checks           -> problems
prepare(request, ctx)          read the pinned export (engine holds its lock) -> PreparedPublication
publish(prepared, ctx)         -> published {publicationId, url, publishedAt}
                                | failed (definitely nothing took effect)
                                | cancelled (before anything took effect)
                                | uncertain (may or may not have)
inspect(publicationId)         remote state, or null
recover(attempt)               -> published | not_published | unknown      (when capabilities.recover)
cancel                         ctx.cancelSignal                            (when capabilities.cancel)
```

`createPublishDestinationRegistry` mirrors the renderer registry: unknown ids
throw `PUBLISH_DESTINATION_UNKNOWN`, reserved ids without adapters are listed
as `unavailable` / not implemented, and `resolve()` refuses anything not
`ready`. Nothing ever substitutes another destination.

### Execution (services/publishing/publishing.ts)

`createPublishingService(registry)` — hosts pass `adapters/publishDestinations.mts`;
tests pass their own. `plan()` collects *every* problem without persisting
anything: destination state and account, format capability, the named
renderer's export only (`resolvePublicationSource`: missing / stale / invalid
→ reasons; no fallback), generic and destination metadata rules, then the
adapter's `validate()`. `createJob()` saves `pending → validating → ready|failed`
and pins the export identity. `execute()`:

1. takes the job's execution lock (`locks/<jobId>.lock`, one process per job);
2. re-validates; a pinned job whose export changed fails `source_changed`;
3. records a new attempt and saves `publishing` **before** calling the adapter;
4. under the export's render target lock (the one renders and deliveries take)
   calls `prepare()`, then re-checks the pinned identity before releasing it;
5. calls `publish()`; a thrown adapter error is treated as `uncertain`;
6. builds the receipt, validates it (`parsePublicationReceipt`,
   `receiptMismatch`), appends it, then saves `published`.

A crash after step 3 leaves `publishing` with no live lock owner: any later
read reconciles it — a receipt for its attempt means `published` (crash between
6's append and save), otherwise `recovery_required`. The server does this at
startup, without retrying anything.

Dead-owner job lock reclamation uses an exclusive `.reclaim` guard and
rechecks ownership inside it. Competing reclaimers cannot delete a replacement
live owner's lock. An interrupted reclamation guard fails closed; inspect
ownership and confirm no reclaiming process remains before manually removing it.
The shared receipt-log append lock similarly fences automatic and operator
reclamation with a `.reclaim` guard; a retained guard requires inspection rather
than automatic removal.

### Receipts and idempotency

Receipts are appended to `out/.publishing/receipts.jsonl` — never to export,
delivery or library records, which publishing does not mutate. A receipt holds
the destination and account id, publication id and URL (http(s) or `mock:`,
never with credentials), job, attempt and idempotency key, the pinned source
identity (so history stays renderer-aware), the metadata snapshot, mode and
timestamps. No paths, no secrets: the parser rejects credential-shaped keys.

- Job ids are random (`pub_…`). An attempt's id and idempotency key are
  `sha256(jobId, attemptNumber)`: resuming the *same* attempt reuses its key;
  a retry after a definite failure is attempt n+1 with a new key.
- `receiptId = f(idempotencyKey)`, so one attempt can only ever have one
  receipt id. Appending is serialised by a cross-process lock; the same
  receipt again is a no-op, a different receipt for the same attempt or a
  second receipt for the same job is refused.
- The key is handed to the adapter. Whether a *platform* deduplicates is the
  adapter's to prove (`capabilities.idempotentPublish`); the engine never
  assumes it. The local mock proves it: its publication id is derived from the
  key and appears by atomic rename, so repeating an attempt returns the same
  publication.
- `recovery_required` never retries blindly. `recover()` settles it only from
  evidence: a recorded receipt for the attempt, or the adapter's `recover()`
  proving published (a receipt is recorded) or not published (`failed`,
  retryable). Anything else stays `recovery_required`.

### Configuration and secrets boundary

- `publishing.local.json` (gitignored, `TOSHI_PUBLISHING_SETTINGS` overrides):
  per destination `enabled`, `accountId` and plain non-secret options. A file
  with credential-shaped keys is refused entirely; a malformed file makes
  destinations `not_configured` rather than guessing.
- `core/ports/destinationCredentials.ts` is where OAuth tokens/API keys will be
  read. They may only reach an adapter, never a job, receipt, log, track
  metadata, export manifest or git. This milestone ships only `noCredentials`;
  no credential storage exists yet.
- Destination status and every API response carry identifiers only.

### The local mock destination

`adapters/publishing/local-mock/` registered as `local-mock` (16:9 → video,
9:16 → short, 1:1 → post) and `local-mock-landscape` (16:9 only). `prepare()`
copies the export into `out/.publishing/destinations/<id>/staging/` and checks
its size; `publish()` moves that copy into `publications/<publicationId>/` with
a `publication.json`. The original export is never touched. Fixtures
(`success`, `failure`, `uncertain`, `throw`, `invalid-receipt`, `delayMs` for
cancellation) are explicit options, settable in `publishing.local.json` or by
tests. It rejects the placeholder title "Untitled" to exercise adapter-level
validation.

Only an absent publication folder proves the local attempt was not published.
Missing, unreadable, malformed or mismatched records in an existing folder leave
reconciliation uncertain and block retry.

### What the YouTube milestone adds

- `adapters/publishing/youtube/`: a `PublishDestination` mapping title,
  description, tags, visibility (and later scheduledAt, thumbnail) onto the
  YouTube Data API, registered in `adapters/publishDestinations.mts` with a
  probe/configured check and `capabilities.network: true`.
- A real `DestinationCredentialProvider` (OS keychain or encrypted local
  store) and the OAuth consent flow — a person-driven, external step.
- Resumable upload inside `publish()`, cancellation through the cancel signal,
  and `recover()` that searches the channel for an upload carrying the
  attempt's key (YouTube has no native idempotency, so
  `idempotentPublish: false` until proven otherwise).
- `inspect()` against the platform (processing/published/removed) and quota
  and rate-limit failures mapped to definite `failed` vs `uncertain`.
- Scheduling execution, thumbnail upload and per-platform metadata limits.
