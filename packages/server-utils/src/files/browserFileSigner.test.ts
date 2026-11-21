import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => ({ value: 'test', name: 'test' }) }) }));
vi.mock('../utils/storage/index', async () => {
  const { S3Storage } = await import('../../../../b4m-core/fab-pipeline/src/storage/S3Storage');
  return { getFilesStorage: () => new S3Storage('files-bucket', 'us-east-2') };
});

import { browserFileStorage, signFabFileGet } from './browserFileSigner';

const query = (url: string) => new URL(url).searchParams;

describe('signFabFileGet', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_REGION', 'us-east-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('signs the attachment disposition into the link', async () => {
    const url = await signFabFileGet('u/page.html', 300, {
      ResponseContentDisposition: 'attachment; filename="page.html"',
    });
    expect(query(url).get('response-content-disposition')).toBe('attachment; filename="page.html"');
    expect(query(url).has('response-content-type')).toBe(false);
  });

  it('signs the pinned content type into the link', async () => {
    const url = await signFabFileGet('u/photo.png', 300, { ResponseContentType: 'image/png' });
    expect(query(url).get('response-content-type')).toBe('image/png');
    expect(query(url).has('response-content-disposition')).toBe(false);
  });

  it('is the generateSignedUrl the browser storage adapter hands fabFileService', () => {
    expect(browserFileStorage().generateSignedUrl).toBe(signFabFileGet);
  });
});
