/**
 * Regression tests for abort/cancellation log severity.
 *
 * Aborts (user stop, client disconnect, execution timeout) are benign and must
 * be logged at WARN, not ERROR. Error-severity logs trip the CloudWatch
 * ERROR->LiveOps/Slack alert pipeline and page on routine cancellations. Genuine
 * failures must still log at ERROR so they stay visible to triage.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';

function createMockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createThrowingLlm(error: Error): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async () => {
      throw error;
    },
    pushToolMessages: vi.fn(),
  };
}

function createContext(logger: ReturnType<typeof createMockLogger>, llm: ICompletionBackend): AgentContext {
  return { userId: 'u1', logger, llm, model: 'test-model', tools: [], maxIterations: 5 };
}

describe('ReActAgent abort log severity (#8947, #8669)', () => {
  it('logs an abort error at warn — never error — and still rethrows', async () => {
    const logger = createMockLogger();
    const agent = new ReActAgent(createContext(logger, createThrowingLlm(new Error('Request aborted'))));
    agent.on('error', () => {}); // EventEmitter rethrows an 'error' event with no listener

    await expect(agent.run('hi')).rejects.toThrow(/aborted/i);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('aborted'), expect.anything());
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an AbortError (by name) at warn', async () => {
    const logger = createMockLogger();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const agent = new ReActAgent(createContext(logger, createThrowingLlm(abort)));
    agent.on('error', () => {});

    await expect(agent.run('hi')).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs the shared retry helper's bare Error('Aborted') (capital A) at warn", async () => {
    // retry.ts throws `new Error('Aborted')` on abort - name 'Error', capital A.
    // The detector must compare case-insensitively or this would page as a failure.
    const logger = createMockLogger();
    const agent = new ReActAgent(createContext(logger, createThrowingLlm(new Error('Aborted'))));
    agent.on('error', () => {});

    await expect(agent.run('hi')).rejects.toThrow(/Aborted/);

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a genuine failure at error', async () => {
    const logger = createMockLogger();
    const agent = new ReActAgent(createContext(logger, createThrowingLlm(new Error('Kaboom: real failure'))));
    agent.on('error', () => {});

    await expect(agent.run('hi')).rejects.toThrow(/Kaboom/);

    expect(logger.error).toHaveBeenCalled();
  });
});
