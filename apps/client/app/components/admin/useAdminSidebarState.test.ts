import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SIDEBAR_COLLAPSED_STORAGE_KEY, SIDEBAR_MORE_STORAGE_KEY } from './adminSidebarConfig';
import { useAdminSidebarCollapsed, useAdminSidebarMore } from './useAdminSidebarState';

const storedMore = () => JSON.parse(window.localStorage.getItem(SIDEBAR_MORE_STORAGE_KEY) ?? 'null');

describe('useAdminSidebarMore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with every section closed and writes nothing', () => {
    const { result } = renderHook(() => useAdminSidebarMore());

    expect(result.current.isMoreOpen('people')).toBe(false);
    expect(storedMore()).toBeNull();
  });

  it('toggles a section open and closed', () => {
    const { result } = renderHook(() => useAdminSidebarMore());

    act(() => result.current.toggleMore('people'));
    expect(result.current.isMoreOpen('people')).toBe(true);
    expect(result.current.isMoreOpen('ai')).toBe(false);

    act(() => result.current.toggleMore('people'));
    expect(result.current.isMoreOpen('people')).toBe(false);
  });

  it('persists each toggle as a string array', () => {
    const { result } = renderHook(() => useAdminSidebarMore());

    act(() => result.current.toggleMore('people'));
    act(() => result.current.toggleMore('ai'));
    expect(storedMore()).toEqual(['people', 'ai']);

    act(() => result.current.toggleMore('people'));
    expect(storedMore()).toEqual(['ai']);
  });

  it('restores stored sections and ignores non-string entries', () => {
    window.localStorage.setItem(SIDEBAR_MORE_STORAGE_KEY, JSON.stringify(['people', 3, null]));

    const { result } = renderHook(() => useAdminSidebarMore());

    expect(result.current.isMoreOpen('people')).toBe(true);
    expect(result.current.isMoreOpen('3')).toBe(false);
  });

  it('treats malformed JSON as no preference', () => {
    window.localStorage.setItem(SIDEBAR_MORE_STORAGE_KEY, '{not json');

    const { result } = renderHook(() => useAdminSidebarMore());

    expect(result.current.isMoreOpen('people')).toBe(false);
  });

  it('treats a non-array value as no preference', () => {
    window.localStorage.setItem(SIDEBAR_MORE_STORAGE_KEY, JSON.stringify({ people: true }));

    const { result } = renderHook(() => useAdminSidebarMore());

    expect(result.current.isMoreOpen('people')).toBe(false);
  });

  it('still works in memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    const { result } = renderHook(() => useAdminSidebarMore());
    expect(result.current.isMoreOpen('people')).toBe(false);

    act(() => result.current.toggleMore('people'));

    expect(result.current.isMoreOpen('people')).toBe(true);
  });
});

describe('useAdminSidebarCollapsed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts expanded and persists each toggle', () => {
    const { result } = renderHook(() => useAdminSidebarCollapsed());
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.toggleCollapsed());

    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');
  });

  it('restores a stored collapse', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');

    const { result } = renderHook(() => useAdminSidebarCollapsed());

    expect(result.current.collapsed).toBe(true);
  });
});
