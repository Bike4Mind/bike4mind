import { describe, expect, it, vi } from 'vitest';

const kms = vi.hoisted(() => ({ send: vi.fn(async (_command: unknown) => ({})) }));

vi.mock('sst', () => ({
  Resource: { App: { stage: 'pr7' }, SECRET_DATA_KEY_WRAPPED: { value: 'AQID' } },
}));
vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: vi.fn(function () {
    return kms;
  }),
  DecryptCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

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

describe('handler', () => {
  it('builds one client that fails fast: a single attempt and bounded connect and socket time', async () => {
    const { KMSClient } = await import('@aws-sdk/client-kms');
    vi.mocked(KMSClient).mockClear();
    const { handler } = await load();
    await handler();
    await handler();
    expect(KMSClient).toHaveBeenCalledTimes(1);
    expect(KMSClient).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, socketTimeout: 3000 },
    });
  });

  it('decrypts the linked blob under the deployed stage from Resource.App', async () => {
    const { handler } = await load();
    const result = await handler();
    expect(result).toMatchObject({ ok: true, coldStart: true });
    expect(kms.send).toHaveBeenCalledWith({
      input: {
        CiphertextBlob: Buffer.from([1, 2, 3]),
        EncryptionContext: { purpose: 'secrets-at-rest', stage: 'pr7' },
      },
    });
  });
});
