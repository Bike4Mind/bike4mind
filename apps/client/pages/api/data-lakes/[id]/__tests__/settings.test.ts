import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = {
  id: 'opti-knowledge',
  datalakeTag: 'datalake:opti-knowledge',
  fileTagPrefix: 'opti:',
  createdByUserId: '',
  groundingMode: 'inline',
};

const h = vi.hoisted(() => ({
  updateFallbackLakeSettings: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'admin-1', isAdmin: true })),
  requireFeatureEnabled: vi.fn(() => () => {}),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => h.requireFeatureEnabled(flag),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { updateFallbackLakeSettings: h.updateFallbackLakeSettings },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fallbackLakeSettingsRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../settings';

const invoke = (req: unknown, res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

const makeReq = (body: Record<string, unknown> = { groundingMode: 'inline' }) => ({
  method: 'PUT',
  query: { id: 'opti-knowledge' },
  body,
  user: { id: 'admin-1' },
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.toAccessContext.mockResolvedValue({ userId: 'admin-1', isAdmin: true });
  h.updateFallbackLakeSettings.mockResolvedValue(LAKE);
});

describe('PUT /api/data-lakes/:id/settings', () => {
  it('validates the body and delegates to updateFallbackLakeSettings with the access context', async () => {
    const { res, json } = makeRes();
    await invoke(makeReq({ groundingMode: 'inline' }), res);

    expect(h.updateFallbackLakeSettings).toHaveBeenCalledWith(
      'opti-knowledge',
      { userId: 'admin-1', isAdmin: true },
      { groundingMode: 'inline' },
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(LAKE);
  });

  it('rejects an invalid groundingMode before ever calling the service', async () => {
    const { res, json } = makeRes();
    await expect(invoke(makeReq({ groundingMode: 'not-a-real-mode' }), res)).rejects.toThrow();
    expect(h.updateFallbackLakeSettings).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('propagates a denied gate (non-admin) from the service', async () => {
    h.updateFallbackLakeSettings.mockRejectedValue(
      new Error("You do not have permission to change this data lake's settings")
    );
    const { res, json } = makeRes();

    await expect(invoke(makeReq(), res)).rejects.toThrow(/permission to change/i);
    expect(json).not.toHaveBeenCalled();
  });

  // Real allowlist predicate on purpose (not mocked) - the whole point is which ids pass, mirroring
  // id-put-preferred-prompt.test.ts's convention for the sibling DB-lake route.
  it('rejects a non-activatable preferredSystemPromptId before ever calling the service', async () => {
    const { res, json } = makeRes();
    await expect(invoke(makeReq({ preferredSystemPromptId: 'not-on-the-allowlist' }), res)).rejects.toThrow(
      /not a valid preferred system prompt/i
    );
    expect(h.updateFallbackLakeSettings).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('accepts an activatable preferredSystemPromptId and passes it through', async () => {
    const { res, json } = makeRes();
    await invoke(makeReq({ preferredSystemPromptId: 'triage_router' }), res);

    expect(h.updateFallbackLakeSettings).toHaveBeenCalledWith(
      'opti-knowledge',
      { userId: 'admin-1', isAdmin: true },
      { preferredSystemPromptId: 'triage_router' },
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(LAKE);
  });

  it("accepts '' (the clear sentinel) without consulting the allowlist", async () => {
    const { res, json } = makeRes();
    await invoke(makeReq({ preferredSystemPromptId: '' }), res);

    expect(h.updateFallbackLakeSettings).toHaveBeenCalledWith(
      'opti-knowledge',
      { userId: 'admin-1', isAdmin: true },
      { preferredSystemPromptId: '' },
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(LAKE);
  });

  it('passes systemPrompt through with NO allowlist check - unlike preferredSystemPromptId', async () => {
    const { res, json } = makeRes();
    await invoke(makeReq({ systemPrompt: 'Answer only from this lake.' }), res);

    expect(h.updateFallbackLakeSettings).toHaveBeenCalledWith(
      'opti-knowledge',
      { userId: 'admin-1', isAdmin: true },
      { systemPrompt: 'Answer only from this lake.' },
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith(LAKE);
  });
});
