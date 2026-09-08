import { describe, it, expect, afterEach } from 'vitest';
import { WorkerReplExecutor } from './WorkerReplExecutor';
import { ReplSandboxRetiredError } from './replExecutor';
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
    // The TYPE, not the message - see the matching test in
    // IsolatedVmExecutor.test.ts. `code_execute` branches on this class to
    // tell the agent the sandbox is gone rather than that a step failed.
    await expect(w.runCode('console.log(z);')).rejects.toThrow(ReplSandboxRetiredError);
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

describe('WorkerReplExecutor - the main thread enforces its own deadline', () => {
  /** Long enough for the worker's mirrored stdout to reach the main thread. */
  const MIRROR_SETTLE_MS = 300;
  const settle = () => new Promise(r => setTimeout(r, MIRROR_SETTLE_MS));

  /**
   * Reach past the public surface on purpose. A real `'error'`/`'exit'` event
   * cannot be provoked from guest code - the run is wrapped in try/catch
   * inside the worker, and an OOM via `resourceLimits` is slow and flaky
   * under parallel test load. What these two paths must guarantee is the
   * protocol, not the provocation: retirement RESOLVES with the flag and the
   * mirrored stdout, and never throws.
   */
  type CrashSeams = {
    handleWorkerError: (e: Error) => void;
    handleWorkerExit: (code: number) => void;
  };
  const seams = (ex: WorkerReplExecutor) => ex as unknown as CrashSeams;

  it('does not wait forever on a busy loop that starts after an await', async () => {
    // The worker's inner vm timeout only bounds the synchronous head of the
    // run, so this continuation never lets the worker post a runResult. Before
    // the main-thread deadline existed, this call never returned.
    const ex = new WorkerReplExecutor({ timeoutMs: 400 });
    const t0 = Date.now();
    // Terminal, and reported on the breaching run itself: this path terminates
    // the worker, so this is the last run the executor can serve. A flag
    // rather than a throw because a throw carries no stdout - see below.
    const r = await ex.runCode('await 0; while (true) {}');
    expect(r.sandboxRetired).toBe(true);
    expect(r.error).toMatch(/exceeded the 400ms cap/);
    expect(Date.now() - t0).toBeLessThan(5000);
    await ex.dispose();
  }, 20_000);

  it('does not wait forever on a run that is merely pending', async () => {
    const ex = new WorkerReplExecutor({ timeoutMs: 400 });
    const t0 = Date.now();
    const r = await ex.runCode('await new Promise(() => {});');
    expect(r.sandboxRetired).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    // A call arriving AFTER retirement still throws - there is no run, so
    // there is no stdout to preserve. Asserted on the error TYPE, not just a
    // word in the message: a plain Error satisfies /disposed|terminated/ too,
    // so the old regex could not tell the typed signal from an ordinary
    // failure and would have passed if this producer regressed.
    await expect(ex.runCode('console.log(1)')).rejects.toThrow(ReplSandboxRetiredError);
    expect(Date.now() - t0).toBeLessThan(5000);
    await ex.dispose();
  }, 20_000);

  it('refuses a run on an executor disposed before it was ever called', async () => {
    const ex = new WorkerReplExecutor({ timeoutMs: 400 });
    await ex.dispose();
    await expect(ex.runCode('console.log(1)')).rejects.toThrow(ReplSandboxRetiredError);
  }, 20_000);

  it('keeps the stdout a run printed before the deadline killed the worker', async () => {
    // The whole reason retirement is a flagged result and not a throw: output
    // captured before the sandbox died is the agent's best material for the
    // answer it now has to give without a REPL.
    const ex = new WorkerReplExecutor({ timeoutMs: 500 });
    const r = await ex.runCode('console.log("marker-before-hang"); await new Promise(() => {});');
    expect(r.sandboxRetired).toBe(true);
    expect(r.stdout).toContain('marker-before-hang');
    await ex.dispose();
  }, 20_000);

  it('retires an in-flight run when dispose() races it, keeping stdout', async () => {
    const ex = new WorkerReplExecutor({ timeoutMs: 10_000 });
    await ex.runCode('console.log("warm")');
    const inflight = ex.runCode('console.log("marker-before-dispose"); await new Promise(() => {});');
    await settle();
    await ex.dispose();
    const r = await inflight;
    expect(r.sandboxRetired).toBe(true);
    expect(r.stdout).toContain('marker-before-dispose');
    expect(r.error).toMatch(/disposed before runCode/);
  }, 20_000);

  it('retires an in-flight run when the worker emits an error event', async () => {
    const ex = new WorkerReplExecutor({ timeoutMs: 10_000 });
    await ex.runCode('console.log("warm")');
    const inflight = ex.runCode('console.log("marker-before-crash"); await new Promise(() => {});');
    await settle();
    seams(ex).handleWorkerError(new Error('boom'));
    const r = await inflight;
    expect(r.sandboxRetired).toBe(true);
    expect(r.stdout).toContain('marker-before-crash');
    expect(r.error).toMatch(/worker crashed: boom/);
    await ex.dispose();
  }, 20_000);

  it('retires an in-flight run when the worker exits non-zero (memory limit)', async () => {
    const ex = new WorkerReplExecutor({ timeoutMs: 10_000 });
    await ex.runCode('console.log("warm")');
    const inflight = ex.runCode('console.log("marker-before-exit"); await new Promise(() => {});');
    await settle();
    seams(ex).handleWorkerExit(137);
    const r = await inflight;
    expect(r.sandboxRetired).toBe(true);
    expect(r.stdout).toContain('marker-before-exit');
    expect(r.error).toMatch(/exited unexpectedly with code 137/);
    await ex.dispose();
  }, 20_000);

  it('leaves a normal run untouched (the deadline is not a latency tax)', async () => {
    const ex = new WorkerReplExecutor({ timeoutMs: 5000 });
    const r = await ex.runCode('await 0; console.log("done");');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('done');
    expect(r.sandboxRetired).toBeUndefined();
    await ex.dispose();
  }, 20_000);
});
