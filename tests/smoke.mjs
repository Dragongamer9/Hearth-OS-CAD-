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


  // Stage 2: sketches, extrude/revolve, fillet/chamfer/shell/press-pull, text, groups, mirror and patterns.
  const s2 = await page.evaluate(async () => {
    const h = window.hcad, d = h.design, k = h.kernel;
    const node = (p) => ({ ...p, tf: undefined, name: undefined, id: undefined, color: undefined });
    const size = async (p) => (await k.call("volume", { node: p })).size.map((v) => Math.round(v * 100) / 100);
    const tris = async (p) => (await k.mesh(node(p))).triangles.length / 3;
    const r = {};
    const run = async (name, fn) => { try { r[name] = await fn(); } catch (e) { r[name] = "ERROR " + (e.message || e); } };
    d.clear();
    await run("extrude", async () => {
      const a = d.addSketch({ type: "rect", x: -20, y: -15, w: 40, h: 30 });
      d.update(a.id, { shapes: [...a.shapes, { type: "circle", x: 0, y: 0, r: 6 }] }, { record: false });
      const ex = d.construct("extrude", [a.id], { distance: 12 });
      return { size: await size(ex), tris: await tris(ex) };
    });
    await run("revolve", async () => {
      const a = d.addSketch({ type: "rect", x: 8, y: 0, w: 4, h: 20 });
      const rv = d.construct("revolve", [a.id], { angle: 360, axis: "y" });
      return { size: await size(rv) };
    });
    const box = d.addShape("box", [60, 0, 0]);
    await run("fillet", async () => {
      const e = await k.pickEdge(node(box), [10, 10, 10]);
      const f = d.modify(box.id, "fillet", [e.index], { r: 3 });
      return { edge: e.index, tris: await tris(f) };
    });
    const box2 = d.addShape("box", [100, 0, 0]);
    await run("chamfer", async () => { const e = await k.pickEdge(node(box2), [-10, 0, 20]); return { tris: await tris(d.modify(box2.id, "chamfer", [e.index], { r: 2 })) }; });
    const box3 = d.addShape("box", [140, 0, 0]);
    await run("shell", async () => { const f = await k.pickFace(node(box3), [0, 0, 20]); return { type: f.type, tris: await tris(d.modify(box3.id, "shell", [f.index], { thickness: 2 })) }; });
    const box4 = d.addShape("box", [180, 0, 0]);
    await run("pushpull", async () => { const f = await k.pickFace(node(box4), [0, 0, 20]); return { size: await size(d.modify(box4.id, "pushpull", [f.index], { distance: 5 })) }; });
    await run("text", async () => ({ tris: await tris(d.addShape("text", [0, 60, 0])) }));
    await run("group", async () => { const a = d.addShape("sphere", [0, -60, 0]), b = d.addShape("cone", [30, -60, 0]); return { tris: await tris(d.combine("group", [a.id, b.id])) }; });
    await run("mirror", async () => { const w = d.addShape("wedge", [-60, -60, 0]); const [m] = d.mirror([w.id], "YZ", [[-60, -60, 10]]); return { tris: await tris(m) }; });
    await run("pattern", async () => { const n0 = d.parts.length; d.pattern([d.addShape("cylinder", [-80, 40, 0], { r: 4, h: 8 }).id], "rect", { nx: 3, ny: 2, dx: 12, dy: 12 }); return { made: d.parts.length - n0 - 1 }; });
    await h.idle();
    return r;
  });
  console.log(JSON.stringify(s2));
  const ok2 = (k, cond) => check(!String(s2[k]).startsWith("ERROR") && cond(s2[k]), `${k} (${typeof s2[k] === "string" ? s2[k] : JSON.stringify(s2[k])})`);
  ok2("extrude", (v) => v.size && Math.abs(v.size[0] - 40) < 0.1 && Math.abs(v.size[2] - 12) < 0.1 && v.tris > 20);
  ok2("revolve", (v) => v.size && Math.abs(v.size[0] - 24) < 0.2 && Math.abs(v.size[1] - 24) < 0.2 && Math.abs(v.size[2] - 20) < 0.2);
  ok2("fillet", (v) => v.tris > 12);
  ok2("chamfer", (v) => v.tris > 12);
  ok2("shell", (v) => v.type === "PLANE" && v.tris > 12);
  ok2("pushpull", (v) => v.size && Math.abs(v.size[2] - 25) < 0.1);
  ok2("text", (v) => v.tris > 20);
  ok2("group", (v) => v.tris > 20);
  ok2("mirror", (v) => v.tris > 4);
  ok2("pattern", (v) => v.made === 5);
  await page.evaluate(() => { window.hcad.select([]); window.hcad.view.fit(); });
  await settle();
  await shot("12-stage2-shapes.png");

  // Drawing a rectangle sketch with the mouse, then measuring on the grid.
  await page.evaluate(() => { window.hcad.design.clear(); window.hcad.view.setView("top"); window.hcad.act("rect"); });
  await settle();
  const before2 = await page.evaluate(() => window.hcad.design.parts.length);
  await page.mouse.click(600, 400);
  await page.mouse.move(800, 550);
  await settle();
  await shot("13-drawing-rectangle.png");
  await page.mouse.click(800, 550);
  await page.evaluate(() => window.hcad.idle());
  const sk = await page.evaluate(() => window.hcad.design.parts.map((p) => p.kind));
  check(sk.length === before2 + 1 && sk[sk.length - 1] === "sketch", `drew a rectangle sketch with the mouse (${sk.join(", ")})`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.hcad.select([window.hcad.design.parts[0].id]); window.hcad.act("extrude"); });
  await settle();
  await shot("14-extrude-panel.png");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.hcad.idle());
  const ex2 = await page.evaluate(() => window.hcad.design.parts.map((p) => p.kind));
  check(ex2[0] === "extrude", `Enter extrudes the sketch (${ex2.join(", ")})`);
  await page.evaluate(() => { window.hcad.view.setView("home"); window.hcad.select([window.hcad.design.parts[0].id]); window.hcad.act("fillet"); });
  await settle();
  await shot("15-fillet-panel.png");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.hcad.select([]); window.hcad.view.setView("top"); window.hcad.act("measure"); });
  await settle();
  await page.mouse.click(400, 700);
  await page.mouse.click(700, 700);
  await settle();
  await shot("16-measure.png");
  const meas = await page.evaluate(() => window.hcad.lastMeasure || 0);
  check(meas > 1, `measured between two points (${meas.toFixed(1)} mm)`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.hcad.view.setView("home"));

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
