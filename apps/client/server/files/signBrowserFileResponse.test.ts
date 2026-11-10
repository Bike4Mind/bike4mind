import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IFabFileDocument } from '@bike4mind/common';
import { S3Storage } from '../../../../b4m-core/fab-pipeline/src/storage/S3Storage';

const h = vi.hoisted(() => ({ signUrl: vi.fn<S3Storage['getSignedUrl']>(), update: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { update: h.update },
  userRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.signUrl }),
}));

import { signBrowserFileResponse } from './signBrowserFileResponse';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AWS_REGION', 'us-east-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://minio.internal:9000');
  vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid:9443');
  const storage = new S3Storage('files-bucket');
  h.signUrl.mockImplementation((...args) => storage.getSignedUrl(...args));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('signs the browser response with the SDK, ignoring a stored URL, without writing the row', async () => {
  const input = {
    id: 'owned',
    moderationStatus: 'clean',
    mimeType: 'text/plain',
    filePath: 'owned/folder name/report.txt',
    fileUrl: 'http://minio.internal:9000/files-bucket/owned/report.txt',
    fileUrlExpireAt: new Date(Date.now() + 3600000),
  } as IFabFileDocument;
  const original = { ...input };
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  const response = await signBrowserFileResponse(input);
  const url = new URL(response.fileUrl!);
  expect(url.origin).toBe('https://objects.example.invalid:9443');
  expect(url.pathname).toBe('/files-bucket/owned/folder%20name/report.txt');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  expect(input).toEqual(original);
  expect(response).not.toBe(input);
  expect(fetch).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});

it('drops the upload PUT URL and mints no GET for URL-less upload metadata', async () => {
  const input = {
    id: 'upload',
    filePath: 'owned/upload.txt',
    presignedUrl: '/api/files/upload/upload',
  } as IFabFileDocument;
  const original = { ...input };
  const response = await signBrowserFileResponse(input);
  expect(response.presignedUrl).toBeUndefined();
  expect(response).toMatchObject({ id: 'upload', filePath: 'owned/upload.txt' });
  expect(input).toEqual(original);
  expect(response).not.toBe(input);
  expect(h.signUrl).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});

it('withholds a stored legacy URL when the clean file has no persisted path', async () => {
  const input = {
    id: 'pathless',
    moderationStatus: 'clean',
    fileUrl: 'http://minio.internal:9000/stale.txt',
    fileUrlExpireAt: new Date(Date.now() + 3600000),
  } as IFabFileDocument;
  const original = { ...input };
  const response = await signBrowserFileResponse(input);
  expect(response.fileUrl).toBeUndefined();
  expect(response.fileUrlExpireAt).toBeUndefined();
  expect(input).toEqual(original);
  expect(h.signUrl).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});

it.each(['pending', 'blocked'])('withholds a %s image before signing', async moderationStatus => {
  const input = {
    id: 'image',
    mimeType: 'image/png',
    moderationStatus,
    filePath: 'owned/image.png',
    fileUrl: 'http://minio.internal:9000/image.png',
    fileUrlExpireAt: new Date(Date.now() + 3600000),
  } as IFabFileDocument;
  const response = await signBrowserFileResponse(input);
  expect(response.fileUrl).toBeUndefined();
  expect(response.fileUrlExpireAt).toBeUndefined();
  expect(input.fileUrl).toBe('http://minio.internal:9000/image.png');
  expect(h.signUrl).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});

it('drops the upload PUT URL from a hydrated upload without exposing document internals', async () => {
  const { FabFile } = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  const input = new FabFile({
    fileName: 'upload.txt',
    mimeType: 'text/plain',
    presignedUrl: '/api/files/upload/owned',
  });
  const original = input.toJSON();
  const response = await signBrowserFileResponse(input);
  expect(response).toMatchObject({ id: original.id, fileName: 'upload.txt' });
  expect(response.presignedUrl).toBeUndefined();
  expect(response).not.toHaveProperty('_doc');
  expect(response).not.toHaveProperty('$__');
  expect(input.toJSON()).toEqual(original);
  expect(h.signUrl).not.toHaveBeenCalled();
});

it('preserves hydrated clean fields while signing only the response', async () => {
  const { FabFile } = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  const input = new FabFile({
    fileName: 'report.txt',
    mimeType: 'text/plain',
    moderationStatus: 'clean',
    filePath: 'owned/report.txt',
    fileUrl: 'http://minio.internal:9000/old',
    notes: 'retained',
    tags: [{ name: 'owned' }],
  });
  const original = input.toJSON();
  const response = await signBrowserFileResponse(input);
  expect(response).toMatchObject({ id: original.id, fileName: 'report.txt', notes: 'retained', tags: original.tags });
  expect(new URL(response.fileUrl!).origin).toBe('https://objects.example.invalid:9443');
  expect(response).not.toHaveProperty('_doc');
  expect(input.toJSON()).toEqual(original);
  expect(h.update).not.toHaveBeenCalled();
});

it.each([undefined, '', '   ', 'https://objects.example.invalid:9443'])(
  'always signs fresh and never writes the row: %s',
  async endpoint => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', endpoint);
    const storage = new S3Storage('files-bucket');
    h.signUrl.mockImplementation((...args) => storage.getSignedUrl(...args));
    const input = {
      id: 'expired',
      mimeType: 'text/plain',
      moderationStatus: 'clean',
      filePath: 'owned/report.txt',
      fileUrl: 'http://minio.internal:9000/expired',
      fileUrlExpireAt: new Date(Date.now() - 3600000),
    } as IFabFileDocument;
    const original = { ...input };
    const response = await signBrowserFileResponse(input);
    expect(new URL(response.fileUrl!).origin).toBe(endpoint?.trim() || 'http://minio.internal:9000');
    expect(response.fileUrl).not.toBe(original.fileUrl);
    expect(h.update).not.toHaveBeenCalled();
    expect(input).toEqual(original);
  }
);

it('signs repeated reads inside one window to the identical URL', async () => {
  const input = {
    id: 'a',
    mimeType: 'text/plain',
    moderationStatus: 'clean',
    filePath: 'owned/report.txt',
  } as IFabFileDocument;
  const first = await signBrowserFileResponse(input);
  const second = await signBrowserFileResponse(input);
  expect(second.fileUrl).toBe(first.fileUrl);
});

it('signs a read 10 minutes into the window to the same URL, expiring at window start + TTL', async () => {
  const input = {
    id: 'a',
    mimeType: 'text/plain',
    moderationStatus: 'clean',
    filePath: 'owned/report.txt',
  } as IFabFileDocument;
  vi.useFakeTimers({ now: new Date('2026-01-02T03:00:05Z') });
  try {
    const first = await signBrowserFileResponse(input);
    vi.setSystemTime(new Date('2026-01-02T03:10:05Z'));
    const second = await signBrowserFileResponse(input);
    expect(second.fileUrl).toBe(first.fileUrl);
    expect(second.fileUrlExpireAt).toEqual(new Date('2026-01-02T04:00:00Z'));
  } finally {
    vi.useRealTimers();
  }
});
