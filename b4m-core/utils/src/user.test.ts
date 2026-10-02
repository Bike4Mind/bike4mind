import { describe, it, expect, vi } from 'vitest';
import type { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { checkOrganizationStorageLimit, checkStorageLimit, checkStorageLimitForFile } from './user';
import { BadRequestError } from './errors';

const MB = 1000000;

const user = (fields: Partial<IUserDocument> = {}) => fields as IUserDocument;
const org = (fields: Record<string, unknown> = {}) => fields as unknown as IOrganizationDocument;

describe('checkStorageLimit', () => {
  it('counts the user current storage against the limit', async () => {
    await expect(checkStorageLimit(user({ storageLimit: 10, currentStorageSize: 9 * MB }), 2 * MB)).rejects.toThrow(
      'File size exceeds storage limit'
    );
    await expect(checkStorageLimit(user({ storageLimit: 10, currentStorageSize: 8 * MB }), 2 * MB)).resolves.toBe(
      undefined
    );
  });

  it('defaults to a 1000MB limit', async () => {
    await expect(checkStorageLimit(user(), 1000 * MB + 1)).rejects.toThrow(BadRequestError);
    await expect(checkStorageLimit(user(), 1000 * MB)).resolves.toBe(undefined);
  });
});

describe('checkOrganizationStorageLimit', () => {
  it('rejects a single file larger than the org limit', async () => {
    await expect(checkOrganizationStorageLimit(org({ storageLimit: 5 }), 5 * MB + 1)).rejects.toThrow(
      'Organization storage limit exceeded'
    );
  });

  it('ignores any stray currentStorageSize persisted on the org', async () => {
    await expect(
      checkOrganizationStorageLimit(org({ storageLimit: 5, currentStorageSize: 5 * MB }), 4 * MB)
    ).resolves.toBe(undefined);
  });

  it('defaults to a 1000MB limit', async () => {
    await expect(checkOrganizationStorageLimit(org(), 1000 * MB)).resolves.toBe(undefined);
    await expect(checkOrganizationStorageLimit(org(), 1000 * MB + 1)).rejects.toThrow(BadRequestError);
  });
});

describe('checkStorageLimitForFile', () => {
  it('checks the org limit instead of the user quota for an org upload', async () => {
    const getOrganization = vi.fn().mockResolvedValue(org({ storageLimit: 10 }));
    const overQuotaUser = user({ storageLimit: 1, currentStorageSize: 1 * MB });

    await expect(checkStorageLimitForFile(overQuotaUser, 2 * MB, 'org-1', getOrganization)).resolves.toBe(undefined);
    expect(getOrganization).toHaveBeenCalledWith('org-1');
  });

  it('throws when the organization does not exist', async () => {
    await expect(checkStorageLimitForFile(user(), 1, 'missing', vi.fn().mockResolvedValue(null))).rejects.toThrow(
      'Organization not found'
    );
  });

  it('falls back to the user quota without an organization', async () => {
    await expect(checkStorageLimitForFile(user({ storageLimit: 1, currentStorageSize: 1 * MB }), 1)).rejects.toThrow(
      'File size exceeds storage limit'
    );
  });
});
