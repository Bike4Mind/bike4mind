import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * Regression test for the web `$connect` credential swap: the web client now
 * presents a single-use `?ticket=<t>` instead of the session JWT in the URL.
 * These pin the ticket path (atomic consume + tokenVersion kill-switch), the
 * legacy-token fallback kept for rollout, and the reject-when-neither case.
 *
 * withWebSocketContext is stubbed to the identity wrapper so `func` is invoked
 * as the raw handler; only the DB / verify seams are mocked.
 */

const h = vi.hoisted(() => ({
  consume: vi.fn(),
  findById: vi.fn(),
  connectionCreate: vi.fn(),
  isTokenVersionCurrent: vi.fn(),
  verifyToken: vi.fn(),
  verifyApiKey: vi.fn(),
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler,
}));

vi.mock('@bike4mind/database', () => ({
  Connection: { create: h.connectionCreate },
  User: { findById: h.findById },
  wsConnectTicketRepository: { consume: h.consume },
}));

vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: h.isTokenVersionCurrent,
  // Legacy rollout tokens carry no `typ`, which the real guard accepts.
  isTokenTypeAcceptable: () => true,
}));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/common', () => ({
  ApiKeyScope: { AI_GENERATE: 'ai_generate', AI_CHAT: 'ai_chat', CC_BRIDGE: 'cc_bridge' },
}));
vi.mock('@server/auth/tokenGenerator', () => ({ authTokenGenerator: { verifyToken: h.verifyToken } }));
vi.mock('@server/cli/auth', () => ({ verifyApiKey: h.verifyApiKey }));
vi.mock('@server/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { func } from '../connect';

type Handler = (event: unknown, context: unknown, logger: unknown) => Promise<{ statusCode: number }>;
const call = (event: unknown) => (func as unknown as Handler)(event, {}, { warn: vi.fn(), info: vi.fn() });

const eventWith = (queryStringParameters: Record<string, string>, headers: Record<string, string> = {}) => ({
  queryStringParameters,
  headers,
  requestContext: { connectionId: 'conn-1' },
});

describe('web $connect ticket path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (h.findById as Mock).mockResolvedValue({ id: 'u1', tokenVersion: 5, save: vi.fn() });
    (h.isTokenVersionCurrent as Mock).mockReturnValue(true);
  });

  it('consumes the ticket and opens the connection tagged source web', async () => {
    (h.consume as Mock).mockResolvedValue({ userId: 'u1', tokenVersion: 5, used: true });

    const res = await call(eventWith({ ticket: 't-abc' }));

    expect(res.statusCode).toBe(200);
    expect(h.consume).toHaveBeenCalledWith('t-abc');
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.connectionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', userId: 'u1', source: 'web' })
    );
    // no scopes on a ticket connection
    expect(h.connectionCreate.mock.calls[0][0]).not.toHaveProperty('scopes');
  });

  it('rejects a replayed or expired ticket (consume returns null)', async () => {
    (h.consume as Mock).mockResolvedValue(null);
    await expect(call(eventWith({ ticket: 't-used' }))).rejects.toThrow(/ticket/i);
    expect(h.connectionCreate).not.toHaveBeenCalled();
  });

  it('still fires the tokenVersion kill-switch for a ticket connection', async () => {
    (h.consume as Mock).mockResolvedValue({ userId: 'u1', tokenVersion: 4, used: true });
    (h.isTokenVersionCurrent as Mock).mockReturnValue(false);
    await expect(call(eventWith({ ticket: 't-stale' }))).rejects.toThrow(/expired/i);
    expect(h.connectionCreate).not.toHaveBeenCalled();
  });

  it('rejects a $connect carrying neither ticket nor token', async () => {
    await expect(call(eventWith({}))).rejects.toThrow(/No authentication token/i);
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.connectionCreate).not.toHaveBeenCalled();
  });

  it('still accepts a legacy ?token= JWT during rollout', async () => {
    (h.verifyToken as Mock).mockReturnValue({ id: 'u1', tokenVersion: 5 });

    const res = await call(eventWith({ token: 'legacy.jwt' }));

    expect(res.statusCode).toBe(200);
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.verifyToken).toHaveBeenCalledWith('legacy.jwt');
    expect(h.connectionCreate).toHaveBeenCalledWith(expect.objectContaining({ source: 'web' }));
  });
});
