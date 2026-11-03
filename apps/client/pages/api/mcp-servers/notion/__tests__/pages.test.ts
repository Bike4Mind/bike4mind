// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockEnsureValidToken } = vi.hoisted(() => ({ mockEnsureValidToken: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
      }
    );
    return chain;
  },
}));

// Keep the real error classes so the route's instanceof checks see what the manager throws.
vi.mock('@server/integrations/notion/notionTokenManager', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/notion/notionTokenManager')>();
  return {
    ...actual,
    NotionTokenManager: { ensureValidToken: (...a: unknown[]) => mockEnsureValidToken(...a) },
  };
});
vi.mock('@server/integrations/notion/notionConfig', () => ({ NOTION_API_BASE_URL: 'https://api.notion.com/v1' }));

import handler from '../pages';
import { NotionNotConnectedError, NotionReconnectRequiredError } from '@server/integrations/notion/notionTokenManager';

const call = async (query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'user-1' } });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('GET /api/mcp-servers/notion/pages - connection states', () => {
  it('answers NOTION_NOT_CONNECTED logged once at warn when the user has no Notion connection', async () => {
    mockEnsureValidToken.mockRejectedValue(new NotionNotConnectedError());

    const res = await call();

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toMatchObject({ code: 'NOTION_NOT_CONNECTED' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('answers NOTION_RECONNECT_REQUIRED at warn when the connection was revoked', async () => {
    mockEnsureValidToken.mockRejectedValue(new NotionReconnectRequiredError());

    const res = await call();

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toMatchObject({ code: 'NOTION_RECONNECT_REQUIRED' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps an unreadable stored token at error with a 500', async () => {
    mockEnsureValidToken.mockRejectedValue(new Error('Failed to get valid Notion tokens'));

    const res = await call();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toMatchObject({ code: 'NOTION_DECRYPT_FAILED' });
    expect(errorSpy).toHaveBeenCalledWith('[Notion Pages] Error browsing pages:', expect.any(Error));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps a Notion API failure at error with a 502', async () => {
    mockEnsureValidToken.mockResolvedValue('token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    const res = await call();

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ code: 'NOTION_API_ERROR' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
