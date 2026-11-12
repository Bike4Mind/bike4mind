import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// No global sst mock in this package; a module on the import path reads a Resource at load.
vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => ({ value: 'test', name: 'test' }) }) }));
import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { S3Storage } from '../../../../b4m-core/fab-pipeline/src/storage/S3Storage';

const {
  getFabFile,
  generateSignedUrl,
  recordLakeAccessEvent,
  resolveAccessibleLakes,
  grantingLakes,
  findById,
  adminBypassLakeIds,
} = vi.hoisted(() => ({
  adminBypassLakeIds: vi.fn(),
  getFabFile: vi.fn(),
  generateSignedUrl: vi.fn(),
  recordLakeAccessEvent: vi.fn(),
  resolveAccessibleLakes: vi.fn(),
  grantingLakes: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileRepository: { findById },
  lakeAccessEventRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { getFabFile, generateSignedUrl },
  dataLakeService: { recordLakeAccessEvent },
}));
vi.mock('../dataLakes/index', () => ({
  adminBypassLakeIds,
  resolveAccessibleLakes,
  grantingLakes,
}));
vi.mock('../dataLakes/resolveAuditPrincipal', () => ({ resolveAuditPrincipal: () => ({}) }));
vi.mock('../utils/storage/index', () => ({
  getFilesStorage: () => new S3Storage('files-bucket', 'us-east-2'),
}));

import { loadAccessibleFabFile, type FabFileAccessRequest } from './loadAccessibleFabFile';

const lake = { id: 'lake-1' };
const lakeFile = { id: 'file-1', tags: [{ name: 'datalake:lake-1' }] };

function request(apiKeyInfo?: { scopes: ApiKeyScope[] }): FabFileAccessRequest {
  return {
    user: { id: 'user-1', organizationId: null },
    apiKeyInfo,
    logger: { error: vi.fn() },
  } as unknown as FabFileAccessRequest;
}

describe('loadAccessibleFabFile data-lake fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFabFile.mockRejectedValue(new NotFoundError('File not found'));
    resolveAccessibleLakes.mockResolvedValue([lake]);
    findById.mockResolvedValue(lakeFile);
    grantingLakes.mockReturnValue([lake]);
    generateSignedUrl.mockResolvedValue({ ...lakeFile, fileUrl: 'https://signed' });
    recordLakeAccessEvent.mockResolvedValue(undefined);
    adminBypassLakeIds.mockResolvedValue([]);
  });

  it('serves a lake-granted file to a JWT caller', async () => {
    await expect(loadAccessibleFabFile(request(), 'file-1')).resolves.toMatchObject({ fileUrl: 'https://signed' });
  });

  it('serves a lake-granted file to a key holding datalake:read', async () => {
    const req = request({ scopes: [ApiKeyScope.READ_FILES, ApiKeyScope.DATALAKE_READ] });
    await expect(loadAccessibleFabFile(req, 'file-1')).resolves.toMatchObject({ fileUrl: 'https://signed' });
  });

  it('passes the admin-bypass marker to the audit write', async () => {
    adminBypassLakeIds.mockResolvedValue(['lake-1']);
    await loadAccessibleFabFile(request(), 'file-1');
    expect(adminBypassLakeIds).toHaveBeenCalledWith(expect.anything(), ['lake-1']);
    expect(recordLakeAccessEvent.mock.calls[0][1]).toMatchObject({ adminBypassLakeIds: ['lake-1'] });
  });

  it('omits the marker for a member read', async () => {
    await loadAccessibleFabFile(request(), 'file-1');
    expect(recordLakeAccessEvent.mock.calls[0][1]).not.toHaveProperty('adminBypassLakeIds');
  });

  it('returns no file and records nothing when member-access classification is incomplete', async () => {
    adminBypassLakeIds.mockRejectedValue(new Error('classification unavailable'));
    await expect(loadAccessibleFabFile(request(), 'file-1')).rejects.toThrow('classification unavailable');
    expect(recordLakeAccessEvent).not.toHaveBeenCalled();
  });

  it('rejects when the audit write rejects', async () => {
    adminBypassLakeIds.mockResolvedValue(['lake-1']);
    recordLakeAccessEvent.mockRejectedValue(new Error('mongo blip'));
    await expect(loadAccessibleFabFile(request(), 'file-1')).rejects.toThrow('mongo blip');
  });

  it('keeps the 404 for a files:read-only key and never resolves its lakes', async () => {
    const req = request({ scopes: [ApiKeyScope.READ_FILES] });
    await expect(loadAccessibleFabFile(req, 'file-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(resolveAccessibleLakes).not.toHaveBeenCalled();
    expect(generateSignedUrl).not.toHaveBeenCalled();
  });
});

describe('loadAccessibleFabFile browser response URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAccessibleLakes.mockResolvedValue([lake]);
    findById.mockResolvedValue(lakeFile);
    grantingLakes.mockReturnValue([lake]);
    vi.stubEnv('AWS_REGION', 'us-east-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://minio.internal:9000');
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid');
  });

  it.each(['owner', 'lake'])('returns a browser-reachable URL only after %s access grants the file', async access => {
    const sign = async (
      _input: unknown,
      adapter: {
        storage: { generateSignedUrl: (path: string, expiry: number) => Promise<string> };
      }
    ) => {
      return { ...lakeFile, fileUrl: await adapter.storage.generateSignedUrl('owned/report.txt', 600) };
    };
    if (access === 'owner')
      getFabFile.mockImplementation(async (_user: unknown, input: unknown, adapter: Parameters<typeof sign>[1]) =>
        sign(input, adapter)
      );
    else {
      getFabFile.mockRejectedValue(new NotFoundError('File not found'));
      generateSignedUrl.mockImplementation(sign);
    }
    const result = await loadAccessibleFabFile(request(), 'file-1');
    const url = new URL(result.fileUrl!);
    expect(url.origin).toBe('https://objects.example.invalid');
    expect(url.pathname).toBe('/files-bucket/owned/report.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });
});

afterEach(() => vi.unstubAllEnvs());
