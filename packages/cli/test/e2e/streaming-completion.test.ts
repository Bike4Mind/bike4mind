/**
 * E2E test: shared streaming-completion core through a real ReActAgent.
 *
 * The unit tests drive `runCompletion` and each transport in isolation. This is
 * the regression net the CLI epic (#182, line item 1) calls for on a refactor:
 * a REAL `ServerLlmBackend` (SSE transport -> runCompletion -> streamBridge)
 * driven by a REAL `ReActAgent`, so the whole path is exercised end to end - no
 * faux `complete()` shortcut. The SSE stream is faked with an in-memory
 * PassThrough (no network), one fresh stream per attempt so retries are real.
 *
 * Covers the two behaviors the refactor is about, at the agent level:
 *   - a transient mid-stream drop retries and delivers the turn EXACTLY once
 *     (no double-append), and
 *   - an empty completion surfaces as an error rather than a silent blank turn
 *     (the parity fix, now shared by both transports via runCompletion).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { ReActAgent } from '@bike4mind/agents';
import type { ApiClient } from '../../src/auth/ApiClient';
import { ServerLlmBackend } from '../../src/llm/ServerLlmBackend';

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/**
 * A ServerLlmBackend whose SSE requests are served by scripted in-memory
 * streams - one producer per attempt (the last repeats), so a retry gets a
 * fresh stream. Producers run on a macrotask so the transport's stream
 * listeners are attached before any data / error is emitted.
 */
function makeSseBackend(producers: Array<(stream: PassThrough) => void>): ServerLlmBackend {
  let attempt = 0;
  const apiClient = {
    getAxiosInstance: () => ({
      post: async () => {
        const stream = new PassThrough();
        const producer = producers[Math.min(attempt, producers.length - 1)];
        attempt++;
        setTimeout(() => producer(stream), 0);
        return { status: 200, statusText: 'OK', data: stream };
      },
    }),
  } as unknown as ApiClient;
  return new ServerLlmBackend({ apiClient, model: 'faux-model', completionsUrl: '/completions' });
}

function makeAgent(llm: ServerLlmBackend): ReActAgent {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new ReActAgent({
    userId: 'e2e-test-user',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    llm,
    model: 'faux-model',
    tools: [],
    maxIterations: 3,
    systemPrompt: 'You are a test assistant in an e2e harness.',
  });
}

describe('streaming completion (real ServerLlmBackend + real ReActAgent)', () => {
  it('delivers a normal SSE turn to the agent', async () => {
    const llm = makeSseBackend([
      stream => {
        stream.write(sse({ type: 'content', text: 'Hello from SSE' }));
        stream.write('data: [DONE]\n\n');
        stream.end();
      },
    ]);
    const result = await makeAgent(llm).run('hi', { parallelExecution: false });
    expect(result.finalAnswer).toBe('Hello from SSE');
  });

  it('retries a mid-stream drop and delivers the turn exactly once', async () => {
    const llm = makeSseBackend([
      // Attempt 1: partial content, then a transient socket error mid-stream.
      stream => {
        stream.write(sse({ type: 'content', text: 'partial' }));
        stream.emit('error', new Error('socket hang up'));
      },
      // Attempt 2 (retry): the full turn.
      stream => {
        stream.write(sse({ type: 'content', text: 'full answer' }));
        stream.write('data: [DONE]\n\n');
        stream.end();
      },
    ]);
    const result = await makeAgent(llm).run('hi', { parallelExecution: false });
    // Exactly-once: the discarded attempt's 'partial' must not be prepended.
    expect(result.finalAnswer).toBe('full answer');
  });

  it('surfaces an empty completion as an error instead of a blank turn', async () => {
    // Every attempt ends the stream with no content - the old WS path would have
    // silently delivered a blank turn; the shared core retries then surfaces.
    const llm = makeSseBackend([stream => stream.end()]);
    await expect(makeAgent(llm).run('hi', { parallelExecution: false })).rejects.toThrow(
      /without producing any content/i
    );
  });
});
