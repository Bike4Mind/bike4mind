import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IFabFileDocument, IUserDocument } from '@bike4mind/common';
import { S3Storage } from '../../../fab-pipeline/src/storage/S3Storage';
import { listFabFiles } from './list';
import { search } from './search';
import { listFabFilesBySession } from './listBySession';
import { listFabFilesByQuest } from './listByQuest';

type CollectionAdapter = Parameters<typeof search>[2] &
  Parameters<typeof listFabFilesBySession>[2] &
  Parameters<typeof listFabFilesByQuest>[2];

beforeEach(() => {
  vi.stubEnv('AWS_REGION', 'us-east-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://minio.internal:9000');
  vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid:9443');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['list', 'search', 'session', 'quest'] as const)(
  '%s propagates response-only signing while preserving the private cache and moderation',
  async flow => {
    const privateUrl = 'http://minio.internal:9000/files-bucket/owned/report.txt';
    const expiry = new Date(Date.now() + 3600000);
    const files = [
      {
        id: 'clean',
        moderationStatus: 'clean',
        filePath: 'owned/folder name/report.txt',
        fileUrl: privateUrl,
        fileUrlExpireAt: expiry,
      },
      {
        id: 'held',
        moderationStatus: 'pending',
        filePath: 'owned/held.txt',
        fileUrl: privateUrl,
        fileUrlExpireAt: expiry,
      },
    ] as IFabFileDocument[];
    const originals = files.map(file => ({ ...file }));
    const user = { id: 'owner' } as IUserDocument;
    const update = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const storage = new S3Storage('files-bucket');
    const signer = vi.fn((path: string, expiresIn: number) =>
      storage.getSignedUrl(path, 'get', { expiresIn, audience: 'browser' })
    );
    const adapter = {
      db: {
        users: { findById: vi.fn(async () => user) },
        adminSettings: { findBySettingName: vi.fn(async () => null) },
        projects: {},
        fabFiles: {
          update,
          search: vi.fn(async () => ({ data: files, total: 2, hasMore: false })),
          shareable: {
            findAllAccessibleByIds: vi.fn(async () => files),
            findAccessibleById: vi.fn(async (_user: unknown, id: string) => files.find(file => file.id === id)),
          },
          findAllByIds: vi.fn(async () => files),
          findToolGeneratedBySessionId: vi.fn(async () => []),
        },
        sessions: {
          shareable: { findAccessibleById: vi.fn(async () => ({ id: 'session', knowledgeIds: ['clean', 'held'] })) },
        },
        chatHistories: {
          findById: vi.fn(async () => ({ id: 'quest', sessionId: 'session', fabFileIds: ['clean', 'held'] })),
          findAllBySessionId: vi.fn(async () => []),
        },
      },
      storage: { signedUrlCache: 'bypass', generateSignedUrl: signer },
    } as unknown as CollectionAdapter;
    const invoke = async () => {
      if (flow === 'list') return listFabFiles(user, { ids: ['clean', 'held'] }, adapter);
      if (flow === 'search') return (await search('owner', {}, adapter)).data;
      if (flow === 'session') return listFabFilesBySession('owner', { sessionId: 'session' }, adapter);
      return listFabFilesByQuest('owner', { questId: 'quest' }, adapter);
    };
    const result = await invoke();
    const url = new URL(result.find(file => file.id === 'clean')!.fileUrl!);
    expect(url.origin).toBe('https://objects.example.invalid:9443');
    expect(url.pathname).toBe('/files-bucket/owned/folder%20name/report.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(result.find(file => file.id === 'held')!.fileUrl).toBeUndefined();
    expect(signer).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(files).toEqual(originals);

    adapter.storage.signedUrlCache = undefined;
    const server = await invoke();
    expect(server.find(file => file.id === 'clean')!.fileUrl).toBe(privateUrl);
    expect(fetchMock).toHaveBeenCalledWith(privateUrl, { method: 'GET' });
    expect(signer).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(files).toEqual(originals);
  }
);
