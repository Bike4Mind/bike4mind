import { describe, it, expect, afterEach } from 'vitest';
import { IsolatedVmExecutor } from './IsolatedVmExecutor';
import { ReplSession, _resetReplSessionsForTests } from './ReplSession';

/**
 * Quest 3c tests: `isolated-vm` V8-isolate backend.
 *
 * Two test groups:
 * 1. PARITY - the same behaviours WorkerReplExecutor.test.ts asserts, so the
 *    backends are interchangeable from a caller's perspective.
 * 2. SANDBOX - the adversarial-escape guarantees that justify this backend
 *    existing at all (a real trust boundary, not just resource isolation).
 */

describe('IsolatedVmExecutor', () => {
  const created: IsolatedVmExecutor[] = [];

  afterEach(async () => {
    for (const ex of created) {
      try {
        await Promise.resolve(ex.dispose());
      } catch {
        // already disposed
      }
    }
    created.length = 0;
    await _resetReplSessionsForTests();
  });

  function spawn(opts?: ConstructorParameters<typeof IsolatedVmExecutor>[0]): IsolatedVmExecutor {
    const ex = new IsolatedVmExecutor(opts);
    created.push(ex);
    return ex;
  }

  // --- Parity with the worker backend -------------------------------------

  it('runs a basic console.log and returns stdout', async () => {
    const ex = spawn();
    const r = await ex.runCode('console.log("hi from isolate");');
    expect(r.stdout).toBe('hi from isolate');
    expect(r.error).toBeNull();
  });

  it('persists variables across runCode calls (implicit global)', async () => {
    const ex = spawn();
    await ex.runCode('x = 7;');
    const r = await ex.runCode('console.log(x * 6);');
    expect(r.stdout).toBe('42');
    expect(ex.listGlobals()).toContain('x');
  });

  it('serializes thrown errors without disposing the isolate', async () => {
    const ex = spawn();
    const r1 = await ex.runCode('throw new Error("nope");');
    expect(r1.error).toContain('Error: nope');
    // Isolate still alive; can run more code
    const r2 = await ex.runCode('y = 99; console.log(y);');
    expect(r2.error).toBeNull();
    expect(r2.stdout).toBe('99');
  });

  it('serializes syntax errors instead of throwing out of runCode', async () => {
    const ex = spawn();
    const r = await ex.runCode('this is not valid javascript {{{');
    expect(r.error).toBeTruthy();
    // Isolate survives a compile failure
    const r2 = await ex.runCode('console.log("still alive");');
    expect(r2.stdout).toBe('still alive');
  });

  it('exposes registered tools as in-REPL async functions (positional args)', async () => {
    const ex = spawn();
    ex.setTools({
      add: async (...args: unknown[]) => {
        const [a, b] = args as [number, number];
        return a + b;
      },
      greet: async (...args: unknown[]) => {
        const [name] = args as [string];
        return `hello ${name}`;
      },
    });

    const r = await ex.runCode(`
      const sum = await add(3, 4);
      const greeting = await greet("world");
      console.log(sum + " | " + greeting);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('7 | hello world');
  });

  it('exposes tools that take a single object arg (wrapAgentToolsForRepl shape)', async () => {
    const ex = spawn();
    ex.setTools({
      search: async (...args: unknown[]) => {
        const params = args[0] as { query: string };
        return { hits: [params.query, params.query] };
      },
    });
    const r = await ex.runCode(`
      const out = await search({ query: "pricing" });
      console.log(JSON.stringify(out));
    `);
    expect(r.error).toBeNull();
    expect(JSON.parse(r.stdout)).toEqual({ hits: ['pricing', 'pricing'] });
  });

  it('a tool that throws surfaces as a catchable Error in the REPL', async () => {
    const ex = spawn();
    ex.setTools({
      brokenTool: async () => {
        throw new Error('host side failure');
      },
    });
    const r = await ex.runCode(`
      try {
        await brokenTool();
        console.log("no throw");
      } catch (e) {
        console.log("threw: " + e.message);
      }
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toContain('threw:');
    expect(r.stdout).toContain('host side failure');
  });

  it('tool args + return values round-trip across the JSON boundary', async () => {
    const ex = spawn();
    ex.setTools({
      echo: async (...args: unknown[]) => {
        return { received: args[0] };
      },
    });
    const r = await ex.runCode(`
      const out = await echo({ nums: [1, 2, 3], nested: { ok: true } });
      console.log(JSON.stringify(out));
    `);
    expect(r.error).toBeNull();
    expect(JSON.parse(r.stdout)).toEqual({ received: { nums: [1, 2, 3], nested: { ok: true } } });
  });

  it('tools registered later (after a runCode) are picked up', async () => {
    const ex = spawn();
    const r1 = await ex.runCode(`
      try { await missingTool(); console.log("no throw"); }
      catch (e) { console.log("first: " + e.name); }
    `);
    expect(r1.error).toBeNull();
    expect(r1.stdout).toContain('first: ReferenceError');

    ex.setTools({ missingTool: async () => 'now exists' });
    const r2 = await ex.runCode('console.log(await missingTool());');
    expect(r2.error).toBeNull();
    expect(r2.stdout).toBe('now exists');
  });

  it('setTools merges rather than replacing prior registrations', async () => {
    const ex = spawn();
    ex.setTools({ first: async () => 'a' });
    ex.setTools({ second: async () => 'b' });
    const r = await ex.runCode('console.log(await first(), await second());');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('a b');
  });

  it('a tool returning a non-JSON-serializable value fails with a clear, explicit error', async () => {
    const ex = spawn();
    ex.setTools({ bigintTool: async () => ({ count: 1n }) });
    const r = await ex.runCode(`
      try { await bigintTool(); console.log('no throw'); }
      catch (e) { console.log('threw: ' + e.message); }
    `);
    expect(r.error).toBeNull();
    // The failure is attributed to a non-serializable return, NOT a cryptic
    // "Do not know how to serialize a BigInt" masquerading as a tool throw.
    expect(r.stdout).toContain('threw:');
    expect(r.stdout).toContain('not JSON-serializable');
    expect(r.stdout).toContain('bigintTool');
  });

  it('setTools skips tool names that would shadow reserved in-isolate globals', async () => {
    const ex = spawn();
    // A tool named "console" must NOT clobber the in-isolate console capture.
    ex.setTools({ console: async () => 'hijacked', safeTool: async () => 'ok' });
    const r = await ex.runCode(`
      console.log('capture still works');
      console.log(await safeTool());
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('capture still works\nok');
    // The reserved name was skipped, so it isn't a user-defined global.
    expect(ex.listGlobals()).not.toContain('console');
    expect(ex.listGlobals()).toContain('safeTool');
  });

  it('setTools filters every reserved global name, not just console', async () => {
    const ex = spawn();
    const reserved = ['console', 'structuredClone', 'eval', 'Function', '__registerTools', '_callTool', '_captureLine'];
    const toolMap: Record<string, () => Promise<string>> = { legit: async () => 'ok' };
    for (const n of reserved) toolMap[n] = async () => 'HIJACKED';
    ex.setTools(toolMap);
    // none of the reserved names became a user-defined global; the legit tool did
    const globals = ex.listGlobals();
    for (const n of reserved) expect(globals).not.toContain(n);
    expect(globals).toContain('legit');
    // and the reserved in-isolate semantics are intact (console captures,
    // structuredClone clones, codegen still blocked) - not replaced by 'HIJACKED'
    const r = await ex.runCode(`
      console.log('cap-ok');
      console.log(JSON.stringify(structuredClone({ x: 1 })));
      console.log(await legit());
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('cap-ok\n{"x":1}\nok');
    expect((await ex.runCode('eval("1")')).error).toContain('disabled');
  });

  it('throws when runCode is called after dispose()', async () => {
    const ex = spawn();
    await ex.runCode('z = 1;');
    ex.dispose();
    await expect(ex.runCode('console.log(z);')).rejects.toThrow(/disposed/);
  });

  it('integrates with ReplSession when executor: "isolated" is requested', async () => {
    const session = new ReplSession({ sessionId: 'isolated-session-1', executor: 'isolated' });
    try {
      const r = await session.runCode('console.log("integrated");');
      expect(r.stdout).toBe('integrated');
      expect(r.error).toBeNull();
    } finally {
      await session.dispose();
    }
  });

  it('isolated session emits the same code:start / code:end events', async () => {
    const session = new ReplSession({ sessionId: 'isolated-session-2', executor: 'isolated' });
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

  it('exposes standard JS builtins + a structuredClone polyfill', async () => {
    const ex = spawn();
    const r = await ex.runCode(`
      const clone = structuredClone({ a: [1, 2], b: { c: 3 } });
      console.log(typeof JSON, typeof Math, parseInt("10"), JSON.stringify(clone));
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('object object 10 {"a":[1,2],"b":{"c":3}}');
  });

  it('structuredClone preserves Date / Map / Set / RegExp and handles cycles (not a lossy JSON round-trip)', async () => {
    const ex = spawn();
    const r = await ex.runCode(`
      const d = structuredClone(new Date(0));
      const m = structuredClone(new Map([['k', 1]]));
      const s = structuredClone(new Set([1, 2]));
      const re = structuredClone(/ab+c/gi);
      const cyc = {}; cyc.self = cyc;
      const clonedCyc = structuredClone(cyc);
      console.log(
        d instanceof Date, d.getTime(),
        m instanceof Map, m.get('k'),
        s instanceof Set, s.has(2),
        re instanceof RegExp, re.source, re.flags,
        clonedCyc.self === clonedCyc
      );
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('true 0 true 1 true true true ab+c gi true');
  });

  it('structuredClone preserves reference identity for a shared leaf appearing at multiple paths', async () => {
    const ex = spawn();
    const r = await ex.runCode(`
      const d = new Date(0);
      const ta = new Uint8Array([1, 2, 3]);
      const out = structuredClone({ a: d, b: d, x: ta, y: ta });
      // same source object at two paths -> one shared clone, like real structuredClone
      console.log(out.a === out.b, out.x === out.y, out.a !== d);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('true true true');
  });

  // --- Sandbox / adversarial escape ---------------------------------------

  it('does NOT expose process / require / fs inside the isolate', async () => {
    const ex = spawn();
    const r = await ex.runCode(`
      console.log(typeof process, typeof require, typeof globalThis.process, typeof module);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('undefined undefined undefined undefined');
  });

  it('disables eval and the Function constructor (string codegen)', async () => {
    const ex = spawn();
    const rEval = await ex.runCode('eval("1+1")');
    expect(rEval.error).toContain('disabled');
    const rFn = await ex.runCode('Function("return 1")()');
    expect(rFn.error).toContain('disabled');
  });

  it('blocks the constructor-chain escape to Function', async () => {
    const ex = spawn();
    // The classic vm-escape vector: reach Function via a literal's prototype
    // chain. Function is neutered, so this throws rather than returning a
    // live code-gen capability.
    const r = await ex.runCode('(function(){}).constructor("return typeof process")()');
    expect(r.error).toContain('disabled');
  });

  it('blocks the constructor-chain escape via Async/Generator/AsyncGenerator too', async () => {
    const ex = spawn();
    // The bootstrap neuters all four function-type intrinsics' prototype.constructor,
    // not just the plain Function - assert each escape vector is closed.
    const asyncR = await ex.runCode('(async function(){}).constructor("return 1")');
    expect(asyncR.error).toContain('disabled');
    const genR = await ex.runCode('(function*(){}).constructor("return 1")');
    expect(genR.error).toContain('disabled');
    const asyncGenR = await ex.runCode('(async function*(){}).constructor("return 1")');
    expect(asyncGenR.error).toContain('disabled');
  });

  it('does not leak host globals (no shared object graph)', async () => {
    const ex = spawn();
    // The host hooks are deleted from the isolate global after bootstrap.
    const r = await ex.runCode(`
      console.log(typeof _callTool, typeof _captureLine);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('undefined undefined');
  });

  it('interrupts a CPU-bound infinite loop via timeout, isolate stays usable', async () => {
    const ex = spawn({ timeoutMs: 250 });
    const r = await ex.runCode('while (true) {}');
    expect(r.error).toMatch(/timed out|timeout/i);
    // Isolate survives a timeout - next call works.
    const r2 = await ex.runCode('console.log("alive after timeout");');
    expect(r2.error).toBeNull();
    expect(r2.stdout).toBe('alive after timeout');
  });

  it('enforces the memory limit and marks itself disposed on breach', async () => {
    const ex = spawn({ memoryLimitMb: 16 });
    const r = await ex.runCode(`
      const blocks = [];
      while (true) { blocks.push(new Array(1_000_000).fill(7)); }
    `);
    expect(r.error).toBeTruthy();
    // After an OOM the isolate is gone; the executor fails fast on reuse.
    await expect(ex.runCode('console.log(1)')).rejects.toThrow(/disposed/);
  }, 20_000);
});
