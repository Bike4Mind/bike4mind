import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Isolate the hook's orchestration (parse -> dedup -> persist -> broadcast) from
// the parser/persistence internals, which have their own tests. The hook delegates
// parsing + fallback promotion to parseArtifactsWithFallback (see artifactParser.test.ts).
const persistArtifacts = vi.fn(() => Promise.resolve());
const parseArtifactsWithFallback = vi.fn();

vi.mock('../../utils/artifactPersistence', () => ({
  persistArtifacts: (...args: unknown[]) => persistArtifacts(...args),
}));

vi.mock('../../utils/artifactParser', () => ({
  parseArtifactsWithFallback: (...args: unknown[]) => parseArtifactsWithFallback(...args),
  getArtifactTimestamp: () => 1000,
  generateCompleteArtifactId: (type: string, identifier: string, _ts: number, index: number) =>
    `${type}-${identifier}-${index}`,
  extractReactDependencies: () => ['react'],
  checkHasDefaultExport: () => true,
}));

import { useStreamingArtifactPersistence } from '../useStreamingArtifactPersistence';

const codeArtifact = {
  type: 'code',
  identifier: 'foo',
  title: 'Foo',
  content: 'console.log(1)',
  operation: 'create',
  language: 'js',
};

describe('useStreamingArtifactPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [], cleanedContent: '' });
  });

  it('parses artifacts from a completed quest and persists them once', async () => {
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [codeArtifact], cleanedContent: '' });
    const { result } = renderHook(() => useStreamingArtifactPersistence());

    act(() => {
      result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['some reply'] });
    });

    await waitFor(() => expect(persistArtifacts).toHaveBeenCalledTimes(1));
    const [artifactsArg, sessionArg] = persistArtifacts.mock.calls[0];
    expect(sessionArg).toBe('s1');
    expect(artifactsArg).toEqual([
      expect.objectContaining({ id: 'code-foo-0', type: 'code', title: 'Foo', content: 'console.log(1)' }),
    ]);
  });

  it('does not persist the same quest twice (dedup by quest id)', async () => {
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [codeArtifact], cleanedContent: '' });
    const { result } = renderHook(() => useStreamingArtifactPersistence());

    act(() => {
      result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['r'] });
      result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['r'] });
    });

    await waitFor(() => expect(persistArtifacts).toHaveBeenCalledTimes(1));
  });

  it('delegates parsing (including fallback promotion) to parseArtifactsWithFallback', () => {
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [codeArtifact], cleanedContent: '' });
    const { result } = renderHook(() => useStreamingArtifactPersistence());

    act(() => {
      result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['a', 'b'] });
    });

    // Replies are joined before parsing so an artifact split across chunks is still seen.
    expect(parseArtifactsWithFallback).toHaveBeenCalledWith('a\nb');
    expect(persistArtifacts).toHaveBeenCalledTimes(1);
  });

  it('broadcasts an artifacts-persisted event with the generated ids', async () => {
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [codeArtifact], cleanedContent: '' });
    const listener = vi.fn();
    window.addEventListener('artifacts-persisted', listener);
    const { result } = renderHook(() => useStreamingArtifactPersistence());

    try {
      act(() => {
        result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['r'] });
      });

      await waitFor(() => expect(listener).toHaveBeenCalledOnce());
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail.questId).toBe('q1');
      expect(event.detail.artifacts).toEqual([{ id: 'code-foo-0', type: 'code', title: 'Foo' }]);
    } finally {
      // Remove in finally so a failed assertion above doesn't leak the listener into later tests.
      window.removeEventListener('artifacts-persisted', listener);
    }
  });

  it('skips quests with no id and quests with no replies', () => {
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [codeArtifact], cleanedContent: '' });
    const { result } = renderHook(() => useStreamingArtifactPersistence());

    act(() => {
      result.current.persistArtifactsFromQuest({ sessionId: 's1', replies: ['r'] }); // no id
      result.current.persistArtifactsFromQuest({ id: 'q2', sessionId: 's1', replies: [] }); // no replies
    });

    expect(persistArtifacts).not.toHaveBeenCalled();
  });

  it('re-allows persistence for a quest id after reset (new session)', async () => {
    parseArtifactsWithFallback.mockReturnValue({ artifacts: [codeArtifact], cleanedContent: '' });
    const { result } = renderHook(() => useStreamingArtifactPersistence());

    act(() => {
      result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['r'] });
    });
    await waitFor(() => expect(persistArtifacts).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.reset();
      result.current.persistArtifactsFromQuest({ id: 'q1', sessionId: 's1', replies: ['r'] });
    });
    await waitFor(() => expect(persistArtifacts).toHaveBeenCalledTimes(2));
  });
});
