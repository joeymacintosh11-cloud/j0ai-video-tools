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
  ports/                Extension points that adapters implement.
    renderEngine.ts     RenderEngine / RenderSession, CancelSignal.

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
| `server/`, `scripts/` | `core/`, `services/`, an adapter's engine to plug it in | the Remotion composition, Remotion packages; `scripts/` never imports `server/` |
| `ui/` | `core/`, the composition (for the `<Player>` preview) | `services/`, `server/`, `scripts/` |

\* `services/workflows/render-worker.mts` is the exception. It is a process
entry point, like a CLI script, and it's where the API's renders get their
engine.

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
3. Pick the engine at an entry point: pass `engine: yourEngine` to
   `renderTrackVideo` from a CLI script, or from the render worker for API
   renders. Nothing in `services/` changes.
4. `tests/render-engine-port.test.mts` shows how to drive `renderTrackVideo`
   with a stand-in engine. `npm run lint` already covers `adapters/`.

Every engine writes to the same `out/<slug>/<preset>.mp4`, and export freshness
does not record which engine produced a file: its visualizer fingerprint is
`VISUALIZER_VERSION` (`core/domain/video/exportFreshness.ts`) plus the brand
assets. Content-library records note the template (`COMPOSITION_ID`) and
`VISUALIZER_VERSION`. An adapter whose output looks different should therefore
bring its own visualizer version (and template id). Otherwise a Remotion export
and, say, an After Effects export of the same track are treated as
interchangeable.

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
