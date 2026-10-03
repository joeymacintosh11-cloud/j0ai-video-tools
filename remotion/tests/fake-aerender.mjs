#!/usr/bin/env node
// A stand-in for After Effects' aerender, for tests only: the After Effects
// adapter spawns it exactly as it would the real binary. It understands the
// arguments the adapter passes and behaves according to FAKE_AERENDER_MODE:
//
//   success  print PROGRESS lines for -s..-e and write the -output file
//   fail     print an error and exit 3, writing nothing
//   mov      write a .mov beside -output instead (a non-MP4 output module)
//   silent   exit 0 without writing anything
//   hang     print one PROGRESS line, then wait to be killed
//   mp4      like success, but a real MP4 with video and audio (needs ffmpeg)
//   mp4-silent  a real MP4 with video and no audio, like an empty template
//
// FAKE_AERENDER_ARGS_FILE, when set, receives the argv it was given as JSON.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (process.env.FAKE_AERENDER_ARGS_FILE) {
  writeFileSync(process.env.FAKE_AERENDER_ARGS_FILE, JSON.stringify(args));
}

const output = option("-output");
const first = Number(option("-s") ?? 0);
const last = Number(option("-e") ?? 0);
const progress = (frame) =>
  process.stdout.write(`PROGRESS:  0:00:00:${String(frame % 30).padStart(2, "0")} (${frame}): 0 Seconds\n`);

process.stdout.write("aerender version 99.0x1\n");

switch (process.env.FAKE_AERENDER_MODE ?? "success") {
  case "success":
    for (let frame = first; frame <= last; frame++) progress(frame);
    writeFileSync(output, "fake after effects video");
    process.stdout.write("PROGRESS:  Total Time Elapsed: 1 Seconds\n");
    break;
  case "mp4":
  case "mp4-silent": {
    for (let frame = first; frame <= last; frame++) progress(frame);
    const audio = process.env.FAKE_AERENDER_MODE === "mp4"
      ? ["-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "aac"]
      : [];
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:d=1:r=30",
      ...audio, "-c:v", "mpeg4", "-shortest", "-y", output,
    ]);
    break;
  }
  case "fail":
    process.stderr.write(`aerender ERROR: No comp was found with the given name.\n`);
    process.exit(3);
    break;
  case "mov":
    writeFileSync(output.replace(/\.mp4$/, ".mov"), "quicktime");
    break;
  case "silent":
    break;
  case "hang":
    progress(first);
    setInterval(() => {}, 1_000);
    break;
  default:
    process.stderr.write(`unknown FAKE_AERENDER_MODE\n`);
    process.exit(64);
}
