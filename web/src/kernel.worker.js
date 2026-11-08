// The geometry engine: OpenCascade (through replicad) in a worker, so the window never freezes while it works.
// The page sends a design node (a shape with its sizes and placement, or a join/subtract/intersect of other nodes,
// or a solid read from a STEP file) and gets back triangles to draw, edges to outline, or a STEP file.
import opencascade from "replicad-opencascadejs";
import {
  setOC, makeBox, makeCylinder, makeSphere, draw, drawCircle, drawPolysides, drawRectangle, drawText, loadFont,
  importSTEP, exportSTEP, deserializeShape, makeCompound, makeVertex, measureDistanceBetween, basicFaceExtrusion,
} from "replicad";

let ready = null;
function boot() {
  if (!ready) {
    ready = opencascade({ locateFile: () => new URL("./replicad_single.wasm", self.location.href).href })
      .then((OC) => { setOC(OC); return true; });
  }
  return ready;
}

let font = null;
function fontReady() {
  if (!font) font = loadFont(new URL("./fonts/DejaVuSans-Bold.ttf", self.location.href).href, "default");
  return font;
}

// Built shapes, keyed by the node they came from, so moving one part doesn't rebuild every other one.
const cache = new Map();
const CACHE_MAX = 64;
function remember(key, shape) {
  if (cache.size >= CACHE_MAX) {
    const [k, old] = cache.entries().next().value;
    cache.delete(k);
    try { old.delete(); } catch (_) { /* already freed */ }
  }
  cache.set(key, shape);
}

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

function recentre(shape) {
  // Puts a shape's footprint in the middle and its bottom on the grid, the way 123D drops shapes.
  const [[x0, y0, z0], [x1, y1]] = shape.boundingBox.bounds;
  return shape.translate([-(x0 + x1) / 2, -(y0 + y1) / 2, -z0]);
}

function primitive(kind, p) {
  switch (kind) {
    case "box": {
      const w = num(p.w, 20), d = num(p.d, 20), h = num(p.h, 20);
      return makeBox([-w / 2, -d / 2, 0], [w / 2, d / 2, h]);
    }
    case "cylinder":
      return makeCylinder(num(p.r, 10), num(p.h, 20), [0, 0, 0], [0, 0, 1]);
    case "sphere": {
      const r = num(p.r, 10);
      return makeSphere(r).translate([0, 0, r]);
    }
    case "cone": {
      const r1 = num(p.r1, 10), h = num(p.h, 20);
      const r2 = Math.max(0, +p.r2 || 0);
      let pen = draw([0, 0]).lineTo([r1, 0]);
      pen = r2 > 0.001 ? pen.lineTo([r2, h]).lineTo([0, h]) : pen.lineTo([0, h]);
      return pen.close().sketchOnPlane("XZ").revolve();
    }
    case "torus": {
      const r = num(p.r, 3);
      const R = Math.max(num(p.R, 10), r + 0.1);
      return drawCircle(r).translate(R, r).sketchOnPlane("XZ").revolve();
    }
    case "wedge": {
      const w = num(p.w, 20), d = num(p.d, 20), h = num(p.h, 20);
      return recentre(draw([0, 0]).lineTo([w, 0]).lineTo([0, h]).close().sketchOnPlane("XZ").extrude(d));
    }
    case "prism": {
      const sides = Math.min(64, Math.max(3, Math.round(+p.sides || 6)));
      return drawPolysides(num(p.r, 10), sides).sketchOnPlane("XY").extrude(num(p.h, 20));
    }
    case "text": {
      const t = String(p.text || "").trim() || "Text";
      return recentre(drawText(t, { fontSize: num(p.size, 10), fontFamily: "default" }).sketchOnPlane("XY").extrude(num(p.depth, 3)));
    }
    default:
      throw new Error(`Unknown shape "${kind}"`);
  }
}

// A sketch's shapes as one flat drawing: shapes inside a bigger one become holes, the rest are joined.
function sketchDrawing(sk) {
  const items = (sk.shapes || []).map((sh) => {
    let d, box;
    if (sh.type === "rect") {
      const w = Math.abs(sh.w), hh = Math.abs(sh.h);
      d = drawRectangle(w, hh).translate(sh.x + sh.w / 2, sh.y + sh.h / 2);
      box = [Math.min(sh.x, sh.x + sh.w), Math.min(sh.y, sh.y + sh.h), Math.max(sh.x, sh.x + sh.w), Math.max(sh.y, sh.y + sh.h)];
    } else if (sh.type === "circle") {
      d = drawCircle(sh.r).translate(sh.x, sh.y);
      box = [sh.x - sh.r, sh.y - sh.r, sh.x + sh.r, sh.y + sh.r];
    } else if (sh.type === "ngon") {
      d = drawPolysides(sh.r, Math.max(3, Math.round(sh.sides || 6))).translate(sh.x, sh.y);
      box = [sh.x - sh.r, sh.y - sh.r, sh.x + sh.r, sh.y + sh.r];
    } else if (sh.type === "poly") {
      const pts = sh.points;
      if (!pts || pts.length < 3) throw new Error("A drawn outline needs at least three points.");
      let pen = draw(pts[0]);
      for (const q of pts.slice(1)) pen = pen.lineTo(q);
      d = pen.close();
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    } else throw new Error(`Unknown sketch shape "${sh.type}"`);
    return { d, box, area: (box[2] - box[0]) * (box[3] - box[1]) };
  });
  if (!items.length) throw new Error("That sketch is empty.");
  items.sort((a, b) => b.area - a.area);
  const inside = (a, b) => a[0] >= b[0] - 1e-6 && a[1] >= b[1] - 1e-6 && a[2] <= b[2] + 1e-6 && a[3] <= b[3] + 1e-6;
  let out = items[0].d;
  for (const it of items.slice(1)) {
    out = inside(it.box, items[0].box) ? out.cut(it.d) : out.fuse(it.d);
  }
  return out;
}

const facesOf = (shape) => shape.faces;
const edgesOf = (shape) => shape.edges;
function pick(list, idx) {
  const chosen = (idx || []).map((i) => list[i]).filter(Boolean);
  if (!chosen.length) throw new Error("Those faces or edges aren't on this shape any more. Pick them again.");
  return chosen;
}

function place(shape, tf) {
  if (!tf) return shape;
  const s = num(tf.s, 1);
  if (Math.abs(s - 1) > 1e-9) shape = shape.scale(s, [0, 0, 0]);
  const [rx, ry, rz] = tf.r || [0, 0, 0];
  // Same order as the 3D view (three.js "XYZ" Euler): Z first, then Y, then X, all about the shape's own origin.
  if (rz) shape = shape.rotate(rz, [0, 0, 0], [0, 0, 1]);
  if (ry) shape = shape.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rx) shape = shape.rotate(rx, [0, 0, 0], [1, 0, 0]);
  const [x, y, z] = tf.p || [0, 0, 0];
  if (x || y || z) shape = shape.translate([x, y, z]);
  return shape;
}

function buildRaw(node) {
  if (node.kind === "boolean" && node.op === "group") {
    return makeCompound((node.children || []).map((c) => build(c).clone()));
  }
  if (node.kind === "sketch") throw new Error("A sketch is flat; extrude or revolve it to make a solid.");
  if (node.kind === "extrude" || node.kind === "revolve") {
    const sk = node.sketch;
    const z = 0;
    const sketch = sketchDrawing(sk).sketchOnPlane("XY", z);
    let solid;
    if (node.kind === "extrude") {
      const dist = +node.params.distance || 10;
      solid = dist >= 0 ? sketch.extrude(dist) : sketchDrawing(sk).sketchOnPlane("XY", dist).extrude(-dist);
    } else {
      const axis = node.params.axis === "x" ? [1, 0, 0] : [0, 1, 0];
      solid = sketch.revolve(axis, { origin: [0, 0, 0], angle: Math.max(1, Math.min(360, +node.params.angle || 360)) });
      // Stand it up: the line it turned around becomes the up direction, and it sits on the grid (like a vase).
      solid = node.params.axis === "x" ? solid.rotate(-90, [0, 0, 0], [0, 1, 0]) : solid.rotate(90, [0, 0, 0], [1, 0, 0]);
      const z0 = solid.boundingBox.bounds[0][2];
      if (Math.abs(z0) > 1e-9) solid = solid.translate([0, 0, -z0]);
    }
    return place(solid, sk.tf);
  }
  if (node.kind === "modify") {
    const base = build(node.child).clone();
    const p = node.params || {};
    if (node.op === "fillet" || node.op === "chamfer") {
      const chosen = pick(edgesOf(base), node.picks);
      const r = num(p.r, 1);
      return node.op === "fillet" ? base.fillet(r, (f) => f.inList(chosen)) : base.chamfer(r, (f) => f.inList(chosen));
    }
    if (node.op === "shell") {
      const chosen = pick(facesOf(base), node.picks);
      return base.shell(num(p.thickness, 2), (f) => f.inList(chosen));
    }
    if (node.op === "mirror") return base.mirror(p.plane || "YZ", p.origin || [0, 0, 0]);
    if (node.op === "pushpull") {
      const [face] = pick(facesOf(base), node.picks);
      if (face.geomType !== "PLANE") throw new Error("Press/Pull works on flat faces for now.");
      const d = +p.distance || 0;
      if (!d) return base;
      const n = face.normalAt();
      const tool = basicFaceExtrusion(face, n.multiply(d));
      return d > 0 ? base.fuse(tool) : base.cut(tool);
    }
    throw new Error(`Unknown change "${node.op}"`);
  }
  if (node.kind === "boolean") {
    const parts = (node.children || []).map((c) => build(c).clone());
    if (parts.length < 2) throw new Error("Combining needs at least two shapes");
    let out = parts[0];
    for (const other of parts.slice(1)) {
      if (node.op === "join") out = out.fuse(other);
      else if (node.op === "subtract") out = out.cut(other);
      else if (node.op === "intersect") out = out.intersect(other);
      else throw new Error(`Unknown combine "${node.op}"`);
    }
    return out;
  }
  if (node.kind === "brep") return deserializeShape(node.brep);
  return primitive(node.kind, node.params || {});
}

function build(node) {
  const key = JSON.stringify(node);
  const hit = cache.get(key);
  if (hit) return hit;
  const shape = place(buildRaw(node), node.tf);
  remember(key, shape);
  return shape;
}

function meshOf(shape, fine) {
  const m = shape.mesh(fine ? { tolerance: 0.01, angularTolerance: 0.1 } : { tolerance: 0.05, angularTolerance: 0.25 });
  const out = {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    faces: m.faceGroups.length,
  };
  if (!fine) {
    const e = shape.meshEdges({ tolerance: 0.05, angularTolerance: 0.25 });
    out.edges = new Float32Array(e.lines);
  }
  const [[x0, y0, z0], [x1, y1, z1]] = shape.boundingBox.bounds;
  out.bounds = [[x0, y0, z0], [x1, y1, z1]];
  return out;
}

const transfer = (m) => [m.vertices.buffer, m.normals.buffer, m.triangles.buffer].concat(m.edges ? [m.edges.buffer] : []);

const smoothness = (q) => ({ draft: { tolerance: 0.1, angularTolerance: 0.5 }, normal: { tolerance: 0.02, angularTolerance: 0.2 }, fine: { tolerance: 0.005, angularTolerance: 0.08 } }[q] || { tolerance: 0.02, angularTolerance: 0.2 });

async function handle(msg) {
  await boot();
  if (JSON.stringify(msg.node || msg.nodes || "").includes('"kind":"text"')) await fontReady();
  switch (msg.cmd) {
    case "ping":
      return { result: true };
    case "mesh": {
      const m = meshOf(build(msg.node), false);
      return { result: m, transfer: transfer(m) };
    }
    case "exportMesh": {
      // Triangles at print quality for STL / 3MF / OBJ / GLB.
      const shape = build(msg.node);
      const q = smoothness(msg.quality);
      const m = shape.mesh(q);
      const r = { vertices: new Float32Array(m.vertices), triangles: new Uint32Array(m.triangles) };
      return { result: r, transfer: [r.vertices.buffer, r.triangles.buffer] };
    }
    case "exportSTEP": {
      const shapes = msg.nodes.map((n) => ({ shape: build(n.node).clone(), name: n.name || "Part", color: n.color }));
      const blob = exportSTEP(shapes);
      const buf = await blob.arrayBuffer();
      return { result: buf, transfer: [buf] };
    }
    case "importSTEP": {
      const shape = await importSTEP(new Blob([msg.bytes]));
      const brep = shape.serialize();
      const m = meshOf(shape, false);
      return { result: { brep, mesh: m }, transfer: transfer(m) };
    }
    case "pickFace":
    case "pickEdge": {
      // Which face or edge of a part is nearest to a point on it (the part's own coordinates), with its outline
      // or triangles to highlight. The index is what fillet, shell and press/pull remember.
      const shape = build(msg.node);
      const list = msg.cmd === "pickFace" ? facesOf(shape) : edgesOf(shape);
      const v = makeVertex(msg.point);
      let best = -1, bestD = Infinity;
      list.forEach((el, i) => {
        const d = measureDistanceBetween(el, v);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0) throw new Error("Nothing to pick there.");
      const el = list[best];
      const out = { index: best, distance: bestD, type: el.geomType };
      if (msg.cmd === "pickEdge") {
        out.lines = new Float32Array(makeCompound([el]).meshEdges({ tolerance: 0.05, angularTolerance: 0.2 }).lines);
        return { result: out, transfer: [out.lines.buffer] };
      }
      const m = makeCompound([el]).mesh({ tolerance: 0.05, angularTolerance: 0.25 });
      out.vertices = new Float32Array(m.vertices);
      out.triangles = new Uint32Array(m.triangles);
      return { result: out, transfer: [out.vertices.buffer, out.triangles.buffer] };
    }
    case "outline": {
      // Edges (index list) or faces as highlight geometry, for showing what's already picked.
      const shape = build(msg.node);
      const res = [];
      for (const i of msg.edges || []) { const e = edgesOf(shape)[i]; if (e) res.push(...makeCompound([e]).meshEdges({ tolerance: 0.05, angularTolerance: 0.2 }).lines); }
      const lines = new Float32Array(res);
      return { result: { lines }, transfer: [lines.buffer] };
    }
    case "volume": {
      const [[x0, y0, z0], [x1, y1, z1]] = build(msg.node).boundingBox.bounds;
      return { result: { size: [x1 - x0, y1 - y0, z1 - z0] } };
    }
    default:
      throw new Error(`Unknown command ${msg.cmd}`);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const { result, transfer: t } = await handle(msg);
    self.postMessage({ id: msg.id, ok: true, result }, t || []);
  } catch (err) {
    const text = typeof err === "number" ? "The geometry engine couldn't do that with these shapes." : (err && err.message) || String(err);
    self.postMessage({ id: msg.id, ok: false, error: text });
  }
};

boot().then(() => self.postMessage({ id: 0, ok: true, result: "ready" }), (err) => self.postMessage({ id: 0, ok: false, error: `The geometry engine didn't start: ${err && err.message || err}` }));
