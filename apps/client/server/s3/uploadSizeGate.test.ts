import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  updateOne: vi.fn(),
  deleteObject: vi.fn(),
  findOrganization: vi.fn(),
  findUser: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  FabFile: { updateOne: h.updateOne },
  organizationRepository: { findById: h.findOrganization },
  User: { findById: h.findUser },
}));
// Only the settings read is stubbed; getSettingsValue and checkStorageLimitForFile are real.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingsMap: vi.fn(async () => h.settings),
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: h.deleteObject }) }));

import { judgeLandedUpload, rejectLandedUpload, type LandedUploadRow } from './uploadSizeGate';

const MB = 1024 * 1024;
const owner = (over: Partial<IUserDocument> = {}) =>
  ({ id: 'u1', storageLimit: 100, currentStorageSize: 0, ...over }) as IUserDocument;

const logger = { warn: vi.fn(), error: vi.fn() } as never;
const judge = ({ measuredSize = 1000, ...row }: Partial<LandedUploadRow> & { measuredSize?: number } = {}) =>
  judgeLandedUpload({ _id: 'ff1', userId: 'u1', fileSize: 1000, status: 'pending', ...row }, measuredSize, logger);

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = {};
  h.findUser.mockResolvedValue(owner());
});

describe('judgeLandedUpload', () => {
  it('admits an object no larger than its declaration, under the limits', async () => {
    expect(await judge()).toBeNull();
    expect(await judge({ measuredSize: 900 })).toBeNull();
  });

  it('rejects an object larger than the size the create-time checks ran on', async () => {
    expect(await judge({ measuredSize: 1001 })).toBe('larger_than_declared');
  });

  it('rejects an object at or over MaxFileSize even with no declared size', async () => {
    expect(await judge({ fileSize: 0, measuredSize: 30 * MB })).toBe('file_too_large');
  });

  it('rejects an object that would take the owner past their storage limit', async () => {
    h.findUser.mockResolvedValue(owner({ storageLimit: 1, currentStorageSize: MB - 10 }));
    expect(await judge()).toBe('storage_limit_exceeded');
  });

  // A notebook import charges its rows before their S3 event can see them.
  it('does not count the bytes an import already charged to this row twice', async () => {
    // 10 bytes of headroom in a 1 MB (decimal) limit: the row's 1000 bytes are already in the balance.
    h.findUser.mockResolvedValue(owner({ storageLimit: 1, currentStorageSize: 999_990 }));
    expect(await judge({ storageChargedAt: new Date() })).toBeNull();
    expect(await judge()).toBe('storage_limit_exceeded');
  });

  it('admits an object within its declared size when the limits cannot be read', async () => {
    h.findUser.mockRejectedValue(new Error('mongo blip'));
    expect(await judge()).toBeNull();
    await expect(judge({ fileSize: 0 })).rejects.toThrow('mongo blip');
  });

  it("measures an org-owned file against the org's limit", async () => {
    h.findOrganization.mockResolvedValue({ id: 'o1', storageLimit: 0 });
    expect(await judge({ organizationId: 'o1' })).toBe('storage_limit_exceeded');
    expect(h.findOrganization).toHaveBeenCalledWith('o1');
  });

  it('leaves a rewrite of an already-complete row to its own commit', async () => {
    expect(await judge({ status: 'complete', measuredSize: 100 * MB })).toBeNull();
  });
});

describe('rejectLandedUpload', () => {
  it('deletes the object and withdraws the still-pending row', async () => {
    h.updateOne.mockResolvedValue({ modifiedCount: 1 });

    expect(await rejectLandedUpload('ff1', 'uploads/x.pdf')).toBe(true);
    expect(h.deleteObject).toHaveBeenCalledWith('uploads/x.pdf');
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'ff1', status: { $ne: 'complete' }, deletedAt: null },
      { $set: { deletedAt: expect.any(Date) } }
    );
  });

  it('keeps the object of a row that went complete meanwhile', async () => {
    h.updateOne.mockResolvedValue({ modifiedCount: 0 });

    expect(await rejectLandedUpload('ff1', 'uploads/x.pdf')).toBe(false);
    expect(h.deleteObject).not.toHaveBeenCalled();
  });
});
