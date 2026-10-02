import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  missingTemplateFiles,
  renderedMediaProblems,
  REQUIRED_TEMPLATE_FILES,
  TEMPLATE_DATA_FIELDS_READ,
  TEMPLATE_DATA_FILE_NAME,
  TEMPLATE_EXPRESSIONS,
} from "../adapters/after-effects/templateContract.mts";
import { renderPreset } from "../core/domain/video/renderPresets.ts";
import { buildTemplateData } from "../core/domain/video/templateData.ts";

/**
 * The contract between the After Effects adapter and a template
 * (adapters/after-effects/templateContract.mts), and the bootstrap script
 * that builds a minimal template (template/create-toshi-template.jsx) — run
 * here against stand-ins for After Effects' scripting objects, since After
 * Effects itself is not available to tests.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = path.join(PROJECT_ROOT, "adapters", "after-effects", "template", "create-toshi-template.jsx");

const data = buildTemplateData({
  props: {
    title: "Ghetto Geek",
    artist: "Toshi",
    musicalKey: "F Minor",
    bpm: 100,
    coverSrc: "tracks/ghetto-geek/cover.png",
    audioSrc: "tracks/ghetto-geek/beat.wav",
    brandLogoSrc: "brand/toshi/toshi-logo-light.png",
    brandBadgeSrc: "brand/toshi/toshi-icon-mark.png",
  },
  preset: renderPreset("youtube-16x9"),
  durationInFrames: 5555,
  resolveAsset: (relative) => `/staged/${relative}`,
});

/** Evaluates an After Effects expression's text, the way its last statement yields the value. */
const evaluate = (expression: string): unknown =>
  vm.runInNewContext(expression, {
    footage: (name: string) => {
      assert.equal(name, TEMPLATE_DATA_FILE_NAME);
      return { sourceData: data };
    },
  });

/* ------------------------------------------------------------------ *
 * Does a project use the staged files?
 * ------------------------------------------------------------------ */

const utf16 = (text: string, littleEndian: boolean) =>
  Buffer.from(
    Buffer.from(text, "utf16le").map((_byte, index, bytes) =>
      littleEndian ? bytes[index] : bytes[index % 2 === 0 ? index + 1 : index - 1],
    ),
  );

test("a project that never mentions the staged files is caught; one that does passes, however it encodes paths", () => {
  const paths = REQUIRED_TEMPLATE_FILES.map((name) => `/Users/me/Toshi/${name}`).join("\n");

  assert.deepEqual(missingTemplateFiles(new Uint8Array()), [...REQUIRED_TEMPLATE_FILES]);
  assert.deepEqual(missingTemplateFiles(Buffer.from("RIFX....Toshi Visualizer....")), [...REQUIRED_TEMPLATE_FILES]);
  assert.deepEqual(missingTemplateFiles(Buffer.from(`{"fullpath":"${paths}"}`)), []);
  assert.deepEqual(missingTemplateFiles(utf16(paths, true)), []);
  assert.deepEqual(missingTemplateFiles(utf16(paths, false)), []);
  assert.deepEqual(
    missingTemplateFiles(Buffer.from("/Users/me/Toshi/toshi-cover.png /Users/me/Toshi/toshi-render-data.json")),
    ["toshi-audio.wav"],
  );
});

test("a rendered file needs both video and audio", () => {
  assert.deepEqual(renderedMediaProblems(["video", "audio"]), []);
  assert.deepEqual(renderedMediaProblems(["video"]), ["no audio stream"]);
  assert.deepEqual(renderedMediaProblems(["audio"]), ["no video stream"]);
  assert.deepEqual(renderedMediaProblems([]), ["no video stream", "no audio stream"]);
});

test("every field the template's expressions read exists in the template data, and they render the track", () => {
  for (const fieldPath of TEMPLATE_DATA_FIELDS_READ) {
    const value = fieldPath.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], data);
    assert.notEqual(value, undefined, fieldPath.join("."));
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(TEMPLATE_EXPRESSIONS).map(([layer, expression]) => [layer, evaluate(expression)])),
    { Title: "Ghetto Geek", Artist: "Toshi", "Key BPM": "F Minor  ·  100 BPM" },
  );
});

/* ------------------------------------------------------------------ *
 * The bootstrap script, against stand-in After Effects objects
 * ------------------------------------------------------------------ */

type FakeProperty = { value: unknown; expression: string; setValue: (value: unknown) => void };

class FakeLayer {
  inPoint = 0;
  outPoint: number | undefined;
  timeRemapEnabled = false;
  readonly properties = new Map<string, FakeProperty>();
  name: string;
  readonly kind: string;
  readonly source: { name: string } | null;
  constructor(name: string, kind: string, source: { name: string } | null) {
    this.name = name;
    this.kind = kind;
    this.source = source;
  }
  property(name: string): FakeProperty {
    if (!this.properties.has(name)) {
      const property: FakeProperty = {
        value: name === "Source Text" ? { fontSize: 0 } : undefined,
        expression: "",
        setValue(value) {
          property.value = value;
        },
      };
      this.properties.set(name, property);
    }
    return this.properties.get(name)!;
  }
}

const runBootstrap = (options: { staged?: readonly string[]; existingComp?: string; folder?: string | null } = {}) => {
  const staged = new Set(options.staged ?? ["toshi-render-data.json", "toshi-cover.png", "toshi-audio.wav", "toshi-brand-logo.png"]);
  const alerts: string[] = [];
  const imports: string[] = [];
  const comps: FakeComp[] = [];

  class CompItem {}
  class FakeComp extends CompItem {
    comment = "";
    readonly stack: FakeLayer[] = [];
    readonly layers = {
      add: (item: { name: string }) => this.push(new FakeLayer(item.name, "footage", item)),
      addSolid: (_color: number[], name: string) => this.push(new FakeLayer(name, "solid", null)),
      addText: (text: string) => this.push(new FakeLayer(text, "text", null)),
    };
    name: string;
    readonly width: number;
    readonly height: number;
    readonly pixelAspect: number;
    readonly duration: number;
    readonly frameRate: number;
    constructor(name: string, width: number, height: number, pixelAspect: number, duration: number, frameRate: number) {
      super();
      this.name = name;
      this.width = width;
      this.height = height;
      this.pixelAspect = pixelAspect;
      this.duration = duration;
      this.frameRate = frameRate;
    }
    push(layer: FakeLayer) {
      this.stack.unshift(layer); // After Effects adds new layers on top.
      return layer;
    }
    openInViewer() {}
  }

  const projectItems: unknown[] = options.existingComp ? [new FakeComp(options.existingComp, 1, 1, 1, 1, 1)] : [];
  const context = {
    CompItem,
    ParagraphJustification: { LEFT_JUSTIFY: "left" },
    ImportOptions: class {
      readonly file: { fsName: string };
      constructor(file: { fsName: string }) {
        this.file = file;
      }
    },
    File: class {
      readonly fsName: string;
      readonly exists: boolean;
      constructor(fsName: string) {
        this.fsName = fsName;
        this.exists = staged.has(path.basename(fsName));
      }
    },
    Folder: { selectDialog: () => (options.folder === null ? null : { fsName: options.folder ?? "/Users/me/Toshi" }) },
    alert: (message: string) => alerts.push(message),
    app: {
      project: {
        get numItems() {
          return projectItems.length;
        },
        item: (index: number) => projectItems[index - 1],
        importFile: (importOptions: { file: { fsName: string } }) => {
          imports.push(importOptions.file.fsName);
          return { name: path.basename(importOptions.file.fsName) };
        },
        items: {
          addComp: (...args: ConstructorParameters<typeof FakeComp>) => {
            const comp = new FakeComp(...args);
            comps.push(comp);
            return comp;
          },
        },
      },
      newProject: () => {},
      beginUndoGroup: () => {},
      endUndoGroup: () => {},
    },
  };

  vm.runInNewContext(readFileSync(BOOTSTRAP, "utf8"), context);
  return { alerts, imports, comps };
};

test("the bootstrap script builds the template the adapter's contract describes", () => {
  const { alerts, imports, comps } = runBootstrap();

  assert.deepEqual(imports, [
    "/Users/me/Toshi/toshi-render-data.json",
    "/Users/me/Toshi/toshi-cover.png",
    "/Users/me/Toshi/toshi-audio.wav",
    "/Users/me/Toshi/toshi-brand-logo.png",
  ]);
  assert.equal(comps.length, 1);
  const [comp] = comps;
  assert.deepEqual(
    [comp.name, comp.width, comp.height, comp.pixelAspect, comp.frameRate],
    ["Toshi Visualizer", 1920, 1080, 1, 30],
  );
  assert.ok(comp.duration >= 600, "long enough for any track");
  assert.match(comp.comment, /toshi-template-contract: 1/);

  // Top to bottom, as the Timeline shows it.
  assert.deepEqual(
    comp.stack.map((layer) => [layer.name, layer.kind, layer.source?.name ?? null]),
    [
      ["Audio", "footage", "toshi-audio.wav"],
      ["Brand Logo", "footage", "toshi-brand-logo.png"],
      ["Key BPM", "text", null],
      ["Artist", "text", null],
      ["Title", "text", null],
      ["Cover", "footage", "toshi-cover.png"],
      ["Background", "solid", null],
    ],
  );

  // Text layers use exactly the contract's expressions.
  const byName = new Map(comp.stack.map((layer) => [layer.name, layer]));
  for (const [layer, expression] of Object.entries(TEMPLATE_EXPRESSIONS)) {
    assert.equal(byName.get(layer)?.property("Source Text").expression, expression, layer);
  }

  // Audio plays a track of any length, to the end of the composition.
  const audio = byName.get("Audio")!;
  assert.equal(audio.timeRemapEnabled, true);
  assert.equal(audio.property("Time Remap").expression, "time - thisLayer.inPoint");
  assert.equal(audio.outPoint, comp.duration);

  // The cover fits its box whatever the image's size.
  assert.match(byName.get("Cover")!.property("Scale").expression, /640 \/ Math\.max\(thisLayer\.source\.width, thisLayer\.source\.height\)/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Toshi template created/);
});

test("the bootstrap script refuses to clobber an existing template or run without the staged files", () => {
  const existing = runBootstrap({ existingComp: "Toshi Visualizer" });
  assert.deepEqual(existing.comps, []);
  assert.match(existing.alerts[0], /already has a composition named "Toshi Visualizer"/);

  const unstaged = runBootstrap({ staged: ["toshi-render-data.json"] });
  assert.match(unstaged.alerts[0], /toshi-cover\.png is not in \/Users\/me\/Toshi\. Render once with --engine after-effects/);

  const cancelled = runBootstrap({ folder: null });
  assert.deepEqual([cancelled.comps, cancelled.alerts], [[], []]);
});
