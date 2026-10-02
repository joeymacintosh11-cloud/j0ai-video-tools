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
| `adapters/<x>/` | `core/`, its own technology | other adapters, hosts |
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
  without loading anything: an unknown id is `INVALID_RENDERER`, a reserved id
  with no adapter (`premiere`, `after-effects` today) is `RENDERER_UNAVAILABLE`.
  The CLI checks while parsing arguments and the API before queuing (HTTP 400).
  The worker resolves again, so a bad id that slips through becomes a
  structured job error rather than a crash.
- **The job carries it.** `RenderJobView.engine`, every render-journal event,
  and the worker's argv carry the id. Older journal events with no engine
  read back as `remotion`.
- **The export records it.** Content-library records store
  `template.renderer`. Older records have none and read back as `remotion`
  (`storedRendererId`).
- **Freshness distinguishes it.** `rendererFingerprintParts()` adds the renderer
  to an export's visualizer fingerprint. It adds nothing for Remotion, so
  every manifest written before engines were selectable keeps its exact
  fingerprint and stays current. Freshness is judged against the default
  renderer, so an export from another engine reads as stale
  (`visualizer_changed`) instead of passing for a current Remotion export.
  Every engine still writes to the same `out/<slug>/<preset>.mp4`, and a job's
  per-target lock is per slug and preset, never per engine.

## Adding a renderer (e.g. Premiere Pro, After Effects)

1. Create `adapters/<name>/` and implement `RenderEngine` from
   `core/ports/renderEngine.ts`:
   - `open()` connects to the host app or prepares a project, and returns a
     session whose `assetRoot` is the directory the renderer reads
     `public/`-relative assets from (the project's `public/` if it reads them
     in place);
   - `resolve(props)` maps `VisualizerProps` onto the template and returns its
     frame count and canvas;
   - `render({ outputPath, cancelSignal, onProgress })` writes the video to
     `outputPath` and rejects if cancelled;
   - `close()` releases everything, and is idempotent.
2. Map fields, don't redefine them. Layout shapes come from
   `RenderPreset.layout`, brand assets from `BRAND_ASSET_PATHS`, frame math
   from `secondsToFrames`.
3. Register it under its renderer id in `adapters/renderEngines.mts`, as a lazy
   loader (one line). From then on `--engine <id>`, the API's `engine` field
   and the render worker all reach it. Nothing in `services/`, `server/` or
   `scripts/` changes. A renderer id outside `RENDERER_IDS` also needs adding
   to `core/domain/video/renderers.ts`.
4. `tests/render-engine-port.test.mts` shows how to drive `renderTrackVideo`
   with a stand-in engine, and `tests/render-engine-registry.test.mts` how
   resolution is tested. `npm run lint` already covers `adapters/`.

The engine's id is recorded with its exports and fingerprinted (see *Choosing
the engine per job*), so different renderers' exports are never mistaken for
each other. `VISUALIZER_VERSION` and `COMPOSITION_ID` still describe the
Remotion template. A non-Remotion export is stale against the default
renderer until per-track engine preferences exist.

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
