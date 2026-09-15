/**
 * Runner mechanics tests using a scripted mock LLM.
 *
 * These tests cover the runner's orchestration responsibilities - sandbox
 * setup/cleanup, metric aggregation, error handling, suite-level summary.
 * They do NOT test that real tasks pass against real LLMs; that's the
 * job of the (deferred) production-backend entry point.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';
import { runEval, runEvalSuite } from './runner';
import type { EvalTask, EvalContext } from './types';

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Scripted LLM that emits a single text response and stops. */
function scriptedLlm(text: string, inputTokens = 100, outputTokens = 50): ICompletionBackend {
  return {
    currentModel: 'mock-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
    ) => {
      await callback([text], { inputTokens, outputTokens, toolsUsed: [] });
    },
    pushToolMessages: vi.fn(),
  };
}

/** LLM that throws on first call - simulates agent crash. */
function crashingLlm(): ICompletionBackend {
  return {
    currentModel: 'mock-model',
    getModelInfo: async () => [],
    complete: async () => {
      throw new Error('simulated provider failure');
    },
    pushToolMessages: vi.fn(),
  };
}

function makeContext(llm: ICompletionBackend, label = 'mock-model:default'): EvalContext {
  return {
    configLabel: label,
    agent: {
      userId: 'test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: silentLogger() as any,
      llm,
      model: 'mock-model',
      tools: [],
    },
  };
}

describe('runEval', () => {
  it('passes when check returns true and aggregates metrics', async () => {
    const task: EvalTask = {
      id: 'pass-task',
      description: 'always passes',
      prompt: 'do the thing',
      check: async result => ({
        passed: result.finalAnswer === 'expected output',
        reason: 'final answer matched',
      }),
    };

    const result = await runEval(task, makeContext(scriptedLlm('expected output', 80, 40)));

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('final answer matched');
    expect(result.metrics.totalTokens).toBe(120);
    expect(result.metrics.iterations).toBeGreaterThanOrEqual(1);
    expect(result.metrics.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('fails (passed=false, no error) when check returns false', async () => {
    const task: EvalTask = {
      id: 'fail-task',
      description: 'always fails',
      prompt: 'do the thing',
      check: async () => ({ passed: false, reason: 'never passes' }),
    };

    const result = await runEval(task, makeContext(scriptedLlm('whatever')));

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('never passes');
    expect(result.error).toBeUndefined();
  });

  it('returns error result (not throw) when the agent crashes', async () => {
    const task: EvalTask = {
      id: 'crash-task',
      description: 'agent crashes',
      prompt: 'do the thing',
      check: async () => ({ passed: true, reason: 'unreachable' }),
    };

    const result = await runEval(task, makeContext(crashingLlm()));

    expect(result.passed).toBe(false);
    expect(result.error).toContain('simulated provider failure');
    expect(result.metrics.totalTokens).toBe(0);
  });

  it('runs setup before the agent and cleans up sandbox afterward', async () => {
    let observedSandboxDir = '';
    const task: EvalTask = {
      id: 'sandbox-task',
      description: 'verifies sandbox lifecycle',
      prompt: sandboxDir => `process ${sandboxDir}`,
      setup: async sandboxDir => {
        observedSandboxDir = sandboxDir;
        await fs.writeFile(path.join(sandboxDir, 'fixture.txt'), 'fixture content', 'utf-8');
      },
      check: async (_result, sandboxDir) => {
        const fixture = await fs.readFile(path.join(sandboxDir, 'fixture.txt'), 'utf-8');
        return { passed: fixture === 'fixture content', reason: 'fixture survived to check' };
      },
    };

    const result = await runEval(task, makeContext(scriptedLlm('done')));

    expect(result.passed).toBe(true);
    expect(observedSandboxDir).toBeTruthy();
    expect(existsSync(observedSandboxDir)).toBe(false); // cleanup happened
  });

  it('passes the sandbox dir into the prompt function', async () => {
    let promptSeen = '';
    const task: EvalTask = {
      id: 'prompt-fn',
      description: 'prompt function receives sandbox',
      prompt: sandboxDir => {
        promptSeen = sandboxDir;
        return `work in ${sandboxDir}`;
      },
      check: async () => ({ passed: true, reason: 'ok' }),
    };

    await runEval(task, makeContext(scriptedLlm('done')));

    expect(promptSeen).toContain('b4m-eval-prompt-fn');
  });

  it('invokes toolFactory with the sandbox dir and uses returned tools', async () => {
    const factoryCalls: string[] = [];
    const dummyTool = {
      toolFn: vi.fn(async () => 'dummy result'),
      toolSchema: { name: 'dummy', description: 'dummy', parameters: { type: 'object', properties: {} } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const task: EvalTask = {
      id: 'tool-factory',
      description: 'tool factory invoked per-task',
      prompt: 'x',
      check: async () => ({ passed: true, reason: 'ok' }),
    };

    await runEval(task, makeContext(scriptedLlm('done')), async sandboxDir => {
      factoryCalls.push(sandboxDir);
      return [dummyTool];
    });

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]).toContain('b4m-eval-tool-factory');
  });

  it('cleans up sandbox even when the agent throws', async () => {
    let observedSandboxDir = '';
    const task: EvalTask = {
      id: 'crash-sandbox',
      description: 'sandbox cleanup on error',
      prompt: 'do the thing',
      setup: async sandboxDir => {
        observedSandboxDir = sandboxDir;
      },
      check: async () => ({ passed: true, reason: 'unreachable' }),
    };

    await runEval(task, makeContext(crashingLlm()));

    expect(observedSandboxDir).toBeTruthy();
    expect(existsSync(observedSandboxDir)).toBe(false);
  });
});

describe('runEvalSuite', () => {
  it('aggregates passed/failed/errored counts and totals', async () => {
    const passTask: EvalTask = {
      id: 'p',
      description: 'pass',
      prompt: 'x',
      check: async () => ({ passed: true, reason: 'ok' }),
    };
    const failTask: EvalTask = {
      id: 'f',
      description: 'fail',
      prompt: 'x',
      check: async () => ({ passed: false, reason: 'no' }),
    };
    const crashTask: EvalTask = {
      id: 'c',
      description: 'crash',
      prompt: 'x',
      check: async () => ({ passed: true, reason: 'unreachable' }),
    };

    // First two tasks run against scriptedLlm; third hits the crashingLlm.
    // We use a single context per call, so split into two suite runs and merge.
    const okReport = await runEvalSuite([passTask, failTask], makeContext(scriptedLlm('out', 100, 50)));
    expect(okReport.summary.passed).toBe(1);
    expect(okReport.summary.failed).toBe(1);
    expect(okReport.summary.errored).toBe(0);
    expect(okReport.summary.totalTokens).toBe(300); // 150 per task × 2

    const crashReport = await runEvalSuite([crashTask], makeContext(crashingLlm()));
    expect(crashReport.summary.errored).toBe(1);
    expect(crashReport.summary.passed).toBe(0);
  });

  it('attaches configLabel to every result', async () => {
    const task: EvalTask = {
      id: 't',
      description: 't',
      prompt: 'x',
      check: async () => ({ passed: true, reason: 'ok' }),
    };
    const ctx = makeContext(scriptedLlm('out'), 'sonnet-4.6:minimal-prompt');

    const report = await runEvalSuite([task, task], ctx);

    expect(report.configLabel).toBe('sonnet-4.6:minimal-prompt');
    expect(report.results.every(r => r.configLabel === 'sonnet-4.6:minimal-prompt')).toBe(true);
  });
});
