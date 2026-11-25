import { describe, expect, it, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: { SECRET_ENCRYPTION_KEY_WRAPPED: { value: 'AQID' } } }));

async function load() {
  vi.resetModules();
  return import('./secretsAtRestUnwrapProbe');
}

const clock = () => {
  let t = 0;
  return () => (t += 40);
};

describe('runUnwrapProbe', () => {
  it('returns timing only, passes the stage context, and flags the first call as cold', async () => {
    const { runUnwrapProbe } = await load();
    const decrypt = vi.fn(async () => {});
    const first = await runUnwrapProbe({ blobBase64: 'AQID', stage: 'pr1', decrypt, now: clock() });
    const second = await runUnwrapProbe({ blobBase64: 'AQID', stage: 'pr1', decrypt, now: clock() });
    expect(first).toEqual({ ok: true, decryptMs: 40, coldStart: true });
    expect(second.coldStart).toBe(false);
    expect(decrypt).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), { purpose: 'secrets-at-rest', stage: 'pr1' });
  });

  it('reports a KMS error as ok: false without throwing or leaking the message', async () => {
    const { runUnwrapProbe } = await load();
    const decrypt = vi.fn(async () => {
      throw Object.assign(new Error('secret detail'), { name: 'AccessDeniedException' });
    });
    const result = await runUnwrapProbe({ blobBase64: 'AQID', stage: 'pr1', decrypt, now: clock() });
    expect(result).toMatchObject({ ok: false, error: 'AccessDeniedException' });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});
