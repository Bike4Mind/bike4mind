import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { protocol } from 'electron';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

import { ENGINE_CSP, MODEL_ENGINE_URL, registerModelProtocol, resolveEngineAsset } from './engineProtocol';

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
