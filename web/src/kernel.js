// Talks to the geometry worker: each call is a promise that settles when the worker answers.
let worker = null;
let nextId = 1;
const waiting = new Map();
let readyResolve, readyReject;
export const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

export function start() {
  if (worker) return ready;
  worker = new Worker(new URL("./kernel.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    if (id === 0) { ok ? readyResolve(true) : readyReject(new Error(error)); return; }
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    ok ? w.resolve(result) : w.reject(new Error(error));
  };
  worker.onerror = (e) => {
    const err = new Error(`The geometry engine stopped: ${e.message || "unknown error"}`);
    readyReject(err);
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  return ready;
}

export function call(cmd, args = {}, transfer = []) {
  return ready.then(() => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, ...args }, transfer);
  }));
}

export const mesh = (node) => call("mesh", { node });
export const exportMesh = (node, quality) => call("exportMesh", { node, quality });
export const exportSTEP = (nodes) => call("exportSTEP", { nodes });
export const importSTEP = (bytes) => call("importSTEP", { bytes }, [bytes.buffer]);
export const pickFace = (node, point) => call("pickFace", { node, point });
export const pickEdge = (node, point) => call("pickEdge", { node, point });
export const outline = (node, edges) => call("outline", { node, edges });
