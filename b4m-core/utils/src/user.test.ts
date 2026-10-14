import { describe, it, expect, vi } from 'vitest';
import { StorageLimitError, StorageLimitErrorInfoSchema } from '@bike4mind/common';
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

  it('carries a stable code and the used, limit and requested bytes', async () => {
    await expect(
      checkStorageLimit(user({ storageLimit: 10, currentStorageSize: 9 * MB }), 2 * MB)
    ).rejects.toMatchObject({
      statusCode: 400,
      info: {
        errorCode: 'storage_limit_exceeded',
        used_bytes: 9 * MB,
        limit_bytes: 10 * MB,
        requested_bytes: 2 * MB,
        owner: 'user',
      },
    });
  });

  it('clamps a drifted negative counter so the info still satisfies the wire schema', async () => {
    const error = await checkStorageLimit(user({ storageLimit: 1, currentStorageSize: -500_000 }), 1_600_000).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(StorageLimitError);
    const { info } = error as StorageLimitError;
    expect(info.used_bytes).toBe(0);
    expect(StorageLimitErrorInfoSchema.safeParse(info).success).toBe(true);
  });

  it('clamps a negative stored limit so the info still satisfies the wire schema', async () => {
    const error = await checkStorageLimit(user({ storageLimit: -1 }), 1).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(StorageLimitError);
    const { info } = error as StorageLimitError;
    expect(info.limit_bytes).toBe(0);
    expect(StorageLimitErrorInfoSchema.safeParse(info).success).toBe(true);
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

  it('carries a stable org code and the byte counts', async () => {
    await expect(checkOrganizationStorageLimit(org({ storageLimit: 5 }), 5 * MB + 1)).rejects.toMatchObject({
      statusCode: 400,
      info: {
        errorCode: 'org_storage_limit_exceeded',
        used_bytes: 0,
        limit_bytes: 5 * MB,
        requested_bytes: 5 * MB + 1,
        owner: 'org',
      },
    });
  });

  it('clamps a negative stored org limit so the info still satisfies the wire schema', async () => {
    const error = await checkOrganizationStorageLimit(org({ storageLimit: -1 }), 1).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(StorageLimitError);
    const { info } = error as StorageLimitError;
    expect(info.limit_bytes).toBe(0);
    expect(StorageLimitErrorInfoSchema.safeParse(info).success).toBe(true);
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
