import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { Request } from 'express';
import { S3Storage } from '../../../../b4m-core/fab-pipeline/src/storage/S3Storage';

const { getFabFile, generateSignedUrl, recordLakeAccessEvent, resolveAccessibleLakes, grantingLakes, findById } =
  vi.hoisted(() => ({
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
vi.mock('@server/dataLakes', () => ({ resolveAccessibleLakes, grantingLakes }));
vi.mock('@bike4mind/server-utils/dataLakes/resolveAuditPrincipal', () => ({ resolveAuditPrincipal: () => ({}) }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => new S3Storage('files-bucket', 'us-east-2'),
}));

import { loadAccessibleFabFile } from './loadAccessibleFabFile';

const lake = { id: 'lake-1' };
const lakeFile = { id: 'file-1', tags: [{ name: 'datalake:lake-1' }] };

function request(apiKeyInfo?: { scopes: ApiKeyScope[] }): Request {
  return {
    user: { id: 'user-1', organizationId: null },
    apiKeyInfo,
    logger: { error: vi.fn() },
  } as unknown as Request;
}

describe('loadAccessibleFabFile data-lake fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFabFile.mockRejectedValue(new NotFoundError('File not found'));
    resolveAccessibleLakes.mockResolvedValue([lake]);
    findById.mockResolvedValue(lakeFile);
    grantingLakes.mockReturnValue([lake]);
    generateSignedUrl.mockResolvedValue({ ...lakeFile, fileUrl: 'https://signed' });
  });

  it('serves a lake-granted file to a JWT caller', async () => {
    await expect(loadAccessibleFabFile(request(), 'file-1')).resolves.toMatchObject({ fileUrl: 'https://signed' });
  });

  it('serves a lake-granted file to a key holding datalake:read', async () => {
    const req = request({ scopes: [ApiKeyScope.READ_FILES, ApiKeyScope.DATALAKE_READ] });
    await expect(loadAccessibleFabFile(req, 'file-1')).resolves.toMatchObject({ fileUrl: 'https://signed' });
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
        storage: { signedUrlCache?: string; generateSignedUrl: (path: string, expiry: number) => Promise<string> };
      }
    ) => {
      expect(adapter.storage.signedUrlCache).toBe('bypass');
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

  it('keeps the shared URL cache when no browser signing endpoint is configured', async () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', '');
    let cacheMode: string | undefined = 'unset';
    getFabFile.mockImplementation(
      async (_user: unknown, _input: unknown, adapter: { storage: { signedUrlCache?: string } }) => {
        cacheMode = adapter.storage.signedUrlCache;
        return lakeFile;
      }
    );
    await loadAccessibleFabFile(request(), 'file-1');
    expect(cacheMode).toBeUndefined();
  });
});

afterEach(() => vi.unstubAllEnvs());
