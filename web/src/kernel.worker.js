// The geometry engine: OpenCascade (through replicad) in a worker, so the window never freezes while it works.
// The page sends a design node (a shape with its sizes and placement, or a join/subtract/intersect of other nodes,
// or a solid read from a STEP file) and gets back triangles to draw, edges to outline, or a STEP file.
import opencascade from "replicad-opencascadejs";
import {
  setOC, makeBox, makeCylinder, makeSphere, draw, drawCircle, drawPolysides,
  importSTEP, exportSTEP, deserializeShape,
} from "replicad";

let ready = null;
function boot() {
  if (!ready) {
    ready = opencascade({ locateFile: () => new URL("./replicad_single.wasm", self.location.href).href })
      .then((OC) => { setOC(OC); return true; });
  }
  return ready;
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
    default:
      throw new Error(`Unknown shape "${kind}"`);
  }
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
