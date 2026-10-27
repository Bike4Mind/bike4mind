import { describe, expect, it, vi } from 'vitest';
import {
  QuestPollResponseSchema,
  formatChoicesBlock,
  type IChatHistoryItemDocument,
  type ITurnTiming,
} from '@bike4mind/common';
import { toQuestPollBody } from './questPollBody';

vi.mock('./storage/index', () => ({
  getGeneratedImageStorage: () => ({ getSignedUrl: async (key: string) => `https://signed.example.invalid/${key}` }),
}));

const quest = (overrides: Partial<IChatHistoryItemDocument>) =>
  ({ id: 'q1', sessionId: 's1', status: 'done', type: 'text', ...overrides }) as IChatHistoryItemDocument;

describe('toQuestPollBody', () => {
  it('carries rendered videos, resolved to presigned urls alongside the images', async () => {
    const body = await toQuestPollBody(quest({ images: ['a.png'], videos: ['clip.mp4'] }), { isOwner: true });

    expect(body.videos).toEqual(['clip.mp4']);
    expect(body.files.map(file => file.url)).toEqual([
      'https://signed.example.invalid/a.png',
      'https://signed.example.invalid/clip.mp4',
    ]);
  });

  it('defaults images and videos to empty lists on a quest that rendered nothing', async () => {
    const body = await toQuestPollBody(quest({}), { isOwner: true });

    expect(body.images).toEqual([]);
    expect(body.videos).toEqual([]);
  });

  describe('fallbackInfo', () => {
    const info = {
      primaryModel: 'm1',
      primaryModelName: 'M1',
      fallbackModel: 'm2',
      fallbackModelName: 'M2',
      reason: 'rate limited',
    };

    it('projects the full record on a successful turn', async () => {
      expect((await toQuestPollBody(quest({ fallbackInfo: info }), { isOwner: true })).fallbackInfo).toEqual(info);
    });

    it('is absent when the quest has none', async () => {
      expect((await toQuestPollBody(quest({}), { isOwner: true })).fallbackInfo).toBeUndefined();
      expect((await toQuestPollBody(quest({ fallbackInfo: null }), { isOwner: true })).fallbackInfo).toBeUndefined();
    });

    it('drops a malformed record and logs which fields were bad', async () => {
      const logger = { warn: vi.fn() };
      const malformed = { primaryModel: 'm1' } as IChatHistoryItemDocument['fallbackInfo'];

      const body = await toQuestPollBody(quest({ fallbackInfo: malformed }), { isOwner: true, logger });

      expect(body.fallbackInfo).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Dropping malformed fallbackInfo from quest poll body',
        expect.objectContaining({ questId: 'q1', issues: expect.arrayContaining(['fallbackModel']) })
      );
    });

    it('is withheld on an error turn, e.g. a recovered timeout', async () => {
      const body = await toQuestPollBody(quest({ type: 'error', fallbackInfo: info }), { isOwner: true });
      expect(body.fallbackInfo).toBeUndefined();
    });
  });
});

describe('toQuestPollBody reply', () => {
  const body = (overrides: Partial<IChatHistoryItemDocument>) => toQuestPollBody(quest(overrides), { isOwner: true });

  it('derives reply from replies[] when the pipeline left the scalar null', async () => {
    const out = await body({ reply: null, replies: ['Hi'] });

    expect(out.reply).toBe('Hi');
    expect(out.replies).toEqual(['Hi']);
  });

  it('joins the visible text of every slot, dropping thinking blocks', async () => {
    const replies = ['<think>plan</think>', 'Answer part 1', ' part 2'];

    const out = await body({ reply: null, replies });

    expect(out.reply).toBe('Answer part 1 part 2');
    expect(out.replies).toEqual(replies);
  });

  it('returns the full answer, not the stale rapid-reply prefix', async () => {
    expect((await body({ reply: 'Quick ', replies: ['Quick full answer'] })).reply).toBe('Quick full answer');
  });

  it('strips a trailing choices block from the answer', async () => {
    const block = formatChoicesBlock([
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ]);

    expect((await body({ reply: null, replies: [`Pick one.${block}`] })).reply).toBe('Pick one.');
  });

  it('keeps the scalar reply when there are no slots', async () => {
    const out = await body({ type: 'error', reply: 'Something went wrong', replies: [] });

    expect(out.reply).toBe('Something went wrong');
    expect(out.replies).toEqual([]);
  });

  it('keeps the scalar reply when every slot is thinking-only', async () => {
    expect((await body({ type: 'error', reply: 'err', replies: ['<think>x</think>'] })).reply).toBe('err');
  });

  it('is null when the quest has no content at all', async () => {
    expect((await body({})).reply).toBeNull();
  });
});

describe('toQuestPollBody turnTiming', () => {
  const timing: ITurnTiming = {
    queueMs: 120,
    contextBuildMs: 2400,
    semaphoreWaitMs: 3000,
    totalMs: 415_000,
    retries: [
      {
        reason: 'stream_idle_timeout',
        status: 529,
        requestId: 'req_1',
        delayMs: 3500,
        model: 'claude-opus-5-5',
        at: new Date('2026-10-21T02:21:46.000Z'),
      },
    ],
    fallbackHops: 1,
  };

  it('passes the turn timing through, retries included', async () => {
    const body = await toQuestPollBody(quest({ turnTiming: timing }), { isOwner: true });

    expect(body.turnTiming).toEqual(timing);
  });

  it('is absent when the quest has none', async () => {
    const body = await toQuestPollBody(quest({}), { isOwner: true });

    expect(body.turnTiming).toBeUndefined();
  });

  it('serializes to the shape the public poll schema documents, with `at` as an ISO string', async () => {
    const body = await toQuestPollBody(quest({ type: 'message', turnTiming: timing }), { isOwner: true });

    const parsed = QuestPollResponseSchema.parse(JSON.parse(JSON.stringify(body)));

    expect(parsed.turnTiming?.retries[0].at).toBe('2026-10-21T02:21:46.000Z');
  });
});
