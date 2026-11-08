// Drives the built page (app/ui) in a real browser engine: the geometry engine starts, shapes are made and combined,
// every export format is written, files are opened and converted, a design saves and loads, and the main screens
// are photographed into shots/. Run in CI after scripts/build-web.mjs. BROWSER=webkit|chromium (default chromium).
import { chromium, webkit } from "playwright";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "app", "ui");
const engine = process.env.BROWSER === "webkit" ? webkit : chromium;
const name = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
const shots = join(root, "shots", name);
await mkdir(shots, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".map": "application/json" };
const server = http.createServer(async (req, res) => {
  try {
    const p = join(ui, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html");
    const body = await readFile(p);
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(8765, r));

const fails = [];
const check = (ok, what) => { if (ok) console.log(`ok - ${what}`); else { console.log(`not ok - ${what}`); fails.push(what); } };

const browser = await engine.launch({ args: name === "chromium" ? ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const shot = (f) => page.screenshot({ path: join(shots, f) });
const settle = () => page.waitForTimeout(600);

try {
  await page.goto("http://localhost:8765/index.html");
  await page.waitForFunction(() => window.hcad && window.hcad.ready, null, { timeout: 180000 });
  check(true, "geometry engine started");
  await shot("01-start.png");

  // The Primitives menu, then placing a box by clicking the grid.
  await page.click('[data-group="primitives"]');
  await settle();
  await shot("02-primitives-menu.png");
  await page.click('.di[data-kind="box"]');
  await page.mouse.move(720, 520);
  await page.mouse.move(724, 524);
  await settle();
  await shot("03-placing-box.png");
  await page.mouse.click(724, 524);
  await page.evaluate(() => window.hcad.idle());
  await settle();
  const placed = await page.evaluate(() => window.hcad.design.parts.map((p) => p.kind));
  check(placed.length === 1 && placed[0] === "box", "a box was placed by clicking the grid");
  await shot("04-box-selected.png");

  // A cylinder through it, then Subtract.
  const combined = await page.evaluate(async () => {
    const h = window.hcad;
    const box = h.design.parts[0];
    const cyl = h.design.addShape("cylinder", [box.tf.p[0], box.tf.p[1], -5], { r: 6, h: 40 });
    const torus = h.design.addShape("torus", [box.tf.p[0] + 40, box.tf.p[1], 0]);
    h.select([box.id, cyl.id]);
    await h.act("subtract");
    await h.idle();
    const parts = h.design.parts.map((p) => ({ kind: p.kind, op: p.op }));
    const g = h.view.groups.get(h.design.parts[0].id);
    const tris = g ? g.userData.mesh.geometry.index.count / 3 : 0;
    return { parts, tris };
  });
  check(combined.parts.length === 2 && combined.parts[0].kind === "boolean" && combined.parts[0].op === "subtract", "subtract made one combined part");
  check(combined.tris > 50, `the cut part has triangles (${combined.tris})`);
  await page.evaluate(() => window.hcad.view.fit());
  await settle();
  await shot("05-subtracted.png");

  // Rotate handles.
  await page.evaluate(() => { window.hcad.select([window.hcad.design.parts[0].id]); window.hcad.act("rotate"); });
  await settle();
  await shot("06-rotate-handles.png");

  // Every export format.
  const exports = await page.evaluate(async () => {
    const h = window.hcad;
    const out = {};
    for (const ext of ["stl", "3mf", "obj", "glb", "step"]) {
      try {
        const { bytes } = await h.writeModel(ext, h.design, h.design.parts, { quality: "normal" });
        out[ext] = { size: bytes.length, head: new TextDecoder().decode(bytes.slice(0, 20)) };
        h.files.writeFile(`/home/you/Models/test.${ext}`, bytes);
      } catch (e) { out[ext] = { error: e.message || String(e) }; }
    }
    return out;
  });
  for (const [ext, r] of Object.entries(exports)) check(!r.error && r.size > 100, `export ${ext.toUpperCase()} (${r.error || r.size + " bytes"})`);
  check(exports.step && exports.step.head && exports.step.head.startsWith("ISO-10303"), "the STEP file is a real STEP file");
  check(exports.glb && exports.glb.head && exports.glb.head.startsWith("glTF"), "the GLB file is a real GLB file");

  // Opening what we wrote: STL, 3MF and OBJ as meshes, STEP as a solid.
  const opened = await page.evaluate(async () => {
    const h = window.hcad;
    const r = {};
    for (const ext of ["stl", "3mf", "obj", "glb", "step"]) {
      try {
        const m = await h.readModel(`test.${ext}`, await h.files.readFile(`/home/you/Models/test.${ext}`));
        r[ext] = m.kind === "solid" ? { kind: "solid", tris: m.mesh.triangles.length / 3 } : { kind: "mesh", tris: m.positions.length / 9 };
      } catch (e) { r[ext] = { error: e.message || String(e) }; }
    }
    return r;
  });
  for (const [ext, r] of Object.entries(opened)) check(!r.error && r.tris > 50, `open ${ext.toUpperCase()} (${r.error || `${r.kind}, ${r.tris} triangles`})`);
  check(opened.step && opened.step.kind === "solid", "STEP opens as a real solid");

  // Importing into the design (the menu's Import does this), then converting files.
  await page.evaluate(async () => { await window.hcad.importPaths(["/home/you/Models/test.stl", "/home/you/Models/test.step"]); await window.hcad.idle(); });
  await settle();
  const kinds = await page.evaluate(() => window.hcad.design.parts.map((p) => p.kind));
  check(kinds.includes("mesh") && kinds.includes("brep"), `imported an STL and a STEP into the design (${kinds.join(", ")})`);
  await page.evaluate(() => window.hcad.view.fit());
  await settle();
  await shot("07-imported.png");
  const conv = await page.evaluate(async () => {
    const h = window.hcad;
    const r = {};
    for (const [from, to] of [["stl", "3mf"], ["step", "stl"], ["3mf", "obj"], ["obj", "glb"]]) {
      try { r[`${from}→${to}`] = await h.convertOne(`/home/you/Models/test.${from}`, to); } catch (e) { r[`${from}→${to}`] = "ERROR " + (e.message || e); }
    }
    return r;
  });
  for (const [k, v] of Object.entries(conv)) check(!String(v).startsWith("ERROR"), `convert ${k} (${v})`);

  // Save and load a design.
  const saved = await page.evaluate(() => {
    const h = window.hcad;
    const text = h.design.toFile();
    const d = new h.DesignClass();
    d.loadFile(text);
    return { a: h.design.parts.length, b: d.parts.length, meshes: d.meshes.size, size: text.length };
  });
  check(saved.a === saved.b && saved.meshes === 1, `a design saves and loads (${saved.b} parts, ${saved.size} bytes)`);

  // Undo all the way and redo.
  const undo = await page.evaluate(async () => {
    const h = window.hcad;
    const n = h.design.parts.length;
    let steps = 0;
    while (h.design.undo()) steps++;
    const empty = h.design.parts.length;
    while (h.design.redo()) {}
    await h.idle();
    return { n, steps, empty, back: h.design.parts.length };
  });
  check(undo.empty === 0 && undo.back === undo.n, `undo and redo (${undo.steps} steps)`);
  await page.waitForTimeout(1500);

  // Dialogs and the main menu.
  await page.evaluate(() => { window.hcad.select([]); });
  await page.click(".logo");
  await settle();
  await shot("08-main-menu.png");
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 700);
  await page.evaluate(() => { window.hcad.act("export"); });
  await settle();
  await shot("09-export-dialog.png");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.hcad.act("convert"); });
  await settle();
  await shot("10-convert-dialog.png");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.hcad.act("import"); });
  await settle();
  await shot("11-file-picker.png");
  await page.keyboard.press("Escape");
} catch (err) {
  fails.push(`crashed: ${err.message || err}`);
  console.log(String(err && err.stack || err));
  try { await shot("99-failure.png"); } catch {}
}

const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
if (realErrors.length) console.log(`::warning title=${name} console errors::${realErrors.slice(0, 10).join(" | ").slice(0, 3000)}`);
await browser.close();
server.close();
if (fails.length) {
  console.log(`::error title=${name} smoke test::${fails.join(" | ").slice(0, 3500)}`);
  process.exit(1);
}
console.log(`::notice title=${name} smoke test::all checks passed`);
