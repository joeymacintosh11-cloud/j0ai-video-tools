#!/usr/bin/env node
// Test-only AppleEvent sender substitute. No Adobe application is contacted.
import process from "node:process";
import { Buffer } from "node:buffer";
import { setInterval } from "node:timers";
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
const command = process.argv.at(-1);
const scriptFile = JSON.parse(command.match(/POSIX file ("(?:\\.|[^"\\])*")/)[1]);
const script = readFileSync(scriptFile, "utf8");
const jobFile = JSON.parse(script.match(/TOSHI_PREP_JOB_FILE = (.*);/)[1]);
const job = JSON.parse(readFileSync(jobFile, "utf8"));
const mode = process.env.FAKE_PREP_MODE;
if (process.env.FAKE_PREP_CALLS) appendFileSync(process.env.FAKE_PREP_CALLS, JSON.stringify(job) + "\n");
if (mode === "hang" || mode === "cancel-status") {
  if (mode === "cancel-status") process.on("SIGTERM", () => {
    writeFileSync(job.statusFile + ".tmp", JSON.stringify({ token: job.token, success: false,
      preparedProject: job.preparedProject, marker: job.marker, identity: job.identity,
      composition: job.composition, prepVersion: job.prepVersion,
      errorCode: "PREPARATION_CANCELLED", errorMessage: "cancelled" }));
    renameSync(job.statusFile + ".tmp", job.statusFile);
    process.exit(0);
  });
  setInterval(() => {}, 1000);
}
else if (mode === "launch-fail") { process.stderr.write("AppleEvent denied (-1743)\n"); process.exit(1); }
else {
  const bytes = Buffer.concat([Buffer.from("RIFX\0\0\0\0Egg!"), Buffer.from([
    mode === "wrong-track" ? "toshi-text-deadbeef" : job.marker,
    job.identity, job.composition, ...Object.values(job.assets),
  ].join("\0"))]);
  if (mode !== "missing-project" && mode !== "save-fail") writeFileSync(job.preparedProject, bytes);
  let status = { token: job.token, success: mode !== "save-fail", preparedProject: job.preparedProject,
    marker: job.marker, identity: job.identity, composition: job.composition, prepVersion: job.prepVersion,
    ...(mode === "save-fail" ? { errorCode: "PROJECT_SAVE_FAILED", errorMessage: "synthetic save failure" } : {}) };
  if (mode === "wrong-token") status.token = "old-run-token";
  if (mode === "wrong-status-path") status.preparedProject = "/wrong.aep";
  if (mode === "malformed") status = "not json";
  if (mode !== "missing-status") {
    writeFileSync(job.statusFile + ".tmp", typeof status === "string" ? status : JSON.stringify(status));
    renameSync(job.statusFile + ".tmp", job.statusFile);
  }
  // Deliberately misleading output. Production must ignore this.
  process.stdout.write("0\nSUCCESS\n");
}
