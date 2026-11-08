// Opening and saving model files: STL, 3MF, OBJ, PLY and GLB/GLTF come in as triangle meshes, STEP as real solids.
// Everything can go out as STL, 3MF, OBJ or GLB; solids can also go out as STEP.
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { zipSync, strToU8 } from "three/addons/libs/fflate.module.js";
import * as kernel from "./kernel.js";

export const OPEN_EXTS = ["hcad", "stl", "3mf", "obj", "ply", "glb", "gltf", "step", "stp"];
export const IMPORT_EXTS = ["stl", "3mf", "obj", "ply", "glb", "gltf", "step", "stp"];
export const EXPORT_FORMATS = [
  { ext: "stl", label: "STL", note: "3D printing, works with every slicer" },
  { ext: "3mf", label: "3MF", note: "3D printing, keeps parts and colours" },
  { ext: "step", label: "STEP", note: "Other CAD programs, exact shapes" },
  { ext: "obj", label: "OBJ", note: "Blender and most 3D apps" },
  { ext: "glb", label: "GLB", note: "Godot and other game engines" },
];

const tri = (geo) => {
  const g = geo.index ? geo.toNonIndexed() : geo;
  return g.getAttribute("position").array.slice();
};

// Joins every mesh in a loaded scene into one list of triangles (their own placements applied).
function sceneTriangles(root) {
  root.updateMatrixWorld(true);
  const chunks = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    chunks.push(g.getAttribute("position").array);
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Moves triangles so the model sits on the grid, centred, the way 123D drops imports.
export function dropOnGrid(pos) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  if (!isFinite(min[0])) throw new Error("That file has no triangles in it.");
  const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < pos.length; i += 3) { pos[i] += off[0]; pos[i + 1] += off[1]; pos[i + 2] += off[2]; }
  return { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// Game-engine files are in metres with Y pointing up; CAD and printers use millimetres with Z up.
function fromYUpMetres(pos) {
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] * 1000, y = pos[i + 1] * 1000, z = pos[i + 2] * 1000;
    pos[i] = x; pos[i + 1] = -z; pos[i + 2] = y;
  }
}

// Reads a model file's bytes. Returns { kind: "mesh", positions } or { kind: "solid", brep, mesh }.
export async function readModel(name, bytes) {
  const ext = name.toLowerCase().split(".").pop();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  switch (ext) {
    case "stl": {
      const positions = tri(new STLLoader().parse(buf));
      return { kind: "mesh", positions, ...dropOnGrid(positions) };
    }
    case "ply": {
      const positions = tri(new PLYLoader().parse(buf));
      return { kind: "mesh", positions, ...dropOnGrid(positions) };
    }
    case "obj": {
      const positions = sceneTriangles(new OBJLoader().parse(new TextDecoder().decode(bytes)));
      return { kind: "mesh", positions, ...dropOnGrid(positions) };
    }
    case "3mf": {
      const positions = sceneTriangles(new ThreeMFLoader().parse(buf));
      return { kind: "mesh", positions, ...dropOnGrid(positions) };
    }
    case "glb":
    case "gltf": {
      const gltf = await new GLTFLoader().parseAsync(buf, "");
      const positions = sceneTriangles(gltf.scene);
      fromYUpMetres(positions);
      return { kind: "mesh", positions, ...dropOnGrid(positions) };
    }
    case "step":
    case "stp": {
      const r = await kernel.importSTEP(new Uint8Array(buf));
      const [[x0, y0, z0], [x1, y1, z1]] = r.mesh.bounds;
      return { kind: "solid", brep: r.brep, mesh: r.mesh, size: [x1 - x0, y1 - y0, z1 - z0], offset: [-(x0 + x1) / 2, -(y0 + y1) / 2, -z0] };
    }
    default:
      throw new Error(`Hearth OS CAD can't open .${ext} files yet.`);
  }
}

// A part's placement as a matrix (scale, then turn Z, Y, X, then move: the same as the geometry engine).
export function partMatrix(tf) {
  const m = new THREE.Matrix4();
  const r = (tf && tf.r) || [0, 0, 0];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...r.map(THREE.MathUtils.degToRad), "XYZ"));
  const s = (tf && tf.s) || 1;
  m.compose(new THREE.Vector3(...((tf && tf.p) || [0, 0, 0])), q, new THREE.Vector3(s, s, s));
  return m;
}

// Triangles for every part, for exporting: [{ name, color, vertices: Float32Array, triangles: Uint32Array }].
export async function partTriangles(design, parts, quality = "normal") {
  const out = [];
  for (const p of parts) {
    if (p.kind === "mesh") {
      const m = design.meshes.get(p.meshRef);
      if (!m) continue;
      const v = m.positions.slice();
      new THREE.BufferAttribute(v, 3).applyMatrix4(partMatrix(p.tf));
      const t = new Uint32Array(v.length / 3);
      for (let i = 0; i < t.length; i++) t[i] = i;
      out.push({ name: p.name, color: p.color, vertices: v, triangles: t });
    } else {
      const r = await kernel.exportMesh(p, quality);
      out.push({ name: p.name, color: p.color, vertices: r.vertices, triangles: r.triangles });
    }
  }
  return out;
}

function stl(meshes) {
  const count = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  const head = "Hearth OS CAD";
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, count, true);
  let o = 84;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const m of meshes) {
    const v = m.vertices, t = m.triangles;
    for (let i = 0; i < t.length; i += 3) {
      a.fromArray(v, t[i] * 3); b.fromArray(v, t[i + 1] * 3); c.fromArray(v, t[i + 2] * 3);
      n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
      for (const p of [n, a, b, c]) { dv.setFloat32(o, p.x, true); dv.setFloat32(o + 4, p.y, true); dv.setFloat32(o + 8, p.z, true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

function obj(meshes) {
  const lines = ["# Hearth OS CAD", "# units: millimetres"];
  let base = 1;
  for (const m of meshes) {
    lines.push(`o ${m.name.replace(/\s+/g, "_")}`);
    for (let i = 0; i < m.vertices.length; i += 3) lines.push(`v ${+m.vertices[i].toFixed(5)} ${+m.vertices[i + 1].toFixed(5)} ${+m.vertices[i + 2].toFixed(5)}`);
    for (let i = 0; i < m.triangles.length; i += 3) lines.push(`f ${m.triangles[i] + base} ${m.triangles[i + 1] + base} ${m.triangles[i + 2] + base}`);
    base += m.vertices.length / 3;
  }
  return strToU8(lines.join("\n") + "\n");
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

function threeMF(meshes) {
  const objs = [], items = [], mats = [];
  meshes.forEach((m, k) => {
    const id = k + 2;
    mats.push(`<base name="${esc(m.name)}" displaycolor="${(m.color || "#cccccc").toUpperCase()}FF"/>`);
    const vs = [], ts = [];
    for (let i = 0; i < m.vertices.length; i += 3) vs.push(`<vertex x="${+m.vertices[i].toFixed(5)}" y="${+m.vertices[i + 1].toFixed(5)}" z="${+m.vertices[i + 2].toFixed(5)}"/>`);
    for (let i = 0; i < m.triangles.length; i += 3) ts.push(`<triangle v1="${m.triangles[i]}" v2="${m.triangles[i + 1]}" v3="${m.triangles[i + 2]}"/>`);
    objs.push(`<object id="${id}" name="${esc(m.name)}" type="model" pid="1" pindex="${k}"><mesh><vertices>${vs.join("")}</vertices><triangles>${ts.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Hearth OS CAD</metadata><resources><basematerials id="1">${mats.join("")}</basematerials>${objs.join("")}</resources><build>${items.join("")}</build></model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    "3D/3dmodel.model": strToU8(model),
  });
}

async function glb(meshes) {
  const scene = new THREE.Scene();
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    const v = new Float32Array(m.vertices.length);
    for (let i = 0; i < v.length; i += 3) { v[i] = m.vertices[i] / 1000; v[i + 1] = m.vertices[i + 2] / 1000; v[i + 2] = -m.vertices[i + 1] / 1000; }
    g.setAttribute("position", new THREE.BufferAttribute(v, 3));
    g.setIndex(new THREE.BufferAttribute(m.triangles, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: m.color || "#cccccc", roughness: 0.6 }));
    mesh.name = m.name;
    scene.add(mesh);
  }
  const res = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Uint8Array(res);
}

// Makes the bytes of a model file. Returns { bytes, skipped } (parts a format can't hold, like meshes in STEP).
export async function writeModel(ext, design, parts, { quality = "normal" } = {}) {
  if (!parts.length) throw new Error("There's nothing to export.");
  if (ext === "step" || ext === "stp") {
    const solids = parts.filter((p) => p.kind !== "mesh");
    if (!solids.length) throw new Error("STEP files hold solids, and these parts are all meshes (from STL, OBJ…). Try STL or 3MF.");
    const buf = await kernel.exportSTEP(solids.map((p) => ({ node: p, name: p.name, color: p.color })));
    return { bytes: new Uint8Array(buf), skipped: parts.length - solids.length };
  }
  const meshes = await partTriangles(design, parts, quality);
  if (ext === "stl") return { bytes: stl(meshes), skipped: 0 };
  if (ext === "obj") return { bytes: obj(meshes), skipped: 0 };
  if (ext === "3mf") return { bytes: threeMF(meshes), skipped: 0 };
  if (ext === "glb") return { bytes: await glb(meshes), skipped: 0 };
  throw new Error(`Hearth OS CAD can't write .${ext} files.`);
}
