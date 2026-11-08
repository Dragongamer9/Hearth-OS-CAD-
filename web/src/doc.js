// The design: a list of parts. A part is a shape with sizes (box, cylinder…), a solid read from a STEP file, a
// triangle mesh read from STL/3MF/OBJ/PLY/GLB, or a join/subtract/intersect of other parts (kept inside it, so it can
// be rebuilt exactly). Every change goes through here so undo and redo always work.

export const KINDS = {
  box: { label: "Box", params: { w: 20, d: 20, h: 20 } },
  cylinder: { label: "Cylinder", params: { r: 10, h: 20 } },
  sphere: { label: "Sphere", params: { r: 10 } },
  cone: { label: "Cone", params: { r1: 10, r2: 0, h: 20 } },
  torus: { label: "Torus", params: { R: 10, r: 3 } },
  wedge: { label: "Wedge", params: { w: 20, d: 20, h: 20 } },
  prism: { label: "Prism", params: { r: 10, sides: 6, h: 20 } },
};

export const PARAM_LABELS = {
  w: "Width", d: "Depth", h: "Height", r: "Radius", r1: "Bottom radius", r2: "Top radius", R: "Ring radius", sides: "Sides",
};

export const OP_LABELS = { join: "Joined", subtract: "Subtracted", intersect: "Intersected" };

const COLORS = ["#7fb2e6", "#e8a35f", "#86c98f", "#d98bd0", "#e6d36e", "#8fd3d6", "#e68383"];

let counter = 1;
const newId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;

export class Design {
  constructor() {
    this.parts = [];          // top-level parts, in the order they were made
    this.meshes = new Map();  // meshRef -> { positions: Float32Array } (never changed once added)
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.dirty = false;
    this.colorIndex = 0;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(why) { for (const fn of this.listeners) fn(why); }

  snapshot() { return JSON.stringify(this.parts); }

  // Call before every change: saves where we were so Undo can come back to it.
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.parts = JSON.parse(this.undoStack.pop());
    this.dirty = true;
    this.emit("undo");
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.parts = JSON.parse(this.redoStack.pop());
    this.dirty = true;
    this.emit("redo");
    return true;
  }

  find(id) { return this.parts.find((p) => p.id === id) || null; }

  nextColor() { return COLORS[this.colorIndex++ % COLORS.length]; }

  addShape(kind, at = [0, 0, 0], params = null) {
    const k = KINDS[kind];
    const n = this.parts.filter((p) => p.kind === kind).length + 1;
    const part = {
      id: newId(), name: `${k.label} ${n}`, kind,
      params: { ...k.params, ...(params || {}) },
      tf: { p: [...at], r: [0, 0, 0], s: 1 },
      color: this.nextColor(),
    };
    this.checkpoint();
    this.parts.push(part);
    this.emit("add");
    return part;
  }

  addSolid(name, brep, at = [0, 0, 0]) {
    const part = { id: newId(), name, kind: "brep", brep, tf: { p: [...at], r: [0, 0, 0], s: 1 }, color: this.nextColor() };
    this.checkpoint();
    this.parts.push(part);
    this.emit("add");
    return part;
  }

  addMesh(name, positions, at = [0, 0, 0], color = null) {
    const meshRef = newId();
    this.meshes.set(meshRef, { positions });
    const part = { id: newId(), name, kind: "mesh", meshRef, tf: { p: [...at], r: [0, 0, 0], s: 1 }, color: color || this.nextColor() };
    this.checkpoint();
    this.parts.push(part);
    this.emit("add");
    return part;
  }

  update(id, patch, { record = true } = {}) {
    const part = this.find(id);
    if (!part) return;
    if (record) this.checkpoint();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "params" || k === "tf") part[k] = { ...part[k], ...v };
      else part[k] = v;
    }
    this.emit("update");
  }

  remove(ids) {
    const set = new Set(ids);
    if (!this.parts.some((p) => set.has(p.id))) return;
    this.checkpoint();
    this.parts = this.parts.filter((p) => !set.has(p.id));
    this.emit("remove");
  }

  duplicate(ids, offset = [10, 10, 0]) {
    const made = [];
    this.checkpoint();
    for (const id of ids) {
      const src = this.find(id);
      if (!src) continue;
      const copy = JSON.parse(JSON.stringify(src));
      reid(copy);
      copy.name = `${src.name} copy`;
      copy.tf.p = copy.tf.p.map((v, i) => v + offset[i]);
      this.parts.push(copy);
      made.push(copy);
    }
    this.emit("add");
    return made;
  }

  // Join, subtract (the first part keeps, the others cut it) or intersect. The parts go inside the new one.
  combine(op, ids) {
    const parts = ids.map((id) => this.find(id)).filter(Boolean);
    if (parts.length < 2) throw new Error("Pick at least two parts.");
    if (parts.some((p) => p.kind === "mesh")) throw new Error("Mesh models (STL, OBJ…) can't be combined yet. That's coming in a later update.");
    const first = parts[0];
    const part = {
      id: newId(), name: `${first.name} (${OP_LABELS[op].toLowerCase()})`, kind: "boolean", op,
      children: parts.map((p) => JSON.parse(JSON.stringify(p))),
      tf: { p: [0, 0, 0], r: [0, 0, 0], s: 1 }, color: first.color,
    };
    this.checkpoint();
    const set = new Set(ids);
    const at = this.parts.findIndex((p) => set.has(p.id));
    this.parts = this.parts.filter((p) => !set.has(p.id));
    this.parts.splice(Math.max(0, at), 0, part);
    this.emit("combine");
    return part;
  }

  // Undoes a combine on one part, putting its pieces back where they were.
  separate(id) {
    const part = this.find(id);
    if (!part || part.kind !== "boolean") return [];
    this.checkpoint();
    const i = this.parts.indexOf(part);
    const kids = part.children.map((c) => {
      const k = JSON.parse(JSON.stringify(c));
      k.tf = composeTf(part.tf, k.tf);
      return k;
    });
    this.parts.splice(i, 1, ...kids);
    this.emit("separate");
    return kids;
  }

  clear() {
    this.parts = [];
    this.meshes.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.emit("load");
  }

  // .hcad files: JSON with the parts, and mesh triangles stored as base64.
  toFile() {
    const meshes = {};
    const used = new Set();
    const walk = (p) => { if (p.kind === "mesh") used.add(p.meshRef); (p.children || []).forEach(walk); };
    this.parts.forEach(walk);
    for (const ref of used) {
      const m = this.meshes.get(ref);
      if (m) meshes[ref] = toBase64(new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
    }
    return JSON.stringify({ format: "hearth-os-cad", formatVersion: 1, units: "mm", parts: this.parts, meshes });
  }

  loadFile(text) {
    const data = JSON.parse(text);
    if (data.format !== "hearth-os-cad" || !Array.isArray(data.parts)) throw new Error("That isn't a Hearth OS CAD design.");
    this.parts = data.parts;
    this.meshes.clear();
    for (const [ref, b64] of Object.entries(data.meshes || {})) {
      const bytes = fromBase64(b64);
      this.meshes.set(ref, { positions: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) });
    }
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.emit("load");
  }
}

function reid(p) {
  p.id = newId();
  (p.children || []).forEach(reid);
}

// A part's placement inside a combined part, written as a placement of its own (only when the combined part was
// moved without rotating or scaling, which is what 123D-style editing does; otherwise kept as the combine's).
function composeTf(outer, inner) {
  const noTurn = (outer.r || []).every((v) => !v) && (outer.s || 1) === 1;
  if (!noTurn) return inner;
  return { ...inner, p: inner.p.map((v, i) => v + (outer.p[i] || 0)) };
}

export function toBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
