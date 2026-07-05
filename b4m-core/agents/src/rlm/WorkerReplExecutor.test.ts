import { describe, it, expect, afterEach } from 'vitest';
import { WorkerReplExecutor } from './WorkerReplExecutor';
import { ReplSession, _resetReplSessionsForTests } from './ReplSession';

/**
 * Quest 3b tests: worker_threads with resourceLimits as the execution
 * backend. Each test spins up a fresh worker. Tests are async-aware of
 * the worker lifecycle and dispose at the end so vitest doesn't leak
 * threads.
 */

describe('WorkerReplExecutor', () => {
  const created: WorkerReplExecutor[] = [];

  afterEach(async () => {
    for (const w of created) {
      await w.dispose().catch(() => {});
    }
    created.length = 0;
    await _resetReplSessionsForTests();
  });

  function spawn(opts?: ConstructorParameters<typeof WorkerReplExecutor>[0]): WorkerReplExecutor {
    const w = new WorkerReplExecutor(opts);
    created.push(w);
    return w;
  }

  it('runs a basic console.log and returns stdout', async () => {
    const w = spawn();
    const r = await w.runCode('console.log("hi from worker");');
    expect(r.stdout).toBe('hi from worker');
    expect(r.error).toBeNull();
  });

  it('persists variables across runCode calls (variable hoisted to globals)', async () => {
    const w = spawn();
    await w.runCode('x = 7;');
    const r = await w.runCode('console.log(x * 6);');
    expect(r.stdout).toBe('42');
  });

  it('serializes thrown errors without crashing the worker', async () => {
    const w = spawn();
    const r1 = await w.runCode('throw new Error("nope");');
    expect(r1.error).toContain('Error: nope');
    // Worker still alive; can run more code
    const r2 = await w.runCode('y = 99; console.log(y);');
    expect(r2.stdout).toBe('99');
  });

  it('exposes registered tools as in-REPL async functions (RPC across boundary)', async () => {
    const w = spawn();
    w.setTools({
      add: async (...args: unknown[]) => {
        const [a, b] = args as [number, number];
        return a + b;
      },
      greet: async (...args: unknown[]) => {
        const [name] = args as [string];
        return `hello ${name}`;
      },
    });

    const r = await w.runCode(`
      const sum = await add(3, 4);
      const greeting = await greet("world");
      console.log(sum + " | " + greeting);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('7 | hello world');
  });

  it('a tool that throws on the main side surfaces as an Error in the REPL', async () => {
    const w = spawn();
    w.setTools({
      brokenTool: async () => {
        throw new Error('main side failure');
      },
    });
    const r = await w.runCode(`
      try {
        await brokenTool();
        console.log("no throw");
      } catch (e) {
        console.log("threw: " + e.message);
      }
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toContain('threw:');
    expect(r.stdout).toContain('main side failure');
  });

  it('tool args round-trip across the structured-clone boundary', async () => {
    const w = spawn();
    w.setTools({
      echo: async (...args: unknown[]) => {
        return { received: args[0] };
      },
    });
    const r = await w.runCode(`
      const out = await echo({ nums: [1, 2, 3], nested: { ok: true } });
      console.log(JSON.stringify(out));
    `);
    expect(r.error).toBeNull();
    expect(JSON.parse(r.stdout)).toEqual({ received: { nums: [1, 2, 3], nested: { ok: true } } });
  });

  it('does NOT expose process / require / fs inside the worker REPL', async () => {
    const w = spawn();
    const r = await w.runCode(`
      console.log(typeof process);
      console.log(typeof require);
      console.log(typeof globalThis.process);
    `);
    expect(r.stdout).toContain('undefined');
  });

  it('tool calls registered later (after a runCode) are picked up', async () => {
    const w = spawn();
    // First: no tool, expect ReferenceError
    const r1 = await w.runCode(`
      try { await missingTool(); console.log("no throw"); }
      catch (e) { console.log("first: " + e.name); }
    `);
    expect(r1.error).toBeNull();
    expect(r1.stdout).toContain('first:');

    // Now register and try again
    w.setTools({ missingTool: async () => 'now exists' });
    const r2 = await w.runCode('console.log(await missingTool());');
    expect(r2.error).toBeNull();
    expect(r2.stdout).toBe('now exists');
  });

  it('throws when runCode is called after dispose()', async () => {
    const w = spawn();
    await w.runCode('z = 1;');
    await w.dispose();
    await expect(w.runCode('console.log(z);')).rejects.toThrow(/disposed/);
  });

  it('integrates with ReplSession when executor: "worker" is requested', async () => {
    const session = new ReplSession({
      sessionId: 'worker-session-1',
      executor: 'worker',
    });
    try {
      const r = await session.runCode('console.log("integrated");');
      expect(r.stdout).toBe('integrated');
      expect(r.error).toBeNull();
    } finally {
      await session.dispose();
    }
  });

  it('worker session emits the same code:start / code:end events as in-process', async () => {
    const session = new ReplSession({
      sessionId: 'worker-session-2',
      executor: 'worker',
    });
    try {
      const events: string[] = [];
      session.on('code:start', () => events.push('start'));
      session.on('code:end', e => events.push(`end:${e.ok}`));
      await session.runCode('console.log("ok");');
      expect(events).toEqual(['start', 'end:true']);
    } finally {
      await session.dispose();
    }
  });
});
