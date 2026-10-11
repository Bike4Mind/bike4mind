import { it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  sign: vi.fn(async () => 'https://objects.example.invalid/file'),
}));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (handler: unknown) => handler }) }));
vi.mock('@bike4mind/services', () => ({ fabFilesService: { listFabFilesByQuest: h.list } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileRepository: {},
  questRepository: {},
  sessionRepository: {},
  userRepository: {},
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: h.sign }) }));
import handler from '../files';

it('uses request-local browser signing for authorized quest collection responses', async () => {
  const request = { user: { id: 'owner' }, query: { id: 'quest' } };
  const json = vi.fn();
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(request, { json });
  const adapter = (h.list.mock.calls[0] as unknown[])[2] as {
    storage: { signedUrlCache?: string; generateSignedUrl: (path: string, expiry: number) => Promise<string | null> };
  };
  expect(adapter.storage.signedUrlCache).toBe('bypass');
  await adapter.storage.generateSignedUrl('owned/report.txt', 600);
  expect(h.sign).toHaveBeenCalledWith('owned/report.txt', 'get', { expiresIn: 600, audience: 'browser' });
});
