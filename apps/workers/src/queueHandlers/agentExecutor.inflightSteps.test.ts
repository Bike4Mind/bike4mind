import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { createInflightStepPersister } from './agentExecutor.inflightSteps';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const deferred = () => {
  let resolve: () => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeDeps = () => ({
  executionId: 'exec-1',
  persistSteps: vi.fn<(executionId: string, steps: string[]) => Promise<unknown>>().mockResolvedValue(undefined),
  logger: { warn: vi.fn() },
  emitMetric: vi
    .fn<(namespace: string, metricName: string, value: number) => Promise<void>>()
    .mockResolvedValue(undefined),
});

/** Starts `drain()` and reports whether it has resolved, so a test can pin that it is still waiting. */
const watchDrain = (drain: () => Promise<void>) => {
  const state = { settled: false };
  const done = drain().then(() => {
    state.settled = true;
  });
  return { state, done };
};

describe('createInflightStepPersister', () => {
  it('starts the write without waiting for it', () => {
    const deps = makeDeps();
    deps.persistSteps.mockReturnValue(new Promise(() => {}));
    const persister = createInflightStepPersister(deps);

    persister.persist(['step-1']);

    expect(deps.persistSteps).toHaveBeenCalledWith('exec-1', ['step-1']);
  });

  it('drain waits for a write that is still in flight', async () => {
    const deps = makeDeps();
    const write = deferred();
    deps.persistSteps.mockReturnValue(write.promise);
    const persister = createInflightStepPersister(deps);

    persister.persist(['step-1']);
    const { state, done } = watchDrain(() => persister.drain());
    await flush();
    expect(state.settled).toBe(false);

    write.resolve();
    await done;
    expect(deps.emitMetric).not.toHaveBeenCalled();
  });

  // The Lambda freezes once the handler returns, so a failure metric still in flight would be
  // lost or sent on a later thaw with an expired SigV4 signature.
  it('drain waits for the failure metric of a failed write, not just the write', async () => {
    const deps = makeDeps();
    deps.persistSteps.mockRejectedValue(new Error('db down'));
    const emit = deferred();
    deps.emitMetric.mockReturnValue(emit.promise);
    const persister = createInflightStepPersister(deps);

    persister.persist(['step-1']);
    const { state, done } = watchDrain(() => persister.drain());
    await flush();
    expect(deps.emitMetric).toHaveBeenCalledWith('Lumina5/AgentExecutor', 'InflightStepsPersistFailed', 1);
    expect(state.settled).toBe(false);

    emit.resolve();
    await done;
    expect(deps.logger.warn).toHaveBeenCalledWith('[Stream] Failed to persist in-flight steps', {
      executionId: 'exec-1',
      error: 'db down',
    });
  });

  it('drain resolves at once when nothing is in flight', async () => {
    const persister = createInflightStepPersister(makeDeps());
    persister.persist(['step-1']);
    await flush();
    await expect(persister.drain()).resolves.toBeUndefined();
  });
});

// processExecution has no harness, so the drain is pinned against the source, the way
// agentExecutor.toolDepsWiring.test.ts pins the toolDeps wiring.
describe('processExecution in-flight step wiring', () => {
  const source = readFileSync(join(__dirname, 'agentExecutor.ts'), 'utf8');
  const start = source.indexOf('async function processExecution(');
  // The next column-zero banner comment ends the function body.
  const end = source.indexOf('\n// ---', start);
  const processExecution = source.slice(start, end);

  it('persists in-flight steps through the persister, not a bare fire-and-forget write', () => {
    expect(processExecution).toContain('inflightSteps.persist(agent.getSteps());');
    expect(processExecution).not.toContain('void agentExecutionRepository.updateInflightSteps(');
  });

  it('drains the persister in a finally, so every return path waits for pending writes', () => {
    expect(processExecution).toMatch(/\} finally \{\n\s+await inflightSteps\.drain\(\);\n\s+\}\n\}\n*$/);
  });
});
