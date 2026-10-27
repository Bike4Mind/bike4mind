import { describe, it, expect, vi } from 'vitest';
import type { ILogger } from '@bike4mind/observability';
import { createHeadlessLlmBackendDeps } from './headlessOllama.js';

const { constructBackend } = vi.hoisted(() => ({
  constructBackend: vi.fn<(host: string, logger: ILogger) => void>(),
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const original = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return {
    ...original,
    OllamaBackend: class {
      constructor(host: string, logger: ILogger) {
        constructBackend(host, logger);
      }
    },
  };
});

describe('headless Ollama diagnostics', () => {
  it.each([false, true])('keeps every backend diagnostic off stdout (verbose: %s)', verbose => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const consoleLog = vi.spyOn(console, 'log');
    const deps = createHeadlessLlmBackendDeps(verbose);

    deps.createOllamaBackend('http://127.0.0.1:11434');
    expect(constructBackend).toHaveBeenCalledOnce();
    const [host, logger] = constructBackend.mock.calls[0];
    expect(host).toBe('http://127.0.0.1:11434');

    logger.info('answer already produced', { model: 'local' });
    logger.warn('warning');
    logger.error('error');
    logger.debug('debug');

    expect(stderr).toHaveBeenCalledWith('answer already produced {"model":"local"}\n');
    expect(stderr).toHaveBeenCalledWith('warning\n');
    expect(stderr).toHaveBeenCalledWith('error\n');
    expect(stderr).toHaveBeenCalledTimes(verbose ? 4 : 3);
    if (verbose) expect(stderr).toHaveBeenCalledWith('debug\n');
    expect(stdout).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('renders structured metadata, circular values and errors readably', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createHeadlessLlmBackendDeps(false).createOllamaBackend('http://127.0.0.1:11434');
    const logger = constructBackend.mock.lastCall![1];
    const circular: Record<string, unknown> = { model: 'local' };
    circular.self = circular;
    const failure = Object.assign(new Error('connect ECONNREFUSED'), { config: { headers: { Authorization: 'x' } } });

    logger.info('ending turn', { model: 'local', toolsExecuted: ['a', 'b'] }, 3);
    logger.warn('circular', circular);
    logger.error('failed:', failure);
    logger.error('nested', { cause: failure });

    expect(stderr).toHaveBeenCalledWith('ending turn {"model":"local","toolsExecuted":["a","b"]} 3\n');
    expect(stderr).toHaveBeenCalledWith('circular {"model":"local","self":"[Circular]"}\n');
    expect(stderr).toHaveBeenCalledWith('failed: Error: connect ECONNREFUSED\n');
    expect(stderr).toHaveBeenCalledWith('nested {"cause":"Error: connect ECONNREFUSED"}\n');
  });
});
