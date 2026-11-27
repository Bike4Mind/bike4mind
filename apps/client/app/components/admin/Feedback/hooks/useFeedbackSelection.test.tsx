import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFeedbackSelection } from './useFeedbackSelection';

describe('feedback selection', () => {
  it('supports page and all-matching selection, with a loaded-page fallback on deselection', () => {
    const { result } = renderHook(() => useFeedbackSelection({ pageIds: ['a', 'b'], scopeKey: 'page1', total: 5 }));
    act(() => result.current.setSelection({ mode: 'explicit', ids: ['a', 'b'] }));
    expect(result.current.selection).toEqual({ mode: 'explicit', ids: ['a', 'b'] });
    act(() => result.current.setSelection({ mode: 'allMatching' }));
    act(() => result.current.toggle('a'));
    expect(result.current.selection).toEqual({ mode: 'explicit', ids: ['b'] });
    act(() => result.current.clear());
    expect(result.current.selection).toEqual({ mode: 'explicit', ids: [] });
  });
  it('clears selection immediately on page/filter changes', () => {
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useFeedbackSelection({ pageIds: ['a'], scopeKey, total: 5 }),
      { initialProps: { scopeKey: 'first' } }
    );
    act(() => result.current.toggle('a'));
    rerender({ scopeKey: 'second' });
    expect(result.current.selection).toEqual({ mode: 'explicit', ids: [] });
  });
});
