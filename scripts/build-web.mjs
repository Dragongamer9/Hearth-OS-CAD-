// Bundles web/ into app/ui/ (what the Tauri window serves): the page and its styles copied, the app and the geometry
// worker bundled with esbuild, and OpenCascade's WebAssembly copied next to them. Runs in CI.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "app", "ui");
const require = createRequire(import.meta.url);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of ["index.html", "style.css"]) cpSync(join(root, "web", f), join(out, f));

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "safari16"],
  sourcemap: true,
  minify: true,
  external: ["node:*"],
  logLevel: "info",
};
await build({ ...common, entryPoints: [join(root, "web", "src", "main.js")], outfile: join(out, "app.js") });
await build({ ...common, entryPoints: [join(root, "web", "src", "kernel.worker.js")], outfile: join(out, "kernel.worker.js") });

const wasm = join(dirname(require.resolve("replicad-opencascadejs/package.json")), "dist", "replicad_single.wasm");
if (!existsSync(wasm)) throw new Error("replicad_single.wasm is missing from replicad-opencascadejs");
cpSync(wasm, join(out, "replicad_single.wasm"));

// The letters for the Text tool (DejaVu Sans Bold, free to share).
const fontDir = join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
mkdirSync(join(out, "fonts"), { recursive: true });
cpSync(join(fontDir, "DejaVuSans-Bold.ttf"), join(out, "fonts", "DejaVuSans-Bold.ttf"));

for (const f of ["app.js", "kernel.worker.js", "replicad_single.wasm"]) {
  console.log(`${f}: ${(statSync(join(out, f)).size / 1048576).toFixed(1)} MB`);
}
