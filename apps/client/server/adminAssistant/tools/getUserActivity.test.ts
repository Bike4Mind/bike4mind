import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminUserRef = vi.fn();
vi.mock('../resolveAdminUserRef', async importOriginal => ({
  ...(await importOriginal<typeof import('../resolveAdminUserRef')>()),
  resolveAdminUserRef: (...args: unknown[]) => resolveAdminUserRef(...args),
}));
const listUserActivity = vi.fn();
vi.mock('../../utils/userActivity', () => ({
  listUserActivity: (...args: unknown[]) => listUserActivity(...args),
}));

import { getUserActivityTool } from './getUserActivity';

const USER_ID = '65f1a2b3c4d5e6f708192a3b';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runRaw = (args: unknown) => getUserActivityTool.implementation(context, undefined).toolFn(args);
const runTool = async (args: unknown) => JSON.parse(await runRaw(args));

const entry = (extra: Record<string, unknown> = {}) => ({
  id: 'e1',
  occurredAt: new Date('2026-10-02T00:00:00Z'),
  action: 'credits.grant',
  actor: { kind: 'user', name: 'Grace Admin', email: 'grace@example.com', userId: 'admin-2' },
  summary: 'Granted 100 credits',
  context: { ip: '203.0.113.9', userAgent: 'agent-string', source: 'admin_ui' },
  details: { secret: 'detail-value' },
  ...extra,
});

describe('getUserActivityTool', () => {
  beforeEach(() => {
    resolveAdminUserRef
      .mockReset()
      .mockResolvedValue({ id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false });
    listUserActivity.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  });

  it('returns not_found for an unknown user', async () => {
    resolveAdminUserRef.mockResolvedValue(null);

    expect(await runTool({ userId: USER_ID })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it.each([{ limit: 26 }, { limit: 0 }])('rejects %o as invalid_input', async extra => {
    expect(await runTool({ userId: USER_ID, ...extra })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(listUserActivity).not.toHaveBeenCalled();
  });

  it('asks for target-direction activity without security events, default limit 15', async () => {
    await runTool({ userId: USER_ID });

    expect(listUserActivity).toHaveBeenCalledWith(
      { id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false },
      { direction: 'target', includeSecurity: false, limit: 15 }
    );
  });

  it('returns picked fields only and never actorIp or actorUserAgent', async () => {
    listUserActivity.mockResolvedValue({ entries: [entry()], nextCursor: null });

    const raw = await runRaw({ userId: USER_ID });

    expect(JSON.parse(raw).data).toEqual({
      truncated: false,
      entries: [
        {
          at: '2026-10-02T00:00:00.000Z',
          action: 'credits.grant',
          actorName: 'Grace Admin',
          summary: 'Granted 100 credits',
        },
      ],
    });
    for (const leaked of [
      '203.0.113.9',
      'agent-string',
      'actorIp',
      'actorUserAgent',
      'grace@example.com',
      'detail-value',
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('reports truncated when the helper has more entries', async () => {
    listUserActivity.mockResolvedValue({ entries: [entry()], nextCursor: { occurredAt: new Date(), id: 'e1' } });

    expect((await runTool({ userId: USER_ID })).data.truncated).toBe(true);
  });

  it('hands the model userId, email and limit in its JSON schema', () => {
    const { parameters } = getUserActivityTool.implementation(context, undefined).toolSchema;

    expect(Object.keys((parameters as { properties: object }).properties)).toEqual(['userId', 'email', 'limit']);
  });
});
