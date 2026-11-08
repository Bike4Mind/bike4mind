import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeType, StorageLimitError } from '@bike4mind/common';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const h = vi.hoisted(() => ({
  createFabFile: vi.fn(),
  findUser: vi.fn(),
  findOrganization: vi.fn(),
  assertCanWriteDataLakeTags: vi.fn(),
  reconcileDataLakeFallbackTags: vi.fn(),
  consumeFileUploadBudget: vi.fn(async (_req: unknown, _fileCount: number) => undefined),
  pendingBytes: new Map<string | undefined, number>(),
  admitPendingUploads: vi.fn(),
}));

vi.mock('@server/files/fileUploadBudget', () => ({ consumeFileUploadBudget: h.consumeFileUploadBudget }));
vi.mock('@server/files/pendingUploads', () => ({ admitPendingUploads: h.admitPendingUploads }));
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createS3Client: () => ({}),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
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
vi.mock('@bike4mind/server-utils/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

import { createPresignedUpload } from './createPresignedUpload';

beforeEach(() => {
  h.pendingBytes.clear();
  h.findUser.mockResolvedValue({ id: 'u1', currentStorageSize: 0 });
  h.admitPendingUploads.mockImplementation(async () => ({
    count: 0,
    bytesFor: (organizationId: string | undefined) => h.pendingBytes.get(organizationId) ?? 0,
  }));
});

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

  it('stamps the API key that requested the upload, so its later indexing charge is attributed to it', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
    const keyReq = { user: { id: 'u1' }, ability: {}, logger: { warn: vi.fn() }, apiKeyInfo: { keyId: 'key-1' } };
    await createPresignedUpload(keyReq as never, upload() as never);

    expect(h.createFabFile.mock.calls[0][0]).toMatchObject({ apiKeyId: 'key-1' });
  });

  it('stamps no API key on a JWT upload', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
    await createPresignedUpload(req, upload() as never);

    expect(created()).not.toHaveProperty('apiKeyId');
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

describe('createPresignedUpload - upload allowance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFile.mockResolvedValue({ id: 'f1' });
    h.findOrganization.mockImplementation(async (id: string) => ({ id, currentStorageSize: 0 }));
    h.reconcileDataLakeFallbackTags.mockImplementation(async (tags: unknown) => tags);
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
  });

  it('spends one unit of the allowance for the upload', async () => {
    await createPresignedUpload(req, upload() as never);

    expect(h.consumeFileUploadBudget).toHaveBeenCalledTimes(1);
    expect(h.consumeFileUploadBudget.mock.calls[0][1]).toBe(1);
  });

  it('creates no file and presigns nothing when the allowance refuses the upload', async () => {
    h.consumeFileUploadBudget.mockRejectedValueOnce(new Error('Upload limit reached'));

    await expect(createPresignedUpload(req, upload() as never)).rejects.toThrow('Upload limit reached');
    expect(h.createFabFile).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('does not spend the allowance on an upload an earlier gate refuses', async () => {
    await expect(
      createPresignedUpload(req, {
        ...upload(),
        fileName: 'malware.exe',
        mimeType: 'application/x-msdownload',
      } as never)
    ).rejects.toThrow(/unsupported file type/);

    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
  });
});

describe('createPresignedUpload - in-flight uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFile.mockResolvedValue({ id: 'f1' });
    h.reconcileDataLakeFallbackTags.mockImplementation(async (tags: unknown) => tags);
    h.assertCanWriteDataLakeTags.mockResolvedValue([]);
  });

  it('rejects a negative declared size before admission or allowance consumption', async () => {
    await expect(createPresignedUpload(req, { ...upload(), fileSize: -1 } as never)).rejects.toThrow(
      'File size must be positive'
    );
    expect(h.admitPendingUploads).not.toHaveBeenCalled();
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('admits one pending upload against the pool the file bills to', async () => {
    h.assertCanWriteDataLakeTags.mockResolvedValue([
      { id: 'lake-1', datalakeTag: 'datalake:team', organizationId: 'org-1', createdAt: new Date() },
    ]);
    h.findOrganization.mockResolvedValue({ id: 'org-1', currentStorageSize: 0 });

    await createPresignedUpload(req, upload([{ name: 'datalake:team', strength: 1 }]) as never);

    expect(h.admitPendingUploads).toHaveBeenCalledWith(req, 1, ['org-1']);
  });

  it('refuses before spending the allowance or creating a file when the cap refuses', async () => {
    h.admitPendingUploads.mockRejectedValueOnce(new Error('uploads in progress'));

    await expect(createPresignedUpload(req, upload() as never)).rejects.toThrow('uploads in progress');
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('reads personal usage after admission rather than using the auth snapshot', async () => {
    h.admitPendingUploads.mockImplementationOnce(async () => {
      h.findUser.mockResolvedValue({ id: 'u1', storageLimit: 1, currentStorageSize: 1_000_000 });
      return { count: 0, bytesFor: () => 0 };
    });

    await expect(createPresignedUpload(req, upload() as never)).rejects.toMatchObject({
      info: { errorCode: 'storage_limit_exceeded', used_bytes: 1_000_000 },
    });
    expect(h.findUser).toHaveBeenCalledWith('u1');
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('propagates a failed personal usage read before spending the allowance', async () => {
    h.findUser.mockRejectedValueOnce(new Error('usage unavailable'));
    await expect(createPresignedUpload(req, upload() as never)).rejects.toThrow('usage unavailable');
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
  });

  it('refuses when the personal owner disappeared after auth', async () => {
    h.findUser.mockResolvedValueOnce(null);
    await expect(createPresignedUpload(req, upload() as never)).rejects.toThrow('Sign in to upload files');
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
  });

  it("counts the owner's in-flight bytes against the quota", async () => {
    // Default 1000 MB personal quota, all of it already promised to uploads in flight.
    h.pendingBytes.set(undefined, 1000 * 1_000_000);

    await expect(createPresignedUpload(req, upload() as never)).rejects.toMatchObject({
      info: { errorCode: 'storage_limit_exceeded', used_bytes: 1000 * 1_000_000, requested_bytes: 10 },
    });
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
  });
});
