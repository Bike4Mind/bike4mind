import { describe, it, expect, vi } from 'vitest';
import type { ReActAgent } from '@bike4mind/agents';
import type { IMessage } from '@bike4mind/common';
import { createReactiveCompactionHandler } from './reactiveCompaction.js';
import type { Session } from '../storage/types.js';

function createSession(): Session {
  return {
    id: 'test-session-id',
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'claude-sonnet',
    messages: [],
    metadata: {
      totalTokens: 1000,
      totalCost: 0.01,
      toolCallCount: 5,
    },
  };
}

function fakeAgent(summary: string): ReActAgent {
  return { completeText: vi.fn(async () => summary) } as unknown as ReActAgent;
}

/** Build a working history with `iterationCount` ReAct iterations after a 3-message protected prefix. */
function buildWorkingHistory(iterationCount: number): IMessage[] {
  const messages: IMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'previous turn message' },
    { role: 'user', content: 'current query' },
  ];
  for (let i = 0; i < iterationCount; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'ping', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'pong' }] });
    messages.push({ role: 'user', content: 'Based on the tool results above, please provide a complete answer.' });
  }
  return messages;
}

const INITIAL_MESSAGE_COUNT = 3;

describe('createReactiveCompactionHandler', () => {
  it('summarizes older iterations and preserves the protected prefix + recent tail', async () => {
    const messages = buildWorkingHistory(3);
    const agent = fakeAgent('summary of earlier turns');
    const handler = createReactiveCompactionHandler(agent, createSession(), INITIAL_MESSAGE_COUNT);

    const result = await handler(messages);

    expect(result).not.toBeNull();
    expect(agent.completeText).toHaveBeenCalledTimes(1);
    // Protected prefix is untouched.
    expect(result![0]).toEqual(messages[0]);
    expect(result![1]).toEqual(messages[1]);
    expect(result![2]).toEqual(messages[2]);
    // Strictly smaller than the original.
    expect(result!.length).toBeLessThan(messages.length);
    // The summary text made it into the replacement history.
    const flattened = JSON.stringify(result);
    expect(flattened).toContain('summary of earlier turns');
    // The most recent iteration's tool_use/tool_result pair survives verbatim (not flattened).
    const lastToolUse = messages[messages.length - 3];
    expect(result).toContainEqual(lastToolUse);
  });

  it('returns null when there is nothing older than the preserved recent iterations', async () => {
    // Only 2 iterations total - nothing left to summarize once the last 2 are preserved.
    const messages = buildWorkingHistory(2);
    const agent = fakeAgent('should not be used');
    const handler = createReactiveCompactionHandler(agent, createSession(), INITIAL_MESSAGE_COUNT);

    const result = await handler(messages);

    expect(result).toBeNull();
    expect(agent.completeText).not.toHaveBeenCalled();
  });

  it('returns null when the summarizer produces empty text', async () => {
    const messages = buildWorkingHistory(3);
    const agent = fakeAgent('   ');
    const handler = createReactiveCompactionHandler(agent, createSession(), INITIAL_MESSAGE_COUNT);

    const result = await handler(messages);

    expect(result).toBeNull();
  });
});
