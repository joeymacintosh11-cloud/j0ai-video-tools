// Toshi After Effects template: one-time bootstrap (template contract 2).
//
// Builds the minimal Toshi template described in the README ("Rendering with
// After Effects") and in adapters/after-effects/templateContract.mts:
//
//   composition "Toshi Visualizer"   1920x1080, 30fps, 10 minutes
//     Audio       toshi-audio.wav, time-remapped so a track of any length plays in full
//     Brand Logo  toshi-brand-logo.png, bottom right
//     Waveform    native Audio Waveform effect reading the Audio layer, lower right
//     Accent      thin gold rule under the track details
//     Key BPM     text from toshi-render-data.json ("F Minor · 100 BPM")
//     Artist      text from toshi-render-data.json
//     Title       text from toshi-render-data.json
//     Cover       toshi-cover.png, fitted into a 640px square, left
//     Background  native Gradient Ramp: warm amber-charcoal glow to Toshi off-black
//
// Native effects only (Gradient Ramp, Audio Waveform): no plugins, nothing
// aerender cannot render, and nothing per track. Every render reloads the
// staged files, so the same template serves every track.
//
// How to use it:
//   1. Stage the files once: npm run render-track -- <track> --engine after-effects
//      (the files land beside the data file, by default in your .aep's folder).
//   2. In After Effects, start a NEW project, then File > Scripts > Run Script File...
//      and choose this file. Pick the folder holding toshi-render-data.json.
//   3. Save the project as the "project" in after-effects.local.json (in that same
//      folder) and render again.
//
// ExtendScript (ES3): var only, no arrow functions, no let/const.

(function createToshiTemplate() {
  var COMP_NAME = "Toshi Visualizer";
  var WIDTH = 1920;
  var HEIGHT = 1080;
  var FPS = 30;
  var DURATION = 600; // seconds; must be at least the longest track
  var DATA = "toshi-render-data.json";

  // The Toshi palette (adapters/remotion/BeatVisualizer/theme.ts), as 0..1 RGB.
  var OFF_BLACK = [0.043, 0.043, 0.043]; // #0b0b0b
  var WARM_CHARCOAL = [0.165, 0.118, 0.063]; // amber-tinted charcoal for the glow
  var VINTAGE_GOLD = [0.722, 0.525, 0.043]; // #b8860b
  var WARM_CREAM = [0.957, 0.91, 0.816]; // #f4e8d0

  // Must stay identical to TEMPLATE_DATA_LOADER / templateTextExpression in
  // templateContract.mts (a test compares them).
  var LOADER = [
    'var TOSHI_DATA = "' + DATA + '";',
    "function toshiTrack() {",
    "  var data = null;",
    "  try { data = footage(TOSHI_DATA).sourceData; } catch (err) { data = null; }",
    "  if (data && !data.track && data.length > 0) { data = data[0]; }",
    "  if (!data || !data.track) {",
    "    var text = footage(TOSHI_DATA).sourceText;",
    '    data = typeof JSON !== "undefined" ? JSON.parse(text) : eval("(" + text + ")");',
    "  }",
    "  return data.track;",
    "}"
  ].join("\n");

  function textExpression(body) {
    return LOADER + "\ntry {\n  " + body + '\n} catch (err) {\n  "[" + TOSHI_DATA + ": " + err.message + "]";\n}';
  }

  var warnings = [];

  function rgba(color) {
    return [color[0], color[1], color[2], 1];
  }

  function stagedFile(folder, name) {
    var file = new File(folder.fsName + "/" + name);
    if (!file.exists) {
      throw new Error(
        name + " is not in " + folder.fsName + ". Render once with --engine after-effects to stage it, then run this script again."
      );
    }
    return file;
  }

  function importStaged(folder, name) {
    return app.project.importFile(new ImportOptions(stagedFile(folder, name)));
  }

  // Effects are added by match name or display name, whichever this After
  // Effects knows; a failure is reported at the end instead of aborting.
  function addEffect(layer, names) {
    var parade = layer.property("ADBE Effect Parade");
    for (var i = 0; i < names.length; i++) {
      try {
        if (parade.canAddProperty(names[i])) {
          return parade.addProperty(names[i]);
        }
      } catch (ignored) {}
    }
    warnings.push("Could not add the " + names[names.length - 1] + " effect to " + layer.name + ".");
    return null;
  }

  function setEffect(effect, names, value) {
    if (effect === null) {
      return;
    }
    for (var i = 0; i < names.length; i++) {
      try {
        var property = effect.property(names[i]);
        if (property !== null) {
          property.setValue(value);
          return;
        }
      } catch (ignored) {}
    }
    warnings.push("Could not set " + names[0] + " on " + effect.name + ".");
  }

  function addText(comp, name, size, color, position, expression) {
    var layer = comp.layers.addText(name);
    layer.name = name;
    var sourceText = layer.property("Source Text");
    var doc = sourceText.value;
    doc.fontSize = size;
    doc.applyFill = true;
    doc.fillColor = color;
    doc.applyStroke = false;
    doc.justification = ParagraphJustification.LEFT_JUSTIFY;
    sourceText.setValue(doc);
    sourceText.expression = expression;
    layer.property("Position").setValue(position);
    return layer;
  }

  function fitInto(layer, box) {
    layer.property("Scale").expression =
      "var s = " + box + " / Math.max(thisLayer.source.width, thisLayer.source.height) * 100; [s, s]";
  }

  if (!app.project) {
    app.newProject();
  }

  for (var index = 1; index <= app.project.numItems; index++) {
    var existing = app.project.item(index);
    if (existing instanceof CompItem && existing.name === COMP_NAME) {
      alert('This project already has a composition named "' + COMP_NAME + '". Run this script in a new, empty project.');
      return;
    }
  }

  var folder = Folder.selectDialog("Choose the folder that holds " + DATA + " and the staged toshi-* files");
  if (folder === null) {
    return;
  }

  app.beginUndoGroup("Create Toshi template");
  try {
    var data = importStaged(folder, DATA);
    var cover = importStaged(folder, "toshi-cover.png");
    var audio = importStaged(folder, "toshi-audio.wav");
    var logo = importStaged(folder, "toshi-brand-logo.png");

    var comp = app.project.items.addComp(COMP_NAME, WIDTH, HEIGHT, 1, DURATION, FPS);
    comp.comment = "toshi-template-contract: 2; data: " + data.name;

    // Bottom to top: each add() goes on top of the previous one.

    // A warm amber-charcoal glow behind the cover, fading to Toshi off-black.
    var background = comp.layers.addSolid(OFF_BLACK, "Background", WIDTH, HEIGHT, 1, DURATION);
    var ramp = addEffect(background, ["ADBE Ramp", "Gradient Ramp", "Ramp"]);
    setEffect(ramp, ["Start of Ramp", "ADBE Ramp-0001"], [WIDTH * 0.3, HEIGHT * 0.45]);
    setEffect(ramp, ["Start Color", "ADBE Ramp-0002"], rgba(WARM_CHARCOAL));
    setEffect(ramp, ["End of Ramp", "ADBE Ramp-0003"], [WIDTH * 1.05, HEIGHT * 1.15]);
    setEffect(ramp, ["End Color", "ADBE Ramp-0004"], rgba(OFF_BLACK));
    setEffect(ramp, ["Ramp Shape", "ADBE Ramp-0005"], 2); // 2 = Radial

    var coverLayer = comp.layers.add(cover);
    coverLayer.name = "Cover";
    coverLayer.property("Position").setValue([520, HEIGHT / 2]);
    fitInto(coverLayer, 640);
    coverLayer.outPoint = DURATION;

    addText(comp, "Title", 96, WARM_CREAM, [960, 470], textExpression('var t = toshiTrack(); t.title ? String(t.title) : "";'));
    addText(comp, "Artist", 56, VINTAGE_GOLD, [960, 560], textExpression('var t = toshiTrack(); t.artist ? String(t.artist) : "";'));
    var keyBpm = addText(
      comp,
      "Key BPM",
      40,
      WARM_CREAM,
      [960, 640],
      textExpression(
        'var t = toshiTrack(); var parts = []; if (t.key) { parts.push(String(t.key)); } if (t.bpm) { parts.push(t.bpm + " BPM"); } parts.join(" \\u00b7 ");'
      )
    );
    keyBpm.property("Opacity").setValue(80);

    var accent = comp.layers.addSolid(VINTAGE_GOLD, "Accent", 160, 4, 1, DURATION);
    accent.property("Position").setValue([1040, 690]);

    // The waveform is drawn by the native Audio Waveform effect from the Audio
    // layer's sound at render time, so it follows whatever track is staged.
    var waveformLayer = comp.layers.addSolid(OFF_BLACK, "Waveform", WIDTH, HEIGHT, 1, DURATION);
    var waveform = addEffect(waveformLayer, ["ADBE AudWave", "Audio Waveform"]);
    setEffect(waveform, ["Start Point"], [960, 860]);
    setEffect(waveform, ["End Point"], [1780, 860]);
    setEffect(waveform, ["Displayed Samples"], 220);
    setEffect(waveform, ["Maximum Height"], 140);
    setEffect(waveform, ["Audio Duration (milliseconds)"], 400);
    setEffect(waveform, ["Thickness"], 3);
    setEffect(waveform, ["Softness"], 15);
    setEffect(waveform, ["Inside Color"], rgba(VINTAGE_GOLD));
    setEffect(waveform, ["Outside Color"], rgba(WARM_CREAM));

    var logoLayer = comp.layers.add(logo);
    logoLayer.name = "Brand Logo";
    logoLayer.property("Position").setValue([WIDTH - 200, HEIGHT - 90]);
    fitInto(logoLayer, 240);
    logoLayer.outPoint = DURATION;

    // A footage layer keeps the length its file had when it was added, so a
    // longer track would be cut off. Time remapping with a "time" expression
    // lets the layer run to the end of the composition and plays whatever
    // length toshi-audio.wav has at render time; past its end there is silence.
    var audioLayer = comp.layers.add(audio);
    audioLayer.name = "Audio";
    audioLayer.timeRemapEnabled = true;
    audioLayer.property("Time Remap").expression = "time - thisLayer.inPoint";
    audioLayer.outPoint = DURATION;

    // Pointed at the Audio layer last, once every layer index is final.
    setEffect(waveform, ["Audio Layer"], audioLayer.index);

    app.endUndoGroup();
    comp.openInViewer();
    alert(
      'Toshi template created: composition "' + COMP_NAME + '".\n\n' +
        (warnings.length > 0 ? "Check by hand:\n- " + warnings.join("\n- ") + "\n\n" : "") +
        "Save the project in " + folder.fsName + ", set its path as \"project\" and \"" + COMP_NAME +
        "\" as \"composition\" in after-effects.local.json, then render again."
    );
  } catch (error) {
    app.endUndoGroup();
    alert("Toshi template was not created: " + error.toString());
  }
})();
