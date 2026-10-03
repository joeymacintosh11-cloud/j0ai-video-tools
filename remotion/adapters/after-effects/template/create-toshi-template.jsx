// Toshi After Effects template: bootstrap (template contract 3).
//
// Builds the minimal Toshi template described in the README ("Rendering with
// After Effects") and in adapters/after-effects/templateContract.mts:
//
//   composition "Toshi Visualizer"   1920x1080, 30fps, 10 minutes
//     Audio       toshi-audio.wav, time-remapped so a track of any length plays in full
//     Brand Logo  toshi-brand-logo.png, bottom right
//     Waveform    native Audio Waveform effect reading the Audio layer, lower right
//     Accent      thin gold rule under the track details
//     Key BPM     the track's key and BPM, joined with " · "
//     Artist      the track's artist
//     Title       the track's title
//     Cover       toshi-cover.png, fitted into a 640px square, left
//     Background  native Gradient Ramp: warm amber-charcoal glow to Toshi off-black
//
// Native effects only (Gradient Ramp, Audio Waveform): no plugins, nothing
// aerender cannot render. Every render reloads the staged images and audio,
// so those always follow the track being rendered.
//
// The text does not: After Effects 2026 gives expressions null for the staged
// JSON at render time, so this script reads toshi-render-data.json itself and
// writes the title, artist, key and BPM into the layers. The template is
// therefore built for the track that is staged when it runs, and must be
// rebuilt for each new track. It records which track in a marker
// ("toshi-text-..." in the composition and Title layer comments); the adapter
// refuses to render a template whose marker belongs to another track.
//
// How to use it, for each track:
//   1. Stage the track: npm run render-track -- <track> --engine after-effects
//      (the files land beside the data file, by default in your .aep's folder;
//      the render stops there if the template was built for another track).
//   2. In After Effects, start a NEW project, then File > Scripts > Run Script File...
//      and choose this file. Pick the folder holding toshi-render-data.json.
//   3. Save the project as the "project" in after-effects.local.json (in that same
//      folder), replacing the old one, and render again.
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

  // The same rules as templateText / templateTextMarker in templateContract.mts
  // (a test compares them).
  function templateText(track) {
    var parts = [];
    if (track.key) {
      parts.push(String(track.key));
    }
    if (track.bpm) {
      parts.push(String(track.bpm) + " BPM");
    }
    return {
      Title: track.title ? String(track.title) : "",
      Artist: track.artist ? String(track.artist) : "",
      "Key BPM": parts.join(" \u00b7 ")
    };
  }

  function templateTextMarker(text) {
    var source = text.Title + "\n" + text.Artist + "\n" + text["Key BPM"];
    var hash = 0x811c9dc5;
    for (var i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash = hash >>> 0;
    }
    var hex = hash.toString(16);
    while (hex.length < 8) {
      hex = "0" + hex;
    }
    return "toshi-text-" + hex;
  }

  // The staged data, as the adapter wrote it. ExtendScript may have no JSON
  // object; the file is the adapter's own output, so eval is the fallback.
  function readTrack(folder) {
    var file = stagedFile(folder, DATA);
    file.encoding = "UTF-8";
    if (!file.open("r")) {
      throw new Error("Could not open " + file.fsName + ".");
    }
    var source = file.read();
    file.close();
    var data;
    try {
      data = typeof JSON !== "undefined" && JSON.parse ? JSON.parse(source) : eval("(" + source + ")");
    } catch (parseError) {
      throw new Error(DATA + " is not valid JSON (" + parseError.message + "). Render once with --engine after-effects to stage it again.");
    }
    if (!data || typeof data !== "object" || !data.track || typeof data.track !== "object") {
      throw new Error(DATA + " has no track. Render once with --engine after-effects to stage it again.");
    }
    return data.track;
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

  function addText(comp, name, size, color, position, value) {
    var layer = comp.layers.addText(value);
    layer.name = name;
    var sourceText = layer.property("Source Text");
    var doc = sourceText.value;
    doc.text = value;
    doc.fontSize = size;
    doc.applyFill = true;
    doc.fillColor = color;
    doc.applyStroke = false;
    doc.justification = ParagraphJustification.LEFT_JUSTIFY;
    sourceText.setValue(doc);
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
    var text = templateText(readTrack(folder));
    var marker = templateTextMarker(text);
    var cover = importStaged(folder, "toshi-cover.png");
    var audio = importStaged(folder, "toshi-audio.wav");
    var logo = importStaged(folder, "toshi-brand-logo.png");

    var comp = app.project.items.addComp(COMP_NAME, WIDTH, HEIGHT, 1, DURATION, FPS);
    comp.comment = "toshi-template-contract: 3; " + marker;

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

    var title = addText(comp, "Title", 96, WARM_CREAM, [960, 470], text.Title);
    title.comment = marker;
    addText(comp, "Artist", 56, VINTAGE_GOLD, [960, 560], text.Artist);
    var keyBpm = addText(comp, "Key BPM", 40, WARM_CREAM, [960, 640], text["Key BPM"]);
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
        "Text for this track: " + text.Title + " / " + text.Artist + " / " + text["Key BPM"] + " (" + marker + ").\n" +
        "Rebuild the template whenever you render a different track.\n\n" +
        (warnings.length > 0 ? "Check by hand:\n- " + warnings.join("\n- ") + "\n\n" : "") +
        "Save the project in " + folder.fsName + ", set its path as \"project\" and \"" + COMP_NAME +
        "\" as \"composition\" in after-effects.local.json, then render again."
    );
  } catch (error) {
    app.endUndoGroup();
    alert("Toshi template was not created: " + error.toString());
  }
})();
