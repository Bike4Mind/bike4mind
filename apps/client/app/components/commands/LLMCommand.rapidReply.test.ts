import { describe, it, expect, vi, beforeEach } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));

vi.mock('@client/app/utils/llm', () => ({
  createOptimisticQuest: (_qc: unknown, _sid: unknown, _prompt: unknown, cb: () => unknown) => cb(),
  updateOptimisticQuest: (_qc: unknown, _q: unknown, _s: unknown, _d: unknown, cb: () => unknown) => cb(),
  createOptimisticSessionId: () => 'tmp-session-1',
}));

import { handleLLMCommand } from './LLMCommand';
import { blankRapidReplies } from '@client/app/hooks/chatCompletionState';

type HandlerArgs = Parameters<typeof handleLLMCommand>[0];

// A workbench file forces the rapid-reply request regardless of prompt complexity.
const args = (currentSession: { id: string } | null): HandlerArgs =>
  ({
    params: 'hello world',
    currentSession,
    model: 'claude-sonnet-5',
    workBenchFiles: [{ id: 'file-1', fileName: 'a.txt' }],
    promptFileIds: [],
    queryClient: {},
    tools: [],
    userId: 'user-1',
    modelConfigurations: [],
    sendJsonMessage: vi.fn(),
  }) as unknown as HandlerArgs;

describe('handleLLMCommand - id-less rapid-reply registration', () => {
  let settleRapidReply: () => void;

  beforeEach(() => {
    while (blankRapidReplies.claim());
    post.mockReset();
    post.mockImplementation((url: string) =>
      url === '/api/ai/rapid-reply'
        ? new Promise(resolve => {
            settleRapidReply = () => resolve({ data: { success: true } });
          })
        : Promise.resolve({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } })
    );
  });

  it('registers a first send with no session until its rapid-reply request settles', async () => {
    await handleLLMCommand(args(null));
    expect(post.mock.calls.some(([url]) => url === '/api/ai/rapid-reply')).toBe(true);

    settleRapidReply();
    await Promise.resolve();
    await Promise.resolve();
    expect(blankRapidReplies.claim()).toBe(false);
  });

  it('lets the id-less ack claim the registration while the request is in flight', async () => {
    await handleLLMCommand(args(null));
    expect(blankRapidReplies.claim()).toBe(true);
    settleRapidReply();
  });

  it('does not register a send whose ack will carry the session id', async () => {
    await handleLLMCommand(args({ id: 'session-1' }));
    expect(blankRapidReplies.claim()).toBe(false);
    settleRapidReply();
  });
});

describe('handleLLMCommand - skipRapidReply', () => {
  const optiArgs = (skipRapidReply?: boolean): HandlerArgs =>
    ({
      ...args(null),
      workBenchFiles: [],
      currentSession: { id: 'session-1', surface: 'opti' },
      skipRapidReply,
    }) as HandlerArgs;
  const firedRapidReply = () => post.mock.calls.some(([url]) => url === '/api/ai/rapid-reply');

  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { success: true, quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  it('acks an ordinary opti-surface send', async () => {
    await handleLLMCommand(optiArgs());
    expect(firedRapidReply()).toBe(true);
  });

  it('skips the ack for a tool-directed send, even on the opti surface', async () => {
    await handleLLMCommand(optiArgs(true));
    expect(firedRapidReply()).toBe(false);
  });

  it('keeps the flag out of the request params', async () => {
    await handleLLMCommand(optiArgs(true));
    const llmCall = post.mock.calls.find(([url]) => url !== '/api/ai/rapid-reply');
    expect(JSON.stringify(llmCall?.[1] ?? {})).not.toContain('skipRapidReply');
  });
});
