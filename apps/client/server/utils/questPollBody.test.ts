import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatChoicesBlock, type IChatHistoryItemDocument } from '@bike4mind/common';
import { toQuestPollBody } from './questPollBody';

const ORIGINAL_CDN = process.env.NEXT_PUBLIC_CDN_URL;

afterEach(() => {
  process.env.NEXT_PUBLIC_CDN_URL = ORIGINAL_CDN;
});

const quest = (overrides: Partial<IChatHistoryItemDocument>) =>
  ({ id: 'q1', sessionId: 's1', status: 'done', type: 'text', ...overrides }) as IChatHistoryItemDocument;

describe('toQuestPollBody', () => {
  it('carries rendered videos, resolved to CDN urls alongside the images', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';

    const body = toQuestPollBody(quest({ images: ['a.png'], videos: ['clip.mp4'] }), { isOwner: true });

    expect(body.videos).toEqual(['clip.mp4']);
    expect(body.files.map(file => file.url)).toEqual([
      'https://cdn.example.com/generated/a.png',
      'https://cdn.example.com/generated/clip.mp4',
    ]);
  });

  it('defaults images and videos to empty lists on a quest that rendered nothing', () => {
    const body = toQuestPollBody(quest({}), { isOwner: true });

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

    it('projects the full record on a successful turn', () => {
      expect(toQuestPollBody(quest({ fallbackInfo: info }), { isOwner: true }).fallbackInfo).toEqual(info);
    });

    it('is absent when the quest has none', () => {
      expect(toQuestPollBody(quest({}), { isOwner: true }).fallbackInfo).toBeUndefined();
      expect(toQuestPollBody(quest({ fallbackInfo: null }), { isOwner: true }).fallbackInfo).toBeUndefined();
    });

    it('drops a malformed record and logs which fields were bad', () => {
      const logger = { warn: vi.fn() };
      const malformed = { primaryModel: 'm1' } as IChatHistoryItemDocument['fallbackInfo'];

      const body = toQuestPollBody(quest({ fallbackInfo: malformed }), { isOwner: true, logger });

      expect(body.fallbackInfo).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Dropping malformed fallbackInfo from quest poll body',
        expect.objectContaining({ questId: 'q1', issues: expect.arrayContaining(['fallbackModel']) })
      );
    });

    it('is withheld on an error turn, e.g. a recovered timeout', () => {
      const body = toQuestPollBody(quest({ type: 'error', fallbackInfo: info }), { isOwner: true });
      expect(body.fallbackInfo).toBeUndefined();
    });
  });
});

describe('toQuestPollBody reply', () => {
  const body = (overrides: Partial<IChatHistoryItemDocument>) => toQuestPollBody(quest(overrides), { isOwner: true });

  it('derives reply from replies[] when the pipeline left the scalar null', () => {
    const out = body({ reply: null, replies: ['Hi'] });

    expect(out.reply).toBe('Hi');
    expect(out.replies).toEqual(['Hi']);
  });

  it('joins the visible text of every slot, dropping thinking blocks', () => {
    const replies = ['<think>plan</think>', 'Answer part 1', ' part 2'];

    const out = body({ reply: null, replies });

    expect(out.reply).toBe('Answer part 1 part 2');
    expect(out.replies).toEqual(replies);
  });

  it('returns the full answer, not the stale rapid-reply prefix', () => {
    expect(body({ reply: 'Quick ', replies: ['Quick full answer'] }).reply).toBe('Quick full answer');
  });

  it('strips a trailing choices block from the answer', () => {
    const block = formatChoicesBlock([
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ]);

    expect(body({ reply: null, replies: [`Pick one.${block}`] }).reply).toBe('Pick one.');
  });

  it('keeps the scalar reply when there are no slots', () => {
    const out = body({ type: 'error', reply: 'Something went wrong', replies: [] });

    expect(out.reply).toBe('Something went wrong');
    expect(out.replies).toEqual([]);
  });

  it('keeps the scalar reply when every slot is thinking-only', () => {
    expect(body({ type: 'error', reply: 'err', replies: ['<think>x</think>'] }).reply).toBe('err');
  });

  it('is null when the quest has no content at all', () => {
    expect(body({}).reply).toBeNull();
  });
});
