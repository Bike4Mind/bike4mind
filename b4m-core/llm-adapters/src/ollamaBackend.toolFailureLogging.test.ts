/**
 * The tool layer leaves the failure log to the adapter, so OllamaBackend must log a failed tool
 * itself: warn for an expected refusal, error for a real defect.
 * Must stay in sync with toolFailureLogLevel in executeToolsBatch.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { ExpectedToolError, type IMessage } from '@bike4mind/common';
import { OllamaBackend } from './ollamaBackend';

const TOOL_NAME = 'image_generation';

async function runFailingTool(error: Error) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const backend = new OllamaBackend('http://localhost:11434', logger as never);
  const replies = [
    { message: { content: '', tool_calls: [{ function: { name: TOOL_NAME, arguments: {} } }] } },
    { message: { content: 'done', tool_calls: [] } },
  ];
  let call = 0;
  const chat = vi.fn().mockImplementation(async () => ({
    prompt_eval_count: 5,
    eval_count: 2,
    ...replies[Math.min(call++, replies.length - 1)],
  }));
  (backend as unknown as { _api: unknown })._api = { chat };

  await backend.complete(
    'qwen2.5-coder:3b',
    [{ role: 'user', content: 'generate an image of a red bicycle' } as IMessage],
    {
      stream: false,
      tools: [
        {
          toolSchema: { name: TOOL_NAME, description: TOOL_NAME, parameters: { type: 'object' } },
          toolFn: async () => {
            throw error;
          },
        },
      ],
    },
    async () => undefined
  );
  return logger;
}

describe('Ollama tool failure logging', () => {
  it.each([
    { label: 'an expected refusal at warn', error: new ExpectedToolError('refused'), level: 'warn' as const },
    { label: 'an unexpected failure at error', error: new Error('boom'), level: 'error' as const },
  ])('logs $label', async ({ error, level }) => {
    const logger = await runFailingTool(error);
    const otherLevel = level === 'warn' ? 'error' : 'warn';

    expect(logger[level]).toHaveBeenCalledWith(
      '[Tool Execution] Tool failed',
      expect.objectContaining({ toolName: TOOL_NAME, error: error.message })
    );
    expect(logger[otherLevel]).not.toHaveBeenCalledWith('[Tool Execution] Tool failed', expect.anything());
  });
});
