import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Proves the single-lake GET is WIRED to the redaction, not merely that the redaction works.
 * The service-level tests cover `redactLakeForActor` itself; without this, deleting the call in
 * `[id].ts` and returning the raw document leaves every other suite green - and that line is the
 * whole point of the endpoint's change.
 *
 * The real `redactLakeForActor` is used deliberately (only the access gate is stubbed), so this
 * also pins the end-to-end behaviour a reader actually sees: key ABSENT, not blanked.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
  fabFileRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@bike4mind/services', async () => {
  // Real redaction, stubbed gate: the point is the wiring between them.
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    dataLakeService: {
      ...actual.dataLakeService,
      assertLakeAccess: h.assertLakeAccess,
    },
  };
});

import handler from '../[id]';

const PROMPT = 'Always begin your reply with the token LAKEPROMPT-OK.';
const publishedLake = {
  id: 'lake1',
  slug: 'lake1',
  name: 'Published Lake',
  fileTagPrefix: 'lk:',
  datalakeTag: 'datalake:lake1',
  createdByUserId: 'owner',
  status: 'active',
  isPublic: true,
  systemPrompt: PROMPT,
};

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const get = () => ({ method: 'GET', query: { id: 'lake1' } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('GET /api/data-lakes/[id] - editor-only redaction is wired into the handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeAccess.mockResolvedValue(publishedLake);
  });

  it('withholds systemPrompt from a stranger who can READ the published lake', async () => {
    h.toAccessContext.mockResolvedValue({ userId: 'stranger', isAdmin: false, userTags: [] });
    const { res, json } = makeRes();

    await run(get(), res);

    const body = json.mock.calls[0][0];
    expect('systemPrompt' in body).toBe(false);
    // Everything a reader is entitled to still comes back.
    expect(body.name).toBe('Published Lake');
    expect(body.datalakeTag).toBe('datalake:lake1');
  });

  it('returns systemPrompt to the lake owner', async () => {
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    const { res, json } = makeRes();

    await run(get(), res);

    expect(json.mock.calls[0][0].systemPrompt).toBe(PROMPT);
  });

  it('returns systemPrompt to an admin who does not own the lake', async () => {
    h.toAccessContext.mockResolvedValue({ userId: 'someone-else', isAdmin: true, userTags: [] });
    const { res, json } = makeRes();

    await run(get(), res);

    expect(json.mock.calls[0][0].systemPrompt).toBe(PROMPT);
  });
});
