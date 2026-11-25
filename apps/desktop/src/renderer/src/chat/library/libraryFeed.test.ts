import { describe, expect, it } from 'vitest';
import type { LibraryItem, LibraryMedium } from '@shared/library';
import { appendPage, emptyFeed, needsFirstLoad, nextToLoad, visibleItems } from './libraryFeed';

const item = (medium: LibraryMedium, id: string, minute: number): LibraryItem => ({
  id,
  medium,
  prompt: id,
  model: 'm',
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  availability: 'ready',
  contentType: medium === 'image' ? 'image/png' : 'video/mp4',
});

const ids = (items: LibraryItem[]) => items.map(entry => entry.id);

describe('libraryFeed', () => {
  it('asks for the first page of every medium the filter covers', () => {
    const state = emptyFeed();
    expect(needsFirstLoad(state, 'all')).toBe(true);
    expect(nextToLoad(state, 'all')).toEqual(['image', 'video']);
    expect(nextToLoad(state, 'video')).toEqual(['video']);
  });

  it('shows one medium as the server ordered it', () => {
    const state = appendPage(emptyFeed(), 'image', {
      items: [item('image', 'i2', 9), item('image', 'i1', 5)],
      nextCursor: 'c',
    });
    expect(ids(visibleItems(state, 'image'))).toEqual(['i2', 'i1']);
    expect(nextToLoad(state, 'image')).toEqual(['image']);
  });

  it('merges All newest first, only down to where both lists have reached', () => {
    let state = appendPage(emptyFeed(), 'image', {
      items: [item('image', 'i3', 50), item('image', 'i2', 40), item('image', 'i1', 10)],
      nextCursor: 'ci',
    });
    state = appendPage(state, 'video', { items: [item('video', 'v2', 45), item('video', 'v1', 30)], nextCursor: 'cv' });
    // i1 (minute 10) is older than the oldest video loaded (30): a newer video may be on the next page.
    expect(ids(visibleItems(state, 'all'))).toEqual(['i3', 'v2', 'i2', 'v1']);
    // Videos hold the merge back, so they are what loads next.
    expect(nextToLoad(state, 'all')).toEqual(['video']);

    state = appendPage(state, 'video', { items: [item('video', 'v0', 20)], nextCursor: null });
    expect(ids(visibleItems(state, 'all'))).toEqual(['i3', 'v2', 'i2', 'v1', 'v0', 'i1']);
    expect(nextToLoad(state, 'all')).toEqual(['image']);
  });

  it('shows everything once both lists are exhausted, and loads nothing more', () => {
    let state = appendPage(emptyFeed(), 'image', { items: [item('image', 'i1', 1)], nextCursor: null });
    state = appendPage(state, 'video', { items: [], nextCursor: null });
    expect(ids(visibleItems(state, 'all'))).toEqual(['i1']);
    expect(nextToLoad(state, 'all')).toEqual([]);
    expect(needsFirstLoad(state, 'all')).toBe(false);
  });

  it('drops an item a later page repeats', () => {
    let state = appendPage(emptyFeed(), 'image', { items: [item('image', 'i1', 1)], nextCursor: 'c' });
    state = appendPage(state, 'image', { items: [item('image', 'i1', 1), item('image', 'i0', 0)], nextCursor: null });
    expect(ids(visibleItems(state, 'image'))).toEqual(['i1', 'i0']);
  });
});
