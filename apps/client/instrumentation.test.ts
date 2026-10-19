// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from './instrumentation';

describe('instrumentation register', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails the Node.js server at boot on a malformed TRUSTED_PROXY_HOPS', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'one');
    await expect(register()).rejects.toThrow(/TRUSTED_PROXY_HOPS must be a non-negative integer/);
  });

  it.each([undefined, '', '0', '2'])('boots with TRUSTED_PROXY_HOPS=%s', async value => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('TRUSTED_PROXY_HOPS', value);
    await expect(register()).resolves.toBeUndefined();
  });

  it('skips the check outside the Node.js runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'one');
    await expect(register()).resolves.toBeUndefined();
  });
});
