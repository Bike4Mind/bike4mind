import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

import { ENGINE_CSP, MODEL_ENGINE_URL, resolveEngineAsset } from './engineProtocol';

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
