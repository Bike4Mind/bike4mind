import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebounceValue } from './useDebouncedValue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebounceValue', () => {
  it('settles the debounced value once the delay passes', () => {
    const { result } = renderHook(() => useDebounceValue('a', 300));

    act(() => result.current.setValue('ab'));
    expect(result.current).toMatchObject({ value: 'ab', debouncedValue: 'a' });

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.debouncedValue).toBe('ab');
  });

  it('sets both values at once and drops a pending update', () => {
    const { result } = renderHook(() => useDebounceValue('old', 300));

    act(() => result.current.setValue('typed'));
    act(() => result.current.setValueImmediately(''));
    expect(result.current).toMatchObject({ value: '', debouncedValue: '' });

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toMatchObject({ value: '', debouncedValue: '' });
  });
});
