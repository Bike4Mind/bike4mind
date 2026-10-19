import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactLibrary } from './ArtifactLibrary';

/** An axios rejection as the library sees it: `isAxiosError` keys on the flag, not the class. */
function httpError(status?: number): AxiosError {
  const error = new AxiosError('request failed');
  if (status) error.response = { status } as AxiosError['response'];
  return error;
}

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'a', type: 'html', title: 'Hello Page', createdAt: '2026-09-29T10:00:00.000Z', ...overrides };
}

describe('ArtifactLibrary', () => {
  let get: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;
  let library: ArtifactLibrary;

  beforeEach(() => {
    get = vi.fn();
    apiClient = { getAxiosInstance: () => ({ get }) } as unknown as AuthenticatedApiClient;
    library = new ArtifactLibrary(() => apiClient, { debug: vi.fn() });
  });

  describe('list', () => {
    it('asks the server only for rows this app made, newest first', async () => {
      get.mockResolvedValue({ data: { artifacts: [], pagination: { total: 0 } } });

      await library.list();

      const [endpoint, config] = get.mock.calls[0];
      expect(endpoint).toBe('/api/artifacts');
      expect(config.params).toMatchObject({ tags: ['desktop'], sortBy: 'createdAt', sortOrder: 'desc' });
      expect(config.params.limit).toBeLessThanOrEqual(100);
    });

    it('returns the rows and the server total', async () => {
      get.mockResolvedValue({
        data: { artifacts: [row(), row({ id: 'b', type: 'svg' })], pagination: { total: 9 } },
      });

      expect(await library.list()).toEqual({
        artifacts: [
          { id: 'a', type: 'html', title: 'Hello Page', createdAt: '2026-09-29T10:00:00.000Z' },
          { id: 'b', type: 'svg', title: 'Hello Page', createdAt: '2026-09-29T10:00:00.000Z' },
        ],
        total: 9,
      });
    });

    it('drops a row missing an id or type rather than the whole list', async () => {
      get.mockResolvedValue({ data: { artifacts: [row(), { title: 'no id' }, null] } });

      const result = await library.list();

      expect(result.artifacts.map(a => a.id)).toEqual(['a']);
      expect(result.total).toBe(1);
    });

    it('names a signed-out read instead of showing an empty library', async () => {
      apiClient = null;

      expect(await library.list()).toEqual({
        artifacts: [],
        total: 0,
        error: 'Sign in to see your artifacts.',
      });
      expect(get).not.toHaveBeenCalled();
    });

    it('turns a failed request into an error the panel can render', async () => {
      get.mockRejectedValue(httpError(401));

      expect(await library.list()).toEqual({
        artifacts: [],
        total: 0,
        error: 'Your session has expired. Sign in again.',
      });
    });

    it('says the server was unreachable when the request never got a status', async () => {
      get.mockRejectedValue(httpError());

      expect((await library.list()).error).toBe('The server could not be reached.');
    });
  });

  describe('read', () => {
    it('asks for the body alongside the document', async () => {
      get.mockResolvedValue({ data: { artifact: row(), content: { content: '<h1>Hi</h1>' } } });

      const result = await library.read('a');

      const [endpoint, config] = get.mock.calls[0];
      expect(endpoint).toBe('/api/artifacts/a');
      expect(config.params).toEqual({ includeContent: true });
      expect(result).toEqual({
        artifact: { id: 'a', type: 'html', title: 'Hello Page', content: '<h1>Hi</h1>' },
      });
    });

    it('escapes the id into the path', async () => {
      get.mockResolvedValue({ data: {} });

      await library.read('a/../b');

      expect(get.mock.calls[0][0]).toBe('/api/artifacts/a%2F..%2Fb');
    });

    it('reports a document that came back without a body', async () => {
      get.mockResolvedValue({ data: { artifact: row() } });

      expect(await library.read('a')).toEqual({ error: 'The server returned no content for this artifact.' });
    });

    it('turns a deleted artifact into an error rather than a rejection', async () => {
      get.mockRejectedValue(httpError(404));

      expect(await library.read('a')).toEqual({ error: 'That artifact is no longer on the server.' });
    });
  });
});
