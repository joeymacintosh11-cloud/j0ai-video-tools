import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CancelSignal } from "../../core/ports/renderEngine.ts";
import type { AfterEffectsConfig } from "./afterEffectsConfig.mts";
import { PREPARATION_VERSION, PreparationError, runAfterEffectsPreparation, type PreparationJob } from "./afterEffectsScripting.mts";
import { acquireAfterEffectsStagingLock, newWorkspaceOwner, writeWorkspaceOwner, type WorkspaceOwner } from "./stagingLock.mts";
import { automationDirectory } from "./workspace.mts";
import { missingTemplateFiles, templateTextStatus, type TemplateText } from "./templateContract.mts";

const SCRIPT = fileURLToPath(new URL("./template/prepare-toshi-template.jsx", import.meta.url));
export const hashProject = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export const preparedIdentity = (input: {
  readonly baseHash: string;
  readonly prepVersion: string;
  readonly marker: string;
  readonly text: TemplateText;
  readonly trackIdentity: string;
  readonly composition: string;
  readonly assets: Readonly<Record<string, string>>;
}): string => `toshi-prepared-${hashProject(JSON.stringify(input))}`;

export const validatePreparedProject = (bytes: Uint8Array, job: Pick<PreparationJob, "marker" | "identity" | "composition">): void => {
  if (Buffer.from(bytes).subarray(0, 4).toString() !== "RIFX" || bytes.length < 32 ||
      templateTextStatus(bytes, job.marker) !== "current" ||
      missingTemplateFiles(bytes, [job.identity, job.composition, "toshi-cover", "toshi-audio"]).length > 0) {
    throw new PreparationError("Prepared template mismatch: invalid project, composition, assets or track identity.");
  }
};

export type PrepareTemplateInput = {
  readonly config: AfterEffectsConfig;
  readonly baseBytes: Uint8Array;
  readonly composition: string;
  readonly marker: string;
  readonly text: TemplateText;
  readonly trackIdentity: string;
  readonly assets: Readonly<Record<string, string>>;
  readonly cancelSignal?: CancelSignal;
  readonly log: (message: string) => void;
  readonly onOwnership?: (changes: Partial<WorkspaceOwner>) => void;
};

export type PreparationDeps = {
  readonly run: typeof runAfterEffectsPreparation;
  readonly prepVersion: string;
};

export const prepareAfterEffectsTemplate = async (
  input: PrepareTemplateInput,
  overrides: Partial<PreparationDeps> = {},
): Promise<string> => {
  const deps = { run: runAfterEffectsPreparation, prepVersion: PREPARATION_VERSION, ...overrides };
  const { config, composition, marker, text, trackIdentity, assets, log } = input;
  const baseHash = hashProject(input.baseBytes);
  const identity = preparedIdentity({ baseHash, prepVersion: deps.prepVersion, marker, text, trackIdentity, composition, assets });
  await mkdir(config.workingDirectory, { recursive: true, mode: 0o700 });
  const working = await realpath(config.workingDirectory);
  const project = path.join(working, `${identity}.aep`);
  const provenance = `${project}.json`;
  const basePath = await realpath(config.project);
  if (project === basePath || await realpath(project).catch(() => project) === basePath) {
    throw new PreparationError("Unsafe cache path: refusing to replace or reuse the configured base project.");
  }
  // The full content digest binds the cache to the saved, validated project;
  // presence of a marker alone cannot make a truncated/corrupted file valid.
  try {
    const meta = JSON.parse(await readFile(provenance, "utf8"));
    const bytes = await readFile(project);
    if (meta.identity === identity && meta.baseHash === baseHash && meta.prepVersion === deps.prepVersion &&
        meta.marker === marker && meta.composition === composition &&
        meta.projectHash === hashProject(bytes)) {
      validatePreparedProject(bytes, { marker, identity, composition });
      const temporary = `${provenance}.tmp-${randomUUID()}`;
      await writeFile(temporary, JSON.stringify({ ...meta, lastUsedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      try { await rename(temporary, provenance); } finally { await rm(temporary, {force:true}); }
      log("After Effects: Reusing prepared After Effects template.");
      return project;
    }
  } catch { /* A missing, corrupt or mismatched cache is rebuilt, never rendered. */ }

  // GUI scripting is shared even when two configs stage in different folders.
  const guiDir = automationDirectory(config.applicationBundleId);
  await mkdir(guiDir, { recursive: true, mode: 0o700 });
  log("After Effects: Waiting for After Effects lock (GUI preparation is serialized across data folders).");
  const releaseGui = acquireAfterEffectsStagingLock(path.join(guiDir, "automation.json"));
  const token = randomUUID();
  const runDir = path.join(working, `run-${token}`);
  let uncertain = false;
  let runOwner: WorkspaceOwner = { ...newWorkspaceOwner(), trackIdentity, runToken: token, runDirectory: runDir };
  const ownership = (changes: Partial<WorkspaceOwner>) => {
    runOwner = { ...runOwner, ...changes };
    writeWorkspaceOwner(path.join(runDir, "owner.json"), runOwner);
    releaseGui.update({ phase: runOwner.phase, safeToDelete: runOwner.safeToDelete, trackIdentity, runToken: token, runDirectory: runDir, childPid: runOwner.childPid });
    input.onOwnership?.(changes);
  };
  try {
    await mkdir(runDir, {mode:0o700});
    ownership({ phase: "staging", safeToDelete: true });
    const partial = path.join(runDir, "prepared.partial.aep");
    const job: PreparationJob = {
      token, baseProject: path.join(runDir, `base${path.extname(config.project)}`), configuredBaseProject: config.project,
      preparedProject: partial, statusFile: path.join(runDir, `status-${token}.json`), cancelFile: path.join(runDir, "cancel"),
      composition, marker, identity, prepVersion: deps.prepVersion, text, assets,
    };
    // Open a byte-for-byte snapshot, never the user's actual project. No Adobe
    // save path can point at the configured base, even on a JSX error.
    await writeFile(job.baseProject, input.baseBytes);
    const jobFile = path.join(runDir, "job.json");
    const scriptFile = path.join(runDir, "prepare.jsx");
    await writeFile(jobFile, JSON.stringify(job));
    await writeFile(scriptFile, `var TOSHI_PREP_JOB_FILE = ${JSON.stringify(jobFile)};\n${await readFile(SCRIPT, "utf8")}`);
    log("After Effects: Preparing After Effects template.");
    ownership({ phase: "preparing", safeToDelete: false, runToken: token, runDirectory: runDir });
    await deps.run({ job, scriptFile, applicationBundleId: config.applicationBundleId,
      timeoutMs: config.preparationTimeoutMs, cancelSignal: input.cancelSignal,
      onChild: (pid) => ownership({ childPid: pid }) });
    ownership({ phase: "completed", safeToDelete: true, childPid: null });
    const bytes = await readFile(partial).catch(() => { throw new PreparationError("Missing prepared project after successful JSX status."); });
    validatePreparedProject(bytes, job);
    if (hashProject(await readFile(config.project)) !== baseHash) {
      throw new PreparationError("The base changed during preparation; prepared copy rejected.");
    }
    const metaPartial = path.join(runDir, "provenance.partial.json");
    await writeFile(metaPartial, JSON.stringify({ identity, baseHash, marker, composition,
      prepVersion: deps.prepVersion, projectHash: hashProject(bytes), renderer: "after-effects", trackIdentity,
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }));
    // Locks protect promotion. If interrupted between these two renames, the
    // absent/mismatched provenance makes the cache a miss next time.
    await rename(partial, project);
    await rename(metaPartial, provenance);
    return project;
  } catch (error) {
    uncertain = error instanceof PreparationError && error.uncertain;
    if (uncertain) {
      try { ownership({ phase: "uncertain", safeToDelete: false }); }
      catch { log("After Effects: recovery metadata update failed; existing unsafe ownership retained."); }
    }
    if (uncertain) log(`After Effects: JSX completion is uncertain; retaining staging/GUI locks and ${runDir}. ` +
      "Verify AE scripting and aerender have stopped before removing locks/files. Enable Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network for status writing.");
    throw error;
  } finally {
    if (!uncertain) {
      if (await readFile(path.join(runDir, "owner.json")).then(() => true, () => false)) ownership({ phase: "completed", safeToDelete: true, childPid: null });
      await rm(runDir, { recursive: true, force: true });
      releaseGui();
      input.onOwnership?.({ phase: "ready", safeToDelete: true, childPid: null, runDirectory: null, runToken: null });
    }
  }
};
