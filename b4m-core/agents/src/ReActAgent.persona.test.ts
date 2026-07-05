/**
 * Tests for ReActAgent persona composition in getSystemPrompt().
 *
 * Validates the compose-vs-replace contract for Agent-mode persona injection:
 * `personaPrompt` is prepended IN FRONT of the operational prompt (default or
 * `systemPrompt` override) rather than replacing it, so a configured agent
 * speaks in character while keeping ReAct tool-use guidance. No persona means
 * behavior unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

function createMockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * LLM that records the system message of the first `complete()` call, then
 * returns a tool-less final answer so `run()` finishes in a single iteration.
 */
function createCapturingLlm(capture: { systemPrompt?: string }): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
    ) => {
      if (capture.systemPrompt === undefined) {
        const sys = messages.find(m => m.role === 'system');
        capture.systemPrompt = typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content);
      }
      await callback(['Done.'], { inputTokens: 1, outputTokens: 1, toolsUsed: [] });
    },
    pushToolMessages: vi.fn(),
  };
}

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'test-user',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: createMockLogger() as any,
    llm,
    model: 'test-model',
    tools: [],
    maxIterations: 2,
    ...overrides,
  };
}

async function captureSystemPrompt(overrides: Partial<AgentContext>): Promise<string> {
  const capture: { systemPrompt?: string } = {};
  const agent = new ReActAgent(createContext(createCapturingLlm(capture), overrides));
  await agent.run('hello');
  return capture.systemPrompt ?? '';
}

describe('ReActAgent getSystemPrompt() persona composition', () => {
  it('uses the default operational prompt when no persona or override is set', async () => {
    const prompt = await captureSystemPrompt({});
    expect(prompt).toContain('You are an autonomous AI agent with access to tools');
    expect(prompt).not.toContain('You are Nova');
  });

  it('prepends the persona in front of the default operational prompt', async () => {
    const persona = 'You are Nova, a stoic navigator.';
    const prompt = await captureSystemPrompt({ personaPrompt: persona });
    expect(prompt.startsWith(`${persona}\n\n`)).toBe(true);
    // Operational guidance is preserved below the persona, not replaced.
    expect(prompt).toContain('You are an autonomous AI agent with access to tools');
  });

  it('prepends the persona in front of a systemPrompt override (override replaces default, persona still leads)', async () => {
    const persona = 'You are Nova, a stoic navigator.';
    const override = 'CUSTOM OPERATIONAL PROMPT.';
    const prompt = await captureSystemPrompt({ personaPrompt: persona, systemPrompt: override });
    expect(prompt).toBe(`${persona}\n\n${override}`);
    expect(prompt).not.toContain('You are an autonomous AI agent with access to tools');
  });

  it('trims a whitespace-only persona to nothing (no stray prefix)', async () => {
    const prompt = await captureSystemPrompt({ personaPrompt: '   ' });
    expect(prompt).toContain('You are an autonomous AI agent with access to tools');
    expect(prompt.startsWith('\n\n')).toBe(false);
  });
});
