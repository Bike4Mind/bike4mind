import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, any> }));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: vi.fn() },
  questRepository: { findBySessionIdAndId: vi.fn(), update: vi.fn() },
}));

vi.mock('@bike4mind/services', () => ({
  sessionService: { deleteSessionMessage: vi.fn() },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: unknown) => handler,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['get', 'put', 'post', 'delete', 'patch']) {
      chain[method] = (handler: unknown) => {
        captured.handlers[method] = handler;
        return chain;
      };
    }
    return chain;
  },
}));

import '../../pages/api/sessions/[id]/chat/[messageId]/index';
import { questRepository, sessionRepository } from '@bike4mind/database';

const OWNER = 'user-owner';
const SHAREE = 'user-sharee';
const EDITOR = 'user-editor';

// `res.status().json()` chains, so the object must return itself from both.
const makeRes = () => {
  const out = { statusCode: 200, body: undefined as unknown };
  const api: any = {
    status: vi.fn((code: number) => {
      out.statusCode = code;
      return api;
    }),
    json: vi.fn((payload: unknown) => {
      out.body = payload;
      return api;
    }),
  };
  api.out = out;
  return api;
};

describe('PUT /api/sessions/[id]/chat/[messageId] authorization', () => {
  beforeEach(() => {
    vi.mocked(questRepository.update)
      .mockReset()
      .mockResolvedValue({ id: 'msg-1', reply: 'edited' } as never);
    vi.mocked(questRepository.findBySessionIdAndId)
      .mockReset()
      .mockResolvedValue({ id: 'msg-1', sessionId: 'session-1', reply: 'original', promptMeta: {} } as never);
    vi.mocked(sessionRepository.findById)
      .mockReset()
      .mockResolvedValue({
        id: 'session-1',
        userId: OWNER,
        users: [
          { userId: SHAREE, permissions: ['read'] },
          { userId: EDITOR, permissions: ['read', 'update'] },
        ],
      } as never);
  });

  it('refuses a read-only sharee rewriting a reply, and does not write the message', async () => {
    const response = makeRes();
    await captured.handlers.put(
      { query: { id: 'session-1', messageId: 'msg-1' }, body: { reply: 'pwned' }, user: { id: SHAREE } },
      response
    );

    expect(response.out.statusCode).toBe(403);
    expect(questRepository.update).not.toHaveBeenCalled();
  });

  it('still allows a sharee holding update to edit the reply', async () => {
    const response = makeRes();
    await captured.handlers.put(
      { query: { id: 'session-1', messageId: 'msg-1' }, body: { reply: 'fixed' }, user: { id: EDITOR } },
      response
    );

    expect(response.out.statusCode).toBe(200);
    expect(questRepository.update).toHaveBeenCalled();
  });
});
