// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: vi.fn(), shareable: { findUpdateAccessById: vi.fn() } },
  questRepository: { findBySessionIdAndId: vi.fn(), updateInSession: vi.fn() },
}));

vi.mock('@bike4mind/services', () => ({
  sessionService: { deleteSessionMessage: vi.fn() },
}));

// The legacy URL serves the v1 contract handler, so the real contract adapter runs; only baseApi is stubbed.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    for (const method of ['get', 'put', 'post', 'delete', 'patch']) chain[method] = compose;
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));

import handler from '../../pages/api/sessions/[id]/chat/[messageId]/index';
import { questRepository, sessionRepository } from '@bike4mind/database';

const OWNER = 'user-owner';
const SHAREE = 'user-sharee';
const EDITOR = 'user-editor';

const run = async (userId: string, body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'session-1', messageId: 'msg-1' }, body });
  Object.assign(req, { user: { id: userId }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
};

describe('PUT /api/sessions/[id]/chat/[messageId] authorization', () => {
  beforeEach(() => {
    vi.mocked(questRepository.updateInSession)
      .mockReset()
      .mockResolvedValue({ id: 'msg-1', reply: 'edited' } as never);
    vi.mocked(questRepository.findBySessionIdAndId)
      .mockReset()
      .mockResolvedValue({ id: 'msg-1', sessionId: 'session-1', reply: 'original', promptMeta: {} } as never);
    vi.mocked(sessionRepository.shareable.findUpdateAccessById)
      .mockReset()
      .mockResolvedValue({ id: 'session-1' } as never);
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
    await expect(run(SHAREE, { reply: 'pwned' })).rejects.toMatchObject({ statusCode: 403 });
    expect(questRepository.updateInSession).not.toHaveBeenCalled();
  });

  it('still allows a sharee holding update to edit the reply', async () => {
    const response = await run(EDITOR, { reply: 'fixed' });

    expect(response._getStatusCode()).toBe(200);
    expect(questRepository.updateInSession).toHaveBeenCalled();
  });

  it('writes only the edited fields, scoped to the session in the URL', async () => {
    await run(EDITOR, { reply: 'fixed' });

    expect(questRepository.updateInSession).toHaveBeenCalledWith('session-1', { id: 'msg-1', reply: 'fixed' });
  });

  it('refuses and writes nothing when update access is revoked right before the write', async () => {
    vi.mocked(sessionRepository.shareable.findUpdateAccessById).mockResolvedValue(null as never);
    await expect(run(EDITOR, { reply: 'fixed' })).rejects.toMatchObject({ statusCode: 403 });
    expect(questRepository.updateInSession).not.toHaveBeenCalled();
  });
});
