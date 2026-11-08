// Hearth OS CAD: the window's page. Builds the 123D-style tool bar, menus, view cube, navigation strip and dialogs,
// and keeps the 3D view in step with the design.
import * as THREE from "three";
import { Design, KINDS, PARAM_LABELS, OP_LABELS, MODIFY_LABELS, MODIFY_PARAMS } from "./doc.js";
import { Viewport } from "./viewport.js";
import * as kernel from "./kernel.js";
import * as files from "./files.js";
import { readModel, writeModel, EXPORT_FORMATS, IMPORT_EXTS, OPEN_EXTS } from "./io.js";
import { Design as DesignClass } from "./doc.js";
import { I, LOGO } from "./icons.js";

const $ = (sel, el = document) => el.querySelector(sel);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

const design = new Design();
let selection = [];
let filePath = null;
let settings = {};
let env = { home: "", models: "" };
const SOON = "Coming in the next update";

// ---------- Settings (remembered; only what changed is sent, and the Rust side merges it into the file) ----------
async function setSetting(key, value) {
  settings[key] = value;
  try { settings = { ...settings, ...(await files.saveSettings({ [key]: value })) }; } catch (e) { toast(`Couldn't save that setting: ${e.message || e}`, true); }
}

// ---------- Toasts ----------
function toast(text, err = false) {
  const t = h(`<div class="toast${err ? " err" : ""}"></div>`);
  t.textContent = text;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

// ---------- The tool bar ----------
const GROUPS = [
  { id: "transform", icon: "transform", label: "Transform", items: [["move", "Move"], ["rotate", "Rotate"]] },
  { id: "primitives", icon: "primitives", label: "Primitives", grid: true, items: Object.keys(KINDS).map((k) => [k, KINDS[k].label]) },
  { id: "sketch", icon: "sketch", label: "Sketch", items: [["rect", "Rectangle"], ["circle2", "Circle"], ["ngon", "Polygon"], ["poly", "Polyline"]] },
  { id: "construct", icon: "construct", label: "Construct", items: [["extrude", "Extrude"], ["revolve", "Revolve"], ["sweep", "Sweep", true], ["loft", "Loft", true]] },
  { id: "modify", icon: "modify", label: "Modify", items: [["pushpull", "Press/Pull"], ["tweak", "Tweak", true], ["split", "Split Face", true], ["fillet", "Fillet"], ["chamfer", "Chamfer"], ["shell", "Shell"]] },
  { id: "pattern", icon: "pattern", label: "Pattern", items: [["rectpattern", "Rectangular"], ["circpattern", "Circular"], ["mirror", "Mirror"]] },
  { id: "grouping", icon: "grouping", label: "Grouping", items: [["group", "Group"], ["ungroup", "Ungroup"]] },
  { id: "combine", icon: "combine", label: "Combine", items: [["join", "Join"], ["subtract", "Subtract"], ["intersect", "Intersect"], ["separate", "Separate"]] },
  { id: "measure", icon: "measure", label: "Measure", action: "measure" },
  { id: "text", icon: "text", label: "Text", action: "text" },
  { id: "snap", icon: "snap", label: "Snap to grid", toggle: true },
  { id: "material", icon: "material", label: "Material", swatches: true },
];
const SWATCHES = ["#7fb2e6", "#2f6fd6", "#e8833a", "#e5484d", "#46c37b", "#e6d36e", "#d98bd0", "#8fd3d6", "#e9edf1", "#9aa5b1", "#4a5058", "#2b2f36"];

function buildTopbar() {
  const bar = $("#topbar");
  bar.innerHTML = "";
  bar.append(
    h(`<button class="t logo" data-menu="main" aria-haspopup="true" aria-label="Main menu"><span class="lg">${LOGO}</span><b>Hearth OS CAD</b><span class="c">${I.caret}</span></button>`),
    h(`<span class="sep"></span>`),
    h(`<button class="t" data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${I.undo}</button>`),
    h(`<button class="t" data-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)">${I.redo}</button>`),
  );
  const tools = h(`<div class="tools"></div>`);
  for (const g of GROUPS) {
    const hasMenu = g.items || g.swatches;
    const b = h(`<button class="t" data-group="${g.id}" aria-label="${g.label}" title="${g.soon ? `${g.label}: ${SOON}` : g.label}" ${g.soon ? "disabled" : ""}>${I[g.icon]}${hasMenu ? `<span class="c">${I.caret}</span>` : ""}</button>`);
    tools.appendChild(b);
  }
  bar.appendChild(tools);
  bar.append(
    h(`<button class="t tbtn" data-act="export">Export</button>`),
    h(`<button class="t" data-act="help" aria-label="Help" title="Help">${I.help}</button>`),
  );
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.menu === "main") return toggleMenu("main", b);
    if (b.dataset.act) { closeMenus(); return act(b.dataset.act); }
    const g = GROUPS.find((x) => x.id === b.dataset.group);
    if (!g) return;
    if (g.toggle) { setSnapOn(!snapOn()); return; }
    if (g.action) { closeMenus(); act(g.action); return; }
    toggleMenu(g.id, b);
  });
  refreshSnapButton();
}

let openMenu = null;
function closeMenus() { $("#menus").innerHTML = ""; document.querySelectorAll(".t.on[data-group], .t.on[data-menu]").forEach((b) => b.classList.remove("on")); openMenu = null; }

function toggleMenu(id, anchor) {
  if (openMenu === id) { closeMenus(); return; }
  closeMenus();
  openMenu = id;
  anchor.classList.add("on");
  const box = anchor.getBoundingClientRect();
  const stage = $("#stage").getBoundingClientRect();
  let dd;
  if (id === "main") dd = mainMenu();
  else {
    const g = GROUPS.find((x) => x.id === id);
    if (g.swatches) {
      dd = h(`<div class="dd"><div class="swatches"></div></div>`);
      for (const c of SWATCHES) {
        const sw = h(`<button class="sw" aria-label="Colour ${c}" style="background:${c}"></button>`);
        sw.onclick = () => { closeMenus(); setColor(c); };
        $(".swatches", dd).appendChild(sw);
      }
    } else if (g.grid) {
      dd = h(`<div class="dd grid" role="menu"></div>`);
      for (const [k, label] of g.items) {
        const b = h(`<button class="di" role="menuitem" data-kind="${k}">${I[k]}${label}</button>`);
        b.onclick = () => { closeMenus(); startPlacing(k); };
        dd.appendChild(b);
      }
    } else {
      dd = h(`<div class="dd list" role="menu"></div>`);
      for (const [k, label, soon] of g.items) {
        const b = h(`<button class="mi" role="menuitem" data-act="${k}" ${soon ? `disabled title="${SOON}"` : ""}>${I[k]}${label}${soon ? '<span class="k">Soon</span>' : ""}</button>`);
        b.onclick = () => { closeMenus(); act(k); };
        dd.appendChild(b);
      }
    }
  }
  dd.style.left = `${Math.max(6, Math.min(box.left - stage.left, stage.width - 320))}px`;
  dd.style.top = "0px";
  $("#menus").appendChild(dd);
}

function mainMenu() {
  const dd = h(`<div class="dd list" role="menu" style="min-width:260px"></div>`);
  const item = (icon, label, action, key = "", sub = false) => {
    const b = h(`<button class="mi" role="menuitem">${I[icon]}${label}${key ? `<span class="k">${key}</span>` : ""}${sub ? `<span class="ch">${I.chevron}</span>` : ""}</button>`);
    b.onclick = (e) => { e.stopPropagation(); if (sub) return action(b); closeMenus(); action(); };
    return b;
  };
  dd.append(
    item("new", "New", () => act("new"), "Ctrl+N"),
    item("open", "Open…", () => act("open"), "Ctrl+O"),
    item("import", "Import…", () => act("import"), "Ctrl+I"),
    h(`<div class="mhr"></div>`),
    item("save", "Save", () => act("save"), "Ctrl+S"),
    item("saveas", "Save a copy…", () => act("saveas"), "Ctrl+Shift+S"),
    h(`<div class="mhr"></div>`),
    item("export", "Export 3D…", () => act("export"), "Ctrl+E"),
    item("convert", "Convert files…", () => act("convert")),
  );
  if (files.isApp) dd.append(h(`<div class="mhr"></div>`), item("exit", "Exit", () => act("exit")));
  return dd;
}

document.addEventListener("pointerdown", (e) => {
  if (!openMenu) return;
  if (e.target.closest(".dd") || e.target.closest("#topbar button")) return;
  closeMenus();
});

// ---------- View cube, navigation strip, units ----------
function buildViewControls() {
  $("#cube").innerHTML = `
    <button class="home" aria-label="Home view" title="Home view">${I.home}</button>
    <svg class="c3" viewBox="0 0 84 84" role="group" aria-label="View cube">
      <polygon data-view="top" points="42,8 74,26 42,44 10,26" fill="#fafbfc"></polygon>
      <polygon data-view="front" points="10,26 42,44 42,78 10,60" fill="#e6eaee"></polygon>
      <polygon data-view="right" points="74,26 42,44 42,78 74,60" fill="#d6dce2"></polygon>
      <text x="42" y="30" text-anchor="middle">TOP</text>
      <text x="26" y="57" text-anchor="middle" style="font-size:8px">FRONT</text>
      <text x="58" y="57" text-anchor="middle" style="font-size:8px">RIGHT</text>
    </svg>`;
  $("#cube .home").onclick = () => view.setView("home");
  $("#cube").querySelectorAll("polygon").forEach((p) => { p.onclick = () => view.setView(p.dataset.view); });

  const nav = $("#navbar");
  const buttons = [
    ["select", "select", "Select (click parts)"], ["pan", "pan", "Pan (or middle-drag)"], ["orbit", "orbit", "Orbit (or right-drag)"],
    ["zoom", "zoom", "Zoom (or the wheel)"], ["fit", "fit", "Fit everything in view (F)"], ["persp", "persp", "Perspective / orthographic"],
    ["style", "style", "Materials and outlines"], ["eye", "grid", "Show or hide the grid"],
  ];
  nav.innerHTML = "";
  for (const [icon, id, tip] of buttons) {
    const b = h(`<button class="nb" data-nav="${id}" aria-label="${tip}" title="${tip}">${I[icon]}</button>`);
    b.onclick = () => navAction(id);
    nav.appendChild(b);
  }
  refreshNav();
  refreshUnits();
}

function navAction(id) {
  if (["select", "pan", "orbit", "zoom"].includes(id)) { view.setNavMode(id); refreshNav(); return; }
  if (id === "fit") view.fit();
  if (id === "persp") { const next = (settings.projection || "persp") === "persp" ? "ortho" : "persp"; view.setProjection(next); setSetting("projection", next); }
  if (id === "style") {
    const order = ["edges", "shaded", "wire"];
    const next = order[(order.indexOf(settings.style || "edges") + 1) % order.length];
    view.setStyle(next); setSetting("style", next);
    toast({ edges: "Shaded with outlines", shaded: "Shaded", wire: "Wireframe" }[next]);
  }
  if (id === "grid") { const on = settings.showGrid === false; view.showGrid(on); setSetting("showGrid", on); }
  refreshNav();
}

function refreshNav() {
  document.querySelectorAll("#navbar .nb").forEach((b) => {
    const id = b.dataset.nav;
    b.classList.toggle("on", id === view.navMode || (id === "persp" && settings.projection === "ortho") || (id === "grid" && settings.showGrid !== false));
  });
}

const snapOn = () => settings.snapOn !== false;
const snapSize = () => (Number(settings.snap) > 0 ? Number(settings.snap) : 1);
function setSnapOn(on) { setSetting("snapOn", on); view.setSnap(on ? snapSize() : 0); refreshSnapButton(); refreshUnits(); toast(on ? `Snapping to the grid every ${snapSize()} mm` : "Snapping off"); }
function refreshSnapButton() { const b = document.querySelector('[data-group="snap"]'); if (b) b.classList.toggle("on", snapOn()); }

function refreshUnits() {
  const u = $("#units");
  u.innerHTML = `<span>Units: <b>mm</b></span><button class="link" data-grid>Edit grid</button><span>Grid: <b>${snapOn() ? snapSize().toFixed(snapSize() < 1 ? 1 : 1) : "off"}</b></span>`;
  $("[data-grid]", u).onclick = editGrid;
}

function editGrid() {
  const m = modal("Grid and snapping", `
    <div><div class="mlbl">Snap distance</div><div class="snapopts">${[0.1, 0.25, 0.5, 1, 2, 5, 10, 25].map((v) => `<button class="btn${snapOn() && v === snapSize() ? " pri" : ""}" data-v="${v}">${v} mm</button>`).join("")}</div></div>
    <label class="chk"><input type="checkbox" data-on ${snapOn() ? "checked" : ""}> Snap to the grid when placing and moving</label>`, [["Done", true]]);
  m.body.querySelectorAll("[data-v]").forEach((b) => b.onclick = () => {
    setSetting("snap", Number(b.dataset.v));
    if (!snapOn()) setSetting("snapOn", true);
    view.setSnap(Number(b.dataset.v)); refreshUnits(); refreshSnapButton();
    m.body.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("pri", x === b));
    $("[data-on]", m.body).checked = true;
  });
  $("[data-on]", m.body).onchange = (e) => setSnapOn(e.target.checked);
}

// ---------- Placing new shapes ----------
function preview(kind) {
  const p = KINDS[kind].params;
  let g;
  if (kind === "box") g = new THREE.BoxGeometry(p.w, p.d, p.h).translate(0, 0, p.h / 2);
  else if (kind === "cylinder") g = new THREE.CylinderGeometry(p.r, p.r, p.h, 40).rotateX(Math.PI / 2).translate(0, 0, p.h / 2);
  else if (kind === "sphere") g = new THREE.SphereGeometry(p.r, 32, 20).translate(0, 0, p.r);
  else if (kind === "cone") g = new THREE.CylinderGeometry(p.r2 || 0.001, p.r1, p.h, 40).rotateX(Math.PI / 2).translate(0, 0, p.h / 2);
  else if (kind === "torus") g = new THREE.TorusGeometry(p.R, p.r, 16, 48).translate(0, 0, p.r);
  else if (kind === "prism") g = new THREE.CylinderGeometry(p.r, p.r, p.h, p.sides).rotateX(Math.PI / 2).translate(0, 0, p.h / 2);
  else if (kind === "text") g = new THREE.BoxGeometry(p.size * 0.65 * String(p.text).length, p.size, p.depth).translate(0, 0, p.depth / 2);
  else {
    const s = new THREE.Shape([new THREE.Vector2(-p.w / 2, 0), new THREE.Vector2(p.w / 2, 0), new THREE.Vector2(-p.w / 2, p.h)]);
    g = new THREE.ExtrudeGeometry(s, { depth: p.d, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, p.d / 2, 0);
  }
  return g;
}

function startPlacing(kind) {
  view.startPlacing(kind, preview(kind));
  setHint(`Click on the grid to place the ${KINDS[kind].label.toLowerCase()} · Esc to stop`);
}

function stopPlacing() { view.stopPlacing(); setHint(""); }

function setHint(t) { $("#hint").textContent = t || defaultHint(); }
const defaultHint = () => (design.parts.length ? "Click a part to pick it · Shift-click to pick more · right-drag to orbit" : "Pick a shape from Primitives to start, or open a model from the menu");

// ---------- Keeping the 3D view in step with the design ----------
const shown = new Map(); // part id -> key of what's drawn
const meshCache = new Map(); // key -> mesh data from the geometry engine
// What a part looks like regardless of where it sits, its name or its colour (those don't need the geometry engine).
const keyOf = (p) => (p.kind === "mesh" ? `mesh:${p.meshRef}` : p.kind === "sketch" ? `sketch:${JSON.stringify(p.shapes)}` : JSON.stringify({ ...p, tf: undefined, name: undefined, id: undefined, color: undefined }));
let syncRun = 0;

let syncing = 0;
async function sync() {
  syncing++;
  try { await syncInner(); } finally { syncing--; }
}
// Resolves once the 3D view shows the design as it is now (used by the tests and after opening files).
function idle() {
  return new Promise((resolve) => {
    const tick = () => (syncing === 0 ? resolve() : setTimeout(tick, 40));
    setTimeout(tick, 40);
  });
}

async function syncInner() {
  const run = ++syncRun;
  const ids = new Set(design.parts.map((p) => p.id));
  for (const id of [...shown.keys()]) if (!ids.has(id)) { view.removePart(id); shown.delete(id); }
  const jobs = [];
  for (const p of design.parts) {
    const key = keyOf(p);
    if (shown.get(p.id) === key) { view.placePart(p); continue; }
    jobs.push(p);
  }
  for (const p of jobs) {
    const key = keyOf(p);
    try {
      let data;
      if (p.kind === "sketch") { view.setSketch(p); shown.set(p.id, key); continue; }
      if (p.kind === "mesh") data = { positions: design.meshes.get(p.meshRef).positions };
      else {
        data = meshCache.get(key);
        if (!data) {
          data = await kernel.mesh({ ...p, tf: undefined, name: undefined, id: undefined, color: undefined });
          meshCache.set(key, data);
          if (meshCache.size > 200) meshCache.delete(meshCache.keys().next().value);
        }
      }
      if (run !== syncRun && !design.find(p.id)) continue;
      const now = design.find(p.id);
      if (!now) continue;
      view.setPart(now, data);
      shown.set(p.id, key);
    } catch (err) {
      toast(`${p.name}: ${err.message || err}`, true);
    }
  }
  selection = selection.filter((id) => design.find(id));
  view.setSelection(selection);
  refreshSelectionUI();
  setHint();
  window.hcad.synced = (window.hcad.synced || 0) + 1;
}

design.onChange(() => { sync(); refreshTitle(); });

function refreshTitle() {
  const name = filePath ? files.baseName(filePath) : "Untitled";
  const t = `${design.dirty ? "• " : ""}${name} — Hearth OS CAD`;
  document.title = t;
  if (files.isApp) window.__TAURI__.window.getCurrentWindow().setTitle(t).catch(() => {});
}

// ---------- Selection, quick tools and properties ----------
function select(ids) {
  selection = ids.filter((id) => design.find(id));
  view.setSelection(selection);
  if (selection.length && !view.gizmoMode) view.setGizmoMode("translate");
  refreshSelectionUI();
}

function refreshSelectionUI() {
  const q = $("#quick");
  if (tool) { q.hidden = true; return; }
  const parts = selection.map((id) => design.find(id)).filter(Boolean);
  if (!parts.length) { q.hidden = true; $("#props").hidden = true; return; }
  q.hidden = false;
  const many = parts.length > 1;
  const one = parts.length === 1 ? parts[0] : null;
  const btn = (id, icon, tip, cls = "") => `<button class="q ${cls}${(id === "move" && view.gizmoMode === "translate") || (id === "rotate" && view.gizmoMode === "rotate") ? " on" : ""}" data-q="${id}" aria-label="${tip}" title="${tip}">${I[icon]}</button>`;
  q.innerHTML = [
    `<button class="q gear" aria-label="Quick tools" title="${parts.length} picked">${I.gear}</button>`,
    btn("move", "move", "Move (M)"), btn("rotate", "rotate", "Rotate (R)"), btn("duplicate", "duplicate", "Duplicate (Ctrl+D)"),
    many ? `<span class="qsep"></span>${btn("join", "join", "Join")}${btn("subtract", "subtract", "Subtract (first picked keeps)")}${btn("intersect", "intersect", "Intersect")}` : "",
    one && one.kind === "sketch" ? `<span class="qsep"></span>${btn("extrude", "extrude", "Extrude")}${btn("revolve", "revolve", "Revolve")}` : "",
    one && isSolid(one) ? `<span class="qsep"></span>${btn("pushpull", "pushpull", "Press/Pull")}${btn("fillet", "fillet", "Fillet")}${btn("chamfer", "chamfer", "Chamfer")}${btn("shell", "shell", "Shell")}` : "",
    one && (one.kind === "boolean" || (one.kind === "modify" && one.op !== "mirror")) ? `<span class="qsep"></span>${btn("separate", one.kind === "modify" ? "undo" : one.op === "group" ? "ungroup" : "separate", one.kind === "modify" ? `Take off the ${MODIFY_LABELS[one.op].toLowerCase()}` : one.op === "group" ? "Ungroup" : "Separate")}` : "",
    `<span class="qsep"></span>${btn("delete", "trash", "Delete (Del)", "danger")}`,
  ].join("");
  q.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => act(b.dataset.q));
  showProps(one, parts);
}

function showProps(one, parts) {
  const el = $("#props");
  el.hidden = false;
  if (!one) {
    el.innerHTML = `<div class="lbl">${parts.length} parts picked</div><div style="font-size:13px;color:#5d656e">Use the round bar below to move, rotate, duplicate, join, subtract or intersect them.</div>`;
    return;
  }
  if (tool) return;
  const kindName = one.kind === "boolean" ? (one.op === "group" ? `Group of ${one.children.length} parts` : `${OP_LABELS[one.op]} from ${one.children.length} parts`)
    : one.kind === "brep" ? "Solid (from STEP)" : one.kind === "mesh" ? "Mesh (triangles)" : one.kind === "sketch" ? `Sketch · ${one.shapes.length} shape${one.shapes.length > 1 ? "s" : ""}`
    : one.kind === "modify" ? `${MODIFY_LABELS[one.op]} on ${one.child.name}` : one.kind === "extrude" ? "Extruded sketch" : one.kind === "revolve" ? "Revolved sketch" : KINDS[one.kind].label;
  const paramLabels = KINDS[one.kind] ? PARAM_LABELS : one.kind === "modify" || one.kind === "extrude" || one.kind === "revolve" ? (MODIFY_PARAMS[one.op || one.kind] || {}) : null;
  const sizes = paramLabels && one.params ? Object.keys(paramLabels).filter((k) => k in one.params).map((k) => k === "text"
    ? `<label style="grid-column: 1 / -1">${paramLabels[k]}<input data-param="${k}" data-text value="${esc(one.params[k])}"></label>`
    : `<label>${paramLabels[k] || k}<input data-param="${k}" type="number" step="${k === "sides" ? 1 : k === "angle" ? 15 : 0.5}" min="${k === "r2" ? 0 : k === "sides" ? 3 : k === "distance" ? -1000 : 0.1}" value="${+one.params[k]}"></label>`).join("") : "";
  const g = view.groups.get(one.id);
  let sizeLine = "";
  if (g) { const b = new THREE.Box3().expandByObject(g); if (!b.isEmpty()) { const v = b.getSize(new THREE.Vector3()); sizeLine = `${v.x.toFixed(1)} × ${v.y.toFixed(1)} × ${v.z.toFixed(1)} mm`; } }
  const tf = one.tf;
  el.innerHTML = `
    <input class="name" aria-label="Part name" value="${esc(one.name)}">
    <div class="kind">${kindName}${sizeLine ? ` · ${sizeLine}` : ""}</div>
    ${sizes ? `<div><div class="lbl">${KINDS[one.kind] ? "Size (mm)" : "Settings"}</div><div class="fields">${sizes}</div></div>` : ""}
    ${one.kind === "revolve" ? `<div><div class="lbl">Turn around</div><div class="seg"><button data-axis="y" class="${one.params.axis !== "x" ? "on" : ""}">Sketch's up line</button><button data-axis="x" class="${one.params.axis === "x" ? "on" : ""}">Sketch's side line</button></div></div>` : ""}
    ${one.kind === "sketch" ? `<div style="display:flex;gap:6px"><button class="btn pri" data-do="extrude">Extrude</button><button class="btn" data-do="revolve">Revolve</button></div>` : ""}
    <div><div class="lbl">Position (mm)</div><div class="fields">${["X", "Y", "Z"].map((a, i) => `<label>${a}<input data-pos="${i}" type="number" step="${snapSize()}" value="${+tf.p[i].toFixed(3)}"></label>`).join("")}</div></div>
    <div><div class="lbl">Rotation (°)</div><div class="fields">${["X", "Y", "Z"].map((a, i) => `<label>${a}<input data-rot="${i}" type="number" step="15" value="${+tf.r[i].toFixed(2)}"></label>`).join("")}</div></div>
    ${one.kind === "mesh" || one.kind === "brep" || one.kind === "boolean" ? `<div><div class="lbl">Scale</div><div class="fields"><label>Times<input data-scale type="number" step="0.1" min="0.001" value="${+(tf.s || 1)}"></label></div></div>` : ""}`;
  $(".name", el).onchange = (e) => design.update(one.id, { name: e.target.value.trim() || one.name });
  el.querySelectorAll("[data-axis]").forEach((b) => b.onclick = () => design.update(one.id, { params: { axis: b.dataset.axis } }));
  el.querySelectorAll("[data-do]").forEach((b) => b.onclick = () => act(b.dataset.do));
  el.querySelectorAll("[data-param]").forEach((inp) => inp.onchange = () => {
    if (inp.dataset.text !== undefined) { design.update(one.id, { params: { [inp.dataset.param]: inp.value } }); return; }
    const v = Number(inp.value);
    if (!Number.isFinite(v) || (v < 0 && inp.dataset.param !== "distance")) return;
    design.update(one.id, { params: { [inp.dataset.param]: inp.dataset.param === "sides" ? Math.round(v) : v } });
  });
  el.querySelectorAll("[data-pos]").forEach((inp) => inp.onchange = () => { const p = [...one.tf.p]; p[+inp.dataset.pos] = Number(inp.value) || 0; design.update(one.id, { tf: { p } }); });
  el.querySelectorAll("[data-rot]").forEach((inp) => inp.onchange = () => { const r = [...one.tf.r]; r[+inp.dataset.rot] = Number(inp.value) || 0; design.update(one.id, { tf: { r } }); });
  const sc = $("[data-scale]", el);
  if (sc) sc.onchange = () => { const v = Number(sc.value); if (v > 0) design.update(one.id, { tf: { s: v } }); };
}

function setColor(c) {
  if (!selection.length) { toast("Pick a part first, then choose its colour."); return; }
  design.checkpoint();
  for (const id of selection) { const p = design.find(id); if (p) p.color = c; }
  design.emit("update");
}

// ---------- Tools that take a few clicks: sketching, extrude/revolve, fillet/chamfer/shell/press-pull, measuring ----------
let tool = null;
const isSolid = (p) => p && !["mesh", "sketch"].includes(p.kind);
const displayNode = (p) => ({ ...p, tf: undefined, name: undefined, id: undefined, color: undefined });

function toolPanel(title, body, buttons = []) {
  const el = $("#props");
  el.hidden = false;
  el.innerHTML = `<div class="lbl">${esc(title)}</div><div class="tool-body">${body}</div><div style="display:flex;gap:6px;flex-wrap:wrap">${buttons.map(([id, label, cls]) => `<button class="btn ${cls || ""}" data-tb="${id}">${esc(label)}</button>`).join("")}</div>`;
  $("#quick").hidden = true;
  return el;
}

function beginTool(t) {
  endTool();
  view.stopPlacing();
  tool = t;
  view.setSelection(selection);
}

function endTool() {
  if (!tool) return;
  const t = tool;
  tool = null;
  if (t.cleanup) t.cleanup();
  view.setGroundTool(null);
  view.setSurfaceTool(null);
  view.setPreview(null);
  view.clearHighlights();
  setHint();
  refreshSelectionUI();
}

const fmt = (v) => (Math.round(v * 100) / 100).toString();

function startSketch(type) {
  const label = { rect: "Rectangle", circle2: "Circle", ngon: "Polygon", poly: "Polyline" }[type];
  let pts = [];
  const sides = () => Math.max(3, Math.min(64, Math.round(Number(settings.ngonSides) || 6)));
  const z = 0.06;
  const seg = (list, closed) => {
    const out = [];
    for (let i = 0; i < list.length - (closed ? 0 : 1); i++) {
      const a = list[i], b = list[(i + 1) % list.length];
      out.push(a[0], a[1], z, b[0], b[1], z);
    }
    return out;
  };
  const ring = (cx, cy, r, n, rot = 0) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + rot; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  const help = {
    rect: "Click one corner on the grid, then the opposite corner.",
    circle2: "Click the centre, then click to set the size.",
    ngon: "Click the centre, then click to set the size.",
    poly: "Click each corner. Click the first point again, double-click, or press Enter to finish.",
  }[type];
  const panel = () => {
    const el = toolPanel(`Sketch: ${label}`, `<div style="font-size:13px;color:#5d656e;line-height:1.5">${help}</div><div data-live style="font-size:13px;font-weight:600"></div>${type === "ngon" ? `<div class="fields"><label>Sides<input data-sides type="number" min="3" max="64" value="${sides()}"></label></div>` : ""}`, [["done", "Done", "pri"]]);
    $("[data-tb=done]", el).onclick = () => endTool();
    const sd = $("[data-sides]", el);
    if (sd) sd.onchange = () => setSetting("ngonSides", Math.max(3, Math.min(64, Math.round(Number(sd.value) || 6))));
  };
  const live = (t) => { const el = $("#props [data-live]"); if (el) el.textContent = t; };
  const finishPoly = () => {
    if (pts.length < 3) { toast("A polyline needs at least three corners."); return; }
    const made = design.addSketch({ type: "poly", points: pts.map((p) => [p[0], p[1]]) });
    pts = [];
    view.setPreview(null);
    selection = [made.id];
    view.setSelection(selection);
  };
  beginTool({ name: "sketch", enter: () => type === "poly" && finishPoly() });
  panel();
  setHint(`${help} Esc when you're done.`);
  view.setGroundTool({
    move(p) {
      if (!pts.length) { view.setPreview([p[0] - 2, p[1], z, p[0] + 2, p[1], z, p[0], p[1] - 2, z, p[0], p[1] + 2, z]); return; }
      const a = pts[0];
      if (type === "rect") { view.setPreview(seg([[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]], true)); live(`${fmt(Math.abs(p[0] - a[0]))} × ${fmt(Math.abs(p[1] - a[1]))} mm`); }
      else if (type === "circle2" || type === "ngon") {
        const r = Math.hypot(p[0] - a[0], p[1] - a[1]);
        view.setPreview(seg(ring(a[0], a[1], r, type === "circle2" ? 64 : sides(), type === "ngon" ? Math.PI / 2 : 0), true));
        live(`${type === "circle2" ? "Diameter" : "Size"} ${fmt(r * 2)} mm`);
      } else {
        view.setPreview(seg([...pts, p], false));
        const b = pts[pts.length - 1];
        live(`Line ${fmt(Math.hypot(p[0] - b[0], p[1] - b[1]))} mm`);
      }
    },
    click(p) {
      if (type === "poly") {
        if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < Math.max(1.5, snapSize() * 1.5)) { finishPoly(); return; }
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
        return;
      }
      if (!pts.length) { pts = [p]; return; }
      const a = pts[0];
      let shape = null;
      if (type === "rect") {
        const w = Math.abs(p[0] - a[0]), hh = Math.abs(p[1] - a[1]);
        if (w > 0.01 && hh > 0.01) shape = { type: "rect", x: Math.min(a[0], p[0]), y: Math.min(a[1], p[1]), w, h: hh };
      } else {
        const r = Math.hypot(p[0] - a[0], p[1] - a[1]);
        if (r > 0.01) shape = type === "circle2" ? { type: "circle", x: a[0], y: a[1], r } : { type: "ngon", x: a[0], y: a[1], r, sides: sides() };
      }
      pts = [];
      view.setPreview(null);
      if (shape) { const made = design.addSketch(shape); selection = [made.id]; view.setSelection(selection); }
    },
    dbl() { if (type === "poly") { pts.pop(); finishPoly(); } },
  });
}

function constructTool(kind) {
  let ids = selection.filter((id) => { const p = design.find(id); return p && p.kind === "sketch"; });
  if (!ids.length) {
    const sketches = design.parts.filter((p) => p.kind === "sketch");
    if (sketches.length === 1) ids = [sketches[0].id];
    else { toast(sketches.length ? "Pick the sketch to use (Shift-click to use several)." : "Draw a sketch first, from the Sketch menu."); return; }
  }
  const el = toolPanel(kind === "extrude" ? "Extrude" : "Revolve", kind === "extrude"
    ? `<div style="font-size:13px;color:#5d656e">Pushes the sketch up into a solid. Use a minus number to go down.</div><div class="fields"><label>Distance (mm)<input data-v type="number" step="${snapSize()}" value="${settings.extrudeDistance || 10}"></label></div>`
    : `<div style="font-size:13px;color:#5d656e">Spins the sketch around a line through the grid's centre, then stands the result up on the grid (draw half a vase, get the whole vase). Keep the sketch on one side of that line.</div><div class="fields"><label>Angle (°)<input data-v type="number" step="15" min="1" max="360" value="360"></label></div><div class="seg"><button data-axis="y" class="on">Up line (Y)</button><button data-axis="x">Side line (X)</button></div>`,
    [["ok", kind === "extrude" ? "Extrude" : "Revolve", "pri"], ["cancel", "Cancel"]]);
  let axis = "y";
  el.querySelectorAll("[data-axis]").forEach((b) => b.onclick = () => { axis = b.dataset.axis; el.querySelectorAll("[data-axis]").forEach((x) => x.classList.toggle("on", x === b)); });
  const apply = () => {
    const v = Number($("[data-v]", el).value);
    if (!v) { toast("Type a distance first."); return; }
    endTool();
    if (kind === "extrude") setSetting("extrudeDistance", v);
    const made = design.construct(kind, ids, kind === "extrude" ? { distance: v } : { angle: v, axis });
    select([made.id]);
  };
  beginTool({ name: kind, enter: apply });
  $("[data-tb=ok]", el).onclick = apply;
  $("[data-tb=cancel]", el).onclick = endTool;
  $("[data-v]", el).focus();
}

function modifyTool(op) {
  const first = selection.length === 1 ? design.find(selection[0]) : null;
  let target = isSolid(first) ? first : null;
  const picks = new Map(); // index -> highlight
  const what = op === "fillet" || op === "chamfer" ? "edges" : "faces";
  const one = op === "pushpull";
  const field = { fillet: ["r", "Radius (mm)", 2], chamfer: ["r", "Distance (mm)", 1], shell: ["thickness", "Wall (mm)", 2], pushpull: ["distance", "Distance (mm)", 5] }[op];
  const help = {
    fillet: "Click the edges to round. Click again to unpick.",
    chamfer: "Click the edges to bevel. Click again to unpick.",
    shell: "Click the faces to leave open (or none for a closed hollow).",
    pushpull: "Click a flat face. Plus numbers pull it out, minus numbers push it in.",
  }[op];
  const el = toolPanel(MODIFY_LABELS[op], `<div style="font-size:13px;color:#5d656e;line-height:1.5">${help}</div><div data-count style="font-size:13px;font-weight:600"></div><div class="fields"><label>${field[1]}<input data-v type="number" step="0.5" value="${settings[`${op}Value`] ?? field[2]}"></label></div>`, [["ok", "Apply", "pri"], ["cancel", "Cancel"]]);
  const count = () => { $("[data-count]", el).textContent = target ? `${target.name}: ${picks.size} ${picks.size === 1 ? what.slice(0, -1) : what} picked` : "Click the part to work on."; };
  const redraw = () => { if (target) view.setHighlights(target.id, [...picks.values()]); count(); };
  const apply = () => {
    const v = Number($("[data-v]", el).value);
    if (!target) { toast("Click a part first."); return; }
    if (!picks.size && op !== "shell") { toast(`Pick at least one ${what.slice(0, -1)}.`); return; }
    if (!Number.isFinite(v) || (op !== "pushpull" && v <= 0)) { toast("Type a size first."); return; }
    setSetting(`${op}Value`, v);
    const id = target.id, chosen = [...picks.keys()];
    endTool();
    const made = design.modify(id, op, chosen, { [field[0]]: v });
    select([made.id]);
  };
  beginTool({ name: op, enter: apply });
  $("[data-tb=ok]", el).onclick = apply;
  $("[data-tb=cancel]", el).onclick = endTool;
  count();
  setHint(help);
  view.setSurfaceTool({
    async click(hit) {
      const part = design.find(hit.partId);
      if (!isSolid(part)) { toast(part && part.kind === "mesh" ? "That's a mesh model; this works on solids." : "Click a solid part."); return; }
      if (target && part.id !== target.id) { picks.clear(); }
      target = part;
      selection = [part.id];
      view.setSelection(selection);
      try {
        const r = what === "edges" ? await kernel.pickEdge(displayNode(part), hit.local) : await kernel.pickFace(displayNode(part), hit.local);
        if (op === "pushpull" && r.type !== "PLANE") { toast("Press/Pull works on flat faces for now."); return; }
        if (picks.has(r.index)) picks.delete(r.index);
        else { if (one) picks.clear(); picks.set(r.index, what === "edges" ? { lines: r.lines } : { vertices: r.vertices, triangles: r.triangles }); }
        redraw();
      } catch (err) { toast(err.message || String(err), true); }
    },
  });
}

async function patternDialog(kind) {
  const ids = selection.slice();
  if (!ids.length) { toast("Pick the parts to copy first."); return; }
  const box = new THREE.Box3();
  ids.forEach((id) => { const g = view.groups.get(id); if (g) box.expandByObject(g); });
  const size = box.isEmpty() ? new THREE.Vector3(20, 20, 0) : box.getSize(new THREE.Vector3());
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const body = kind === "rectpattern"
    ? `<div class="fields"><label>Across (X)<input data-k="nx" type="number" min="1" value="3"></label><label>Spacing X (mm)<input data-k="dx" type="number" value="${fmt(size.x + 5)}"></label><label></label><label>Back (Y)<input data-k="ny" type="number" min="1" value="1"></label><label>Spacing Y (mm)<input data-k="dy" type="number" value="${fmt(size.y + 5)}"></label></div>`
    : `<div class="fields"><label>How many<input data-k="count" type="number" min="2" value="6"></label><label>Around (°)<input data-k="angle" type="number" min="1" max="360" value="360"></label></div><div class="seg"><button data-c="grid" class="on">Around the grid's centre</button><button data-c="part">Around the parts' centre</button></div>`;
  const m = modal(kind === "rectpattern" ? "Rectangular pattern" : "Circular pattern", body, [["Cancel", null], ["Make copies", true, "pri"]]);
  let around = "grid";
  m.body.querySelectorAll("[data-c]").forEach((b) => b.onclick = () => { around = b.dataset.c; m.body.querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x === b)); });
  const vals = () => Object.fromEntries([...m.body.querySelectorAll("[data-k]")].map((i) => [i.dataset.k, Number(i.value)]));
  const ok = await new Promise((r) => { m.onClose = r; m.foot.lastChild.onclick = () => { m.vals = vals(); m.close(true); }; });
  if (!ok) return;
  const v = m.vals;
  const made = kind === "rectpattern"
    ? design.pattern(ids, "rect", { nx: Math.max(1, Math.round(v.nx || 1)), ny: Math.max(1, Math.round(v.ny || 1)), dx: v.dx || 0, dy: v.dy || 0 })
    : design.pattern(ids, "circ", { count: Math.max(2, Math.round(v.count || 2)), angle: Math.max(1, Math.min(360, v.angle || 360)), center: around === "grid" ? [0, 0] : [c.x, c.y] });
  select([...ids, ...made.map((p) => p.id)]);
  toast(`Made ${made.length} cop${made.length === 1 ? "y" : "ies"}.`);
}

async function mirrorDialog() {
  const ids = selection.slice();
  if (!ids.length) { toast("Pick the parts to mirror first."); return; }
  const m = modal("Mirror", `<div style="font-size:13px;color:#5d656e">Makes a mirrored copy of each picked part, flipped across its own middle.</div><div class="seg"><button data-p="YZ" class="on">Left ↔ right</button><button data-p="XZ">Front ↔ back</button><button data-p="XY">Top ↔ bottom</button></div>`, [["Cancel", null], ["Mirror", true, "pri"]]);
  let plane = "YZ";
  m.body.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => { plane = b.dataset.p; m.body.querySelectorAll("[data-p]").forEach((x) => x.classList.toggle("on", x === b)); });
  const ok = await new Promise((r) => { m.onClose = r; });
  if (!ok) return;
  const centers = ids.map((id) => {
    const g = view.groups.get(id);
    const b = g ? new THREE.Box3().expandByObject(g) : null;
    const cc = b && !b.isEmpty() ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    return [cc.x, cc.y, cc.z];
  });
  const made = design.mirror(ids, plane, centers);
  // The copy lands on top of the original: move it beside it, along the mirror's direction.
  const axis = { YZ: 0, XZ: 1, XY: 2 }[plane];
  design.checkpoint(); design.undoStack.pop();
  made.forEach((p, k) => {
    const g = view.groups.get(ids[k]);
    const b = g ? new THREE.Box3().expandByObject(g) : null;
    const span = b && !b.isEmpty() ? b.getSize(new THREE.Vector3()).getComponent(axis) : 20;
    if (axis !== 2) p.tf.p[axis] += span + 5;
  });
  design.emit("update");
  select(made.map((p) => p.id));
}

function measureTool() {
  let a = null;
  const el = toolPanel("Measure", `<div style="font-size:13px;color:#5d656e">Click two points on parts or on the grid.</div><div data-out style="font-size:14px;line-height:1.7"></div>`, [["done", "Done", "pri"]]);
  $("[data-tb=done]", el).onclick = endTool;
  beginTool({ name: "measure" });
  setHint("Click two points to measure between them.");
  const out = $("[data-out]", el);
  view.setSurfaceTool({
    ground: true,
    click(hit) {
      const p = hit.world;
      if (!a) { a = p; view.setPreview([p[0] - 1.5, p[1], p[2], p[0] + 1.5, p[1], p[2], p[0], p[1] - 1.5, p[2], p[0], p[1] + 1.5, p[2]], 0xd94f00); out.textContent = "Now click the second point."; return; }
      const d = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      view.setPreview([...a, ...p], 0xd94f00);
      out.innerHTML = `<b style="font-size:18px">${fmt(Math.hypot(...d))} mm</b><br>X ${fmt(Math.abs(d[0]))} · Y ${fmt(Math.abs(d[1]))} · Z ${fmt(Math.abs(d[2]))} mm`;
      window.hcad.lastMeasure = Math.hypot(...d);
      a = null;
    },
  });
}

// ---------- Actions ----------
async function act(name) {
  try {
    switch (name) {
      case "undo": if (!design.undo()) toast("Nothing to undo."); break;
      case "redo": if (!design.redo()) toast("Nothing to redo."); break;
      case "move": view.setGizmoMode("translate"); refreshSelectionUI(); if (!selection.length) toast("Pick a part to move."); break;
      case "rotate": view.setGizmoMode("rotate"); refreshSelectionUI(); if (!selection.length) toast("Pick a part to rotate."); break;
      case "duplicate": if (selection.length) select(design.duplicate(selection, [snapSize() * 10, snapSize() * 10, 0]).map((p) => p.id)); break;
      case "delete": if (selection.length) { design.remove(selection); select([]); } break;
      case "join": case "subtract": case "intersect": {
        if (selection.length < 2) { toast(name === "subtract" ? "Pick the part to keep first, then Shift-click the parts that cut it." : "Shift-click two or more parts first."); break; }
        const made = design.combine(name, selection);
        select([made.id]);
        break;
      }
      case "separate": {
        const one = selection.length === 1 && design.find(selection[0]);
        if (!one || !(one.kind === "boolean" || (one.kind === "modify" && one.op !== "mirror"))) { toast("Pick a joined, subtracted, intersected or filleted part to separate."); break; }
        select(design.separate(one.id).map((p) => p.id));
        break;
      }
      case "rect": case "circle2": case "ngon": case "poly": startSketch(name); break;
      case "extrude": case "revolve": constructTool(name); break;
      case "pushpull": case "fillet": case "chamfer": case "shell": modifyTool(name); break;
      case "rectpattern": case "circpattern": await patternDialog(name); break;
      case "mirror": await mirrorDialog(); break;
      case "group": {
        if (selection.length < 2) { toast("Shift-click two or more parts to group them."); break; }
        select([design.combine("group", selection).id]);
        break;
      }
      case "ungroup": {
        const g = selection.length === 1 && design.find(selection[0]);
        if (!g || g.op !== "group") { toast("Pick a group to ungroup."); break; }
        select(design.separate(g.id).map((p) => p.id));
        break;
      }
      case "measure": measureTool(); break;
      case "text": startPlacing("text"); break;
      case "new": if (await okToDiscard()) { design.clear(); filePath = null; select([]); refreshTitle(); view.setView("home"); } break;
      case "open": await openDesign(); break;
      case "import": await importModels(); break;
      case "save": await saveDesign(false); break;
      case "saveas": await saveDesign(true); break;
      case "export": await exportDialog(); break;
      case "convert": await convertDialog(); break;
      case "help": helpDialog(); break;
      case "exit": if (await okToDiscard()) window.__TAURI__.window.getCurrentWindow().destroy(); break;
      default: break;
    }
  } catch (err) {
    toast(err.message || String(err), true);
  }
}

const lastDir = () => settings.lastDir || env.models || env.home || "";
const rememberDir = (path) => setSetting("lastDir", files.dirName(path));

async function okToDiscard() {
  if (!design.dirty || !design.parts.length) return true;
  return new Promise((resolve) => {
    const m = modal("Unsaved changes", `<div style="font-size:14px">This design has changes that aren't saved. Throw them away?</div>`, [["Keep editing", false], ["Throw away", true, "pri"]]);
    m.onClose = resolve;
  });
}

async function openDesign() {
  if (!(await okToDiscard())) return;
  const picked = await files.pickFile({ title: "Open", exts: OPEN_EXTS, startDir: lastDir() });
  if (!picked) return;
  const path = picked[0];
  rememberDir(path);
  if (files.extOf(path) !== "hcad") {
    design.clear(); filePath = null;
    await importPaths([path]);
    refreshTitle();
    return;
  }
  const bytes = await files.readFile(path);
  design.loadFile(new TextDecoder().decode(bytes));
  filePath = path;
  select([]);
  refreshTitle();
  await idle();
  view.setView("home");
}

async function importModels() {
  const picked = await files.pickFile({ title: "Import models", exts: IMPORT_EXTS, multiple: true, startDir: lastDir() });
  if (!picked) return;
  rememberDir(picked[0]);
  await importPaths(picked);
}

async function importPaths(paths) {
  const made = [];
  // New models go in a row to the right of what's already there, so they never land inside each other.
  const box = view.contentBox();
  let x = box.isEmpty() ? null : box.max.x + 20;
  for (const path of paths) {
    const name = files.baseName(path).replace(/\.[^.]+$/, "");
    try {
      const model = await readModel(path, await files.readFile(path));
      const w = (model.size && model.size[0]) || 20;
      const cx = x === null ? 0 : x + w / 2;
      x = (x === null ? w / 2 : x + w) + 20;
      const part = model.kind === "solid"
        ? design.addSolid(name, model.brep, [cx + model.offset[0], model.offset[1], model.offset[2]])
        : design.addMesh(name, model.positions, [cx, 0, 0]);
      made.push(part.id);
    } catch (err) {
      toast(`${files.baseName(path)}: ${err.message || err}`, true);
    }
  }
  if (made.length) { await idle(); select(made); view.fit(); }
}

async function saveDesign(asCopy) {
  let path = filePath;
  if (!path || asCopy) {
    path = await files.pickFile({ title: asCopy ? "Save a copy" : "Save design", mode: "save", saveExts: ["hcad"], suggestedName: filePath ? files.baseName(filePath) : "My design.hcad", startDir: lastDir() });
    if (!path) return;
    rememberDir(path);
  }
  await files.writeFile(path, new TextEncoder().encode(design.toFile()));
  if (!asCopy) { filePath = path; design.dirty = false; }
  refreshTitle();
  toast(`Saved ${files.baseName(path)}`);
}

function waitSynced() {
  return new Promise((resolve) => {
    const start = window.hcad.synced || 0;
    const tick = () => ((window.hcad.synced || 0) > start ? resolve() : setTimeout(tick, 50));
    setTimeout(tick, 50);
  });
}

// ---------- Dialogs ----------
function modal(title, body, buttons = [["Close", null]]) {
  const back = h(`<div class="modal-back"><div class="modal" role="dialog" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" aria-label="Close">✕</button></div><div class="modal-body"></div><div class="modal-foot"></div></div></div>`);
  $(".modal-body", back).innerHTML = body;
  const m = { el: back, body: $(".modal-body", back), foot: $(".modal-foot", back), onClose: null, close: (v) => { back.remove(); document.removeEventListener("keydown", key, true); m.onClose && m.onClose(v); } };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); m.close(null); } };
  document.addEventListener("keydown", key, true);
  $(".icon-btn", back).onclick = () => m.close(null);
  for (const [label, value, cls] of buttons) {
    const b = h(`<button class="btn ${cls || ""}">${esc(label)}</button>`);
    b.onclick = () => m.close(value);
    m.foot.appendChild(b);
  }
  document.body.appendChild(back);
  return m;
}

function formatPicker(current, onPick) {
  return `<div class="fmt-list">${EXPORT_FORMATS.map((f) => `<button class="fmt${f.ext === current ? " on" : ""}" data-fmt="${f.ext}">${f.label}<small>${f.note}</small></button>`).join("")}</div>`;
}
function wireFormats(m, state) {
  m.body.querySelectorAll("[data-fmt]").forEach((b) => b.onclick = () => { state.ext = b.dataset.fmt; m.body.querySelectorAll("[data-fmt]").forEach((x) => x.classList.toggle("on", x === b)); state.onChange && state.onChange(); });
  m.body.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => { state.quality = b.dataset.q; m.body.querySelectorAll("[data-q]").forEach((x) => x.classList.toggle("on", x === b)); });
}
const qualityPicker = (q) => `<div><div class="mlbl">Smoothness of curves</div><div class="seg">${["draft", "normal", "fine"].map((v) => `<button data-q="${v}" class="${v === q ? "on" : ""}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div></div>`;

async function exportDialog() {
  if (!design.parts.length) { toast("There's nothing to export yet."); return; }
  const state = { ext: settings.exportFormat || "stl", quality: settings.exportQuality || "normal" };
  const m = modal(`Export ${filePath ? `“${esc(files.baseName(filePath).replace(/\.hcad$/, ""))}”` : "design"}`, `
    <div><div class="mlbl">Format</div>${formatPicker(state.ext)}</div>
    ${qualityPicker(state.quality)}
    <label class="chk"><input type="checkbox" data-sel ${selection.length ? "" : "disabled"}> Only the picked parts${selection.length ? ` (${selection.length})` : ""}</label>`, [["Cancel", null], ["Export…", true, "pri"]]);
  wireFormats(m, state);
  const go = await new Promise((r) => { m.onClose = r; const only = $("[data-sel]", m.body); m.foot.lastChild.onclick = () => { state.only = only.checked; m.close(true); }; });
  if (!go) return;
  setSetting("exportFormat", state.ext); setSetting("exportQuality", state.quality);
  const parts = state.only ? selection.map((id) => design.find(id)).filter(Boolean) : design.parts;
  const base = (filePath ? files.baseName(filePath).replace(/\.hcad$/, "") : parts.length === 1 ? parts[0].name : "design").replace(/[\\/:*?"<>|]/g, "-");
  const path = await files.pickFile({ title: `Export ${state.ext.toUpperCase()}`, mode: "save", saveExts: [state.ext], suggestedName: `${base}.${state.ext}`, startDir: lastDir() });
  if (!path) return;
  rememberDir(path);
  toast("Exporting…");
  const { bytes, skipped } = await writeModel(state.ext, design, parts, { quality: state.quality });
  await files.writeFile(path, bytes);
  toast(`Exported ${files.baseName(path)}${skipped ? ` (${skipped} mesh part${skipped > 1 ? "s" : ""} left out: STEP holds solids only)` : ""}`);
}

async function convertDialog() {
  const state = { ext: settings.convertFormat || "stl", quality: settings.exportQuality || "normal", inputs: [] };
  const m = modal("Convert files", `
    <div style="font-size:13px;color:#5d656e">Turn models into another format. The new files go next to the originals, with the same names.</div>
    <div style="display:flex;gap:10px;align-items:center"><button class="btn" data-add>Choose files…</button><span data-count style="font-size:13px;color:#5d656e">No files chosen</span></div>
    <div class="jobs" data-jobs hidden></div>
    <div><div class="mlbl">Convert to</div>${formatPicker(state.ext)}</div>
    ${qualityPicker(state.quality)}`, [["Close", null], ["Convert", true, "pri"]]);
  wireFormats(m, state);
  const jobs = $("[data-jobs]", m.body);
  const runBtn = m.foot.lastChild;
  runBtn.disabled = true;
  const draw = () => {
    jobs.hidden = !state.inputs.length;
    $("[data-count]", m.body).textContent = state.inputs.length ? `${state.inputs.length} file${state.inputs.length > 1 ? "s" : ""}` : "No files chosen";
    jobs.innerHTML = state.inputs.map((j, i) => `<div class="job"><span>${esc(files.baseName(j.path))}</span><span class="st ${j.st || "wait"}" data-i="${i}">${esc(j.msg || "Ready")}</span></div>`).join("");
    runBtn.disabled = !state.inputs.length;
  };
  $("[data-add]", m.body).onclick = async () => {
    const picked = await files.pickFile({ title: "Choose files to convert", exts: IMPORT_EXTS.concat(["hcad"]), multiple: true, startDir: lastDir() });
    if (!picked) return;
    rememberDir(picked[0]);
    state.inputs = picked.map((path) => ({ path }));
    draw();
  };
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    setSetting("convertFormat", state.ext);
    for (const j of state.inputs) {
      j.st = "wait"; j.msg = "Working…"; draw();
      try {
        const out = await convertOne(j.path, state.ext, state.quality);
        j.st = "ok"; j.msg = `Done → ${files.baseName(out)}`;
      } catch (err) {
        j.st = "bad"; j.msg = err.message || String(err);
      }
      draw();
    }
    runBtn.disabled = false;
  };
}

// Converts one file without touching the design that's open.
export async function convertOne(path, ext, quality = "normal") {
  const tmp = new Design();
  const bytes = await files.readFile(path);
  if (files.extOf(path) === "hcad") tmp.loadFile(new TextDecoder().decode(bytes));
  else {
    const model = await readModel(path, bytes);
    if (model.kind === "solid") tmp.addSolid("Part", model.brep); else tmp.addMesh("Part", model.positions);
  }
  const out = path.replace(/\.[^./]+$/, "") + "." + ext;
  if (out === path) throw new Error("It's already that format.");
  const { bytes: data } = await writeModel(ext, tmp, tmp.parts, { quality });
  await files.writeFile(out, data);
  return out;
}

function helpDialog() {
  modal("Getting around", `
    <div style="font-size:14px;line-height:1.7">
      <b>Add a shape:</b> Primitives, then click on the grid.<br>
      <b>Pick parts:</b> click; Shift-click to pick more.<br>
      <b>Move or rotate:</b> drag the handles (M / R switch between them), or type numbers on the left.<br>
      <b>Combine:</b> pick two or more, then Join, Subtract or Intersect on the round bar. For Subtract, pick the part to keep first.<br>
      <b>Look around:</b> right-drag to orbit, middle-drag to pan, the wheel to zoom, F to fit, or click the view cube.<br>
      <b>Keys:</b> Ctrl+Z undo, Ctrl+Y redo, Ctrl+D duplicate, Delete, Ctrl+S save, Ctrl+E export, Esc to stop.
    </div>`);
}

// ---------- Keys ----------
document.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-back")) return;
  const typing = e.target.closest("input, textarea, select");
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (k === "escape") { closeMenus(); if (tool) endTool(); else if (view.placing) stopPlacing(); else if (!typing) select([]); return; }
  if (ctrl && k === "z" && !e.shiftKey && !typing) { e.preventDefault(); act("undo"); return; }
  if (ctrl && (k === "y" || (k === "z" && e.shiftKey)) && !typing) { e.preventDefault(); act("redo"); return; }
  if (ctrl && k === "s") { e.preventDefault(); act(e.shiftKey ? "saveas" : "save"); return; }
  if (ctrl && k === "o") { e.preventDefault(); act("open"); return; }
  if (ctrl && k === "n") { e.preventDefault(); act("new"); return; }
  if (ctrl && k === "i") { e.preventDefault(); act("import"); return; }
  if (ctrl && k === "e") { e.preventDefault(); act("export"); return; }
  if (k === "enter" && tool && tool.enter && (!typing || typing.closest("#props"))) { e.preventDefault(); tool.enter(); return; }
  if (typing) return;
  if (ctrl && k === "d") { e.preventDefault(); act("duplicate"); return; }
  if (ctrl && k === "a") { e.preventDefault(); select(design.parts.map((p) => p.id)); return; }
  if (k === "delete" || k === "backspace") { act("delete"); return; }
  if (k === "m") act("move");
  if (k === "r") act("rotate");
  if (k === "f") view.fit();
});

// ---------- Start ----------
const view = new Viewport($("#view"), {
  onPick: (id, add) => {
    if (!id) { if (!add) select([]); return; }
    if (add) select(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
    else select([id]);
  },
  onPlace: (kind, at) => {
    const part = design.addShape(kind, at);
    stopPlacing();
    select([part.id]);
  },
  onTransformEnd: (changes) => {
    if (!changes.length) return;
    design.checkpoint();
    for (const c of changes) { const p = design.find(c.id); if (p) p.tf = { ...p.tf, ...c.tf }; }
    design.emit("update");
  },
  onDragInfo: (t) => { const d = $("#draginfo"); d.hidden = !t; d.textContent = t; },
});

window.hcad = { design, view, act, select, idle, endTool, get tool() { return tool; }, convertOne, importPaths, files, readModel, writeModel, kernel, DesignClass, get selection() { return selection; }, synced: 0, ready: false };

async function main() {
  buildTopbar();
  buildViewControls();
  setHint();
  try { env = await files.init(); } catch (_) { /* browser */ }
  try { settings = (await files.loadSettings()) || {}; } catch (e) { toast(`Settings couldn't be read: ${e.message || e}`, true); }
  view.setSnap(snapOn() ? snapSize() : 0);
  view.setStyle(settings.style || "edges");
  view.showGrid(settings.showGrid !== false);
  if (settings.projection === "ortho") view.setProjection("ortho");
  refreshNav(); refreshUnits(); refreshSnapButton();
  view.setView("home");
  if (files.isApp) {
    window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (e) => {
      if (!design.dirty || !design.parts.length) return;
      e.preventDefault();
      if (await okToDiscard()) window.__TAURI__.window.getCurrentWindow().destroy();
    });
  }
  try {
    await kernel.start();
    $("#boot").hidden = true;
  } catch (err) {
    $("#boot .boot-card").textContent = err.message || String(err);
    return;
  }
  window.hcad.ready = true;
  if (env.file) {
    try {
      if (files.extOf(env.file) === "hcad") { design.loadFile(new TextDecoder().decode(await files.readFile(env.file))); filePath = env.file; }
      else await importPaths([env.file]);
      refreshTitle();
    } catch (err) { toast(err.message || String(err), true); }
  }
  refreshTitle();
}
main();
