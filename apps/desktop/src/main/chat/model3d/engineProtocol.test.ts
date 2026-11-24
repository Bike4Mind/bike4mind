import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protocol } from 'electron';
import {
  BOOT_TIMEOUT_MS,
  BUILD_TIMEOUT_MESSAGE,
  BUILD_TIMEOUT_MS,
  ENGINE_CSP,
  MODEL_ENGINE_URL,
  registerModelProtocol,
  resolveEngineAsset,
} from './engineProtocol';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

describe('ENGINE_CSP', () => {
  it('admits no remote origin anywhere', () => {
    expect(ENGINE_CSP).not.toMatch(/https?:/);
    expect(ENGINE_CSP).not.toMatch(/ws:|wss:/);
    expect(ENGINE_CSP).not.toContain('*');
  });

  it('limits connections to the scheme itself and allows only what the build needs', () => {
    expect(ENGINE_CSP).toContain("connect-src 'self'");
    expect(ENGINE_CSP).toContain("default-src 'none'");
    expect(ENGINE_CSP).toContain("'wasm-unsafe-eval'");
    expect(ENGINE_CSP).not.toContain("'unsafe-eval'");
    expect(ENGINE_CSP).not.toContain("script-src 'unsafe-inline'");
  });
});

describe('resolveEngineAsset', () => {
  it('serves the fixed engine files', () => {
    expect(resolveEngineAsset('/')).toMatchObject({ kind: 'inline', type: expect.stringContaining('text/html') });
    expect(resolveEngineAsset('/engine.js')).toMatchObject({ kind: 'inline' });
    expect(resolveEngineAsset('/worker.js')).toMatchObject({ kind: 'inline' });
    expect(resolveEngineAsset('/manifold.wasm')).toEqual({
      kind: 'file',
      file: 'manifold.wasm',
      type: 'application/wasm',
    });
  });

  it('refuses everything else, including traversal', () => {
    expect(resolveEngineAsset('/../../etc/passwd')).toBeNull();
    expect(resolveEngineAsset('/LICENSE')).toBeNull();
    expect(resolveEngineAsset('/manifold.js/x')).toBeNull();
  });

  it('frames from a hosted, standard URL', () => {
    expect(MODEL_ENGINE_URL).toBe('b4m-model://engine/');
  });
});

describe('registerModelProtocol', () => {
  it('sends the engine CSP on every file it serves, and serves nothing else', async () => {
    const assets = mkdtempSync(join(tmpdir(), 'model-engine-'));
    writeFileSync(join(assets, 'manifold.wasm'), 'wasm');
    registerModelProtocol(assets);
    const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1];
    if (!handler) throw new Error('registerModelProtocol did not register a handler');
    for (const path of ['', 'worker.js', 'manifold.wasm']) {
      const response = await handler(new Request(`${MODEL_ENGINE_URL}${path}`));
      expect(response.status, path).toBe(200);
      expect(response.headers.get('Content-Security-Policy'), path).toBe(ENGINE_CSP);
    }
    expect((await handler(new Request('b4m-model://elsewhere/worker.js'))).status).toBe(404);
  });
});

describe('engine page script', () => {
  type Posted = { type: string; id?: number; outcome?: { ok: boolean; error?: string } };

  class FakeWorker {
    static all: FakeWorker[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    received: Array<{ type: string; wasm?: unknown }> = [];
    terminated = false;
    constructor() {
      FakeWorker.all.push(this);
    }
    postMessage(data: { type: string }): void {
      this.received.push(data);
    }
    terminate(): void {
      this.terminated = true;
    }
    ready(): void {
      this.onmessage?.({ data: { type: 'ready' } });
    }
    answer(outcome: unknown): void {
      this.onmessage?.({ data: outcome });
    }
    get builds(): number {
      return this.received.filter(message => message.type === 'build').length;
    }
  }

  const COMPILED = { compiled: 'manifold' };

  /**
   * Runs the real engine page script against stand-ins for the browser APIs it touches: Worker,
   * WebAssembly.compileStreaming, fetch and the parent window. Timers are vitest's fake ones.
   */
  function startEngine() {
    const asset = resolveEngineAsset('/engine.js');
    if (asset?.kind !== 'inline') throw new Error('engine.js is not served inline');
    const parent = { postMessage: vi.fn<(data: Posted) => void>() };
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | null = null;
    const window = {
      parent,
      addEventListener: (_type: string, listener: typeof onMessage) => {
        onMessage = listener;
      },
    };
    const WebAssembly = { compileStreaming: () => Promise.resolve(COMPILED) };
    const fetch = () => Promise.resolve({});
    new Function('window', 'Worker', 'WebAssembly', 'fetch', asset.body)(window, FakeWorker, WebAssembly, fetch);
    const send = (id: number) => onMessage?.({ source: parent, data: { type: 'build', id, source: 'x', params: {} } });
    const replies = () => parent.postMessage.mock.calls.map(([data]) => data).filter(data => data.type === 'built');
    return { send, replies };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);

  describe('engine page', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      FakeWorker.all = [];
    });
    afterEach(() => vi.useRealTimers());

    it('warms a worker with the page-compiled WASM before any build is asked for', async () => {
      startEngine();
      await settle();
      expect(FakeWorker.all).toHaveLength(1);
      expect(FakeWorker.all[0].received).toEqual([{ type: 'init', wasm: COMPILED }]);
    });

    it('starts the build budget only once the worker is ready, so a slow cold boot does not time out', async () => {
      const { send, replies } = startEngine();
      await settle();
      send(1);
      await settle();
      // Longer than a build's budget, still inside the boot ceiling.
      await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS * 2);
      const [cold] = FakeWorker.all;
      expect(cold.builds).toBe(0);
      cold.ready();
      await settle();
      expect(cold.builds).toBe(1);
      await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS - 1);
      cold.answer({ ok: true, parts: [] });
      expect(replies()).toEqual([{ type: 'built', id: 1, outcome: { ok: true, parts: [] } }]);
    });

    it('still kills a model that never returns, BUILD_TIMEOUT_MS after it started', async () => {
      const { send, replies } = startEngine();
      await settle();
      FakeWorker.all[0].ready();
      send(1);
      await settle();
      await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS);
      expect(FakeWorker.all[0].terminated).toBe(true);
      expect(replies()).toEqual([{ type: 'built', id: 1, outcome: { ok: false, error: BUILD_TIMEOUT_MESSAGE } }]);
    });

    it('gives up on a worker that never becomes ready at the boot ceiling', async () => {
      const { send, replies } = startEngine();
      await settle();
      send(1);
      await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
      expect(FakeWorker.all[0].terminated).toBe(true);
      expect(replies()[0].outcome).toEqual({ ok: false, error: expect.stringContaining('did not start') });
    });

    it('runs the next build on the worker warmed while the previous one ran, never on a used one', async () => {
      const { send, replies } = startEngine();
      await settle();
      FakeWorker.all[0].ready();
      send(1);
      await settle();
      expect(FakeWorker.all).toHaveLength(2);
      FakeWorker.all[1].ready();
      FakeWorker.all[0].answer({ ok: true, parts: [] });
      send(2);
      await settle();
      expect(FakeWorker.all[1].builds).toBe(1);
      expect(FakeWorker.all[0].builds).toBe(1);
      expect(FakeWorker.all[0].terminated).toBe(true);
      FakeWorker.all[1].answer({ ok: true, parts: [] });
      expect(replies().map(reply => reply.id)).toEqual([1, 2]);
    });

    it('hands a booting worker to the build that supersedes the one waiting on it', async () => {
      const { send, replies } = startEngine();
      await settle();
      send(1);
      send(2);
      await settle();
      FakeWorker.all[0].ready();
      await settle();
      expect(FakeWorker.all[0].builds).toBe(1);
      FakeWorker.all[0].answer({ ok: true, parts: [] });
      expect(replies().map(reply => reply.id)).toEqual([2]);
    });
  });
});

describe('engine worker script', () => {
  type Part = { name: string; positions: Float32Array; indices: Uint32Array };
  type Reply = { ok: true; parts: Part[] } | { ok: false; error: string };

  const scratch = mkdtempSync(join(tmpdir(), 'model-worker-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const manifoldPath = createRequire(import.meta.url).resolve('manifold-3d/manifold.js');

  // The node project's types declare WebAssembly as a namespace only; the runtime has it as a value.
  type WasmApi = { compile(bytes: Uint8Array): Promise<object>; instantiate(...args: unknown[]): Promise<unknown> };
  const wasmApi = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

  type WorkerScope = { onmessage: (event: { data: unknown }) => Promise<void> };

  /**
   * Runs the real worker script in Node against the real manifold-3d build: the browser globals it
   * leans on (self, a blob: URL for the model source) are stood in for, nothing else. `wasm` is the
   * page's precompiled module, as the engine page hands it over; without one the worker loads its own.
   */
  async function boot(source: string, wasm: object | null): Promise<{ worker: WorkerScope; posted: unknown[] }> {
    const asset = resolveEngineAsset('/worker.js');
    if (asset?.kind !== 'inline') throw new Error('worker.js is not served inline');
    const manifold = pathToFileURL(manifoldPath).href;
    const file = join(scratch, `worker-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, asset.body.replace("'./manifold.js'", JSON.stringify(manifold)));
    // A data: URL shows up verbatim in V8 stacks, as the blob: URL does in the engine (a file URL
    // would be printed as a path), so the worker's stack-line parsing sees what it sees in Electron.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const posted: unknown[] = [];
    (globalThis as { self?: unknown }).self = { postMessage: (data: unknown) => posted.push(data) };
    await import(/* @vite-ignore */ pathToFileURL(file).href);
    const worker = (globalThis as unknown as { self: WorkerScope }).self;
    await worker.onmessage({ data: { type: 'init', wasm } });
    return { worker, posted };
  }

  async function build(source: string, print: boolean, wasm: object | null = null): Promise<Reply> {
    const { worker, posted } = await boot(source, wasm);
    expect(posted).toEqual([{ type: 'ready' }]);
    await worker.onmessage({ data: { type: 'build', source, params: {}, print } });
    return posted[1] as Reply;
  }

  /** True when every edge is shared by exactly two triangles, i.e. the mesh is closed. */
  function isClosed({ positions, indices }: Part): boolean {
    const key = (index: number) => Array.from(positions.subarray(index * 3, index * 3 + 3)).join(',');
    const edges = new Map<string, number>();
    for (let index = 0; index < indices.length; index += 3) {
      const corners = [indices[index], indices[index + 1], indices[index + 2]].map(key);
      for (let side = 0; side < 3; side += 1) {
        const edge = [corners[side], corners[(side + 1) % 3]].sort().join('|');
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    return [...edges.values()].every(count => count === 2);
  }

  // Two cubes that overlap by half: as parts they are two shells, for a print one solid.
  const OVERLAPPING = `export default function model({ m }) {
  const { Manifold } = m;
  return [
    { name: 'a', color: '#ff0000', shape: Manifold.cube([10, 10, 10]) },
    { name: 'b', color: '#00ff00', shape: Manifold.cube([10, 10, 10]).translate([5, 0, 0]) },
  ];
}`;

  describe('model worker', () => {
    it('keeps each part separate in a normal build', async () => {
      const reply = await build(OVERLAPPING, false);
      expect(reply.ok && reply.parts.map(part => part.name)).toEqual(['a', 'b']);
    });

    it('unions every part into one closed solid for a print', async () => {
      const reply = await build(OVERLAPPING, true);
      if (!reply.ok) throw new Error(reply.error);
      expect(reply.parts).toHaveLength(1);
      const [solid] = reply.parts;
      expect(isClosed(solid)).toBe(true);
      const xs = Array.from(solid.positions.filter((_value, index) => index % 3 === 0));
      expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 15]);
    });

    it('passes the physical material fields through, as plain numbers and a colour string', async () => {
      const reply = await build(
        `export default function model({ m }) {
        return [{ name: 'lamp', shape: m.Manifold.cube([1, 1, 1]), clearcoat: 0.5, sheen: '0.25', transmission: 1,
          ior: 1.45, thickness: 2, emissive: '#ffaa00', emissiveIntensity: 3, texture: 'wood' }];
      }`,
        false
      );
      if (!reply.ok) throw new Error(reply.error);
      expect(reply.parts[0]).toMatchObject({
        clearcoat: 0.5,
        sheen: 0.25,
        transmission: 1,
        ior: 1.45,
        thickness: 2,
        emissive: '#ffaa00',
        emissiveIntensity: 3,
        texture: 'wood',
      });
    });

    it('records the source lines that built each part, through helpers and booleans', async () => {
      const source = [
        'function post(m, x) {', // 1
        '  return m.Manifold.cylinder(40, 2).translate([x, 0, 0]);', // 2
        '}', // 3
        'export default function model({ m }) {', // 4
        '  const { Manifold } = m;', // 5
        '  const base = Manifold.cube([30, 30, 4]);', // 6
        '  const hole = Manifold.cylinder(4, 3);', // 7
        '  const plate = base.subtract(hole);', // 8
        '  const posts = Manifold.union([post(m, 2), post(m, 28)]);', // 9
        '  return [', // 10
        "    { name: 'base', shape: plate },", // 11
        "    { name: 'posts', shape: posts },", // 12
        "    { name: 'cap', shape: Manifold.sphere(5) },", // 13
        '  ];', // 14
        '}', // 15
      ].join('\n');
      const reply = await build(source, false);
      if (!reply.ok) throw new Error(reply.error);
      const lines = Object.fromEntries(
        reply.parts.map(part => [part.name, (part as Part & { lines?: number[] }).lines])
      );
      expect(lines).toEqual({ base: [6, 7, 8], posts: [2, 9], cap: [13] });
    });

    it('reports a part that is not a shape the same way for a print', async () => {
      const reply = await build('export default function model() { return [{ name: "x" }]; }', true);
      expect(reply.ok ? '' : reply.error).toContain('item 0 is not');
    });

    it('instantiates from the precompiled module the engine page hands over', async () => {
      const wasm = await wasmApi.compile(readFileSync(join(manifoldPath, '..', 'manifold.wasm')));
      const instantiate = vi.spyOn(wasmApi, 'instantiate');
      const reply = await build(OVERLAPPING, false, wasm);
      expect(reply.ok && reply.parts.map(part => part.name)).toEqual(['a', 'b']);
      expect(instantiate).toHaveBeenCalledWith(wasm, expect.anything());
      instantiate.mockRestore();
    });

    it('reports a failed instantiate as a start failure instead of hanging', async () => {
      const wasm = await wasmApi.compile(readFileSync(join(manifoldPath, '..', 'manifold.wasm')));
      const instantiate = vi.spyOn(wasmApi, 'instantiate').mockRejectedValueOnce(new Error('out of memory'));
      const { posted } = await boot(OVERLAPPING, wasm);
      expect(posted).toEqual([{ type: 'failed', error: 'The model engine failed to start: out of memory' }]);
      instantiate.mockRestore();
    });
  });
});
