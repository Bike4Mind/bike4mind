import { describe, it, expect } from 'vitest';
import { IChatHistoryItem } from '@bike4mind/common';
import { summarizeChatContext, extractImagesFromChat, generateModalContentFromContext } from './modalToolHelpers';

// The from-context helpers accept whatever the client sends as chatHistory, so
// fixtures are cast through unknown to exercise both the legacy {content,text}
// shape and the real IChatHistoryItem {prompt,reply,images} shape.
const msg = (item: Record<string, unknown>): IChatHistoryItem => item as unknown as IChatHistoryItem;

describe('summarizeChatContext', () => {
  it('reflects the legacy {content} message shape', () => {
    const summary = summarizeChatContext([msg({ content: 'We shipped a new feature today' })]);
    expect(summary).toContain('new feature');
  });

  it('reflects the real IChatHistoryItem {prompt,reply} shape', () => {
    const summary = summarizeChatContext([
      msg({ prompt: 'Any maintenance planned?', reply: 'Yes, maintenance tonight' }),
    ]);
    expect(summary).toContain('maintenance');
  });

  it('returns an empty string for empty history', () => {
    expect(summarizeChatContext([])).toBe('');
  });

  it('returns an empty string when messages carry no text', () => {
    expect(summarizeChatContext([msg({ images: ['https://cdn.example.com/a.png'] })])).toBe('');
  });
});

describe('extractImagesFromChat', () => {
  it('collects image-generation results (type + url)', () => {
    expect(extractImagesFromChat([msg({ type: 'image', url: 'https://cdn.example.com/gen.png' })])).toEqual([
      'https://cdn.example.com/gen.png',
    ]);
  });

  it('collects attached images', () => {
    const images = extractImagesFromChat([
      msg({ attachments: [{ type: 'image', url: 'https://cdn.example.com/att.png' }] }),
    ]);
    expect(images).toEqual(['https://cdn.example.com/att.png']);
  });

  it('ignores IChatHistoryItem.images (bucket keys, not usable URLs)', () => {
    const images = extractImagesFromChat([msg({ prompt: 'look', images: ['sessions/abc/generated.png'] })]);
    expect(images).toEqual([]);
  });

  it('returns an empty array for empty history', () => {
    expect(extractImagesFromChat([])).toEqual([]);
  });
});

describe('generateModalContentFromContext', () => {
  it('builds text-only content that reflects the recent messages', () => {
    const content = generateModalContentFromContext([msg({ prompt: 'Announcing our new feature launch' })], {
      type: 'modal',
    });

    expect(content).not.toBeNull();
    // 'feature' in the summary drives the templated title.
    expect(content?.title).toBe('🚀 Exciting New Feature!');
    expect(content?.description).toContain('new feature launch');
    expect(content?.imageUrl).toBeUndefined();
  });

  it('populates imageUrl from an attached image in the recent messages', () => {
    const content = generateModalContentFromContext(
      [
        msg({
          prompt: 'here is a screenshot',
          attachments: [{ type: 'image', url: 'https://cdn.example.com/shot.png' }],
        }),
      ],
      { type: 'modal' }
    );

    expect(content).not.toBeNull();
    expect(content?.imageUrl).toBe('https://cdn.example.com/shot.png');
  });

  it('builds banner content when type is banner', () => {
    const content = generateModalContentFromContext([msg({ prompt: 'scheduled maintenance tonight' })], {
      type: 'banner',
    });

    expect(content?.isBanner).toBe(true);
    expect(content?.textMessage).toBeTruthy();
  });

  it('returns null for empty history so callers surface a clear message', () => {
    expect(generateModalContentFromContext([], { type: 'modal' })).toBeNull();
  });

  it('returns null when messages carry no text and no images', () => {
    expect(generateModalContentFromContext([msg({ prompt: '' }), msg({})], { type: 'modal' })).toBeNull();
  });
});
