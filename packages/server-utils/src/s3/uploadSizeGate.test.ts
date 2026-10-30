import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  findOne: vi.fn(),
  deleteObject: vi.fn(),
  findOrganization: vi.fn(),
  findUser: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  FabFile: { findOneAndUpdate: h.findOneAndUpdate, findOne: h.findOne },
  organizationRepository: { findById: h.findOrganization },
  User: { findById: h.findUser },
}));
// Only the settings read is stubbed; getSettingsValue and checkStorageLimitForOwner are real.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingsMap: vi.fn(async () => h.settings),
}));
vi.mock('../utils/storage/index', () => ({ getFilesStorage: () => ({ delete: h.deleteObject }) }));

import { admitLandedUpload, judgeLandedUpload, rejectLandedUpload, type LandedUploadRow } from './uploadSizeGate';

const MB = 1024 * 1024;
const owner = (over: Partial<IUserDocument> = {}) =>
  ({ id: 'u1', storageLimit: 100, currentStorageSize: 0, ...over }) as IUserDocument;

const logger = { warn: vi.fn(), error: vi.fn() } as never;
const judge = ({ measuredSize = 1000, ...row }: Partial<LandedUploadRow> & { measuredSize?: number } = {}) =>
  judgeLandedUpload(
    { _id: 'ff1', userId: 'u1', fileSize: 1000, status: 'pending', clientUpload: true, ...row },
    measuredSize,
    logger
  );

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

  // A redelivered event can read the row after its first landing was charged but before it went complete.
  it('does not count the bytes already charged to this row twice', async () => {
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

  // Org-owned storage is billed to the org, so its counter, not the uploader's, bounds the landing.
  it("bounds an org-owned file by the org's usage, not the uploader's", async () => {
    h.findUser.mockResolvedValue(owner({ storageLimit: 1, currentStorageSize: MB }));
    h.findOrganization.mockResolvedValue({ id: 'o1', storageLimit: 1, currentStorageSize: 0 });
    expect(await judge({ organizationId: 'o1' })).toBeNull();

    h.findOrganization.mockResolvedValue({ id: 'o1', storageLimit: 1, currentStorageSize: MB - 10 });
    expect(await judge({ organizationId: 'o1' })).toBe('storage_limit_exceeded');
  });

  // e.g. an agent avatar: the door wrote bytes it held and returned success, so the gate must not
  // soft-delete it however far over the declared size or the owner's quota it lands.
  it('admits a row a server-side door wrote, without reading the limits', async () => {
    h.findUser.mockResolvedValue(owner({ storageLimit: 1, currentStorageSize: MB }));
    expect(await judge({ clientUpload: undefined, measuredSize: 30 * MB })).toBeNull();
    expect(await judge({ clientUpload: false, measuredSize: 2000 })).toBeNull();
    expect(h.findUser).not.toHaveBeenCalled();
  });

  it('leaves a rewrite of an already-complete row to its own commit', async () => {
    expect(await judge({ status: 'complete', measuredSize: 100 * MB })).toBeNull();
  });
});

describe('rejectLandedUpload', () => {
  it('deletes the object and withdraws the still-pending row', async () => {
    h.findOneAndUpdate.mockResolvedValue({ uploadRejectedAt: new Date() });

    expect(await rejectLandedUpload('ff1', 'uploads/x.pdf')).toBe(true);
    expect(h.deleteObject).toHaveBeenCalledWith('uploads/x.pdf');
    expect(h.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'ff1', status: { $ne: 'complete' }, deletedAt: null },
      { $set: { deletedAt: expect.any(Date), uploadRejectedAt: expect.any(Date) } },
      { new: true }
    );
  });

  it('keeps the object of a row that went complete meanwhile', async () => {
    h.findOneAndUpdate.mockResolvedValue(null);
    h.findOne.mockResolvedValue(null);

    expect(await rejectLandedUpload('ff1', 'uploads/x.pdf')).toBe(false);
    expect(h.deleteObject).not.toHaveBeenCalled();
  });

  it('retries cleanup of an already-rejected tombstone', async () => {
    h.findOneAndUpdate.mockResolvedValue(null);
    h.findOne.mockResolvedValue({ uploadRejectedAt: new Date() });

    expect(await rejectLandedUpload('ff1', 'uploads/x.pdf')).toBe(true);
    expect(h.deleteObject).toHaveBeenCalledWith('uploads/x.pdf');
    expect(h.findOne).toHaveBeenCalledWith(
      { _id: 'ff1', status: { $ne: 'complete' }, uploadRejectedAt: { $ne: null } },
      null,
      { includeDeleted: true }
    );
  });

  it('does not reject a landing that another invocation already completed', async () => {
    h.findOneAndUpdate.mockResolvedValue(null);
    h.findOne.mockResolvedValue(null);
    const row = { _id: 'ff1', userId: 'u1', fileSize: 1, status: 'pending' as const, clientUpload: true };

    expect(await admitLandedUpload(row, 2, 'uploads/x.pdf', logger)).toBe(true);
    expect(h.deleteObject).not.toHaveBeenCalled();
  });
});
