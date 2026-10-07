import { describe, it, expect } from 'vitest';
import {
  attachUploadBytes,
  checkAttachStorage,
  checkStorageForUpload,
  getStorageQuota,
  serverStorageLimitMessage,
  storageExceededMessage,
} from './storageQuota';

const MB = 1_000_000;

describe('getStorageQuota', () => {
  it('converts the MB limit the way the server does, defaulting to 1000 MB', () => {
    expect(getStorageQuota({ currentStorageSize: 5, storageLimit: 2 })).toEqual({ usedBytes: 5, limitBytes: 2 * MB });
    expect(getStorageQuota({ currentStorageSize: 5 } as never)).toEqual({ usedBytes: 5, limitBytes: 1000 * MB });
  });

  it('returns null while usage is unknown so nothing is blocked', () => {
    expect(getStorageQuota(null)).toBeNull();
    expect(getStorageQuota({ storageLimit: 10 } as never)).toBeNull();
    expect(checkStorageForUpload(null, 10 * MB)).toEqual({ status: 'ok' });
  });
});

describe('checkStorageForUpload', () => {
  const quota = { usedBytes: 50 * MB, limitBytes: 100 * MB };

  it('is ok well under the limit', () => {
    expect(checkStorageForUpload(quota, 10 * MB)).toEqual({ status: 'ok' });
  });

  it('warns once the upload would take usage to 90% or more', () => {
    expect(checkStorageForUpload(quota, 40 * MB)).toMatchObject({ status: 'near', percent: 90 });
  });

  it('allows an upload that lands exactly on the limit, like the server', () => {
    expect(checkStorageForUpload(quota, 50 * MB).status).toBe('near');
  });

  it('refuses one byte over and reports how much to free', () => {
    const check = checkStorageForUpload(quota, 50 * MB + 1);
    expect(check).toMatchObject({ status: 'exceeds', bytesToFree: 1 });
  });

  it('refuses any file for a user already at the limit', () => {
    const check = checkStorageForUpload({ usedBytes: 100 * MB, limitBytes: 100 * MB }, 1);
    expect(check.status).toBe('exceeds');
    if (check.status !== 'exceeds') return;
    expect(storageExceededMessage(check)).toBe(
      'Not enough storage: you are using 100 MB of 100 MB, and this upload needs 1 B. Free up at least 1 B to continue.'
    );
  });
});

describe('serverStorageLimitMessage', () => {
  const axiosError = (status: number, data: unknown) => ({ isAxiosError: true, response: { status, data } });

  it('returns the server refusal verbatim', () => {
    expect(serverStorageLimitMessage(axiosError(400, { error: 'File size exceeds storage limit' }))).toBe(
      'File size exceeds storage limit'
    );
  });

  it('also matches the organization refusal (checkOrganizationStorageLimit)', () => {
    expect(serverStorageLimitMessage(axiosError(400, { error: 'Organization storage limit exceeded' }))).toBe(
      'Organization storage limit exceeded'
    );
  });

  it('ignores other errors', () => {
    expect(serverStorageLimitMessage(axiosError(400, { error: 'No file size provided' }))).toBeUndefined();
    expect(serverStorageLimitMessage(axiosError(500, { error: 'File size exceeds storage limit' }))).toBeUndefined();
    expect(serverStorageLimitMessage(new Error('File size exceeds storage limit'))).toBeUndefined();
  });
});

describe('attachUploadBytes', () => {
  const sized = (size: number, type: string) => {
    const file = new File([], 'f', { type });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it('caps an image at the size the client resizes it down to', () => {
    expect(attachUploadBytes(sized(12 * MB, 'image/jpeg'))).toBe(3 * 1024 * 1024);
    expect(attachUploadBytes(sized(1000, 'image/png'))).toBe(1000);
  });

  it('counts any other file at its full size', () => {
    expect(attachUploadBytes(sized(12 * MB, 'application/pdf'))).toBe(12 * MB);
  });
});

describe('checkAttachStorage', () => {
  const sized = (size: number, type: string) => {
    const file = new File([], 'f', { type });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  // The exact repro from review: the flat resize-cap estimate (3 MB) exceeds, but the true
  // post-resize size (as low as 85% of that cap) does not - so this must not block.
  it('does not block an oversized image whose true resized size would still fit', () => {
    const quota = { usedBytes: 1 * MB, limitBytes: 4 * MB };
    const check = checkAttachStorage(quota, sized(4_000_000, 'image/jpeg'));
    expect(check.status).not.toBe('exceeds');
  });

  it('still blocks when even the best-case resized size would exceed', () => {
    const quota = { usedBytes: 0, limitBytes: 1 * MB };
    const check = checkAttachStorage(quota, sized(12 * MB, 'image/jpeg'));
    expect(check.status).toBe('exceeds');
  });

  it('judges a non-image at its real size, with no resize margin', () => {
    const quota = { usedBytes: 0, limitBytes: 4 * MB };
    const check = checkAttachStorage(quota, sized(5 * MB, 'application/pdf'));
    expect(check.status).toBe('exceeds');
  });
});
