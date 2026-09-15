import { afterEach, describe, expect, it, vi } from 'vitest';

const { axiosPut, apiPut } = vi.hoisted(() => ({ axiosPut: vi.fn(), apiPut: vi.fn() }));
vi.mock('axios', () => ({ default: { put: axiosPut } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: apiPut } }));

import { uploadFileToUrl } from './uploadFileToUrl';

describe('uploadFileToUrl', () => {
  afterEach(() => vi.clearAllMocks());
  const file = new Blob(['hello']);

  it('uses the authenticated api client for a same-origin proxy path (self-host)', async () => {
    await uploadFileToUrl('/api/files/abc123/upload', file, 'text/markdown');
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(axiosPut).not.toHaveBeenCalled();
    expect(apiPut.mock.calls[0][0]).toBe('/api/files/abc123/upload');
  });

  it('uses raw axios (no app auth) for an absolute S3 presigned URL (hosted)', async () => {
    const s3 = 'https://bucket.s3.us-east-2.amazonaws.com/key.md?sig=x';
    await uploadFileToUrl(s3, file, 'text/markdown');
    expect(axiosPut).toHaveBeenCalledTimes(1);
    expect(apiPut).not.toHaveBeenCalled();
    expect(axiosPut.mock.calls[0][0]).toBe(s3);
  });

  it('sends protocol-relative URLs through raw axios, never the authed api client', async () => {
    // '//host/...' passes startsWith('/'); guard it so the Bearer never reaches a foreign origin.
    await uploadFileToUrl('//evil.example.com/key.md', file, 'text/markdown');
    expect(axiosPut).toHaveBeenCalledTimes(1);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('forwards request config (signal, onUploadProgress) and Content-Type to the put call', async () => {
    const signal = new AbortController().signal;
    const onUploadProgress = vi.fn();
    await uploadFileToUrl('/api/files/abc/upload', file, 'text/markdown', { signal, onUploadProgress });
    const cfg = apiPut.mock.calls[0][2];
    expect(cfg.signal).toBe(signal);
    expect(cfg.onUploadProgress).toBe(onUploadProgress);
    expect(cfg.headers['Content-Type']).toBe('text/markdown');
  });
});
