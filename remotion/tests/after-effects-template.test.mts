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
  TEMPLATE_LAYERS,
  TEMPLATE_TEXT_LAYERS,
  TEMPLATE_TEXT_MARKER_PREFIX,
  templateText,
  templateTextMarker,
  templateTextStatus,
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

const GHETTO_GEEK_TEXT = { Title: "Ghetto Geek", Artist: "Toshi", "Key BPM": "F Minor · 100 BPM" };

/** A reference 32-bit FNV-1a, written independently of the contract's. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/* ------------------------------------------------------------------ *
 * Metadata: the track text the template is built with
 * ------------------------------------------------------------------ */

test("ghetto-geek's staged data gives Ghetto Geek / Toshi / F Minor · 100 BPM", () => {
  assert.deepEqual(ghettoGeek.track, {
    title: "Ghetto Geek",
    artist: "Toshi",
    key: "F Minor",
    bpm: 100,
    subtitle: "Boom bap soul, trap bounce and latin heat.",
  });
  assert.deepEqual(templateText(ghettoGeek.track), GHETTO_GEEK_TEXT);
  assert.deepEqual(Object.keys(templateText(ghettoGeek.track)).sort(), [...TEMPLATE_TEXT_LAYERS].sort());
});

test("missing optional metadata shows as nothing, never as undefined or a placeholder", () => {
  assert.deepEqual(templateText({ title: "Untitled Beat", bpm: 90 }), { Title: "Untitled Beat", Artist: "", "Key BPM": "90 BPM" });
  assert.deepEqual(templateText({ key: "A Minor" }), { Title: "", Artist: "", "Key BPM": "A Minor" });
  assert.deepEqual(templateText({}), { Title: "", Artist: "", "Key BPM": "" });
  assert.deepEqual(templateText({ title: null, artist: "", key: undefined, bpm: 0 }), { Title: "", Artist: "", "Key BPM": "" });
});

test("the text marker is a stable FNV-1a of the three lines, different for different text", () => {
  const marker = templateTextMarker(GHETTO_GEEK_TEXT);
  assert.equal(marker, `${TEMPLATE_TEXT_MARKER_PREFIX}${fnv1a("Ghetto Geek\nToshi\nF Minor · 100 BPM")}`);
  assert.match(marker, /^toshi-text-[0-9a-f]{8}$/);
  assert.equal(templateTextMarker({ ...GHETTO_GEEK_TEXT }), marker);
  assert.notEqual(templateTextMarker({ ...GHETTO_GEEK_TEXT, Title: "Ghetto Geek 2" }), marker);
  assert.equal(templateTextMarker({ Title: "", Artist: "", "Key BPM": "" }), `toshi-text-${fnv1a("\n\n")}`);
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

test("a project's text marker says whether it was built for this track", () => {
  const marker = templateTextMarker(GHETTO_GEEK_TEXT);
  const other = templateTextMarker({ ...GHETTO_GEEK_TEXT, Title: "Another Beat" });
  assert.equal(templateTextStatus(Buffer.from(`RIFX....toshi-template-contract: 3; ${marker}....`), marker), "current");
  assert.equal(templateTextStatus(utf16(`comment ${marker}`, true), marker), "current");
  assert.equal(templateTextStatus(Buffer.from(`RIFX....${other}....`), marker), "stale");
  assert.equal(templateTextStatus(utf16(`comment ${other}`, false), marker), "stale");
  assert.equal(templateTextStatus(Buffer.from("RIFX....toshi-cover.png....toshi-audio.wav"), marker), "unmarked");
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
  comment = "";
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
  options: {
    staged?: readonly string[];
    existingComp?: string;
    folder?: string | null;
    effects?: ReadonlySet<string>;
    /** toshi-render-data.json's contents; ghetto-geek's by default. */
    data?: string;
    /** ExtendScript without a JSON object, as in older After Effects. */
    noJson?: boolean;
  } = {},
) => {
  const data = options.data ?? JSON.stringify(ghettoGeek, null, 2);
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
      encoding = "BINARY";
      opened = false;
      constructor(fsName: string) {
        this.fsName = fsName;
        this.exists = staged.has(path.basename(fsName));
      }
      open(mode: string) {
        assert.equal(mode, "r");
        this.opened = this.exists;
        return this.opened;
      }
      read() {
        assert.ok(this.opened, "read before open");
        assert.equal(this.encoding, "UTF-8");
        assert.equal(path.basename(this.fsName), "toshi-render-data.json");
        return data;
      }
      close() {
        this.opened = false;
      }
    },
    Folder: { selectDialog: () => (options.folder === null ? null : { fsName: options.folder ?? "/Users/me/Toshi" }) },
    alert: (message: string) => alerts.push(message),
    ...(options.noJson ? { JSON: undefined } : {}),
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
  assert.equal(comp.comment, `toshi-template-contract: 3; ${templateTextMarker(GHETTO_GEEK_TEXT)}`);

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
  assert.match(alerts[0], /Text for this track: Ghetto Geek \/ Toshi \/ F Minor · 100 BPM \(toshi-text-[0-9a-f]{8}\)\.\nRebuild the template whenever you render a different track\./);
  assert.doesNotMatch(alerts[0], /Check by hand/);
});

/** What the bootstrap wrote into each text layer: the Source Text value, and any expression. */
const writtenText = (layer: (name: string) => FakeLayer | undefined) =>
  Object.fromEntries(
    TEMPLATE_TEXT_LAYERS.map((name) => {
      const sourceText = propertyOf(layer(name)!, "Source Text");
      assert.equal(sourceText.expression, "", `${name} has no expression`);
      return [name, (sourceText.value as { text: string }).text];
    }),
  );

test("the bootstrap reads the staged JSON and writes the track's text into the text layers, in the Toshi colours", () => {
  const { layer } = runBootstrap();
  assert.deepEqual(writtenText(layer), GHETTO_GEEK_TEXT);
  const fill = (name: string) => hex((propertyOf(layer(name)!, "Source Text").value as { fillColor: number[] }).fillColor);
  assert.deepEqual([fill("Title"), fill("Artist"), fill("Key BPM")], ["#f4e8d0", "#b8860b", "#f4e8d0"]);
  assert.deepEqual(
    TEMPLATE_TEXT_LAYERS.map((name) => (propertyOf(layer(name)!, "Source Text").value as { fontSize: number }).fontSize),
    [40, 56, 96],
  );
  assert.equal(layer("Title")!.comment, templateTextMarker(GHETTO_GEEK_TEXT), "the marker the adapter checks");

  // ExtendScript without JSON parses the same file the same way.
  const legacy = runBootstrap({ noJson: true });
  assert.deepEqual(writtenText(legacy.layer), GHETTO_GEEK_TEXT);
});

test("the bootstrap's text and marker follow the same rules as the contract, for any track", () => {
  const tracks: Record<string, unknown>[] = [
    { title: "Untitled Beat", bpm: 90 },
    { key: "A Minor" },
    {},
    { title: "Café Ñoño — 東京 🎧", artist: "Ünïcode \"Quoted\"", key: "C# Major", bpm: "128" },
    { title: "Line\nBreak", artist: "Toshi", key: "F Minor", bpm: 100.5, extra: { nested: [1, 2] } },
  ];
  for (const track of tracks) {
    const { comps, layer, alerts } = runBootstrap({ data: JSON.stringify({ ...ghettoGeek, track }) });
    assert.match(alerts[0], /Toshi template created/, JSON.stringify(track));
    const expected = templateText(track);
    assert.deepEqual(writtenText(layer), expected, JSON.stringify(track));
    assert.equal(comps[0].comment, `toshi-template-contract: 3; ${templateTextMarker(expected)}`);
    assert.equal(layer("Title")!.comment, templateTextMarker(expected));
  }
});

test("no track's metadata is hard-coded in the template builder or the contract", () => {
  for (const file of [BOOTSTRAP, path.join(PROJECT_ROOT, "adapters", "after-effects", "templateContract.mts")]) {
    const source = readFileSync(file, "utf8");
    for (const value of ["Ghetto Geek", "ghetto-geek", "F Minor", "100 BPM"]) {
      assert.ok(!source.includes(value), `${path.basename(file)} mentions ${value}`);
    }
  }
  // Another track's data builds another track's text.
  const { layer } = runBootstrap({ data: JSON.stringify({ ...ghettoGeek, track: { title: "Night Drive", artist: "Someone Else", key: "D Major", bpm: 84 } }) });
  assert.deepEqual(writtenText(layer), { Title: "Night Drive", Artist: "Someone Else", "Key BPM": "D Major · 84 BPM" });
});

test("staged data the builder cannot use stops it with a clear reason, before anything is built", () => {
  const invalid = runBootstrap({ data: "{ not json" });
  assert.deepEqual(invalid.comps, []);
  assert.match(invalid.alerts[0], /^Toshi template was not created: .*toshi-render-data\.json is not valid JSON \(.+\)\. Render once with --engine after-effects/);

  for (const data of [JSON.stringify({ schemaVersion: 1 }), "null", JSON.stringify({ track: "Ghetto" })]) {
    const trackless = runBootstrap({ data });
    assert.deepEqual(trackless.comps, [], data);
    assert.match(trackless.alerts[0], /toshi-render-data\.json has no track\. Render once with --engine after-effects/, data);
  }

  const unstaged = runBootstrap({ staged: ["toshi-cover.png", "toshi-audio.wav", "toshi-brand-logo.png"] });
  assert.deepEqual(unstaged.comps, []);
  assert.match(unstaged.alerts[0], /toshi-render-data\.json is not in \/Users\/me\/Toshi\. Render once with --engine after-effects/);
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
