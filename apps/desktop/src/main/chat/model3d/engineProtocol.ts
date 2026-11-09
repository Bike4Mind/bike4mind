import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { protocol } from 'electron';

export const MODEL_SCHEME = 'b4m-model';

/** What the renderer frames. A host is required: the scheme is `standard`. */
export const MODEL_ENGINE_URL = `${MODEL_SCHEME}://engine/`;
export const MODEL_ENGINE_ORIGIN = `${MODEL_SCHEME}://engine`;

/**
 * The engine frame's policy. Agent-written model code runs only here, inside a Worker, so this is
 * the boundary that keeps it off the network: `connect-src 'self'` admits nothing but this
 * scheme's own fixed files (the manifold WASM is fetched from it), and no remote origin appears
 * anywhere. `blob:` is what lets the worker import the model source as a module, which keeps real
 * line numbers in its stack traces. Sent as a header, like the artifact sandbox's, so nothing the
 * model writes can choose its own policy.
 */
export const ENGINE_CSP = [
  "default-src 'none'",
  "script-src b4m-model: blob: 'wasm-unsafe-eval'",
  'worker-src b4m-model: blob:',
  "connect-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * A build's own budget, counted from the moment its worker is ready: worker boot and the manifold
 * load never eat into it. Past it the worker is killed, which is what stops an endless loop.
 */
export const BUILD_TIMEOUT_MS = 5000;

/**
 * The ceiling on a worker becoming ready. Together with BUILD_TIMEOUT_MS it stays under the 30 s
 * main waits for a build report (ModelLiveView.ts), so a stuck boot still reports its own error.
 */
export const BOOT_TIMEOUT_MS = 15000;

export const BUILD_TIMEOUT_MESSAGE = `Build stopped after ${BUILD_TIMEOUT_MS / 1000} s without finishing. There is no line number because the code never returned: look for an endless loop or a very heavy operation.`;

const ENGINE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body><script type="module" src="./engine.js"></script></body></html>`;

/**
 * The page script. Each build still gets a fresh Worker, so a model can neither leak WASM memory
 * nor state into the next build, and an endless loop costs one terminate() rather than a hung
 * renderer. What it no longer pays for is the cold start: the WASM is compiled once per page and
 * handed to every worker, and the next build's worker is booted (manifold loaded and set up) while
 * the page is idle or the current build runs, so a build normally starts on a warm worker.
 */
const ENGINE_JS = `
const BUILD_TIMEOUT_MS = ${BUILD_TIMEOUT_MS};
const BOOT_TIMEOUT_MS = ${BOOT_TIMEOUT_MS};
const BUILD_TIMEOUT_MESSAGE = ${JSON.stringify(BUILD_TIMEOUT_MESSAGE)};
// null when compiling here fails; each worker then loads the WASM itself.
const compiled = WebAssembly.compileStreaming(fetch('./manifold.wasm')).catch(() => null);
let next = null;
let active = null;
let latest = 0;
function reply(id, outcome) {
  const transfer = [];
  if (outcome && outcome.ok) for (const part of outcome.parts) transfer.push(part.positions.buffer, part.indices.buffer);
  window.parent.postMessage({ type: 'built', id, outcome }, '*', transfer);
}
function spawn() {
  const worker = new Worker('./worker.js', { type: 'module' });
  const ready = new Promise((resolve) => {
    worker.onmessage = (event) => {
      const data = event.data || {};
      resolve(data.type === 'ready' ? true : data.error || 'The model engine failed to start.');
    };
    worker.onerror = (event) => resolve(event.message || 'The model worker failed to start.');
  });
  void compiled.then((wasm) => {
    try {
      worker.postMessage({ type: 'init', wasm });
    } catch {
      worker.postMessage({ type: 'init', wasm: null });
    }
  });
  return { worker, ready };
}
function stopActive() {
  if (!active) return;
  active.worker.terminate();
  clearTimeout(active.timer);
  active = null;
}
function bootOrTimeout(ready) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('The model engine did not start within ' + BOOT_TIMEOUT_MS / 1000 + ' s.'), BOOT_TIMEOUT_MS);
  });
  return Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
}
async function run(id, source, params, print) {
  stopActive();
  latest += 1;
  const token = latest;
  next = next || spawn();
  const engine = next;
  const boot = await bootOrTimeout(engine.ready);
  // Superseded while booting: the worker stays as next, for the build that superseded this one.
  if (token !== latest) return;
  next = null;
  if (boot !== true) {
    engine.worker.terminate();
    reply(id, { ok: false, error: boot });
    return;
  }
  const worker = engine.worker;
  active = {
    worker,
    timer: setTimeout(() => {
      if (!active || active.worker !== worker) return;
      stopActive();
      reply(id, { ok: false, error: BUILD_TIMEOUT_MESSAGE });
    }, BUILD_TIMEOUT_MS),
  };
  worker.onmessage = (event) => {
    if (!active || active.worker !== worker) return;
    stopActive();
    reply(id, event.data);
  };
  worker.onerror = (event) => {
    if (!active || active.worker !== worker) return;
    stopActive();
    reply(id, { ok: false, error: event.message || 'The model worker failed.' });
  };
  worker.postMessage({ type: 'build', source, params, print });
  next = spawn();
}
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== 'build' || typeof data.source !== 'string') return;
  void run(data.id, data.source, data.params || {}, data.print === true);
});
next = spawn();
window.parent.postMessage({ type: 'engine-ready' }, '*');
`;

/** The build itself. Must stay in step with ModelBuildOutcome in shared/model3d.ts. */
const WORKER_JS = `
import Module from './manifold.js';

function toParam(raw) {
  if (typeof raw === 'number') {
    const span = Math.max(Math.abs(raw), 1);
    return { value: raw, min: raw - span, max: raw + span, step: span / 100 };
  }
  if (!raw || typeof raw.value !== 'number') return null;
  const value = raw.value;
  const min = typeof raw.min === 'number' ? raw.min : Math.min(0, value);
  const max = typeof raw.max === 'number' ? raw.max : Math.max(value * 2, value + 1);
  const step = typeof raw.step === 'number' && raw.step > 0 ? raw.step : (max - min) / 100;
  return { value, min, max, step };
}

function lineOf(error, url) {
  const stack = error && typeof error.stack === 'string' ? error.stack : '';
  const at = stack.indexOf(url + ':');
  if (at < 0) return undefined;
  const match = /^:(\\d+):\\d+/.exec(stack.slice(at + url.length));
  return match ? Number(match[1]) : undefined;
}

function meshOf(shape) {
  const mesh = shape.getMesh();
  const count = mesh.vertProperties.length / mesh.numProp;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = mesh.vertProperties[index * mesh.numProp];
    positions[index * 3 + 1] = mesh.vertProperties[index * mesh.numProp + 1];
    positions[index * 3 + 2] = mesh.vertProperties[index * mesh.numProp + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

const PALETTE = ['#b0b7c3', '#c98b4a', '#6f9fd8', '#7cbf7c', '#d6c35a', '#c46f8f'];

function shapeOf(entry, index, Manifold) {
  const shape = entry instanceof Manifold ? entry : entry && entry.shape;
  if (!(shape instanceof Manifold)) {
    throw new Error('The model must return a Manifold, or an array of { name, color, shape } parts (item ' + index + ' is not).');
  }
  return shape;
}

// One solid for a slicer: overlapping parts merge, separate ones (a print-in-place hinge) stay separate shells.
function printPartOf(result, Manifold) {
  const list = Array.isArray(result) ? result : [result];
  const shape = Manifold.union(list.map((entry, index) => shapeOf(entry, index, Manifold)));
  return [{ name: 'print', color: PALETTE[0], ...meshOf(shape) }];
}

function partsOf(result, Manifold) {
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry, index) => {
    const shape = shapeOf(entry, index, Manifold);
    const name = entry instanceof Manifold || typeof entry.name !== 'string' ? 'part' + (index + 1) : entry.name;
    const color = entry instanceof Manifold || typeof entry.color !== 'string' ? PALETTE[index % PALETTE.length] : entry.color;
    const part = { name, color, ...meshOf(shape) };
    // Checked as a tree in the renderer (partTreeError); here only passed through in plain form.
    if (!(entry instanceof Manifold)) {
      if (Array.isArray(entry.pivot)) part.pivot = entry.pivot.map(Number);
      if (typeof entry.parent === 'string') part.parent = entry.parent;
      if (Array.isArray(entry.axis)) part.axis = entry.axis.map(Number);
      if (Array.isArray(entry.range)) part.range = entry.range.map(Number);
      if (entry.motion !== undefined) part.motion = String(entry.motion);
      if (entry.metalness !== undefined) part.metalness = Number(entry.metalness);
      if (entry.roughness !== undefined) part.roughness = Number(entry.roughness);
      for (const key of ['clearcoat', 'sheen', 'transmission', 'ior', 'thickness', 'emissiveIntensity']) {
        if (entry[key] !== undefined) part[key] = Number(entry[key]);
      }
      if (entry.emissive !== undefined) part.emissive = String(entry.emissive);
      if (entry.texture !== undefined) part.texture = String(entry.texture);
      if (entry.smooth !== undefined) part.smooth = typeof entry.smooth === 'boolean' ? entry.smooth : String(entry.smooth);
    }
    return part;
  });
}

let m = null;

// The page's compiled module when it has one, so a new worker instantiates instead of fetching and compiling.
async function load(wasm) {
  if (!wasm) return Module();
  // Emscripten never settles Module() when instantiateWasm fails, so the failure is surfaced here.
  return new Promise((resolve, reject) => {
    Module({
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm), reject);
        return {};
      },
    }).then(resolve, reject);
  });
}

async function init(wasm) {
  try {
    m = await load(wasm);
    m.setup();
    self.postMessage({ type: 'ready' });
  } catch (error) {
    self.postMessage({ type: 'failed', error: 'The model engine failed to start: ' + (error instanceof Error ? error.message : String(error)) });
  }
}

self.onmessage = async (event) => {
  if (event.data.type === 'init') return init(event.data.wasm);
  const { source, params: overrides, print } = event.data;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const mod = await import(url);
    if (typeof mod.default !== 'function') throw new Error('The model file must have a default export: export default function model({ m, p }) { ... }');
    const units = mod.units === 'm' ? 'm' : 'mm';
    const params = {};
    for (const [key, raw] of Object.entries(mod.params || {})) {
      const param = toParam(raw);
      if (param) params[key] = param;
    }
    const p = {};
    for (const [key, param] of Object.entries(params)) {
      const override = overrides[key];
      p[key] = typeof override === 'number' ? override : param.value;
      params[key] = { ...param, value: p[key] };
    }
    const result = await mod.default({ m, p });
    const parts = print ? printPartOf(result, m.Manifold) : partsOf(result, m.Manifold);
    if (!parts.some((part) => part.indices.length > 0)) throw new Error('The model produced no geometry.');
    self.postMessage({ ok: true, parts, params, units }, parts.flatMap((part) => [part.positions.buffer, part.indices.buffer]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ ok: false, error: message, line: lineOf(error, url) });
  } finally {
    URL.revokeObjectURL(url);
  }
};
`;

type EngineAsset = { kind: 'inline'; body: string; type: string } | { kind: 'file'; file: string; type: string };

/** The fixed set of files the scheme serves; anything else is a 404. */
export function resolveEngineAsset(pathname: string): EngineAsset | null {
  switch (pathname) {
    case '/':
      return { kind: 'inline', body: ENGINE_HTML, type: 'text/html; charset=utf-8' };
    case '/engine.js':
      return { kind: 'inline', body: ENGINE_JS, type: 'text/javascript; charset=utf-8' };
    case '/worker.js':
      return { kind: 'inline', body: WORKER_JS, type: 'text/javascript; charset=utf-8' };
    case '/manifold.js':
      return { kind: 'file', file: 'manifold.js', type: 'text/javascript; charset=utf-8' };
    case '/manifold.wasm':
      return { kind: 'file', file: 'manifold.wasm', type: 'application/wasm' };
    default:
      return null;
  }
}

/**
 * Declared before the app is ready. `supportFetchAPI` because the worker loads the WASM with
 * fetch; deliberately not `bypassCSP`.
 */
export function registerModelScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Must run after the app is ready. `assetDir` holds the manifold files the build copies there. */
export function registerModelProtocol(assetDir: string = join(__dirname, 'model3d')): void {
  protocol.handle(MODEL_SCHEME, async request => {
    const url = new URL(request.url);
    const asset = url.host === 'engine' ? resolveEngineAsset(url.pathname) : null;
    if (!asset) return new Response('Not found', { status: 404 });
    const body = asset.kind === 'inline' ? asset.body : await readFile(join(assetDir, asset.file));
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': asset.type,
        'Content-Security-Policy': ENGINE_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
