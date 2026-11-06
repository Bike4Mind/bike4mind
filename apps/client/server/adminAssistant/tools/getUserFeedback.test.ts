import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminUserRef = vi.fn();
vi.mock('../resolveAdminUserRef', async importOriginal => ({
  ...(await importOriginal<typeof import('../resolveAdminUserRef')>()),
  resolveAdminUserRef: (...args: unknown[]) => resolveAdminUserRef(...args),
}));
const limit = vi.fn();
const sort = vi.fn(() => ({ limit }));
const select = vi.fn(() => ({ sort }));
const find = vi.fn(() => ({ select }));
const textLean = vi.fn();
const findText = vi.fn(() => ({ lean: textLean }));
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { find: (...args: unknown[]) => find(...(args as [])) },
  FeedbackTextModel: { find: (...args: unknown[]) => findText(...(args as [])) },
}));

import { getUserFeedbackTool } from './getUserFeedback';

const USER_ID = '65f1a2b3c4d5e6f708192a3b';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runRaw = (args: unknown) => getUserFeedbackTool.implementation(context, undefined).toolFn(args);
const runTool = async (args: unknown) => JSON.parse(await runRaw(args));

const feedbackDoc = (extra: Record<string, unknown> = {}) => ({
  toJSON: () => ({
    id: 'f1',
    createdAt: new Date('2026-10-03T00:00:00Z'),
    type: 'bug',
    subject: 'turn',
    status: 'open',
    content: 'It broke',
    contentStored: false,
    userEmail: 'ada@example.com',
    promptMeta: { prompt: 'prompt-meta-value' },
    ...extra,
  }),
});

describe('getUserFeedbackTool', () => {
  beforeEach(() => {
    resolveAdminUserRef.mockReset().mockResolvedValue({ id: USER_ID });
    limit.mockReset().mockResolvedValue([]);
    find.mockClear();
    textLean.mockReset().mockResolvedValue([]);
  });

  it('returns not_found for an unknown user', async () => {
    resolveAdminUserRef.mockResolvedValue(null);

    expect(await runTool({ userId: USER_ID })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it.each([{ limit: 21 }, { limit: 0 }])('rejects %o as invalid_input', async extra => {
    expect(await runTool({ userId: USER_ID, ...extra })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(find).not.toHaveBeenCalled();
  });

  it('queries the user newest first with the default limit of 10', async () => {
    await runTool({ userId: USER_ID });

    expect(find).toHaveBeenCalledWith({ userId: USER_ID });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(11);
  });

  it('returns picked fields and never promptMeta or userEmail', async () => {
    limit.mockResolvedValue([feedbackDoc()]);

    const raw = await runRaw({ userId: USER_ID });

    expect(JSON.parse(raw).data.items).toEqual([
      {
        id: 'f1',
        createdAt: '2026-10-03T00:00:00.000Z',
        type: 'bug',
        subject: 'turn',
        status: 'open',
        text: 'It broke',
        textExpired: false,
      },
    ]);
    for (const leaked of ['promptMeta', 'prompt-meta-value', 'userEmail', 'ada@example.com']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('truncates text at 500 characters', async () => {
    limit.mockResolvedValue([feedbackDoc({ content: 'x'.repeat(900) })]);

    const result = await runTool({ userId: USER_ID });

    expect(result.data.items[0].text).toHaveLength(500);
  });

  it('selects contentStored and hydrates text from the FeedbackText sibling', async () => {
    limit.mockResolvedValue([feedbackDoc({ content: undefined, contentStored: true })]);
    textLean.mockResolvedValue([{ _id: { toString: () => 'f1' }, content: 'Stored text', contentTruncated: false }]);

    const result = await runTool({ userId: USER_ID });

    expect(select).toHaveBeenCalledWith(expect.stringContaining('contentStored'));
    expect(result.data.items[0]).toMatchObject({ text: 'Stored text', textExpired: false });
  });

  it('flags text whose stored copy has expired, unlike a report that never had text', async () => {
    limit.mockResolvedValue([
      feedbackDoc({ id: 'f1', content: undefined, contentStored: true }),
      feedbackDoc({ id: 'f2', content: undefined, contentStored: false }),
    ]);

    const result = await runTool({ userId: USER_ID });

    expect(result.data.items.map((item: { textExpired: boolean }) => item.textExpired)).toEqual([true, false]);
    expect(result.data.items.map((item: { text: string | null }) => item.text)).toEqual([null, null]);
  });

  it('reports truncated when more reports exist than the limit', async () => {
    limit.mockResolvedValue([feedbackDoc({ id: 'f1' }), feedbackDoc({ id: 'f2' })]);

    const result = await runTool({ userId: USER_ID, limit: 1 });

    expect(result.data.items).toHaveLength(1);
    expect(result.data.truncated).toBe(true);
    expect((await runTool({ userId: USER_ID, limit: 2 })).data.truncated).toBe(false);
  });

  it('hands the model userId, email and limit in its JSON schema', () => {
    const { parameters } = getUserFeedbackTool.implementation(context, undefined).toolSchema;

    expect(Object.keys((parameters as { properties: object }).properties)).toEqual(['userId', 'email', 'limit']);
  });
});
