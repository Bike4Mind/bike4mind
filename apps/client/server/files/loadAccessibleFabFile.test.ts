import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { Request } from 'express';

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
vi.mock('@server/dataLakes/resolveAuditPrincipal', () => ({ resolveAuditPrincipal: () => ({}) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));

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
