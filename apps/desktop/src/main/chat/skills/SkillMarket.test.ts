import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillMarketFilters } from '@shared/skillMarket';
import { SkillMarket, type SkillMarketDeps } from './SkillMarket';

function httpError(status?: number, data?: unknown): AxiosError {
  const error = new AxiosError('request failed');
  if (status) error.response = { status, data } as AxiosError['response'];
  return error;
}

const FILTERS: SkillMarketFilters = { q: '', scope: '', tools: '', minRating: 0, sort: 'top' };

const listing = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  name: 'guide-for-testers',
  description: 'Writes a tester guide.',
  authorName: 'Ana',
  visibility: 'public',
  status: 'approved',
  tags: ['qa'],
  ratingAvg: 4.5,
  ratingCount: 2,
  importCount: 7,
  ...overrides,
});

const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'v2',
  version: 2,
  snapshot: { name: 'guide-for-testers', description: 'd', body: 'line one\nline two', allowedTools: ['web_fetch'] },
  riskTier: 'clean',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('SkillMarket', () => {
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;
  let catalog: { invalidateAccount: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let openExternal: ReturnType<typeof vi.fn>;
  let market: SkillMarket;

  beforeEach(() => {
    get = vi.fn();
    post = vi.fn();
    apiClient = { getAxiosInstance: () => ({ get, post }) } as unknown as AuthenticatedApiClient;
    catalog = { invalidateAccount: vi.fn(), get: vi.fn().mockResolvedValue({ source: 'remote' }) };
    openExternal = vi.fn().mockResolvedValue(undefined);
    market = new SkillMarket({
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'https://app.example.test/',
      catalog: catalog as unknown as SkillMarketDeps['catalog'],
      openExternal: openExternal as unknown as SkillMarketDeps['openExternal'],
      logger: { debug: vi.fn() },
    });
  });

  it('answers every call with a sign-in error when signed out, and never calls out', async () => {
    apiClient = null;
    expect(await market.browse(FILTERS, 1)).toEqual({ listings: [], hasMore: false, error: expect.any(String) });
    expect((await market.listing({ id: 'l1' })).error).toMatch(/Sign in/);
    expect(await market.importListing({ listingId: 'l1' })).toMatchObject({ ok: false, error: expect.any(String) });
    expect((await market.imports()).error).toMatch(/Sign in/);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('browses with the web hook params and reads rows defensively', async () => {
    get.mockResolvedValue({ data: { data: [listing(), { id: 7 }], hasMore: true } });
    const page = await market.browse({ ...FILTERS, q: ' guide ', tools: 'with', minRating: 4 }, 2);

    expect(get).toHaveBeenCalledWith('/api/skills/market', {
      params: { page: '2', limit: '24', sort: 'top', q: 'guide', tools: 'with', minRating: '4' },
    });
    expect(page.hasMore).toBe(true);
    expect(page.listings.map(row => row.name)).toEqual(['guide-for-testers']);
  });

  it('maps a network failure and a 404 to errors rather than rejecting', async () => {
    get.mockRejectedValueOnce(httpError()).mockRejectedValueOnce(httpError(404));
    expect((await market.recommended()).error).toBe('The server could not be reached.');
    expect((await market.listing({ id: 'gone' })).error).toBe('That listing is not available.');
  });

  it('opens an unlisted listing by token, with or without its id', async () => {
    get.mockResolvedValue({
      data: { listing: listing(), version: version(), myImport: null, viewer: { canImport: true } },
    });

    const byToken = await market.listing({ token: 'a/b' });
    expect(get).toHaveBeenLastCalledWith('/api/skills/market/by-token/a%2Fb', undefined);
    expect(byToken.detail).toMatchObject({ canImport: true, version: { id: 'v2' }, myImport: null });

    await market.listing({ id: 'l1', token: 'tok' });
    expect(get).toHaveBeenLastCalledWith('/api/skills/market/l1', { params: { token: 'tok' } });
  });

  it('offers an update with a diff and the tool change when the imported copy is behind', async () => {
    get.mockImplementation(async (url: string) =>
      url === '/api/skills/s1'
        ? {
            data: {
              id: 's1',
              body: 'line one\nold line',
              allowedTools: ['bash_execute'],
              importedFrom: { listingId: 'l1', versionId: 'v1', version: 1 },
              marketStatus: { state: 'stale', locallyModified: true },
            },
          }
        : {
            data: {
              listing: listing(),
              version: version(),
              myImport: { version: 1, skill: { id: 's1', name: 'guide-for-testers' } },
              viewer: { canImport: true },
            },
          }
    );

    const { detail } = await market.listing({ id: 'l1' });
    expect(detail?.update).toMatchObject({
      skillId: 's1',
      fromVersion: 1,
      toVersion: 2,
      versionId: 'v2',
      toolsAdded: ['web_fetch'],
      toolsRemoved: ['bash_execute'],
      locallyModified: true,
    });
    expect(detail?.update?.diff).toMatchObject({ added: 1, removed: 1 });
  });

  it('offers no update when the copy is already on the current version', async () => {
    get.mockImplementation(async (url: string) =>
      url === '/api/skills/s1'
        ? { data: { id: 's1', body: 'line one\nline two', importedFrom: { versionId: 'v2' } } }
        : { data: { listing: listing(), version: version(), myImport: { version: 2, skill: { id: 's1', name: 'x' } } } }
    );
    expect((await market.listing({ id: 'l1' })).detail?.update).toBeUndefined();
  });

  it('imports, then refreshes the account skills so the picker sees it at once', async () => {
    post.mockResolvedValue({ data: { skill: { id: 's9', name: 'guide-for-testers' } } });

    const result = await market.importListing({
      listingId: 'l1',
      name: undefined,
      targetSkillId: 's1',
      expectedVersionId: 'v2',
    });

    expect(post).toHaveBeenCalledWith('/api/skills/market/l1/import', { targetSkillId: 's1', expectedVersionId: 'v2' });
    expect(result).toEqual({ ok: true, skill: { id: 's9', name: 'guide-for-testers' } });
    expect(catalog.invalidateAccount).toHaveBeenCalledTimes(1);
  });

  it('says so when a local skill of the same name will run instead', async () => {
    post.mockResolvedValue({ data: { skill: { id: 's9', name: 'review' } } });
    catalog.get.mockResolvedValue({ source: 'global' });
    expect(await market.importListing({ listingId: 'l1' })).toMatchObject({ ok: true, shadowedByLocal: true });
  });

  it.each([
    [{ error: 'You already have a skill named "x"', code: 'name_taken', suggestedName: 'x-2' }],
    [{ error: 'You edited this copy', code: 'local_changes' }],
    [{ error: 'A newer version was approved', code: 'version_changed' }],
  ])('passes a 409 conflict back for the dialog, and leaves the cache alone: %o', async data => {
    post.mockRejectedValue(httpError(409, data));
    expect(await market.importListing({ listingId: 'l1' })).toEqual({ ok: false, ...data });
    expect(catalog.invalidateAccount).not.toHaveBeenCalled();
  });

  it('drops an unknown conflict code, and maps other failures', async () => {
    post
      .mockRejectedValueOnce(httpError(409, { code: 'weird' }))
      .mockRejectedValueOnce(httpError(400, { error: 'This is your own listing' }));
    expect(await market.importListing({ listingId: 'l1' })).toEqual({ ok: false, error: expect.any(String) });
    expect(await market.importListing({ listingId: 'l1' })).toEqual({ ok: false, error: 'This is your own listing' });
    expect(catalog.invalidateAccount).not.toHaveBeenCalled();
  });

  it('lists only market imports, with the server staleness flag', async () => {
    get.mockResolvedValue({
      data: {
        data: [
          { id: 's1', name: 'mine' },
          { id: 's2', name: 'pick', importedFrom: { listingId: 'l1' }, marketStatus: { state: 'stale' } },
          { id: 's3', name: 'pick2', importedFrom: { listingId: 'l2' }, marketStatus: { state: 'current' } },
        ],
      },
    });
    expect((await market.imports()).imports).toEqual([
      { skillId: 's2', name: 'pick', listingId: 'l1', updateAvailable: true },
      { skillId: 's3', name: 'pick2', listingId: 'l2', updateAvailable: false },
    ]);
  });

  it('builds the web URL for each target in main, and refuses anything else', async () => {
    await market.openOnWeb({ kind: 'listing', id: 'l 1' });
    await market.openOnWeb({ kind: 'skill', id: 's1' });
    await market.openOnWeb({ kind: 'mine' });
    expect(openExternal.mock.calls.map(call => call[0])).toEqual([
      'https://app.example.test/skills/market/l%201',
      'https://app.example.test/skills/s1',
      'https://app.example.test/skills/market/mine',
    ]);

    expect(await market.openOnWeb({ kind: 'url', id: 'javascript:alert(1)' } as never)).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(3);
  });
});
