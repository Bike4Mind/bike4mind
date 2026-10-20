import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Guards the CLIENT half of the auto-offer lever. The server side of `skipAutoOffers` has been
 * live and tested since #2546, but no SPA call site ever set it - so a server-only test passed
 * for months while the feature was unreachable. These assertions fail if the field stops
 * reaching the request body, or starts riding `params` instead of the top level.
 */

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));

// The optimistic-cache wrappers just bracket the network call; run the callback straight through
// so the payload assertion sees the real post.
vi.mock('@client/app/utils/llm', () => ({
  createOptimisticQuest: (_qc: unknown, _sid: unknown, _prompt: unknown, cb: () => unknown) => cb(),
  updateOptimisticQuest: (_qc: unknown, _q: unknown, _s: unknown, _d: unknown, cb: () => unknown) => cb(),
  createOptimisticSessionId: () => 'tmp-session-1',
}));

import { handleLLMCommand } from './LLMCommand';
import { handleCommand } from '@client/app/utils/commands';
import { registerSurfaceChatContextProvider } from '@client/app/utils/surfaceChatContext';

type HandlerArgs = Parameters<typeof handleLLMCommand>[0];

const baseArgs = (): HandlerArgs =>
  ({
    params: 'hello world',
    currentSession: { id: 'session-1' },
    model: 'claude-sonnet-5',
    workBenchFiles: [],
    promptFileIds: [],
    queryClient: {},
    tools: [],
    userId: 'user-1',
    modelConfigurations: [],
    sendJsonMessage: vi.fn(),
  }) as unknown as HandlerArgs;

const llmRequestBody = () => {
  const call = post.mock.calls.find(c => c[0] === '/api/ai/llm');
  if (!call) throw new Error('no POST to /api/ai/llm was made');
  return call[1] as Record<string, unknown> & { params?: Record<string, unknown> };
};

describe('handleLLMCommand - skipAutoOffers on the wire', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  it('sends skipAutoOffers: true at the top level when the toggle is on', async () => {
    await handleLLMCommand({ ...baseArgs(), skipAutoOffers: true });

    expect(llmRequestBody().skipAutoOffers).toBe(true);
  });

  it('omits skipAutoOffers entirely when the toggle is off', async () => {
    await handleLLMCommand({ ...baseArgs(), skipAutoOffers: false });

    expect(llmRequestBody()).not.toHaveProperty('skipAutoOffers');
  });

  it('omits skipAutoOffers when the caller never sets it', async () => {
    await handleLLMCommand(baseArgs());

    expect(llmRequestBody()).not.toHaveProperty('skipAutoOffers');
  });

  // `params` is built by spreading the leftover args, so a field missing from the omit list
  // silently rides along inside it as well - which the server never reads.
  it('does not also nest skipAutoOffers inside params', async () => {
    await handleLLMCommand({ ...baseArgs(), skipAutoOffers: true });

    expect(llmRequestBody().params).not.toHaveProperty('skipAutoOffers');
  });
});

// Ordinary composer turns reach handleLLMCommand through the `/llm` entry of the command map,
// not the direct call, so a field missing from CommandArgExtra is dropped on the main path.
describe('handleCommand("/llm") - composer preferences on the wire', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  it('carries agentMode and researchMode to the top level of the request body', async () => {
    const agentMode = { enabled: true, source: 'toggle' as const };
    const researchMode = { enabled: true, configurations: [], syncScrolling: false, comparisonView: 'grid' as const };

    await handleCommand({ '/llm': handleLLMCommand }, {
      ...baseArgs(),
      command: '/llm',
      agentMode,
      researchMode,
    } as unknown as Parameters<typeof handleCommand>[1]);

    const body = llmRequestBody();
    expect(body.agentMode).toEqual(agentMode);
    expect(body.researchMode).toEqual(researchMode);
    expect(body.params).not.toHaveProperty('agentMode');
  });
});

// The `/new` composer's Agents panel only updates local `workBenchAgents`; those ids have to ride
// the first turn (the one that creates the session) or the selection is silently dropped. They are
// session-creation inputs, so they must be top-level and must NOT also nest inside `params`.
describe('handleLLMCommand - workbench agentIds on a new-session turn (GH #2600)', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  it('sends agentIds at the top level when there is no current session', async () => {
    await handleLLMCommand({ ...baseArgs(), currentSession: null, agentIds: ['a1'] });

    const body = llmRequestBody();
    expect(body.agentIds).toEqual(['a1']);
    expect(body.params).not.toHaveProperty('agentIds');
  });

  it('omits agentIds for an existing session (only applies on create)', async () => {
    await handleLLMCommand({ ...baseArgs(), currentSession: { id: 'session-1' }, agentIds: ['a1'] });

    expect(llmRequestBody()).not.toHaveProperty('agentIds');
  });

  it('omits an empty agentIds list rather than sending []', async () => {
    await handleLLMCommand({ ...baseArgs(), currentSession: null, agentIds: [] });

    expect(llmRequestBody()).not.toHaveProperty('agentIds');
  });

  it('carries agentIds through handleCommand("/llm") for a new session', async () => {
    await handleCommand({ '/llm': handleLLMCommand }, {
      ...baseArgs(),
      currentSession: null,
      command: '/llm',
      agentIds: ['a1', 'a2'],
    } as unknown as Parameters<typeof handleCommand>[1]);

    const body = llmRequestBody();
    expect(body.agentIds).toEqual(['a1', 'a2']);
    expect(body.params).not.toHaveProperty('agentIds');
  });
});

// A programmatic launch's per-send system context rides `extraContextMessages` as one more
// system message. It must never touch the user's message (that is the visible bubble) or
// leak into `params`, and a send without it must not gain an empty system message.
describe('handleLLMCommand - per-send systemContext', () => {
  const systemMessages = (body: Record<string, unknown>) =>
    ((body.extraContextMessages as Array<{ role: string; content: unknown }> | undefined) ?? []).filter(
      m => m.role === 'system'
    );

  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  it('appends systemContext as a system message in extraContextMessages', async () => {
    await handleLLMCommand({ ...baseArgs(), systemContext: 'Extra instructions for this send.' });

    const body = llmRequestBody();
    expect(systemMessages(body).at(-1)).toEqual({ role: 'system', content: 'Extra instructions for this send.' });
    expect(body.message).toBe('hello world');
    expect(body).not.toHaveProperty('systemContext');
    expect(body.params).not.toHaveProperty('systemContext');
  });

  it('carries systemContext through handleCommand("/llm")', async () => {
    await handleCommand({ '/llm': handleLLMCommand }, {
      ...baseArgs(),
      command: '/llm',
      systemContext: 'Extra instructions for this send.',
    } as unknown as Parameters<typeof handleCommand>[1]);

    const body = llmRequestBody();
    expect(systemMessages(body).map(m => m.content)).toContain('Extra instructions for this send.');
    expect(body.params).not.toHaveProperty('systemContext');
  });

  it('sends the same extraContextMessages as before when systemContext is absent', async () => {
    await handleLLMCommand(baseArgs());
    const without = llmRequestBody().extraContextMessages;

    post.mockClear();
    await handleLLMCommand({ ...baseArgs(), systemContext: 'Extra instructions for this send.' });
    const withIt = llmRequestBody().extraContextMessages as unknown[];

    expect(withIt.slice(0, -1)).toEqual((without as unknown[] | undefined) ?? []);
    expect(llmRequestBody().params).not.toHaveProperty('systemContext');
  });
});

// The view description and the surface brief change on every turn, so they are the two context
// messages flagged `perTurn`; the server moves only those into the user turn. Losing the flag puts
// them back in the system prompt, where a change busts the cached prefix for the whole conversation.
// `systemContext` is a caller's guidance, not per-turn data, and must stay in the system prompt.
describe('handleLLMCommand - per-turn context placement', () => {
  const messages = () => (llmRequestBody().extraContextMessages ?? []) as Array<Record<string, unknown>>;
  const viewMessage = () => messages().find(m => String(m.content).startsWith('[Current View Context]'));

  let unregister: (() => void) | undefined;

  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it('flags the view description', async () => {
    await handleLLMCommand(baseArgs());

    expect(viewMessage()).toEqual(expect.objectContaining({ perTurn: true }));
  });

  it('flags the surface brief', async () => {
    unregister = registerSurfaceChatContextProvider(() => ({ briefContext: 'ACTIVE BRIEF' }));

    await handleLLMCommand(baseArgs());

    expect(messages().find(m => m.content === 'ACTIVE BRIEF')).toEqual(expect.objectContaining({ perTurn: true }));
  });

  it('leaves the caller-supplied systemContext unflagged', async () => {
    unregister = registerSurfaceChatContextProvider(() => ({ briefContext: 'ACTIVE BRIEF' }));

    await handleLLMCommand({ ...baseArgs(), systemContext: 'Extra instructions for this send.' });

    expect(messages().find(m => m.content === 'Extra instructions for this send.')).not.toHaveProperty('perTurn');
  });
});
