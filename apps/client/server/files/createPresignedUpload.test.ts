import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeType, StorageLimitError } from '@bike4mind/common';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const h = vi.hoisted(() => ({
  createFabFile: vi.fn(),
  findOrganization: vi.fn(),
  assertCanWriteDataLakeTags: vi.fn(),
  reconcileDataLakeFallbackTags: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createS3Client: () => ({}),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: h.findOrganization },
  adminSettingsRepository: { getSettingsValue: vi.fn() },
  dataLakeBatchRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingsMap: vi.fn(async () => ({})),
  checkStorageLimit: vi.fn(),
}));
// Partial: only the lake gates are stubbed; fabFilesService.pickOwnerOrganizationId stays real.
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<{ dataLakeService: Record<string, unknown> }>();
  return {
    ...actual,
    dataLakeService: {
      ...actual.dataLakeService,
      assertCanWriteDataLakeTags: h.assertCanWriteDataLakeTags,
      assertCanWriteStaticRegistryTags: vi.fn(),
      reconcileDataLakeFallbackTags: h.reconcileDataLakeFallbackTags,
    },
  };
});
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ assertDataLakeTagWriteScope: vi.fn() }));
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

import { createPresignedUpload } from './createPresignedUpload';

const req = { user: { id: 'u1' }, ability: {}, logger: { warn: vi.fn() } } as never;
const upload = (tags: { name: string; strength: number }[] = []) => ({
  fileName: 'report.txt',
  mimeType: 'text/plain',
  fileSize: 10,
  type: KnowledgeType.FILE,
  tags,
});
const created = () => h.createFabFile.mock.calls[0][0] as { organizationId?: string };

describe('createPresignedUpload - owning organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFile.mockResolvedValue({ id: 'f1' });
    h.findOrganization.mockImplementation(async (id: string) => ({ id, currentStorageSize: 0 }));
    h.reconcileDataLakeFallbackTags.mockImplementation(async (tags: unknown) => tags);
  });

  it('stamps the org of the org-owned lake the upload joins', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([
      { id: 'lake-1', datalakeTag: 'datalake:team', organizationId: 'org-1', createdAt: new Date() },
    ]);
    await createPresignedUpload(req, upload([{ name: 'datalake:team', strength: 1 }]) as never);

    expect(created().organizationId).toBe('org-1');
  });

  it('leaves an upload outside any org lake personal', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
    await createPresignedUpload(req, upload() as never);

    expect(created()).not.toHaveProperty('organizationId');
  });

  it('binds the declared fileSize into the signature, so S3 refuses a PUT of any other length', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
    await createPresignedUpload(req, upload() as never);
    const [, command, options] = vi.mocked(getSignedUrl).mock.calls.at(-1)!;
    expect((command as { input: { ContentLength?: number } }).input.ContentLength).toBe(10);
    expect(options?.signableHeaders?.has('content-length')).toBe(true);
    // Marks the row for the landed-size gate, which judges only client uploads.
    expect(h.createFabFile.mock.calls[0][0]).toMatchObject({ clientUpload: true });
  });
});

describe('createPresignedUpload - quota owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFile.mockResolvedValue({ id: 'f1' });
    h.reconcileDataLakeFallbackTags.mockImplementation(async (tags: unknown) => tags);
  });

  it('checks an org-lake upload against the lake org and refuses it at the org limit', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([
      { id: 'lake-1', datalakeTag: 'datalake:team', organizationId: 'org-1', createdAt: new Date() },
    ]);
    // 1 MB limit, already full: only the org pool can refuse this 10-byte upload (the user is empty).
    h.findOrganization.mockResolvedValue({ id: 'org-1', storageLimit: 1, currentStorageSize: 1024 * 1024 });

    await expect(
      createPresignedUpload(req, upload([{ name: 'datalake:team', strength: 1 }]) as never)
    ).rejects.toBeInstanceOf(StorageLimitError);

    expect(h.findOrganization).toHaveBeenCalledWith('org-1');
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('never reads an org for an upload outside any org lake', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
    await createPresignedUpload(req, upload() as never);

    expect(h.findOrganization).not.toHaveBeenCalled();
  });
});
