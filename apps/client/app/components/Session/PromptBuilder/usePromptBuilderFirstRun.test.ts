import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePromptBuilderFirstRun } from './usePromptBuilderFirstRun';

describe('usePromptBuilderFirstRun', () => {
  beforeEach(() => localStorage.clear());

  it('shows the hint on first run and hides it once marked seen', () => {
    const { result } = renderHook(() => usePromptBuilderFirstRun());
    expect(result.current.showHint).toBe(true);

    act(() => result.current.markSeen());
    expect(result.current.showHint).toBe(false);
    expect(localStorage.getItem('b4m.promptBuilder.seen')).toBe('1');
  });

  it('does not show the hint when already marked seen', () => {
    localStorage.setItem('b4m.promptBuilder.seen', '1');
    const { result } = renderHook(() => usePromptBuilderFirstRun());
    expect(result.current.showHint).toBe(false);
  });
});
