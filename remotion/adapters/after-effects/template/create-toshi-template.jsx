// Toshi After Effects template: one-time bootstrap (template contract 1).
//
// Builds the minimal Toshi template described in the README ("Rendering with
// After Effects") and in adapters/after-effects/templateContract.mts:
//
//   composition "Toshi Visualizer"   1920x1080, 30fps, 10 minutes
//     Audio      toshi-audio.wav, time-remapped so a track of any length plays in full
//     Brand Logo toshi-brand-logo.png, bottom right
//     Key BPM    text from toshi-render-data.json
//     Artist     text from toshi-render-data.json
//     Title      text from toshi-render-data.json
//     Cover      toshi-cover.png, fitted into a 640px square, left
//     Background dark solid
//
// How to use it:
//   1. Stage the files once: npm run render-track -- <track> --engine after-effects
//      (it stops with "does not use ..." — that is expected; the files are now staged
//      beside the data file, by default in your .aep's folder).
//   2. In After Effects, start a NEW project, then File > Scripts > Run Script File...
//      and choose this file. Pick the folder holding toshi-render-data.json.
//   3. Save the project as the "project" in after-effects.local.json (save it in that
//      same folder) and render again.
//
// ExtendScript (ES3): var only, no arrow functions, no let/const.

(function createToshiTemplate() {
  var COMP_NAME = "Toshi Visualizer";
  var WIDTH = 1920;
  var HEIGHT = 1080;
  var FPS = 30;
  var DURATION = 600; // seconds; must be at least the longest track
  var DATA = "toshi-render-data.json";

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

  function addText(comp, name, size, position, expression) {
    var layer = comp.layers.addText(name);
    layer.name = name;
    var sourceText = layer.property("Source Text");
    var doc = sourceText.value;
    doc.fontSize = size;
    doc.applyFill = true;
    doc.fillColor = [1, 1, 1];
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
    comp.comment = "toshi-template-contract: 1; data: " + data.name;

    // Bottom to top: each add() goes on top of the previous one.
    comp.layers.addSolid([0.043, 0.043, 0.063], "Background", WIDTH, HEIGHT, 1, DURATION);

    var coverLayer = comp.layers.add(cover);
    coverLayer.name = "Cover";
    coverLayer.property("Position").setValue([520, HEIGHT / 2]);
    fitInto(coverLayer, 640);
    coverLayer.outPoint = DURATION;

    var trackField = 'footage("' + DATA + '").sourceData.track';
    addText(comp, "Title", 96, [960, 470], trackField + ".title");
    addText(comp, "Artist", 56, [960, 560], trackField + ".artist");
    addText(comp, "Key BPM", 40, [960, 640], "var t = " + trackField + '; t.key + "  \\u00b7  " + t.bpm + " BPM"');

    var logoLayer = comp.layers.add(logo);
    logoLayer.name = "Brand Logo";
    logoLayer.property("Position").setValue([WIDTH - 200, HEIGHT - 110]);
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

    app.endUndoGroup();
    comp.openInViewer();
    alert(
      'Toshi template created: composition "' + COMP_NAME + '".\n\n' +
        "Save the project in " + folder.fsName + ", set its path as \"project\" and \"" + COMP_NAME +
        "\" as \"composition\" in after-effects.local.json, then render again."
    );
  } catch (error) {
    app.endUndoGroup();
    alert("Toshi template was not created: " + error.toString());
  }
})();
