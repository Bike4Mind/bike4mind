import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware stripped so the handler body runs directly (same pattern as model-deprecation-status.test.ts).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.post = (fn: (typeof handlers)[string]) => {
      handlers.POST = fn;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockFindPublishedBetween = vi.fn();
vi.mock('@bike4mind/database', () => ({
  AdminSettings: {
    findOne: vi.fn().mockResolvedValue({ settingValue: { slackChannelId: 'C1', slackTeamId: 'T1' } }),
    findOneAndUpdate: vi.fn(),
  },
  releaseNoteRepository: { findPublishedBetween: (...a: unknown[]) => mockFindPublishedBetween(...a) },
}));

const mockLoadConfig = vi.fn();
vi.mock('@server/releaseNotes/adminReleaseNotes', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/releaseNotes/adminReleaseNotes')>();
  return { ...actual, loadReleaseNotesConfig: (...a: unknown[]) => mockLoadConfig(...a) };
});

const mockSendToQueue = vi.fn();
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => mockSendToQueue(...a) }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));

import handler from '../generate-highlights';
import { HIGHLIGHTS_NOTE_LIMIT } from '@server/whatsNew/releaseNoteHighlights';

const logger = { warn: vi.fn(), log: vi.fn(), info: vi.fn(), error: vi.fn() };

const note = (id: string, headline: string) => ({
  id,
  releaseTag: `tag-${id}`,
  headline,
  summary: '',
  items: [{ category: 'new', text: `${headline} item`, importance: 1 }],
  publishAt: new Date('2026-10-02T00:00:00Z'),
});

const dryRun = async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { startDate: '2026-09-28', endDate: '2026-10-04', dryRun: true },
  });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true }, logger });
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

describe('POST /api/admin/generate-highlights dry run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ config: { enabled: true, denylist: ['secret'] }, malformed: false });
  });

  it('previews the published release notes in the range, without the denylisted ones, and dispatches nothing', async () => {
    mockFindPublishedBetween.mockResolvedValue([note('a', 'Dark mode'), note('b', 'secret project')]);

    const { status, body } = await dryRun();

    expect(status).toBe(200);
    const [start, end] = mockFindPublishedBetween.mock.calls[0];
    expect(start.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-04T23:59:59.999Z');
    expect(body).toMatchObject({ dryRun: true, skipped: false, modalCount: 1 });
    expect(body.modals).toEqual([expect.objectContaining({ title: 'Dark mode', subtitle: 'tag-a' })]);
    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it('reports a skipped run when release notes are disabled', async () => {
    mockLoadConfig.mockResolvedValue({ config: { enabled: false, denylist: [] }, malformed: false });

    const { body } = await dryRun();

    expect(mockFindPublishedBetween).not.toHaveBeenCalled();
    expect(body).toMatchObject({ dryRun: true, skipped: true, modalCount: 0, modals: [] });
    expect(body.message).toContain('disabled');
  });

  it('reports a truncated range by the note limit, not the post-denylist count', async () => {
    const notes = Array.from({ length: HIGHLIGHTS_NOTE_LIMIT + 1 }, (_, index) =>
      note(String(index), index === 0 ? 'secret project' : `Note ${index}`)
    );
    mockFindPublishedBetween.mockResolvedValue(notes);

    const { body } = await dryRun();

    expect(body.truncated).toBe(true);
    expect(body.message).toContain(`more than ${HIGHLIGHTS_NOTE_LIMIT}`);
    // One of the newest notes is denylisted, so the previewed count is below the limit the message states.
    expect(body.modalCount).toBe(HIGHLIGHTS_NOTE_LIMIT - 1);
  });
});
