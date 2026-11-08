// Files and settings: through the app's Rust side (Tauri) in the real window, or a small in-memory stand-in when the
// page runs in a plain browser (the CI screenshots). Plus the app's own file picker, styled like the rest of it.
import { toBase64, fromBase64 } from "./doc.js";

const tauri = typeof window !== "undefined" && window.__TAURI__ && window.__TAURI__.core;

// The stand-in: a folder tree in memory, filled by tests through window.hcadTestFS.
const memFS = (typeof window !== "undefined" && (window.hcadTestFS = window.hcadTestFS || { "/home/you/Models": {} })) || {};
const memSettings = {};

function memDir(path) {
  const d = memFS[path];
  if (!d) throw new Error("That folder isn't there.");
  return d;
}
const split = (p) => { const i = p.lastIndexOf("/"); return [p.slice(0, i) || "/", p.slice(i + 1)]; };

export const isApp = !!tauri;

export async function init() {
  if (tauri) return tauri.invoke("init");
  return { file: null, home: "/home/you", models: "/home/you/Models", platform: "browser" };
}

export async function readFile(path) {
  if (tauri) return fromBase64(await tauri.invoke("read_file", { path }));
  const [dir, name] = split(path);
  const b = memDir(dir)[name];
  if (!b) throw new Error("That file isn't there.");
  return b;
}

export async function writeFile(path, bytes) {
  if (tauri) return tauri.invoke("write_file", { path, data: toBase64(bytes) });
  const [dir, name] = split(path);
  memDir(dir)[name] = bytes;
}

export async function browse(dir) {
  if (tauri) return tauri.invoke("browse", { dir });
  if (!dir) dir = "/home/you/Models";
  const d = memDir(dir);
  const sub = Object.keys(memFS).filter((k) => k !== dir && split(k)[0] === dir).map((k) => ({ name: split(k)[1], path: k, dir: true, size: 0 }));
  const files = Object.entries(d).map(([name, b]) => ({ name, path: `${dir}/${name}`, dir: false, size: b.length }));
  return { dir, parent: dir === "/" ? null : split(dir)[0], entries: [...sub, ...files] };
}

export async function loadSettings() {
  if (tauri) return tauri.invoke("settings_load");
  return { ...memSettings };
}

// Saves only what changed; the Rust side merges it into the file on disk (never overwriting other settings).
export async function saveSettings(patch) {
  if (tauri) return tauri.invoke("settings_save", { patch });
  Object.assign(memSettings, patch);
  return { ...memSettings };
}

export const extOf = (name) => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); };
export const baseName = (path) => split(path)[1];
export const dirName = (path) => split(path)[0];

const FOLDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>';
const FILE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>';
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : n ? `${n} B` : "");

// The file picker. mode: "open" (one or several files) or "save" (a folder and a name).
// Resolves to an array of paths (open), one path (save), or null if cancelled.
export function pickFile({ title, mode = "open", exts = [], multiple = false, startDir, suggestedName = "", saveExts = [] }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-back";
    wrap.innerHTML = `
      <div class="modal picker" role="dialog" aria-label="${title}">
        <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-x aria-label="Close">✕</button></div>
        <div class="picker-path"><button class="btn" data-up>Up</button><input class="picker-dir" aria-label="Folder"></div>
        <div class="picker-list" role="listbox" aria-label="Files"></div>
        <div class="picker-foot">
          ${mode === "save" ? `<label class="picker-name">File name <input data-name value="${suggestedName}"></label>` : `<span class="picker-hint">${exts.length ? `Shows ${exts.map((e) => "." + e).join(", ")}` : ""}</span>`}
          <span class="grow"></span>
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn pri" data-ok>${mode === "save" ? "Save" : "Open"}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const list = wrap.querySelector(".picker-list");
    const dirInput = wrap.querySelector(".picker-dir");
    const nameInput = wrap.querySelector("[data-name]");
    let current = null;
    let chosen = new Set();

    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onKey, true);

    async function go(dir) {
      try {
        const r = await browse(dir);
        current = r;
        chosen = new Set();
        dirInput.value = r.dir;
        const shown = r.entries.filter((e) => e.dir || !exts.length || exts.includes(extOf(e.name)));
        list.innerHTML = shown.length ? "" : `<div class="picker-empty">Nothing here to ${mode === "save" ? "save over" : "open"}.</div>`;
        for (const e of shown) {
          const row = document.createElement("button");
          row.className = "picker-row";
          row.setAttribute("role", "option");
          row.dataset.path = e.path;
          row.innerHTML = `<span class="picker-ico">${e.dir ? FOLDER : FILE}</span><span class="picker-n"></span><span class="picker-s">${e.dir ? "" : fmtSize(e.size)}</span>`;
          row.querySelector(".picker-n").textContent = e.name;
          row.onclick = (ev) => {
            if (e.dir) return;
            if (mode === "save") { nameInput.value = e.name; return; }
            if (!(multiple && (ev.ctrlKey || ev.shiftKey || ev.metaKey))) { chosen.clear(); list.querySelectorAll(".on").forEach((x) => x.classList.remove("on")); }
            chosen.has(e.path) ? chosen.delete(e.path) : chosen.add(e.path);
            row.classList.toggle("on", chosen.has(e.path));
          };
          row.ondblclick = () => { if (e.dir) go(e.path); else if (mode === "open") done([e.path]); else ok(); };
          list.appendChild(row);
        }
      } catch (err) {
        list.innerHTML = `<div class="picker-empty"></div>`;
        list.firstChild.textContent = err.message || String(err);
      }
    }

    function ok() {
      if (mode === "open") { if (chosen.size) done([...chosen]); return; }
      let name = (nameInput.value || "").trim();
      if (!name) { nameInput.focus(); return; }
      if (saveExts.length && !saveExts.includes(extOf(name))) name = `${name}.${saveExts[0]}`;
      done(`${current.dir.replace(/\/$/, "")}/${name}`);
    }

    wrap.querySelector("[data-x]").onclick = () => done(null);
    wrap.querySelector("[data-cancel]").onclick = () => done(null);
    wrap.querySelector("[data-ok]").onclick = ok;
    wrap.querySelector("[data-up]").onclick = () => current && current.parent && go(current.parent);
    dirInput.onkeydown = (e) => { if (e.key === "Enter") go(dirInput.value); };
    if (nameInput) nameInput.onkeydown = (e) => { if (e.key === "Enter") ok(); };
    go(startDir || "");
  });
}
