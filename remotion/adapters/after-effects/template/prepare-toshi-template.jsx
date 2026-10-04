// Non-interactive ES3 entry point. Node supplies TOSHI_PREP_JOB_FILE in a
// token-specific wrapper. Canonical text and markers come from templateContract.
(function prepareToshiTemplate() {
  var job = null, opened = false, suppressed = false, result = null;
  function quote(value) {
    return '"' + String(value).replace(/[\\"\x00-\x1f]/g, function (c) {
      if (c === "\\") return "\\\\";
      if (c === '"') return '\\"';
      var hex = c.charCodeAt(0).toString(16);
      while (hex.length < 4) hex = "0" + hex;
      return "\\u" + hex;
    }) + '"';
  }
  function encode(object) {
    var parts = [];
    for (var key in object) if (object.hasOwnProperty(key)) {
      parts.push(quote(key) + ":" + (typeof object[key] === "boolean" ? String(object[key]) : quote(object[key])));
    }
    return "{" + parts.join(",") + "}";
  }
  function fail(code, message) { var e = new Error(message); e.prepCode = code; throw e; }
  function checkpoint() {
    if (new File(job.cancelFile).exists) fail("PREPARATION_CANCELLED", "Preparation was cancelled.");
  }
  function writableStatus() {
    var f = new File(job.statusFile + ".tmp");
    f.encoding = "UTF-8";
    if (!f.open("w")) fail("STATUS_WRITE_FAILED", "Cannot open status file: " + f.error);
    try { if (!f.write("")) fail("STATUS_WRITE_FAILED", "Cannot write status file: " + f.error); }
    finally { f.close(); }
    return f;
  }
  try {
    var input = new File(TOSHI_PREP_JOB_FILE);
    input.encoding = "UTF-8";
    if (!input.open("r")) fail("JOB_READ_FAILED", "Cannot read preparation job.");
    var source;
    try { source = input.read(); } finally { input.close(); }
    // Node-owned JSON, never an arbitrary user script. ExtendScript may have no JSON.
    job = typeof JSON !== "undefined" && JSON.parse ? JSON.parse(source) : eval("(" + source + ")");
    result = { token: job.token, success: false, preparedProject: job.preparedProject,
      marker: job.marker, identity: job.identity, composition: job.composition, prepVersion: job.prepVersion };
    writableStatus(); // Check write permission before opening/mutating any project.
    var base = new File(job.baseProject), output = new File(job.preparedProject);
    if (output.fsName === base.fsName || output.fsName === new File(job.configuredBaseProject).fsName || output.exists) {
      fail("UNSAFE_OUTPUT_PATH", "Refusing to overwrite an input project or an existing output.");
    }
    if (app.project && (app.project.dirty || app.project.file || app.project.numItems > 0)) {
      fail("GUI_PROJECT_BUSY", "Close the existing GUI project before automatic preparation; user work is never replaced.");
    }
    checkpoint();
    app.beginSuppressDialogs(); suppressed = true;
    app.open(base); opened = true;
    checkpoint();
    var comp = null, replaced = {};
    for (var i = 1; i <= app.project.numItems; i++) {
      var item = app.project.item(i);
      if (item instanceof CompItem && item.name === job.composition) comp = item;
      if (item instanceof FootageItem && item.file) {
        var stem = item.file.name.replace(/\.[^.]+$/, "");
        if (job.assets.hasOwnProperty(stem)) {
          var asset = new File(job.assets[stem]);
          if (!asset.exists) fail("ASSET_MISSING", "Missing staged asset: " + asset.fsName);
          item.replace(asset); replaced[stem] = true;
        } else if (item.footageMissing || !item.file.exists) {
          fail("FOOTAGE_MISSING", "Unresolved template footage: " + item.file.fsName);
        }
      }
    }
    if (!comp) fail("COMPOSITION_MISSING", "Composition not found: " + job.composition);
    if (!replaced["toshi-cover"] || !replaced["toshi-audio"]) {
      fail("TEMPLATE_ASSETS_MISSING", "The base must import toshi-cover and toshi-audio footage.");
    }
    var names = ["Title", "Artist", "Key BPM"];
    for (var n = 0; n < names.length; n++) {
      var layer = comp.layer(names[n]);
      var text = layer && layer.property("ADBE Text Properties");
      var property = text && text.property("ADBE Text Document");
      if (!property) fail("TEXT_LAYER_MISSING", "Missing text layer: " + names[n]);
      if (property.expressionEnabled) property.expressionEnabled = false;
      if (property.numKeys > 0) fail("ANIMATED_TEXT_UNSUPPORTED", "Keyframed source text needs a compatible base: " + names[n]);
      var doc = property.value; doc.text = job.text[names[n]]; property.setValue(doc);
    }
    comp.comment = "toshi-template-contract: 3; " + job.marker + "; " + job.identity;
    comp.layer("Title").comment = job.marker + "; " + job.identity;
    checkpoint();
    try { app.project.save(output); }
    catch (saveError) { fail("PROJECT_SAVE_FAILED", String(saveError)); }
    if (!output.exists || output.length === 0) fail("PROJECT_SAVE_FAILED", "Prepared project was not saved.");
    checkpoint();
    result.success = true;
  } catch (error) {
    if (result) { result.errorCode = error.prepCode || "JSX_FAILED"; result.errorMessage = String(error); }
  } finally {
    // The terminal status is published only AFTER the GUI stops touching this
    // project. Node must retain locks when no valid terminal status arrives.
    if (opened) {
      try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); }
      catch (closeError) { result.success = false; result.errorCode = "PROJECT_CLOSE_FAILED"; result.errorMessage = String(closeError); result = null; }
    }
    if (suppressed) app.endSuppressDialogs(false);
    if (job && result) {
      try {
        var status = writableStatus();
        if (!status.open("w")) throw new Error("Status open failed");
        try { if (!status.write(encode(result))) throw new Error("Status write failed"); }
        finally { status.close(); }
        if (new File(job.statusFile).exists || !status.rename(new File(job.statusFile).name)) throw new Error("Status promotion failed");
      } catch (statusError) { /* No terminal status: caller fails closed. */ }
    }
  }
})();
