import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB,
  isStorageLimitError,
  StorageLimitError,
  StorageLimitErrorInfoSchema,
} from '@bike4mind/common';
import type { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { checkOrganizationStorageLimit, checkStorageLimit, checkStorageLimitForOwner } from './user';
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
  it('rejects a file that would push cumulative org usage past the limit', async () => {
    await expect(
      checkOrganizationStorageLimit(org({ storageLimit: 5, currentStorageSize: 4 * MB }), 1 * MB + 1)
    ).rejects.toThrow('Organization storage limit exceeded');
    await expect(
      checkOrganizationStorageLimit(org({ storageLimit: 5, currentStorageSize: 4 * MB }), 1 * MB)
    ).resolves.toBe(undefined);
  });

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

  it('reports the org usage it measured against', async () => {
    await expect(
      checkOrganizationStorageLimit(org({ storageLimit: 5, currentStorageSize: 5 * MB }), 1)
    ).rejects.toMatchObject({ info: { used_bytes: 5 * MB } });
  });

  it('defaults to DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB, not the per-user default', async () => {
    const limit = DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB * MB;
    await expect(checkOrganizationStorageLimit(org(), limit)).resolves.toBe(undefined);
    await expect(checkOrganizationStorageLimit(org(), limit + 1)).rejects.toThrow(BadRequestError);
  });
});

describe('checkStorageLimitForOwner', () => {
  it('checks the owning org instead of the uploader for an org-owned file', async () => {
    const getOrganization = vi.fn().mockResolvedValue(org({ storageLimit: 10 }));
    const overQuotaUser = user({ storageLimit: 1, currentStorageSize: 1 * MB });

    await expect(
      checkStorageLimitForOwner({ user: overQuotaUser, organizationId: 'org-1' }, 2 * MB, getOrganization)
    ).resolves.toBe(undefined);
    expect(getOrganization).toHaveBeenCalledWith('org-1');
  });

  it('refuses an org-owned file once the org pool is spent, even when the uploader has room', async () => {
    const getOrganization = vi.fn().mockResolvedValue(org({ storageLimit: 10, currentStorageSize: 10 * MB }));

    await expect(
      checkStorageLimitForOwner({ user: user(), organizationId: 'org-1' }, 1, getOrganization)
    ).rejects.toMatchObject({ info: { errorCode: 'org_storage_limit_exceeded', owner: 'org' } });
  });

  it('refuses a deleted organization as a quota block, not a hard error', async () => {
    await expect(
      checkStorageLimitForOwner({ user: user(), organizationId: 'missing' }, 1, vi.fn().mockResolvedValue(null))
    ).rejects.toSatisfy(error => isStorageLimitError(error) && error.info.errorCode === 'org_storage_limit_exceeded');
  });

  it('fails loudly when an org-owned check has no way to load the org', async () => {
    await expect(checkStorageLimitForOwner({ user: user(), organizationId: 'org-1' }, 1)).rejects.toThrow(
      'needs getOrganization'
    );
  });

  it('checks the uploader for a personal file', async () => {
    await expect(
      checkStorageLimitForOwner({ user: user({ storageLimit: 1, currentStorageSize: 1 * MB }) }, 1)
    ).rejects.toThrow('File size exceeds storage limit');
  });
});
