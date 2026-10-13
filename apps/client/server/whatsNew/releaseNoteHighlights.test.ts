import { describe, it, expect, vi } from 'vitest';
import type { IReleaseNoteDocument } from '@bike4mind/database';

const { mockFindPublishedBetween, mockLoadConfig } = vi.hoisted(() => ({
  mockFindPublishedBetween: vi.fn(),
  mockLoadConfig: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ releaseNoteRepository: { findPublishedBetween: mockFindPublishedBetween } }));
vi.mock('@server/releaseNotes/adminReleaseNotes', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/releaseNotes/adminReleaseNotes')>()),
  loadReleaseNotesConfig: mockLoadConfig,
}));

import {
  HIGHLIGHTS_NOTE_LIMIT,
  loadHighlightsReleaseNotes,
  parseHighlightsEndDate,
  releaseNoteToHighlightsEntry,
} from './releaseNoteHighlights';

const note = (overrides: Partial<IReleaseNoteDocument> = {}) =>
  ({
    id: 'note-1',
    releaseTag: 'v2026.10.01',
    headline: 'Faster uploads',
    summary: 'Uploads got sturdier.',
    items: [
      { category: 'fixed', text: 'Progress no longer stalls', importance: 1, sourcePrs: [] },
      { category: 'new', text: 'Minor new thing', importance: 3, sourcePrs: [] },
      { category: 'new', text: 'Resumable uploads', importance: 1, sourcePrs: [] },
    ],
    publishAt: new Date('2026-10-01T09:00:00Z'),
    ...overrides,
  }) as IReleaseNoteDocument;

describe('releaseNoteToHighlightsEntry', () => {
  it('maps headline, tag and publish date, and groups items by category in importance order', () => {
    const entry = releaseNoteToHighlightsEntry(note());

    expect(entry).toMatchObject({
      _id: 'note-1',
      title: 'Faster uploads',
      subtitle: 'v2026.10.01',
      createdAt: new Date('2026-10-01T09:00:00Z'),
    });
    expect(entry.description).toBe(
      'Uploads got sturdier.\n\nNew:\n- Resumable uploads\n- Minor new thing\n\nFixed:\n- Progress no longer stalls'
    );
  });

  it('falls back to the release tag for a blank headline and drops a blank summary', () => {
    const entry = releaseNoteToHighlightsEntry(note({ headline: '  ', summary: '' }));

    expect(entry.title).toBe('v2026.10.01');
    expect(entry.description.startsWith('New:')).toBe(true);
  });
});

describe('parseHighlightsEndDate', () => {
  it('extends a date-only value to the end of that UTC day', () => {
    expect(parseHighlightsEndDate('2026-10-04').toISOString()).toBe('2026-10-04T23:59:59.999Z');
  });

  it('keeps a full timestamp as given', () => {
    expect(parseHighlightsEndDate('2026-10-04T12:00:00Z').toISOString()).toBe('2026-10-04T12:00:00.000Z');
  });
});

describe('loadHighlightsReleaseNotes', () => {
  const range = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-08T00:00:00Z') };
  const logger = { warn: vi.fn() } as unknown as Parameters<typeof loadHighlightsReleaseNotes>[1];
  const notes = (count: number) => Array.from({ length: count }, (_, i) => note({ id: `note-${i}` }));

  it('reports a range that holds more notes than one run summarizes, and summarizes the limit', async () => {
    mockLoadConfig.mockResolvedValue({ config: { enabled: true, denylist: [] }, malformed: false });
    mockFindPublishedBetween.mockResolvedValue(notes(HIGHLIGHTS_NOTE_LIMIT + 1));
    const result = await loadHighlightsReleaseNotes(range, logger);
    expect(mockFindPublishedBetween).toHaveBeenCalledWith(
      range.start,
      range.end,
      expect.any(Date),
      HIGHLIGHTS_NOTE_LIMIT + 1
    );
    expect(result).toMatchObject({ kind: 'ok', truncated: true });
    expect(result.kind === 'ok' && result.entries).toHaveLength(HIGHLIGHTS_NOTE_LIMIT);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is not truncated at exactly the limit', async () => {
    mockLoadConfig.mockResolvedValue({ config: { enabled: true, denylist: [] }, malformed: false });
    mockFindPublishedBetween.mockResolvedValue(notes(HIGHLIGHTS_NOTE_LIMIT));
    expect(await loadHighlightsReleaseNotes(range, logger)).toMatchObject({ kind: 'ok', truncated: false });
  });
});
