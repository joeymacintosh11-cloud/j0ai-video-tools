import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  AUDIO_WAVEFORM_EFFECT_NAMES,
  missingTemplateFiles,
  renderedMediaProblems,
  REQUIRED_TEMPLATE_FILES,
  TEMPLATE_DATA_FIELDS_READ,
  TEMPLATE_DATA_FILE_NAME,
  TEMPLATE_DATA_LOADER,
  TEMPLATE_EXPRESSIONS,
  TEMPLATE_LAYERS,
  templateTextExpression,
  templateWarnings,
} from "../adapters/after-effects/templateContract.mts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { renderPreset } from "../core/domain/video/renderPresets.ts";
import { buildTemplateData } from "../core/domain/video/templateData.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";

/**
 * The contract between the After Effects adapter and a template
 * (adapters/after-effects/templateContract.mts), and the bootstrap script
 * that builds the minimal template (template/create-toshi-template.jsx) — run
 * here against stand-ins for After Effects' scripting objects, since After
 * Effects itself is not available to tests.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = path.join(PROJECT_ROOT, "adapters", "after-effects", "template", "create-toshi-template.jsx");

/** ghetto-geek's real template data, exactly as the adapter builds it (assets aside). */
const ghettoGeek = buildTemplateData({
  props: buildTrackProps({
    slug: "ghetto-geek",
    metadata: parseTrackMetadata(
      JSON.parse(readFileSync(path.join(PROJECT_ROOT, "public", "tracks", "ghetto-geek", "metadata.json"), "utf8")),
      "ghetto-geek",
    ),
    analysisAvailable: true,
  }),
  preset: renderPreset("youtube-16x9"),
  durationInFrames: 5555,
  resolveAsset: (relative) => `/staged/${relative}`,
});

/**
 * Evaluates an expression the way After Effects does — its value is the last
 * statement's — with `footage()` returning what `item` describes.
 */
const evaluate = (
  expression: string,
  item: { sourceData?: () => unknown; sourceText?: () => string } | null,
  options: { legacyEngine?: boolean } = {},
): unknown =>
  vm.runInNewContext(expression, {
    footage: (name: string) => {
      assert.equal(name, TEMPLATE_DATA_FILE_NAME);
      if (item === null) throw new Error(`Couldn't find footage named ${name}`);
      return {
        get sourceData() {
          if (!item.sourceData) throw new Error("sourceData is not supported");
          return item.sourceData();
        },
        get sourceText() {
          if (!item.sourceText) throw new Error("sourceText is not supported");
          return item.sourceText();
        },
      };
    },
    // The legacy ExtendScript expression engine has no JSON object.
    ...(options.legacyEngine ? { JSON: undefined } : {}),
  });

const renderedText = (item: Parameters<typeof evaluate>[1], options?: { legacyEngine?: boolean }) =>
  Object.fromEntries(
    Object.entries(TEMPLATE_EXPRESSIONS).map(([layer, expression]) => [layer, evaluate(expression, item, options)]),
  );

const GHETTO_GEEK_TEXT = { Title: "Ghetto Geek", Artist: "Toshi", "Key BPM": "F Minor · 100 BPM" };

/* ------------------------------------------------------------------ *
 * Metadata: the data, the expressions, and what they render
 * ------------------------------------------------------------------ */

test("the template data has the shape the expressions read", () => {
  assert.deepEqual(ghettoGeek.track, {
    title: "Ghetto Geek",
    artist: "Toshi",
    key: "F Minor",
    bpm: 100,
    subtitle: "Boom bap soul, trap bounce and latin heat.",
  });
  for (const fieldPath of TEMPLATE_DATA_FIELDS_READ) {
    const value = fieldPath.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], ghettoGeek);
    assert.notEqual(value, undefined, fieldPath.join("."));
  }
});

test("the text expressions are exactly the loader plus a field read, with a visible error fallback", () => {
  assert.equal(
    TEMPLATE_EXPRESSIONS.Title,
    `${TEMPLATE_DATA_LOADER}\ntry {\n  var t = toshiTrack(); t.title ? String(t.title) : "";\n} catch (err) {\n  "[" + TOSHI_DATA + ": " + err.message + "]";\n}`,
  );
  assert.equal(TEMPLATE_EXPRESSIONS.Artist, templateTextExpression(`var t = toshiTrack(); t.artist ? String(t.artist) : "";`));
  assert.ok(TEMPLATE_EXPRESSIONS["Key BPM"].includes(`parts.join(" \\u00b7 ");`), "· written as an escape, safe in any file encoding");
  assert.match(TEMPLATE_DATA_LOADER, /^var TOSHI_DATA = "toshi-render-data\.json";/);
});

test("ghetto-geek renders as Ghetto Geek / Toshi / F Minor · 100 BPM however After Effects delivers the JSON", () => {
  const json = JSON.stringify(ghettoGeek);
  // As documented (an object), wrapped in an array, text only, and on the legacy engine.
  assert.deepEqual(renderedText({ sourceData: () => JSON.parse(json) }), GHETTO_GEEK_TEXT);
  assert.deepEqual(renderedText({ sourceData: () => [JSON.parse(json)] }), GHETTO_GEEK_TEXT);
  assert.deepEqual(renderedText({ sourceText: () => json }), GHETTO_GEEK_TEXT);
  assert.deepEqual(renderedText({ sourceData: () => undefined, sourceText: () => json }), GHETTO_GEEK_TEXT);
  assert.deepEqual(renderedText({ sourceText: () => json }, { legacyEngine: true }), GHETTO_GEEK_TEXT);
});

test("missing optional fields render as nothing, and unreadable data says why instead of showing placeholders", () => {
  const withTrack = (track: Record<string, unknown>) => ({ sourceData: () => ({ ...ghettoGeek, track }) });
  assert.deepEqual(renderedText(withTrack({ title: "Untitled Beat", bpm: 90 })), {
    Title: "Untitled Beat",
    Artist: "",
    "Key BPM": "90 BPM",
  });
  assert.equal(renderedText(withTrack({ key: "A Minor" }))["Key BPM"], "A Minor");

  for (const text of Object.values(renderedText(null))) {
    assert.match(String(text), /^\[toshi-render-data\.json: Couldn't find footage named toshi-render-data\.json\]$/);
  }
  assert.match(String(renderedText({ sourceText: () => "not json" }).Title), /^\[toshi-render-data\.json: /);
});

/* ------------------------------------------------------------------ *
 * Project checks
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

test("a missing composition name or waveform effect is a warning, never a refusal", () => {
  assert.deepEqual(templateWarnings(Buffer.from("RIFX Toshi Visualizer ADBE AudWave"), "Toshi Visualizer"), []);
  assert.deepEqual(templateWarnings(utf16("Toshi Visualizer Audio Waveform", true), "Toshi Visualizer"), []);
  assert.deepEqual(templateWarnings(Buffer.from("RIFX"), "Toshi Visualizer"), [
    `composition "Toshi Visualizer" was not found in the project file; aerender will stop if it really is missing.`,
    "the project has no Audio Waveform effect, so the video will have no waveform.",
  ]);
  assert.deepEqual([...AUDIO_WAVEFORM_EFFECT_NAMES], ["ADBE AudWave", "Audio Waveform"]);
});

test("a rendered file needs both video and audio", () => {
  assert.deepEqual(renderedMediaProblems(["video", "audio"]), []);
  assert.deepEqual(renderedMediaProblems(["video"]), ["no audio stream"]);
  assert.deepEqual(renderedMediaProblems(["audio"]), ["no video stream"]);
  assert.deepEqual(renderedMediaProblems([]), ["no video stream", "no audio stream"]);
});

/* ------------------------------------------------------------------ *
 * The bootstrap script, against stand-in After Effects objects
 * ------------------------------------------------------------------ */

type FakeProperty = { value: unknown; expression: string; setValue: (value: unknown) => void };

const makeProperty = (initial?: unknown): FakeProperty => {
  const property: FakeProperty = {
    value: initial,
    expression: "",
    setValue(value) {
      property.value = value;
    },
  };
  return property;
};

class FakeEffect {
  readonly name: string;
  readonly values = new Map<string, unknown>();
  constructor(name: string) {
    this.name = name;
  }
  property(name: string) {
    return { setValue: (value: unknown) => this.values.set(name, value) };
  }
}

class FakeLayer {
  inPoint = 0;
  outPoint: number | undefined;
  timeRemapEnabled = false;
  readonly properties = new Map<string, FakeProperty>();
  readonly effects: FakeEffect[] = [];
  name: string;
  readonly kind: string;
  readonly source: { name: string } | null;
  readonly color: number[] | null;
  readonly size: [number, number] | null;
  readonly stack: FakeLayer[];
  readonly availableEffects: ReadonlySet<string>;
  constructor(
    stack: FakeLayer[],
    availableEffects: ReadonlySet<string>,
    init: { name: string; kind: string; source?: { name: string }; color?: number[]; size?: [number, number] },
  ) {
    this.stack = stack;
    this.availableEffects = availableEffects;
    this.name = init.name;
    this.kind = init.kind;
    this.source = init.source ?? null;
    this.color = init.color ?? null;
    this.size = init.size ?? null;
  }
  /** 1 is the top layer, as in After Effects. */
  get index() {
    return this.stack.indexOf(this) + 1;
  }
  property(name: string) {
    if (name === "ADBE Effect Parade") {
      return {
        canAddProperty: (effect: string) => this.availableEffects.has(effect),
        addProperty: (effect: string) => {
          const added = new FakeEffect(effect);
          this.effects.push(added);
          return added;
        },
      };
    }
    if (!this.properties.has(name)) this.properties.set(name, makeProperty(name === "Source Text" ? { fontSize: 0 } : undefined));
    return this.properties.get(name)!;
  }
}

/** A layer's property, typed for the assertions below (the effect group aside). */
const propertyOf = (layer: FakeLayer, name: string): FakeProperty => layer.property(name) as FakeProperty;

const NATIVE_EFFECTS = new Set(["ADBE Ramp", "ADBE AudWave"]);

const runBootstrap = (
  options: { staged?: readonly string[]; existingComp?: string; folder?: string | null; effects?: ReadonlySet<string> } = {},
) => {
  const staged = new Set(options.staged ?? ["toshi-render-data.json", "toshi-cover.png", "toshi-audio.wav", "toshi-brand-logo.png"]);
  const effects = options.effects ?? NATIVE_EFFECTS;
  const alerts: string[] = [];
  const imports: string[] = [];
  const comps: FakeComp[] = [];

  class CompItem {}
  class FakeComp extends CompItem {
    comment = "";
    readonly stack: FakeLayer[] = [];
    readonly layers = {
      add: (item: { name: string }) => this.push({ name: item.name, kind: "footage", source: item }),
      addSolid: (color: number[], name: string, width: number, height: number) =>
        this.push({ name, kind: "solid", color, size: [width, height] }),
      addText: (text: string) => this.push({ name: text, kind: "text" }),
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
    push(init: ConstructorParameters<typeof FakeLayer>[2]) {
      const layer = new FakeLayer(this.stack, effects, init);
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
  const layer = (name: string) => comps[0]?.stack.find((candidate) => candidate.name === name);
  return { alerts, imports, comps, layer };
};

/** Values built inside the sandbox are another realm's arrays; compare plain copies. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const hex = (rgb: readonly number[]) =>
  `#${rgb.slice(0, 3).map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;

test("the bootstrap builds the composition, layers and staged footage the contract names", () => {
  const { alerts, imports, comps, layer } = runBootstrap();

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
  assert.match(comp.comment, /toshi-template-contract: 2/);

  // Top to bottom, as the Timeline shows it.
  assert.deepEqual(comp.stack.map((entry) => entry.name), [...TEMPLATE_LAYERS]);
  assert.deepEqual(
    comp.stack.filter((entry) => entry.source).map((entry) => [entry.name, entry.source?.name]),
    [
      ["Audio", "toshi-audio.wav"],
      ["Brand Logo", "toshi-brand-logo.png"],
      ["Cover", "toshi-cover.png"],
    ],
  );
  assert.match(propertyOf(layer("Cover")!, "Scale").expression, /640 \/ Math\.max\(thisLayer\.source\.width, thisLayer\.source\.height\)/);
  assert.deepEqual(alerts.length, 1);
  assert.match(alerts[0], /Toshi template created/);
  assert.doesNotMatch(alerts[0], /Check by hand/);
});

test("the bootstrap's text layers use exactly the contract's expressions, in the Toshi colours", () => {
  const { layer } = runBootstrap();
  for (const [name, expression] of Object.entries(TEMPLATE_EXPRESSIONS)) {
    assert.equal(propertyOf(layer(name)!, "Source Text").expression, expression, name);
  }
  const fill = (name: string) => hex((propertyOf(layer(name)!, "Source Text").value as { fillColor: number[] }).fillColor);
  assert.deepEqual([fill("Title"), fill("Artist"), fill("Key BPM")], ["#f4e8d0", "#b8860b", "#f4e8d0"]);
  // Nothing track-specific is baked in: the only text is the layer name.
  assert.equal(layer("Title")!.kind, "text");
});

test("the background is a native radial Gradient Ramp: warm amber-charcoal glow to Toshi off-black", () => {
  const { layer } = runBootstrap();
  const background = layer("Background")!;
  assert.deepEqual(plain([background.kind, hex(background.color!), background.size]), ["solid", "#0b0b0b", [1920, 1080]]);
  assert.equal(background.effects.length, 1);
  const [ramp] = background.effects;
  assert.equal(ramp.name, "ADBE Ramp");
  assert.equal(ramp.values.get("Ramp Shape"), 2, "radial");
  assert.equal(hex(ramp.values.get("Start Color") as number[]), "#2a1e10");
  assert.equal(hex(ramp.values.get("End Color") as number[]), "#0b0b0b");
  assert.deepEqual(plain(ramp.values.get("Start of Ramp")), [576, 486]);

  const accent = layer("Accent")!;
  assert.deepEqual(plain([accent.kind, hex(accent.color!), accent.size]), ["solid", "#b8860b", [160, 4]]);
});

test("the waveform is the native Audio Waveform effect, reading the Audio layer, lower right", () => {
  const { layer } = runBootstrap();
  const waveformLayer = layer("Waveform")!;
  assert.equal(waveformLayer.effects.length, 1);
  const [waveform] = waveformLayer.effects;
  assert.equal(waveform.name, "ADBE AudWave");
  assert.equal(waveform.values.get("Audio Layer"), layer("Audio")!.index, "points at the Audio layer by its final index");
  assert.deepEqual(plain([waveform.values.get("Start Point"), waveform.values.get("End Point")]), [[960, 860], [1780, 860]]);
  assert.equal(hex(waveform.values.get("Inside Color") as number[]), "#b8860b");
  assert.equal(hex(waveform.values.get("Outside Color") as number[]), "#f4e8d0");
  assert.ok((waveform.values.get("Maximum Height") as number) > 0);
});

test("the Audio layer plays a track of any length, to the end of the composition", () => {
  const { comps, layer } = runBootstrap();
  const audio = layer("Audio")!;
  assert.equal(audio.timeRemapEnabled, true);
  assert.equal(propertyOf(audio!, "Time Remap").expression, "time - thisLayer.inPoint");
  assert.equal(audio.outPoint, comps[0].duration);
});

test("an effect this After Effects cannot add is reported at the end, and the rest of the template is still built", () => {
  const { alerts, comps, layer } = runBootstrap({ effects: new Set(["Gradient Ramp"]) });
  assert.deepEqual(comps[0].stack.map((entry) => entry.name), [...TEMPLATE_LAYERS]);
  assert.equal(layer("Background")!.effects[0].name, "Gradient Ramp", "falls back to the display name");
  assert.match(alerts[0], /Toshi template created/);
  assert.match(alerts[0], /Check by hand:\n- Could not add the Audio Waveform effect to Waveform\./);
});

test("the bootstrap refuses to clobber an existing template or run without the staged files", () => {
  const existing = runBootstrap({ existingComp: "Toshi Visualizer" });
  assert.deepEqual(existing.comps, []);
  assert.match(existing.alerts[0], /already has a composition named "Toshi Visualizer"/);

  const unstaged = runBootstrap({ staged: ["toshi-render-data.json"] });
  assert.match(unstaged.alerts[0], /toshi-cover\.png is not in \/Users\/me\/Toshi\. Render once with --engine after-effects/);

  const cancelled = runBootstrap({ folder: null });
  assert.deepEqual([cancelled.comps, cancelled.alerts], [[], []]);
});
