// The 3D view: the light workplane grid, the parts, picking, the move/rotate handles and the camera.
// Z points up (like CAD and printers); right-drag orbits, middle-drag pans and the wheel zooms, the way 123D did.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { partMatrix } from "./io.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const BG = 0xf1f3f5;
const SEL = new THREE.Color("#2b7bd6");

export class Viewport {
  constructor(el, { onPick, onPlace, onTransformEnd, onHover, onDragInfo }) {
    this.el = el;
    this.onPick = onPick; this.onPlace = onPlace; this.onTransformEnd = onTransformEnd;
    this.onHover = onHover || (() => {}); this.onDragInfo = onDragInfo || (() => {});
    this.groups = new Map(); // part id -> THREE.Group
    this.selected = new Set();
    this.snap = 1;
    this.style = "edges";
    this.placing = null;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(BG);
    el.appendChild(r.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a0, 1.6));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    scene.add(this.sun);

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -20000, 20000);
    this.camera = this.persp;
    this.persp.position.set(160, -220, 170);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.setNavMode("select");

    this.root = new THREE.Group();
    scene.add(this.root);
    this.makeGrid(300);

    this.tc = new TransformControls(this.camera, r.domElement);
    this.tc.setSize(0.9);
    this.tc.setTranslationSnap(this.snap);
    this.tc.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.pivot = new THREE.Object3D();
    scene.add(this.pivot);
    scene.add(this.tc.getHelper());
    this.tc.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value;
      if (e.value) this.beginDrag(); else this.endDrag();
    });
    this.tc.addEventListener("objectChange", () => this.dragMove());

    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.bindPointer();

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = () => { this.controls.update(); this.render(); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  makeGrid(size) {
    if (this.grid) this.scene.remove(this.grid);
    const g = (this.grid = new THREE.Group());
    const half = size / 2;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: 0xe3e9ef, transparent: true, opacity: 0.9, depthWrite: false }));
    plane.renderOrder = -2;
    g.add(plane);
    const minor = [], major = [];
    for (let v = -half; v <= half + 1e-6; v += 10) {
      const arr = Math.abs(v % 50) < 1e-6 ? major : minor;
      arr.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
    }
    const line = (pts, color) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthWrite: false }));
      l.renderOrder = -1;
      return l;
    };
    g.add(line(minor, 0xc9d3dc), line(major, 0x9fb0c0));
    g.add(line([-half, -half, 0, half, -half, 0, half, -half, 0, half, half, 0, half, half, 0, -half, half, 0, -half, half, 0, -half, -half, 0], 0x8696a6));
    this.scene.add(g);
    this.gridSize = size;
  }

  showGrid(on) { this.grid.visible = on; }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }

  updateOrtho() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    const dist = this.persp.position.distanceTo(this.controls.target);
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * dist;
    this.ortho.left = (-halfH * w) / h; this.ortho.right = (halfH * w) / h;
    this.ortho.top = halfH; this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  setProjection(kind) {
    const to = kind === "ortho" ? this.ortho : this.persp;
    if (to === this.camera) return;
    to.position.copy(this.camera.position);
    to.quaternion.copy(this.camera.quaternion);
    if (to === this.ortho) { this.updateOrtho(); this.ortho.zoom = 1; this.ortho.updateProjectionMatrix(); }
    this.camera = to;
    this.controls.object = to;
    this.tc.camera = to;
  }

  render() {
    this.sun.position.copy(this.camera.position).add(new THREE.Vector3(40, -40, 120));
    this.renderer.render(this.scene, this.camera);
  }

  // Left button: picks parts in "select"; in "orbit", "pan" or "zoom" it does that instead (the navigation strip).
  setNavMode(mode) {
    this.navMode = mode;
    const L = { select: null, orbit: THREE.MOUSE.ROTATE, pan: THREE.MOUSE.PAN, zoom: THREE.MOUSE.DOLLY }[mode];
    this.controls.mouseButtons = { LEFT: L, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  }

  setSnap(mm) {
    this.snap = mm;
    this.tc.setTranslationSnap(mm > 0 ? mm : null);
  }

  setStyle(style) {
    this.style = style;
    for (const g of this.groups.values()) this.styleGroup(g);
  }

  styleGroup(g) {
    const sel = this.selected.has(g.userData.id);
    const { mesh, edges } = g.userData;
    mesh.material.wireframe = this.style === "wire";
    mesh.material.emissive.copy(sel ? SEL : new THREE.Color(0)).multiplyScalar(sel ? 0.28 : 0);
    if (edges) {
      edges.visible = this.style !== "shaded";
      edges.material.color.set(sel ? "#ff9a00" : "#2f3a45");
    }
  }

  // Shows a part: its triangles (and outline edges) from the geometry engine or its mesh, at its placement.
  setPart(part, data) {
    this.removePart(part.id);
    const geo = new THREE.BufferGeometry();
    if (data.triangles) {
      geo.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    } else {
      geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      geo.computeVertexNormals();
    }
    geo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    const g = new THREE.Group();
    g.add(mesh);
    let edges = null;
    if (data.edges && data.edges.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(data.edges, 3));
      edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x2f3a45 }));
      g.add(edges);
    }
    g.userData = { id: part.id, mesh, edges };
    mesh.userData.partId = part.id;
    g.matrixAutoUpdate = false;
    g.matrix.copy(partMatrix(part.tf));
    g.matrixWorldNeedsUpdate = true;
    this.root.add(g);
    this.groups.set(part.id, g);
    this.styleGroup(g);
  }

  placePart(part) {
    const g = this.groups.get(part.id);
    if (!g) return;
    g.matrix.copy(partMatrix(part.tf));
    g.matrixWorldNeedsUpdate = true;
    g.userData.mesh.material.color.set(part.color);
  }

  removePart(id) {
    const g = this.groups.get(id);
    if (!g) return;
    this.root.remove(g);
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.groups.delete(id);
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    for (const g of this.groups.values()) this.styleGroup(g);
    this.attachGizmo();
  }

  setGizmoMode(mode) { this.gizmoMode = mode; this.tc.setMode(mode); this.attachGizmo(); }

  attachGizmo() {
    const ids = [...this.selected].filter((id) => this.groups.has(id));
    if (!ids.length || !this.gizmoMode) { this.tc.detach(); return; }
    const box = new THREE.Box3();
    for (const id of ids) box.expandByObject(this.groups.get(id));
    const c = box.getCenter(new THREE.Vector3());
    this.pivot.position.set(c.x, c.y, box.min.z);
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.updateMatrixWorld();
    this.tc.attach(this.pivot);
  }

  beginDrag() {
    this.pivot.updateMatrixWorld();
    this.dragStart = { pivotInv: this.pivot.matrixWorld.clone().invert(), pivotPos: this.pivot.position.clone(), parts: new Map() };
    for (const id of this.selected) {
      const g = this.groups.get(id);
      if (g) this.dragStart.parts.set(id, g.matrix.clone());
    }
  }

  dragMove() {
    if (!this.dragStart) return;
    this.pivot.updateMatrixWorld();
    const delta = this.pivot.matrixWorld.clone().multiply(this.dragStart.pivotInv);
    for (const [id, m0] of this.dragStart.parts) {
      const g = this.groups.get(id);
      g.matrix.multiplyMatrices(delta, m0);
      g.matrixWorldNeedsUpdate = true;
    }
    if (this.tc.mode === "translate") {
      const d = this.pivot.position.clone().sub(this.dragStart.pivotPos);
      this.onDragInfo(`Moved X ${d.x.toFixed(1)} · Y ${d.y.toFixed(1)} · Z ${d.z.toFixed(1)} mm`);
    } else {
      const e = this.pivot.rotation;
      this.onDragInfo(`Turned ${[e.x, e.y, e.z].map((v) => THREE.MathUtils.radToDeg(v).toFixed(0)).find((v) => v !== "0" && v !== "-0") || 0}°`);
    }
  }

  endDrag() {
    if (!this.dragStart) return;
    const changes = [];
    for (const id of this.dragStart.parts.keys()) {
      const g = this.groups.get(id);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      g.matrix.decompose(p, q, s);
      const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
      const round = (v, k = 1000) => Math.round(v * k) / k;
      changes.push({ id, tf: { p: [round(p.x), round(p.y), round(p.z)], r: [e.x, e.y, e.z].map((v) => round(THREE.MathUtils.radToDeg(v), 100)), s: round(s.x, 10000) } });
    }
    this.dragStart = null;
    this.onDragInfo("");
    this.onTransformEnd(changes);
    this.attachGizmo();
  }

  // Shows a see-through shape under the pointer while a new shape is being placed.
  startPlacing(kind, preview) {
    this.stopPlacing();
    this.placing = kind;
    const ghost = new THREE.Mesh(preview, new THREE.MeshStandardMaterial({ color: 0x7fb2e6, transparent: true, opacity: 0.55, depthWrite: false }));
    ghost.visible = false;
    this.ghost = ghost;
    this.scene.add(ghost);
    this.renderer.domElement.style.cursor = "crosshair";
  }

  stopPlacing() {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost.geometry.dispose(); this.ghost = null; }
    this.placing = null;
    this.renderer.domElement.style.cursor = "";
  }

  pointerTo(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  groundPoint() {
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.groundPlane, p)) return null;
    const s = this.snap > 0 ? this.snap : 0;
    if (s) { p.x = Math.round(p.x / s) * s; p.y = Math.round(p.y / s) * s; }
    return [p.x, p.y, 0];
  }

  hit() {
    const meshes = [...this.groups.values()].map((g) => g.userData.mesh);
    const h = this.ray.intersectObjects(meshes, false)[0];
    return h ? h.object.userData.partId : null;
  }

  bindPointer() {
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener("pointerdown", (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; });
    dom.addEventListener("pointermove", (e) => {
      this.pointerTo(e);
      if (this.placing && this.ghost) {
        const p = this.groundPoint();
        this.ghost.visible = !!p;
        if (p) this.ghost.position.set(...p);
        return;
      }
      if (!this.tc.dragging) this.onHover(this.hit());
    });
    dom.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      down = null;
      if (moved || this.tc.dragging || this.tcJustUsed()) return;
      this.pointerTo(e);
      if (this.placing) {
        const p = this.groundPoint();
        if (p) this.onPlace(this.placing, p);
        return;
      }
      if (this.navMode !== "select") return;
      this.onPick(this.hit(), e.shiftKey || e.ctrlKey || e.metaKey);
    });
  }

  tcJustUsed() { return this.tc.axis !== null && this.tc.object; }

  // Camera views: the view cube's faces and Home.
  setView(name) {
    const t = this.contentCenter();
    const d = Math.max(120, this.contentRadius() * 3.2);
    const dirs = {
      home: [0.55, -0.75, 0.6], top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], front: [0, -1, 0], back: [0, 1, 0],
      right: [1, 0, 0], left: [-1, 0, 0],
    };
    const v = new THREE.Vector3(...(dirs[name] || dirs.home)).normalize().multiplyScalar(d);
    this.controls.target.copy(t);
    this.camera.position.copy(t).add(v);
    this.persp.position.copy(this.camera.position);
    this.camera.lookAt(t);
    if (this.camera === this.ortho) { this.updateOrtho(); this.ortho.zoom = 1; this.ortho.updateProjectionMatrix(); }
    this.controls.update();
  }

  contentBox() {
    const box = new THREE.Box3();
    for (const g of this.groups.values()) box.expandByObject(g);
    return box;
  }
  contentCenter() { const b = this.contentBox(); return b.isEmpty() ? new THREE.Vector3(0, 0, 0) : b.getCenter(new THREE.Vector3()); }
  contentRadius() { const b = this.contentBox(); return b.isEmpty() ? this.gridSize * 0.32 : b.getSize(new THREE.Vector3()).length() / 2; }

  fit() {
    const t = this.contentCenter();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const d = Math.max(80, this.contentRadius() / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.15);
    this.controls.target.copy(t);
    this.camera.position.copy(t).add(dir.multiplyScalar(d));
    this.persp.position.copy(this.camera.position);
    if (this.camera === this.ortho) { this.updateOrtho(); this.ortho.zoom = 1; this.ortho.updateProjectionMatrix(); }
    this.controls.update();
  }

  zoomBy(f) {
    const t = this.controls.target;
    this.camera.position.sub(t).multiplyScalar(f).add(t);
    if (this.camera === this.ortho) { this.ortho.zoom /= f; this.ortho.updateProjectionMatrix(); }
    this.controls.update();
  }

  snapshot() { this.render(); return this.renderer.domElement.toDataURL("image/png"); }
}
