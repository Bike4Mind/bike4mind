import { afterEach, describe, expect, it } from 'vitest';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
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
});
