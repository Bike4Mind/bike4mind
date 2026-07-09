import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { IChatHistoryItemDocument } from '@bike4mind/common';

/**
 * useSubscribeToSessionQuests is the sole client-side arrival point for the
 * post-bubble persisted Quest on the agent path (see #335 spec). These tests
 * isolate its wiring to useStreamingArtifactPersistence: mock away
 * useSubscribeCollection (real websocket subscribe machinery, covered
 * elsewhere) and artifactPersistence/artifactParser (covered by
 * useStreamingArtifactPersistence.test.ts), then drive the captured
 * subscription callback directly as the websocket layer would.
 */

const capturedCallbacks: Array<(type: string, data: IChatHistoryItemDocument) => void> = [];
const updateAllQueryData = vi.fn();
const persistArtifacts = vi.fn(() => Promise.resolve());

vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: (...args: unknown[]) => updateAllQueryData(...args),
  useSubscribeCollection: (
    _collectionName: string,
    _query: unknown,
    callback: (type: string, data: IChatHistoryItemDocument) => void
  ) => {
    capturedCallbacks.push(callback);
  },
}));

// artifactParser/artifactPersistence are imported by useStreamingArtifactPersistence
// via RELATIVE specifiers ('../utils/...'), so mock them by a specifier that resolves to
// the same module (mirror the sibling useStreamingArtifactPersistence.test.ts). react-query
// stays aliased because sessions.ts imports it via the @client alias.
vi.mock('../../../utils/artifactPersistence', () => ({
  persistArtifacts: (...args: unknown[]) => persistArtifacts(...args),
}));

vi.mock('../../../utils/artifactParser', () => ({
  parseArtifactsWithFallback: (content: string) => {
    const matches = [...content.matchAll(/<artifact identifier="([^"]+)">([^<]*)<\/artifact>/g)];
    return {
      artifacts: matches.map(([, identifier, body]) => ({
        type: 'code',
        identifier,
        title: identifier,
        content: body,
        operation: 'create',
        language: 'text',
      })),
      cleanedContent: content,
    };
  },
  getArtifactTimestamp: () => 1000,
  generateCompleteArtifactId: (type: string, identifier: string, _ts: number, index: number) =>
    `${type}-${identifier}-${index}`,
  extractReactDependencies: () => [],
  checkHasDefaultExport: () => false,
}));

import { useSubscribeToSessionQuests } from '@client/app/hooks/data/sessions';

const questDoc = (overrides: Partial<IChatHistoryItemDocument>): IChatHistoryItemDocument =>
  ({
    id: 'q1',
    sessionId: 's1',
    replies: ['<artifact identifier="a1">hello</artifact>'],
    ...overrides,
  }) as IChatHistoryItemDocument;

const mount = (sessionId?: string, isStreaming?: boolean) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useSubscribeToSessionQuests(sessionId, isStreaming), { wrapper });
};

describe('useSubscribeToSessionQuests — agent artifact durable persistence', () => {
  beforeEach(() => {
    capturedCallbacks.length = 0;
    updateAllQueryData.mockClear();
    persistArtifacts.mockClear();
  });

  it('persists artifacts from a terminal agent quest (agentExecutionId set, status done)', async () => {
    mount('s1');
    const callback = capturedCallbacks[0];

    callback('write', questDoc({ agentExecutionId: 'e1', status: 'done' }));

    await vi.waitFor(() => expect(persistArtifacts).toHaveBeenCalledTimes(1));
    const [artifactsArg, sessionArg] = persistArtifacts.mock.calls[0];
    expect(sessionArg).toBe('s1');
    expect(artifactsArg).toEqual([expect.objectContaining({ id: 'code-a1-0', title: 'a1', content: 'hello' })]);
  });

  it('does not persist a chat quest (no agentExecutionId)', () => {
    mount('s1');
    const callback = capturedCallbacks[0];

    callback('write', questDoc({ status: 'done' }));

    expect(persistArtifacts).not.toHaveBeenCalled();
  });

  it('does not persist an agent quest that is still running', () => {
    mount('s1');
    const callback = capturedCallbacks[0];

    callback('write', questDoc({ agentExecutionId: 'e1', status: 'running' }));

    expect(persistArtifacts).not.toHaveBeenCalled();
  });

  it('persists the same terminal agent quest exactly once despite repeated change-stream writes', async () => {
    mount('s1');
    const callback = capturedCallbacks[0];

    const doc = questDoc({ agentExecutionId: 'e1', status: 'done' });
    callback('write', doc);
    callback('write', doc);

    await vi.waitFor(() => expect(persistArtifacts).toHaveBeenCalledTimes(1));
  });

  it('still updates the react-query cache for agent quests (existing behavior preserved)', () => {
    mount('s1');
    const callback = capturedCallbacks[0];

    const doc = questDoc({ agentExecutionId: 'e1', status: 'done' });
    callback('write', doc);

    expect(updateAllQueryData).toHaveBeenCalledWith(
      expect.anything(),
      'quests',
      'write',
      doc,
      expect.objectContaining({ keysAllowedToCreate: [['quests', 'session', 's1']] })
    );
  });
});
