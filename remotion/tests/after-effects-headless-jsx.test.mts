import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { templateText, templateTextMarker } from "../adapters/after-effects/templateContract.mts";
import { validatePreparationStatus, PREPARATION_VERSION } from "../adapters/after-effects/afterEffectsScripting.mts";

const source = await readFile(new URL("../adapters/after-effects/template/prepare-toshi-template.jsx", import.meta.url), "utf8");

for (const scenario of ["success", "busy", "missing-comp", "missing-layer", "save-fail", "write-disabled", "close-fail", "cancelled"] as const) {
  test(`actual headless JSX with fake Adobe host: ${scenario}`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "toshi-jsx-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const text = templateText({ title: 'Synthetic "雪"\ntrack', artist: "Toshi", key: "C", bpm: 120 });
    const job = { token: "unique-current-run", baseProject: path.join(dir, "snapshot.aep"), configuredBaseProject: path.join(dir, "base.aep"),
      preparedProject: path.join(dir, "partial.aep"), statusFile: path.join(dir, "status.json"), cancelFile: path.join(dir, "cancel"),
      composition: "Toshi Visualizer", marker: templateTextMarker(text), identity: "toshi-prepared-current", prepVersion: PREPARATION_VERSION,
      text, assets: { "toshi-cover": path.join(dir, "cover.png"), "toshi-audio": path.join(dir, "audio.wav") } };
    await writeFile(job.configuredBaseProject, "UNTOUCHABLE BASE");
    await writeFile(job.baseProject, "snapshot");
    for (const asset of Object.values(job.assets)) await writeFile(asset, "synthetic");
    const jobFile = path.join(dir, "job.json"); await writeFile(jobFile, JSON.stringify(job));
    if (scenario === "cancelled") await writeFile(job.cancelFile, "cancel");
    const events: string[] = [];
    class File {
      fsName: string;
      encoding = "";
      error = "";
      constructor(file: string) { this.fsName = file; }
      get name() { return path.basename(this.fsName); }
      get exists() { return existsSync(this.fsName); }
      get length() { return statSync(this.fsName).size; }
      open(mode: string) { if (mode === "w") writeFileSync(this.fsName, ""); return true; }
      close() { return true; }
      read() { return readFileSync(this.fsName, "utf8"); }
      write(data: string) {
        if (scenario === "write-disabled") throw new Error("Permission denied");
        writeFileSync(this.fsName, data); return true;
      }
      rename(name: string) { events.push("status-published"); renameSync(this.fsName, path.join(dir, name)); return true; }
    }
    class FootageItem {
      file: File;
      footageMissing = false;
      constructor(name: string) { this.file = new File(path.join(dir, name)); }
      replace(file: File) { events.push("relink"); this.file = file; }
    }
    const documents = Object.fromEntries(["Title", "Artist", "Key BPM"].map((name) => [name, {
      value: { text: "old track" }, numKeys: 0, expressionEnabled: false,
      setValue(doc: { text: string }) { this.value = doc; },
    }]));
    const layers = Object.fromEntries(Object.keys(documents).map((name) => [name, {
      comment: "old marker", property: () => ({ property: () => documents[name] }),
    }]));
    class CompItem {
      name = scenario === "missing-comp" ? "Other comp" : job.composition;
      comment = "";
      layer(name: string) { return scenario === "missing-layer" && name === "Artist" ? null : layers[name]; }
    }
    const comp = new CompItem();
    const footage = [new FootageItem("toshi-cover.png"), new FootageItem("toshi-audio.wav")];
    const items = [comp, ...footage];
    const project = {
      file: scenario === "busy" ? new File(job.configuredBaseProject) : null as File | null,
      dirty: scenario === "busy", numItems: scenario === "busy" ? 1 : 0,
      item: (n: number) => items[n - 1],
      save(file: File) {
        events.push("save");
        assert.notEqual(file.fsName, job.configuredBaseProject);
        assert.notEqual(file.fsName, job.baseProject);
        if (scenario === "save-fail") throw new Error("Disk unavailable");
        writeFileSync(file.fsName, "synthetic saved project"); this.file = file;
      },
      close(option: string) {
        events.push("project-closed"); assert.equal(option, "discard");
        if (scenario === "close-fail") throw new Error("Close failed");
        this.file = null; this.numItems = 0;
      },
    };
    const app = { project,
      open(file: File) { events.push("open"); assert.equal(file.fsName, job.baseProject); project.file = file; project.numItems = items.length; },
      beginSuppressDialogs() { events.push("suppress"); }, endSuppressDialogs(show: boolean) { assert.equal(show, false); },
    };
    vm.runInNewContext(source, { app, File, CompItem, FootageItem, TOSHI_PREP_JOB_FILE: jobFile,
      CloseOptions: { DO_NOT_SAVE_CHANGES: "discard" } }, { timeout: 1000 });
    assert.equal(await readFile(job.configuredBaseProject, "utf8"), "UNTOUCHABLE BASE");
    if (scenario === "write-disabled" || scenario === "close-fail") {
      assert.equal(existsSync(job.statusFile), false, "no terminal proof if writes/close failed");
      if (scenario === "write-disabled") assert.equal(events.includes("open"), false);
      return;
    }
    const status = validatePreparationStatus(JSON.parse(await readFile(job.statusFile, "utf8")), job);
    assert.equal(status.success, scenario === "success");
    if (scenario === "success") {
      for (const name of ["Title", "Artist", "Key BPM"] as const) assert.equal(documents[name].value.text, text[name]);
      assert.ok(comp.comment.includes(job.marker)); assert.ok(comp.comment.includes(job.identity));
      assert.equal(layers.Title.comment, `${job.marker}; ${job.identity}`);
      assert.ok(events.indexOf("project-closed") < events.indexOf("status-published"));
      assert.deepEqual(footage.map((item) => item.file.fsName), Object.values(job.assets));
    } else {
      assert.equal(status.errorCode, { busy: "GUI_PROJECT_BUSY", "missing-comp": "COMPOSITION_MISSING",
        "missing-layer": "TEXT_LAYER_MISSING", "save-fail": "PROJECT_SAVE_FAILED", cancelled: "PREPARATION_CANCELLED" }[scenario]);
    }
  });
}
