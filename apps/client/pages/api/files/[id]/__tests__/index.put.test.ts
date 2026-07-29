import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findAccessibleById: vi.fn(),
  update: vi.fn(),
  findByDatalakeTag: vi.fn(),
}));

// Callable chain routed by req.method, same shape as the batch/generate-presigned-urls-batch
// tests: the module registers get/put/delete in sequence and the exported default routes by
// method, so a single import can drive just the PUT handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
      put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
      delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
    });
    return chain;
  },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(), getMetadata: vi.fn() }),
}));

// Only `dataLakeRepository.findByDatalakeTag` and the fabFile persistence collaborators are
// stubbed. `fabFileRepository` here is a bare object (not the real repository) since the route
// only reaches `.shareable.findAccessibleById` and `.update` on the PUT path under test.
vi.mock('@bike4mind/database', () => ({
  changeStorageSize: vi.fn(),
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag },
  fabFileChunkRepository: {},
  fabFileRepository: { shareable: { findAccessibleById: h.findAccessibleById }, update: h.update },
  fileTagRepository: {},
  adminSettingsRepository: {},
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  User: {},
}));

import handler from '../index';

const LAKE = {
  id: 'lake-1',
  // Slug and prefix deliberately differ: deriving the fallback from the slug instead of the
  // lake's fileTagPrefix would otherwise pass unnoticed.
  slug: 'acme-2026',
  createdByUserId: 'u1',
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const META = 'datalake:orga:acme-2026';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};

const req = (body: unknown) =>
  ({
    method: 'PUT',
    user: { id: 'u1', isAdmin: false },
    ability: {},
    query: { id: 'file-1' },
    body,
    logger: { updateMetadata: vi.fn(), error: vi.fn() },
  }) as never;

const run = (body: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(body), res);

const fabFile = (overrides: Record<string, unknown> = {}) => ({
  id: 'file-1',
  userId: 'u1',
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  moderationStatus: 'clean',
  tags: [],
  ...overrides,
});

const tagNamesOf = (callIndex = 0) => {
  const persisted = h.update.mock.calls[callIndex][0] as { tags?: { name: string }[] };
  return (persisted.tags ?? []).map(t => t.name).sort();
};

describe('PUT /api/files/[id] - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.update.mockResolvedValue(undefined);
  });

  it('stamps the lake prefix when the update keeps the meta-tag with no tag under that prefix', async () => {
    h.findAccessibleById.mockResolvedValue(fabFile({ tags: [{ name: META, strength: 1 }] }));
    const { res } = makeRes();

    await run({ tags: [{ name: META, strength: 1 }] }, res);

    expect(tagNamesOf()).toEqual(['acme:uncategorized', META]);
  });

  it('retracts the stamp when the update drops the meta-tag from a file that carried both', async () => {
    h.findAccessibleById.mockResolvedValue(
      fabFile({
        tags: [
          { name: META, strength: 1 },
          { name: 'acme:uncategorized', strength: 1 },
        ],
      })
    );
    const { res } = makeRes();

    await run({ tags: [] }, res);

    expect(tagNamesOf()).toEqual([]);
  });

  it('does not change tags and never looks a lake up when tags is omitted (a rename)', async () => {
    const previousTags = [{ name: 'notes', strength: 1 }];
    h.findAccessibleById.mockResolvedValue(fabFile({ tags: previousTags }));
    const { res } = makeRes();

    await run({ fileName: 'renamed.txt' }, res);

    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    // The route always sends the `tags` key (see update.ts's `!== undefined` guard comment), so
    // an omitted-tags request arrives as an explicit `tags: undefined` - the repository layer's
    // $set skips an undefined field, leaving the persisted document's tags untouched. That is
    // the "does not change tags" contract this case is asserting, not literal reference equality.
    const persisted = h.update.mock.calls[0][0] as { tags?: { name: string }[] };
    expect(persisted.tags).toBeUndefined();
  });

  it('stamps nothing for a body carrying only primaryTag and no tags', async () => {
    const previousTags = [{ name: 'notes', strength: 1 }];
    h.findAccessibleById.mockResolvedValue(fabFile({ tags: previousTags }));
    const { res } = makeRes();

    await run({ primaryTag: META }, res);

    // primaryTag is deliberately not a membership signal: it reaches the write gate (which does
    // look the lake up, asserted below) but never the reconciler, so no stamp is minted and
    // `tags` stays untouched (explicit undefined, same as the omitted-tags rename case above).
    expect(h.findByDatalakeTag).toHaveBeenCalled();
    const persisted = h.update.mock.calls[0][0] as { tags?: { name: string }[] };
    expect(persisted.tags).toBeUndefined();
  });
});
