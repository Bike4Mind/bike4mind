import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage, ThinkingVisibility } from '@bike4mind/common';

type Callback = (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>;

/** One turn: a tagged thinking block, inline reasoning, then the answer. */
/** A backend that returns reasoning separately never emits tagged frames. */
function reasoningLlm(answer: string, tagged = true): ICompletionBackend {
  return {
    currentModel: 'deepseek-reasoner',
    getModelInfo: async () => [],
    complete: async (_model: string, _messages: IMessage[], _options: Partial<ICompletionOptions>, cb: Callback) => {
      if (tagged) {
        await cb(['<think>'], { channel: 'reasoning' });
        await cb(['tagged trace'], { channel: 'reasoning' });
        await cb(['</think>'], { channel: 'reasoning' });
      }
      await cb([answer], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
    },
    pushToolMessages: vi.fn(),
  };
}

function buildAgent(
  thinkingVisibility?: ThinkingVisibility,
  model = 'deepseek-reasoner',
  answer = '<think>inline trace</think>The answer.',
  modelBackend?: string
) {
  const context: AgentContext = {
    userId: 'u1',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm: reasoningLlm(answer, !modelBackend),
    model,
    tools: [],
    maxIterations: 3,
    ...(modelBackend && { modelBackend }),
    ...(thinkingVisibility && { thinkingVisibility }),
  };
  const agent = new ReActAgent(context);
  const deltas: string[] = [];
  agent.on('text_delta', ({ delta }: { delta: string }) => deltas.push(delta));
  return { agent, deltas };
}

describe('ReActAgent thinking visibility', () => {
  it('keeps reasoning out of the deltas and final answer of a withheld run', async () => {
    const { agent, deltas } = buildAgent('none');
    const result = await agent.run('q');
    expect(deltas.join('')).toBe('The answer.');
    expect(result.finalAnswer).toBe('The answer.');
  });

  it('withholds on the runIteration path too', async () => {
    const { agent, deltas } = buildAgent('none');
    const result = await agent.runIteration('q');
    expect(deltas.join('')).toBe('The answer.');
    expect(deltas.join('')).not.toMatch(/trace/);
    expect(JSON.stringify(result)).toContain('The answer.');
    expect(JSON.stringify(result)).not.toMatch(/trace/);
  });

  it('keeps a GPT answer that mentions the marker literally', async () => {
    const { agent } = buildAgent('none', 'gpt-4o', 'Wrap it in <think> tags.', 'openai');
    const result = await agent.run('q');
    expect(result.finalAnswer).toBe('Wrap it in <think> tags.');
  });

  it('keeps a Claude answer that mentions the marker literally', async () => {
    const { agent } = buildAgent('none', 'claude-sonnet-4-5', 'Wrap it in <think> tags.');
    const result = await agent.run('q');
    expect(result.finalAnswer).toBe('Wrap it in <think> tags.');
  });

  it('leaves a raw run unchanged', async () => {
    const { agent, deltas } = buildAgent('raw');
    await agent.run('q');
    expect(deltas.join('')).toContain('<think>tagged trace</think>');
  });

  it('defaults to raw when no visibility is set', async () => {
    const { agent, deltas } = buildAgent();
    await agent.run('q');
    expect(deltas.join('')).toContain('inline trace');
  });
});
