// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, FabFileSourceType, FILE_READ_TOOL_NAMES } from '@bike4mind/common';

const { findByIdAndUserId } = vi.hoisted(() => ({ findByIdAndUserId: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findByIdAndUserId } }));

const { limitInputFilesForKey } = await import('./generateKeyInputs');
const { fileToolsDeniedFor } = await import('./fileScopes');
const { GENERATE_UPLOAD_MARKER } = await import('./generateUploadMarker');

const FILE_ID = 'a'.repeat(24);
const key = (...scopes: ApiKeyScope[]) => ({ apiKeyInfo: { scopes } });
const load = vi.fn(async () => ({ s3Key: 'k' }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('limitInputFilesForKey', () => {
  it('refuses a library file to an ai:generate key without files:read', async () => {
    findByIdAndUserId.mockResolvedValue({ userId: 'u1', sourceType: FabFileSourceType.MANUAL_UPLOAD });
    const limited = limitInputFilesForKey(key(ApiKeyScope.AI_GENERATE), load);
    expect(await limited('u1', FILE_ID)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('lets that key use a generated file or an upload it staged', async () => {
    const limited = limitInputFilesForKey(key(ApiKeyScope.AI_GENERATE), load);
    findByIdAndUserId.mockResolvedValueOnce({ userId: 'u1', sourceType: FabFileSourceType.TOOL_GENERATED });
    expect(await limited('u1', FILE_ID)).toEqual({ s3Key: 'k' });
    findByIdAndUserId.mockResolvedValueOnce({ userId: 'u1', sourceMetadata: { uploadedVia: GENERATE_UPLOAD_MARKER } });
    expect(await limited('u1', FILE_ID)).toEqual({ s3Key: 'k' });
  });

  it('leaves the loader unchanged for a files:read key and a session caller', () => {
    expect(limitInputFilesForKey(key(ApiKeyScope.AI_GENERATE, ApiKeyScope.READ_FILES), load)).toBe(load);
    expect(limitInputFilesForKey({}, load)).toBe(load);
  });
});

describe('fileToolsDeniedFor', () => {
  it('withholds the knowledge-base tools from a key without files:read only', () => {
    expect(fileToolsDeniedFor(key(ApiKeyScope.AI_CHAT))).toEqual([...FILE_READ_TOOL_NAMES]);
    expect(fileToolsDeniedFor(key(ApiKeyScope.AI_CHAT, ApiKeyScope.READ_FILES))).toEqual([]);
    expect(fileToolsDeniedFor({})).toEqual([]);
  });
});
