import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IFabFileDocument } from '@bike4mind/common';
import { verifyFileContentSig } from '@bike4mind/utils';

const h = vi.hoisted(() => ({ signUrl: vi.fn(), update: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { update: h.update },
  userRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.signUrl }),
}));

import { signBrowserFileResponse } from './signBrowserFileResponse';
import { fileContentKey } from '@bike4mind/server-utils/files/browserFileSigner';

const FILE_ID = '0123456789abcdef01234567';

const contentQuery = (fileUrl: string | undefined) => {
  const url = new URL(fileUrl!, 'https://app.example.invalid');
  return { pathname: url.pathname, exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') };
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('mints the stable content URL, ignoring a stored URL, without writing the row', async () => {
  const input = {
    id: FILE_ID,
    moderationStatus: 'clean',
    mimeType: 'text/plain',
    filePath: 'owned/folder name/report.txt',
    fileUrl: 'http://minio.internal:9000/files-bucket/owned/report.txt',
    fileUrlExpireAt: new Date(Date.now() + 3600000),
  } as IFabFileDocument;
  const original = { ...input };
  const response = await signBrowserFileResponse(input);
  const { pathname, exp, sig } = contentQuery(response.fileUrl);
  expect(pathname).toBe(`/api/files/${FILE_ID}/content`);
  expect(verifyFileContentSig({ fileId: FILE_ID, filePath: input.filePath, exp, sig }, fileContentKey())).toMatchObject(
    { ok: true }
  );
  expect(h.signUrl).not.toHaveBeenCalled();
  expect(input).toEqual(original);
  expect(response).not.toBe(input);
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
  expect(contentQuery(response.fileUrl).pathname).toBe(`/api/files/${original.id}/content`);
  expect(response).not.toHaveProperty('_doc');
  expect(input.toJSON()).toEqual(original);
  expect(h.update).not.toHaveBeenCalled();
});

it('mints a fresh URL for an expired stored one and never writes the row', async () => {
  const input = {
    id: FILE_ID,
    mimeType: 'text/plain',
    moderationStatus: 'clean',
    filePath: 'owned/report.txt',
    fileUrl: 'http://minio.internal:9000/expired',
    fileUrlExpireAt: new Date(Date.now() - 3600000),
  } as IFabFileDocument;
  const original = { ...input };
  const response = await signBrowserFileResponse(input);
  expect(contentQuery(response.fileUrl).pathname).toBe(`/api/files/${FILE_ID}/content`);
  expect(response.fileUrlExpireAt!.getTime()).toBeGreaterThan(Date.now());
  expect(h.update).not.toHaveBeenCalled();
  expect(input).toEqual(original);
});

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
