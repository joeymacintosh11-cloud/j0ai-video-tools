import { acquireRenderTargetLock } from "../services/render/renderLock.ts";
const [slug, preset, root] = process.argv.slice(2);
process.send?.({ type: "ready" });
process.on("message", (message) => {
  if (message !== "acquire") return;
  try {
    const lock = acquireRenderTargetLock(slug, preset as "square-1x1", root ? { root } : {});
    process.send?.({ type: "acquired", token: lock.token });
    process.on("message", (command) => {
      if (command === "release") { lock.release(); process.exit(0); }
    });
  } catch (error) {
    process.send?.({ type: "refused", code: (error as { code?: string }).code });
    process.exit(0);
  }
});
