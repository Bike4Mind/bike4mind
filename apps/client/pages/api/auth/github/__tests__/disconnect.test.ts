import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock baseApi so `.post(fn)` returns the handler fn directly (invoke it ourselves).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: any) => fn }),
}));

// Keep asyncHandler as a transparent pass-through.
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

// Mock the McpServer model - findOneAndDelete returns the deleted doc.
vi.mock('@bike4mind/database/ai', () => ({
  McpServer: {
    findOneAndDelete: vi.fn(),
  },
}));

// Mock admin-settings credential lookup.
const mockGetSettings = vi.fn();
const mockGetSettingsValue = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...args: any[]) => mockGetSettings(...args),
  getSettingsValue: (...args: any[]) => mockGetSettingsValue(...args),
}));

// Mock token decryption - return the plaintext token.
const mockDecryptEnvVariables = vi.fn();
vi.mock('@server/security/tokenEncryption', () => ({
  decryptEnvVariables: (...args: any[]) => mockDecryptEnvVariables(...args),
}));

// Import after mocks. McpServer is imported from the `@bike4mind/database/ai` domain
// sub-path since the deep `src/models/*` path is banned by lint and unresolvable
// against the package's exports map. This matches the handler's import.
import handler from '@pages/api/auth/github/disconnect';
import { McpServer } from '@bike4mind/database/ai';

const mockFindOneAndDelete = vi.mocked(McpServer.findOneAndDelete);

const CLIENT_ID = 'gh-client-id';
const CLIENT_SECRET = 'gh-client-secret';
const PLAINTEXT_TOKEN = 'gho_plaintext_access_token';

function makeReqRes() {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = { id: 'user-123' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('/api/auth/github/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());

    // Default happy path: a connected server with an encrypted token exists.
    mockFindOneAndDelete.mockResolvedValue({
      id: 'server-1',
      envVariables: [{ key: 'GITHUB_ACCESS_TOKEN', value: 'encrypted-token' }],
    });
    mockDecryptEnvVariables.mockReturnValue([{ key: 'GITHUB_ACCESS_TOKEN', value: PLAINTEXT_TOKEN }]);
    mockGetSettings.mockResolvedValue({});
    mockGetSettingsValue.mockImplementation((key: string) =>
      key === 'githubMcpClientId' ? CLIENT_ID : key === 'githubMcpClientSecret' ? CLIENT_SECRET : undefined
    );
  });

  it('revokes the OAuth grant at GitHub with correct URL, method, auth, and body', async () => {
    (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe(`https://api.github.com/applications/${CLIENT_ID}/grant`);
    expect(init.method).toBe('DELETE');

    const expectedAuth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
    expect(init.headers.Authorization).toBe(expectedAuth);
    expect(init.headers.Accept).toBe('application/vnd.github+json');

    expect(JSON.parse(init.body)).toEqual({ access_token: PLAINTEXT_TOKEN });
  });

  it('still returns 200 and deletes locally when GitHub revoke throws', async () => {
    (fetch as any).mockRejectedValue(new Error('network down'));

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndDelete).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when GitHub revoke responds with a non-ok status', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 422, text: async () => 'unprocessable' });

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndDelete).toHaveBeenCalledTimes(1);
  });

  it('skips revoke (no fetch) when no server record exists', async () => {
    mockFindOneAndDelete.mockResolvedValue(null);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips revoke (no fetch) when credentials are missing', async () => {
    mockGetSettingsValue.mockReturnValue(undefined);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips revoke (no fetch) when the token is missing from the record', async () => {
    mockFindOneAndDelete.mockResolvedValue({ id: 'server-1', envVariables: [] });
    mockDecryptEnvVariables.mockReturnValue([]);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still returns 200 and deletes locally when the credential lookup throws', async () => {
    // getSettings (a DB call) sits outside the fetch try/catch in a naive
    // implementation; a throw here must not 500 after the local delete succeeded.
    mockGetSettings.mockRejectedValue(new Error('settings store unavailable'));

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndDelete).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
