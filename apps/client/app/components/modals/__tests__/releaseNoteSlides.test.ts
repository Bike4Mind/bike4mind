import { describe, it, expect } from 'vitest';
import type { PublicReleaseNote } from '@bike4mind/common';
import { releaseNoteToModal, RELEASE_NOTE_SLIDE_PREFIX } from '../releaseNoteSlides';

const note = (overrides: Partial<PublicReleaseNote> = {}): PublicReleaseNote => ({
  id: 'rn1',
  release_tag: 'v1.2.3',
  headline: 'Faster search',
  summary: 'Search is quicker now.',
  published_at: '2026-03-05T15:00:00.000Z',
  items: [],
  ...overrides,
});

describe('releaseNoteToModal', () => {
  it('prefixes the id so it cannot collide with a Modal id', () => {
    const slide = releaseNoteToModal(note());
    expect(slide._id).toBe(`${RELEASE_NOTE_SLIDE_PREFIX}rn1`);
    expect(slide.id).toBe(slide._id);
  });

  it('maps headline, tags, firstTime views and the publish date', () => {
    const slide = releaseNoteToModal(note());
    expect(slide.title).toBe('Faster search');
    expect(slide.subtitle).toBe('March 5, 2026 \u00b7 v1.2.3');
    expect(slide.tags).toEqual(['whats-new', 'release-note']);
    expect(slide.numberOfViews?.type).toBe('firstTimeView');
    expect(slide.enabled).toBe(true);
    expect(slide.isBanner).toBe(false);
    expect(slide.priority).toBe(0);
    expect(new Date(slide.createdAt).toISOString()).toBe('2026-03-05T15:00:00.000Z');
  });

  it('falls back to the release tag when the headline is blank', () => {
    expect(releaseNoteToModal(note({ headline: '  ' })).title).toBe('v1.2.3');
  });

  it('groups items by category in New/Improved/Fixed order, most important first', () => {
    const slide = releaseNoteToModal(
      note({
        items: [
          { category: 'fixed', text: 'Fixed a crash', importance: 2 },
          { category: 'new', text: 'Minor new thing', importance: 3 },
          { category: 'new', text: 'Big new thing', importance: 1 },
        ],
      })
    );
    expect(slide.description).toBe(
      'Search is quicker now.\n\n**New**\n\n- Big new thing\n- Minor new thing\n\n**Fixed**\n\n- Fixed a crash'
    );
  });

  it('omits an empty summary', () => {
    const slide = releaseNoteToModal(
      note({ summary: '  ', items: [{ category: 'improved', text: 'X', importance: 1 }] })
    );
    expect(slide.description).toBe('**Improved**\n\n- X');
  });
});
