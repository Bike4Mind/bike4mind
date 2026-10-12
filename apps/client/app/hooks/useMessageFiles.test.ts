import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

const state = vi.hoisted(() => ({
  sessionFiles: [] as { id: string }[],
  workBench: [] as { id: string }[],
  system: [] as { id: string }[],
  currentSession: null as { id: string; knowledgeIds?: string[] } | null,
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFilesBySessionId: () => ({ data: state.sessionFiles }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: state.currentSession }),
  useWorkBenchFiles: () => state.workBench,
  useSystemPromptFiles: () => ({ systemFiles: state.system }),
}));

import { useMessageFiles } from './useMessageFiles';

const SID = 'session-1';
const messageFileIds = (sessionId: string = SID) =>
  renderHook(() => useMessageFiles(sessionId)).result.current.map((f: IFabFileDocument) => f.id);

describe('useMessageFiles', () => {
  beforeEach(() => {
    state.sessionFiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    state.workBench = [];
    state.system = [];
    state.currentSession = null;
  });

  it('excludes a pinned file that has not reached the workbench yet', () => {
    state.currentSession = { id: SID, knowledgeIds: ['a'] };
    expect(messageFileIds()).toEqual(['b', 'c', 'd']);
  });

  it('keeps a file attached only via messages', () => {
    state.currentSession = { id: SID, knowledgeIds: ['a'] };
    expect(messageFileIds()).toContain('d');
  });

  it('still excludes workbench and system files', () => {
    state.workBench = [{ id: 'b' }];
    state.system = [{ id: 'c' }];
    expect(messageFileIds()).toEqual(['a', 'd']);
  });

  it('ignores knowledgeIds of a different current session', () => {
    state.currentSession = { id: 'other', knowledgeIds: ['a'] };
    expect(messageFileIds()).toEqual(['a', 'b', 'c', 'd']);
  });
});
