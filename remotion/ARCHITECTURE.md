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
    renderEngineRegistry.ts
                        Looks engines up by renderer id, with clear errors.

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
                        The only adapters/ module a host imports.
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
| `server/`, `scripts/` | `core/`, `services/`, the engine registry (`adapters/renderEngines.mts`) | any specific engine or composition, Remotion packages; `scripts/` never imports `server/` |
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
  to an export's visualizer fingerprint, and an engine-reported template
  (`ResolvedVideo.template`: composition + version) is added too. Both add
  nothing for Remotion, so every existing manifest keeps its exact fingerprint
  and stays current. Coverage, delivery, release bundles and content packages
  judge Remotion's exports only; the commands that plan from them
  (`render-missing`, `content-package`, `content-package-batch`) therefore
  refuse other engines rather than re-render into the wrong folder.

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
   loader, plus a `probe` if it depends on installed software. From then on
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
             hash the .aep -> template version "aep-sha256:<16 hex>"
  -> resolve(): composition for the format; frames from the track's audio (ffprobe)
             copy cover/audio/brand marks to fixed names beside the data file
             write the template-data sidecar (buildTemplateData) there
  -> render(): aerender -project -comp -output [-OMtemplate] -s 0 -e <frames-1> -close DO_NOT_SAVE_CHANGES
             PROGRESS lines -> progress; exit code / missing file / non-MP4 -> RENDER_FAILED
             move the file into the staging path -> published to out/<slug>/after-effects/<preset>.mp4
  -> library record: renderer after-effects, composition, aep-sha256 version (no paths)
```

**Finding `aerender`** (first match wins; the source is logged):
`TOSHI_AERENDER_PATH`, then `"aerenderPath"` in `after-effects.local.json`,
then `aerender` on `PATH`, then `/Applications/Adobe After Effects */aerender`
on macOS, newest first. An explicit setting that points nowhere is reported,
never silently replaced by another install.

**The template contract.** The `.aep` imports, as footage, the files the
adapter writes next to the data file (by default the project's folder):
`toshi-render-data.json` (the sidecar, read with expressions such as
`footage("toshi-render-data.json").sourceData.track.title`),
`toshi-cover.png`, `toshi-audio.wav`, `toshi-waveform-audio.wav`,
`toshi-brand-logo.png` and `toshi-brand-badge.png`. Expressions cannot swap
a footage item's file, which is why the assets are copied to fixed names
rather than referenced where they live. After Effects reloads them every
time `aerender` opens the project. Each format's composition must have that
format's canvas and frame rate, and be at least as long as the longest track:
`aerender` renders frames `0..duration-1`.

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
