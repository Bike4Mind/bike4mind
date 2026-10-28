import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillMarketFilters } from '@shared/skillMarket';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RATE_LIMITED, SkillMarket, type SkillMarketDeps } from './SkillMarket';

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
  let put: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let localSkill: ReturnType<typeof vi.fn>;
  let writeClipboard: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;
  let catalog: { invalidateAccount: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let openExternal: ReturnType<typeof vi.fn>;
  let market: SkillMarket;

  beforeEach(() => {
    get = vi.fn();
    post = vi.fn();
    put = vi.fn().mockResolvedValue({ data: {} });
    del = vi.fn().mockResolvedValue({ data: '' });
    localSkill = vi.fn().mockResolvedValue(undefined);
    writeClipboard = vi.fn();
    apiClient = { getAxiosInstance: () => ({ get, post, put, delete: del }) } as unknown as AuthenticatedApiClient;
    catalog = { invalidateAccount: vi.fn(), get: vi.fn().mockResolvedValue({ source: 'remote' }) };
    openExternal = vi.fn().mockResolvedValue(undefined);
    market = new SkillMarket({
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'https://app.example.test/',
      catalog: catalog as unknown as SkillMarketDeps['catalog'],
      openExternal: openExternal as unknown as SkillMarketDeps['openExternal'],
      getUserId: () => (apiClient ? 'me' : null),
      localSkill: localSkill as unknown as SkillMarketDeps['localSkill'],
      writeClipboard: writeClipboard as unknown as SkillMarketDeps['writeClipboard'],
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

  it('resolves on a filters payload missing its fields rather than rejecting', async () => {
    get.mockResolvedValue({ data: { data: [], hasMore: false } });
    await expect(market.browse({} as SkillMarketFilters, 1)).resolves.toEqual({ listings: [], hasMore: false });
    expect(get).toHaveBeenCalledWith('/api/skills/market', { params: { page: '1', limit: '24' } });
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

  it('counts a change to the Claude Code tools as a tool change', async () => {
    get.mockImplementation(async (url: string) =>
      url === '/api/skills/s1'
        ? {
            data: {
              id: 's1',
              body: 'line one\nline two',
              claudeCodeAllowedTools: ['Read'],
              importedFrom: { versionId: 'v1' },
            },
          }
        : {
            data: {
              listing: listing(),
              version: version({
                snapshot: { name: 'x', description: 'd', body: 'line one\nline two', claudeCodeAllowedTools: ['Bash'] },
              }),
              myImport: { version: 1, skill: { id: 's1', name: 'x' } },
            },
          }
    );

    const { detail } = await market.listing({ id: 'l1' });
    expect(detail?.version?.snapshot.claudeCodeAllowedTools).toEqual(['Bash']);
    expect(detail?.update).toMatchObject({ toolsAdded: ['Bash'], toolsRemoved: ['Read'] });
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

    openExternal.mockRejectedValueOnce(new Error('no handler'));
    expect(await market.openOnWeb({ kind: 'mine' })).toBe(false);
  });

  describe('publishing', () => {
    const FIELDS = { name: 'tester-guide', description: 'Writes a guide.', body: 'Do it.' };
    const mineBody = (rows: Record<string, unknown>[]) => ({ data: { data: rows } });
    const created = (listingOverrides: Record<string, unknown> = {}) => ({
      status: 201,
      data: {
        listing: {
          id: 'l9',
          name: 'tester-guide',
          visibility: 'public',
          status: 'in_review',
          tags: [],
          ...listingOverrides,
        },
        version: { version: 1, scanStatus: 'passed', reviewStatus: 'pending', riskTier: 'high', scanFindings: [] },
      },
    });
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'skill-upload-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('answers every publishing call with the sign-in error when signed out, and never calls out', async () => {
      apiClient = null;
      const open = vi.fn();
      for (const result of [
        await market.readLocalSkill({ sessionId: 's', name: 'x' }),
        await market.pickUploadSource(open),
        await market.saveSkill({ fields: FIELDS, mode: 'create' }),
        await market.publish({ skillId: 's1', visibility: 'public', tags: [] }),
        await market.submitVersion({ listingId: 'l1' }),
        await market.withdraw('l1'),
        await market.copyShareLink('l1'),
      ]) {
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Sign in/) });
      }
      expect((await market.mine()).error).toMatch(/Sign in/);
      expect((await market.organizations()).error).toMatch(/Sign in/);
      expect(open).not.toHaveBeenCalled();
      expect(localSkill).not.toHaveBeenCalled();
      for (const call of [get, post, put, del]) expect(call).not.toHaveBeenCalled();
    });

    it('reads only a local catalog entry, never a path the request carries', async () => {
      const file = join(dir, 'guide', 'SKILL.md');
      await mkdir(join(dir, 'guide'));
      await writeFile(file, '---\nname: guide\ndescription: d\n---\nBody');
      localSkill.mockImplementation(async (_session: string, name: string) =>
        name === 'guide'
          ? { source: 'global', filePath: file }
          : name === 'acct'
            ? { source: 'remote', filePath: 'b4m:/api/skills/1' }
            : undefined
      );

      expect(await market.readLocalSkill({ sessionId: 's1', name: 'guide' })).toMatchObject({
        ok: true,
        fields: { name: 'guide' },
      });
      expect(localSkill).toHaveBeenCalledWith('s1', 'guide');
      expect(await market.readLocalSkill({ sessionId: 's1', name: 'acct' })).toMatchObject({
        ok: false,
        error: 'That skill is not a file on this machine.',
      });
      expect(await market.readLocalSkill({ sessionId: 's1', name: 'nope', filePath: file } as never)).toMatchObject({
        ok: false,
        error: 'That skill is not a file on this machine.',
      });
    });

    it('reads the picked path itself, and does nothing on a cancelled pick', async () => {
      await writeFile(join(dir, 'one.md'), 'Just a body');
      const open = vi.fn().mockResolvedValueOnce({ canceled: true, filePaths: [] });
      expect(await market.pickUploadSource(open)).toMatchObject({ ok: false, canceled: true });
      open.mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, 'one.md')] });
      expect(await market.pickUploadSource(open)).toMatchObject({
        ok: true,
        fields: { name: 'one', body: 'Just a body' },
      });
      expect(open.mock.calls[0][0].properties).toEqual(
        process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile']
      );
    });

    it('asks for files only off macOS, where openDirectory would hide them', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const open = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
      try {
        for (const [os, properties] of [
          ['darwin', ['openFile', 'openDirectory']],
          ['win32', ['openFile']],
          ['linux', ['openFile']],
        ] as const) {
          Object.defineProperty(process, 'platform', { value: os });
          await market.pickUploadSource(open);
          expect(open.mock.calls.at(-1)![0].properties).toEqual(properties);
        }
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    it('creates a skill from an explicit field list, so allowedTools is never sent', async () => {
      get.mockResolvedValueOnce({ data: { data: [{ id: 'x', name: 'tester-guide', userId: 'someone-else' }] } });
      post.mockResolvedValueOnce({ data: { id: 's1', name: 'tester-guide' } });
      const result = await market.saveSkill({
        fields: { ...FIELDS, allowedTools: ['Bash'] } as never,
        mode: 'create',
      });
      expect(result).toMatchObject({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
      expect(get).toHaveBeenCalledWith('/api/skills', { params: { query: 'tester-guide', limit: '100' } });
      const [url, body] = post.mock.calls[0];
      expect(url).toBe('/api/skills');
      expect(Object.keys(body).sort()).toEqual([
        'argumentHint',
        'body',
        'claudeCodeAllowedTools',
        'description',
        'disableModelInvocation',
        'files',
        'name',
      ]);
      expect(catalog.invalidateAccount).toHaveBeenCalled();
    });

    it('sends the SKILL.md allowed-tools as claudeCodeAllowedTools, on create and update', async () => {
      get.mockResolvedValueOnce({ data: { data: [] } });
      post.mockResolvedValueOnce({ data: { id: 's1' } });
      const claudeCodeAllowedTools = ['Bash(git:*)', 'Read'];
      await market.saveSkill({ fields: { ...FIELDS, claudeCodeAllowedTools }, mode: 'create' });
      expect(post).toHaveBeenCalledWith('/api/skills', expect.objectContaining({ claudeCodeAllowedTools }));
      expect(post.mock.calls[0][1]).not.toHaveProperty('allowedTools');

      get
        .mockResolvedValueOnce({ data: { id: 's1', userId: 'me', claudeCodeAllowedTools } })
        .mockResolvedValueOnce(mineBody([]));
      await market.saveSkill({ fields: FIELDS, mode: 'update', targetSkillId: 's1' });
      expect(put).toHaveBeenCalledWith('/api/skills/s1', expect.objectContaining({ claudeCodeAllowedTools: [] }));
    });

    it('sends each supporting file with its path and content, on create and update', async () => {
      const files = [{ path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n' }];
      get.mockResolvedValueOnce({ data: { data: [] } });
      post.mockResolvedValueOnce({ data: { id: 's1' } });
      await market.saveSkill({ fields: { ...FIELDS, files }, mode: 'create' });
      expect(post).toHaveBeenCalledWith('/api/skills', expect.objectContaining({ files }));

      get.mockResolvedValueOnce({ data: { id: 's1', userId: 'me' } }).mockResolvedValueOnce(mineBody([]));
      await market.saveSkill({ fields: { ...FIELDS, files }, mode: 'update', targetSkillId: 's1' });
      expect(put).toHaveBeenCalledWith('/api/skills/s1', expect.objectContaining({ files }));
    });

    it.each([undefined, '', '<topic>'])('sends the argument hint on create: %s', async argumentHint => {
      get.mockResolvedValueOnce({ data: { data: [] } });
      post.mockResolvedValueOnce({ data: { id: 's1' } });
      expect(await market.saveSkill({ fields: { ...FIELDS, argumentHint }, mode: 'create' })).toMatchObject({
        ok: true,
      });
      expect(post).toHaveBeenCalledWith('/api/skills', expect.objectContaining({ argumentHint: argumentHint ?? '' }));
    });

    it.each([undefined, '', '<topic>'])('replaces the previous argument hint on update: %s', async argumentHint => {
      get
        .mockResolvedValueOnce({ data: { id: 's1', userId: 'me', argumentHint: '<previous>' } })
        .mockResolvedValueOnce(mineBody([]));
      expect(
        await market.saveSkill({ fields: { ...FIELDS, argumentHint }, mode: 'update', targetSkillId: 's1' })
      ).toMatchObject({ ok: true });
      expect(put).toHaveBeenCalledWith('/api/skills/s1', expect.objectContaining({ argumentHint: argumentHint ?? '' }));
    });

    it.each([undefined, '', '<topic>'])(
      'sends the edited argument hint before submitting a version: %s',
      async argumentHint => {
        get.mockResolvedValue(mineBody([{ id: 'l1', name: 'x', sourceSkillId: 'src', status: 'approved' }]));
        post.mockResolvedValueOnce(created());
        expect(await market.submitVersion({ listingId: 'l1', fields: { ...FIELDS, argumentHint } })).toMatchObject({
          ok: true,
        });
        expect(put).toHaveBeenCalledWith(
          '/api/skills/src',
          expect.objectContaining({ argumentHint: argumentHint ?? '' })
        );
        expect(put.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
      }
    );

    it('answers name_taken instead of overwriting, from the lookup or a raced 400', async () => {
      get.mockResolvedValueOnce({
        data: { data: [{ id: 's7', name: 'tester-guide', userId: 'me', importedFrom: { listingId: 'l' } }] },
      });
      expect(await market.saveSkill({ fields: FIELDS, mode: 'create' })).toMatchObject({
        ok: false,
        code: 'name_taken',
        existing: { id: 's7', imported: true },
      });
      expect(post).not.toHaveBeenCalled();

      get
        .mockResolvedValueOnce({ data: { data: [] } })
        .mockResolvedValueOnce({ data: { data: [{ id: 's8', name: 'tester-guide', userId: 'me' }] } });
      post.mockRejectedValueOnce(httpError(400, { error: 'A skill named "tester-guide" already exists' }));
      expect(await market.saveSkill({ fields: FIELDS, mode: 'create' })).toMatchObject({
        code: 'name_taken',
        existing: { id: 's8', imported: false },
      });
      expect(catalog.invalidateAccount).not.toHaveBeenCalled();
    });

    it('passes a server validation message through', async () => {
      get.mockResolvedValueOnce({ data: { data: [] } });
      post.mockRejectedValueOnce(httpError(400, { error: 'Skill description is required' }));
      expect(await market.saveSkill({ fields: FIELDS, mode: 'create' })).toEqual({
        ok: false,
        error: 'Skill description is required',
      });
    });

    it("keeps the server's message when the skill to update is gone", async () => {
      get.mockRejectedValueOnce(httpError(404, { error: 'Skill not found' }));
      expect(await market.saveSkill({ fields: FIELDS, mode: 'update', targetSkillId: 'gone' })).toEqual({
        ok: false,
        error: 'Skill not found',
      });
    });

    it('updates the chosen own skill with a PUT, refuses an imported one, and offers its open listing', async () => {
      get.mockResolvedValueOnce({ data: { id: 's7', userId: 'me', importedFrom: { listingId: 'l' } } });
      expect(await market.saveSkill({ fields: FIELDS, mode: 'update', targetSkillId: 's7' })).toMatchObject({
        ok: false,
      });
      expect(put).not.toHaveBeenCalled();

      get
        .mockResolvedValueOnce({ data: { id: 's8', userId: 'me' } })
        .mockResolvedValueOnce(mineBody([{ id: 'l3', name: 'tester-guide', sourceSkillId: 's8', status: 'approved' }]));
      localSkill.mockResolvedValueOnce({ source: 'project', filePath: '/repo/.claude/skills/tester-guide/SKILL.md' });
      expect(
        await market.saveSkill({ fields: FIELDS, mode: 'update', targetSkillId: 's8', sessionId: 'sess' })
      ).toMatchObject({
        ok: true,
        skill: { id: 's8' },
        listing: { id: 'l3' },
        shadowedByLocal: true,
      });
      expect(localSkill).toHaveBeenCalledWith('sess', 'tester-guide');
      expect(put).toHaveBeenCalledWith(
        '/api/skills/s8',
        expect.objectContaining({ name: 'tester-guide', body: 'Do it.' })
      );
    });

    it('publishes with tags always sent, and maps the result', async () => {
      post.mockResolvedValueOnce(created({ visibility: 'unlisted', shareToken: 'tok' }));
      const result = await market.publish({ skillId: 's1', visibility: 'unlisted', organizationId: 'o1', tags: [] });
      expect(post).toHaveBeenCalledWith('/api/skills/market/publish', {
        skillId: 's1',
        visibility: 'unlisted',
        tags: [],
      });
      expect(result).toMatchObject({
        ok: true,
        listing: { id: 'l9', hasShareLink: true },
        version: { version: 1, reviewStatus: 'pending', riskTier: 'high' },
      });
      expect(JSON.stringify(result)).not.toContain('tok');
    });

    it('maps 409 to already_listed with the listing, 429 to the rate limit, and keeps 403 messages', async () => {
      post.mockRejectedValueOnce(httpError(409, { error: 'This skill already has a listing.' }));
      get.mockResolvedValueOnce(mineBody([{ id: 'l4', name: 'x', sourceSkillId: 's1', status: 'approved' }]));
      expect(await market.publish({ skillId: 's1', visibility: 'public', tags: [] })).toMatchObject({
        ok: false,
        code: 'already_listed',
        listingId: 'l4',
      });

      post.mockRejectedValueOnce(httpError(429, { error: 'Too many' }));
      expect(await market.publish({ skillId: 's1', visibility: 'public', tags: [] })).toEqual({
        ok: false,
        error: RATE_LIMITED,
        code: 'rate_limited',
      });

      post.mockRejectedValueOnce(httpError(403, { error: 'Public listings open after 7 days' }));
      expect(await market.publish({ skillId: 's1', visibility: 'public', tags: [] })).toEqual({
        ok: false,
        error: 'Public listings open after 7 days',
      });

      post.mockRejectedValueOnce(httpError(400, { error: 'You can have at most 10 active listings' }));
      expect(await market.publish({ skillId: 's1', visibility: 'public', tags: [] })).toMatchObject({
        error: 'You can have at most 10 active listings',
      });
    });

    it('submits a new version as a PUT to the source skill, then a POST with no tags', async () => {
      get.mockResolvedValue(mineBody([{ id: 'l1', name: 'x', sourceSkillId: 'src', status: 'approved' }]));
      post.mockResolvedValueOnce(created());
      expect(await market.submitVersion({ listingId: 'l1', fields: FIELDS })).toMatchObject({ ok: true });
      expect(put).toHaveBeenCalledWith('/api/skills/src', expect.objectContaining(FIELDS));
      expect(post).toHaveBeenCalledWith('/api/skills/market/l1/versions', {});
      expect(put.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
    });

    it('reports a landed PUT when the version POST fails, and maps exact content', async () => {
      get.mockResolvedValue(mineBody([{ id: 'l1', name: 'x', sourceSkillId: 'src', status: 'approved' }]));
      post.mockRejectedValueOnce(httpError(429, { error: 'slow' }));
      expect(await market.submitVersion({ listingId: 'l1', fields: FIELDS })).toEqual({
        ok: false,
        error: RATE_LIMITED,
        code: 'rate_limited',
        skillUpdated: true,
      });
      expect(catalog.invalidateAccount).toHaveBeenCalled();

      post.mockRejectedValueOnce(httpError(400, { error: 'This exact content is already live or waiting for review' }));
      expect(await market.submitVersion({ listingId: 'l1' })).toEqual({
        ok: false,
        error: 'This exact content is already live or waiting for review',
        code: 'exact_content',
      });
      expect(put).toHaveBeenCalledTimes(1);
    });

    it("refuses a new version for a listing that is not the caller's", async () => {
      get.mockResolvedValue(mineBody([{ id: 'other', name: 'x', sourceSkillId: 'src', status: 'approved' }]));
      expect(await market.submitVersion({ listingId: 'l1', fields: FIELDS })).toEqual({
        ok: false,
        error: 'That listing is not one of yours.',
      });
      expect(put).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });

    it('reports a failed skill PUT without posting a version', async () => {
      get.mockResolvedValue(mineBody([{ id: 'l1', name: 'x', sourceSkillId: 'src', status: 'approved' }]));
      put.mockRejectedValueOnce(httpError(400, { error: 'Skill body is required' }));
      const result = await market.submitVersion({ listingId: 'l1', fields: FIELDS });
      expect(result).toMatchObject({ ok: false, error: 'Skill body is required' });
      expect(result).not.toHaveProperty('skillUpdated');
      expect(post).not.toHaveBeenCalled();
    });

    it("surfaces a failed listings read instead of claiming the listing is not the caller's", async () => {
      get.mockRejectedValueOnce(httpError(500));
      const result = await market.submitVersion({ listingId: 'l1', fields: FIELDS });
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toEqual({ ok: false, error: 'That listing is not one of yours.' });
      expect(put).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });

    it('refuses a new version for a withdrawn listing before touching the skill', async () => {
      get.mockResolvedValue(mineBody([{ id: 'l1', name: 'x', sourceSkillId: 'src', status: 'withdrawn' }]));
      expect(await market.submitVersion({ listingId: 'l1', fields: FIELDS })).toEqual({
        ok: false,
        error: 'That listing no longer accepts new versions.',
      });
      expect(put).not.toHaveBeenCalled();
    });

    it('withdraws with a DELETE and passes a 409 through', async () => {
      expect(await market.withdraw('l1')).toEqual({ ok: true });
      expect(del).toHaveBeenCalledWith('/api/skills/market/l1');
      del.mockRejectedValueOnce(httpError(409, { error: 'Already withdrawn or delisted' }));
      expect(await market.withdraw('l1')).toEqual({ ok: false, error: 'Already withdrawn or delisted' });
    });

    it('copies the share link built from the environment, only for an unlisted listing', async () => {
      get.mockResolvedValue(
        mineBody([
          { id: 'l1', name: 'a', visibility: 'unlisted', shareToken: 't/1', status: 'approved' },
          { id: 'l2', name: 'b', visibility: 'public', shareToken: 't2', status: 'approved' },
        ])
      );
      expect(await market.copyShareLink('l1')).toEqual({ ok: true });
      expect(writeClipboard).toHaveBeenCalledWith('https://app.example.test/skills/market/u/t%2F1');
      expect(await market.copyShareLink('l2')).toMatchObject({ ok: false });
      expect(writeClipboard).toHaveBeenCalledTimes(1);
      const { listings } = await market.mine();
      expect(listings.map(row => row.hasShareLink)).toEqual([true, false]);
      expect(JSON.stringify(listings)).not.toContain('t/1');
    });

    it('reads organizations and opens only an openable source link', async () => {
      get.mockResolvedValueOnce({ data: { organizations: [{ id: 'o1', name: 'Acme' }, { id: 2 }] } });
      expect(await market.organizations()).toEqual({ organizations: [{ id: 'o1', name: 'Acme' }] });
      expect(await market.openSourceUrl('javascript:alert(1)')).toBe(false);
      expect(await market.openSourceUrl('https://app.example.test/skills/s1')).toBe(true);
    });
  });
});
