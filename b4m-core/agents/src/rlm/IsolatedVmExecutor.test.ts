import { describe, it, expect, afterEach, vi } from 'vitest';
import { IsolatedVmExecutor, TOOL_CALL_TIMEOUT_FRACTION } from './IsolatedVmExecutor';
import { ReplSandboxRetiredError } from './replExecutor';
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
    // The TYPE, not just the message: `code_execute` branches on
    // `instanceof ReplSandboxRetiredError` to tell the agent the sandbox is
    // gone rather than that a step failed, and a plain Error whose message
    // happens to contain "disposed" satisfies a regex while breaking that.
    await expect(ex.runCode('console.log(z);')).rejects.toThrow(ReplSandboxRetiredError);
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
    // The breaching run says so itself. Before this the OOM run returned a
    // bare result and only the NEXT call reported the sandbox gone, so the
    // agent spent an iteration discovering it.
    expect(r.sandboxRetired).toBe(true);
    // After an OOM the isolate is gone; the executor fails fast on reuse.
    await expect(ex.runCode('console.log(1)')).rejects.toThrow(ReplSandboxRetiredError);
  }, 20_000);
});

/**
 * The escape the in-process backend is vulnerable to, run against the isolate.
 *
 * These assert the specific vectors an attacker reaches for: not just
 * `Function`, but the `constructor` hanging off an *injected tool closure*,
 * which is the one that used to hand back the host realm.
 */
describe('IsolatedVmExecutor - guest cannot reach the host realm', () => {
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
  });

  function spawn(opts?: ConstructorParameters<typeof IsolatedVmExecutor>[0]): IsolatedVmExecutor {
    const ex = new IsolatedVmExecutor(opts);
    created.push(ex);
    return ex;
  }

  it('blocks the escape through an injected tool closure', async () => {
    const ex = spawn();
    // A tool closure is a host-side function reference in the in-process
    // backend, so `<tool>.constructor` was a live handle on the host realm's
    // codegen. Across an isolate the stub is in-isolate and its constructor
    // is neutered.
    ex.setTools({ semanticSearch: async () => ({ results: [] }) });

    const r = await ex.runCode('semanticSearch.constructor("return globalThis")()');
    expect(r.error).toContain('disabled');
  });

  it('cannot reach process.env or a host fetch by any of the named vectors', async () => {
    const ex = spawn();
    ex.setTools({ semanticSearch: async () => ({ results: [] }) });

    // Nothing ambient.
    const ambient = await ex.runCode('console.log(typeof process, typeof fetch, typeof require);');
    expect(ambient.error).toBeNull();
    expect(ambient.stdout).toBe('undefined undefined undefined');

    // Nothing reachable by construction either.
    for (const vector of [
      'Object.constructor("return process")()',
      'semanticSearch.constructor("return process")()',
      '({}).constructor.constructor("return process.env")()',
      '[].constructor.constructor("return globalThis.fetch")()',
    ]) {
      const r = await ex.runCode(vector);
      expect(r.error, `vector should be blocked: ${vector}`).toContain('disabled');
    }
  });

  it('preempts a CPU-bound loop that runs AFTER an await, not just a sync one', async () => {
    const ex = spawn({ timeoutMs: 300 });
    const t0 = Date.now();
    // The async IIFE wrapper means everything past the first `await` is a
    // fresh task. The isolate's CPU timeout still covers it.
    const r = await ex.runCode('await 0; while (true) {}');
    expect(r.error).toMatch(/timed out|timeout|terminated/i);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('terminates a run that is pending rather than burning CPU', async () => {
    const ex = spawn({ timeoutMs: 300 });
    const t0 = Date.now();
    // Nothing is executing, so there is no script for the isolate's own
    // timeout to interrupt. Only the host deadline can end this.
    const r = await ex.runCode('await new Promise(() => {});');
    expect(r.error).toMatch(/cap|terminated|timed out/i);
    expect(Date.now() - t0).toBeLessThan(3000);
    // The run that hit the deadline reports the retirement itself.
    expect(r.sandboxRetired).toBe(true);
    // Ending it means killing the isolate, so the executor is spent.
    await expect(ex.runCode('console.log(1)')).rejects.toThrow(ReplSandboxRetiredError);
  });

  it('bounds a stalled tool call as a catchable tool error, keeping the isolate alive', async () => {
    const ex = spawn({ timeoutMs: 300 });
    ex.setTools({ stalls: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await ex.runCode('await stalls();');

    // The host dispatcher gives up at 80% of timeoutMs, so this surfaces as a
    // failed TOOL call - not as the host deadline, whose only means of
    // preemption is killing the isolate. That distinction is the whole point:
    // a slow tool must not cost the session every later code_execute while
    // the agent loop keeps paying an iteration per attempt.
    expect(r.error).toMatch(/did not settle within/i);
    expect(Date.now() - t0).toBeLessThan(3000);

    // Same run, caught in-guest: the agent can route around it.
    const caught = await ex.runCode(`
      try { await stalls(); } catch (e) { console.log('caught:' + e.message.slice(0, 20)); }
    `);
    expect(caught.error).toBeNull();
    expect(caught.stdout).toMatch(/^caught:/);

    // And the sandbox is still serving other work.
    const after = await ex.runCode('console.log(1 + 1);');
    expect(after.error).toBeNull();
    expect(after.stdout).toBe('2');
  });

  it('keeps the tool timeout below the host deadline at every timeoutMs', async () => {
    // A previous revision floored the tool timeout at 1000ms, which for any
    // timeoutMs under ~1250ms put it AFTER the host deadline and silently
    // restored the isolate-killing behaviour. The bound has to be
    // proportional, not absolute.
    const ex = spawn({ timeoutMs: 200 });
    ex.setTools({ stalls: () => new Promise(() => {}) });

    const r = await ex.runCode('await stalls();');
    expect(r.error).toMatch(/did not settle within/i);
    await expect(ex.runCode('console.log("alive")')).resolves.toMatchObject({ error: null });
  });

  /**
   * The behavioural test above passes for any fraction that still lands under
   * the host deadline - 1.0, 1.2 and 2.6 all did - because a tool that stalls
   * FOREVER trips whichever bound comes first. So pin the contract itself: the
   * fraction must be strictly below 1, or a tool call is allowed to consume
   * the entire run and the per-tool bound stops being the one that fires.
   */
  it('derives a tool bound strictly inside the script cap at every timeoutMs', () => {
    expect(TOOL_CALL_TIMEOUT_FRACTION).toBeGreaterThan(0);
    expect(TOOL_CALL_TIMEOUT_FRACTION).toBeLessThan(1);

    for (const timeoutMs of [10, 50, 200, 1_000, 25_000, 30_000]) {
      const derived = Math.max(1, Math.floor(timeoutMs * TOOL_CALL_TIMEOUT_FRACTION));
      expect(derived).toBeLessThan(timeoutMs);
      expect(derived).toBeGreaterThan(0);
    }
  });

  /**
   * The per-call bound caps ONE tool call. It cannot cap a loop of them, and a
   * loop is the shape `code_execute`'s own description asks the model to write
   * ("iterate over many items without spawning an LLM call per item"). Two
   * calls each comfortably inside the per-call bound could sum past the host
   * deadline, which has no preemption but disposing the isolate - so one slow
   * pair of calls cost every later code_execute in the session.
   */
  it('draws sequential tool calls from one per-run budget, keeping the isolate alive', async () => {
    // Per-call bound is 800ms, so a 600ms tool passes it twice over. Together
    // they exceed the 1000ms run budget, which is what has to catch them.
    const ex = spawn({ timeoutMs: 1_000 });
    ex.setTools({ slow: () => new Promise(resolve => setTimeout(() => resolve('done'), 600)) });

    const r = await ex.runCode(`
      const first = await slow();
      console.log('first:' + first);
      try {
        await slow();
        console.log('second:completed');
      } catch (e) {
        console.log('second:' + e.message.slice(0, 80));
      }
    `);

    // The first call fits; the second is refused or cut short by what is left.
    expect(r.stdout).toContain('first:done');
    expect(r.stdout).not.toContain('second:completed');
    // Either bound is a pass: cut short by what the run had left, or refused
    // outright because it had none. Both keep the isolate.
    expect(r.stdout).toMatch(/second:.*(did not settle|no time left)/i);

    // The point of catching it at the tool boundary: the sandbox survives.
    expect(r.sandboxRetired).toBeFalsy();
    await expect(ex.runCode('console.log("alive")')).resolves.toMatchObject({
      error: null,
      stdout: 'alive',
    });
  }, 15_000);

  it("does not expose the bootstrap's own bindings to guest code", async () => {
    const ex = spawn();
    // The bootstrap runs as a script in this context, so without an IIFE its
    // top-level const/let would bind into the SHARED global lexical scope -
    // invisible to listGlobals(), which only reads globalThis own-properties.
    const r = await ex.runCode(`
      console.log([
        '__cap', '__callTool', '__RealFunction', '__AsyncFunction',
        '__GeneratorFunction', '__AsyncGeneratorFunction', '__blockCodegen',
        '__formatLine', '__jsonReplacer', 'HARD_PER_LINE_BYTES',
      ].map(n => typeof globalThis[n]).join(',') + '|' + [
        typeof __cap, typeof __callTool, typeof __RealFunction,
        typeof __blockCodegen, typeof __formatLine, typeof HARD_PER_LINE_BYTES,
      ].join(','));
    `);
    expect(r.error).toBeNull();
    const [asGlobals, asBindings] = r.stdout.split('|');
    expect(asGlobals.split(',').every(t => t === 'undefined')).toBe(true);
    expect(asBindings.split(',').every(t => t === 'undefined')).toBe(true);
  });

  it('gives guest code no captured Function constructor to walk around the codegen block', async () => {
    const ex = spawn();
    // __RealFunction is the pre-override handle to the intrinsic. If it leaked,
    // this is a one-liner past the codegen guard.
    const r = await ex.runCode('console.log(__RealFunction("return 1")());');
    expect(r.error).toMatch(/__RealFunction is not defined/);
  });

  it('gives guest code no handle on the stdout capture Reference', async () => {
    const ex = spawn();
    // __cap is a host ivm.Reference. Reaching it lets guest code forge stdout
    // lines with applySync, or permanently kill capture with release() while
    // the executor keeps reporting healthy.
    const forged = await ex.runCode(`__cap.applySync(undefined, ['forged'], { arguments: { copy: true } });`);
    expect(forged.error).toMatch(/__cap is not defined/);
    expect(forged.stdout).toBe('');

    const killed = await ex.runCode('__cap.release();');
    expect(killed.error).toMatch(/__cap is not defined/);

    // Capture still works after both attempts.
    const r = await ex.runCode('console.log("still capturing");');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('still capturing');
  });

  // --- stdout integrity (the observation channel the HOST reports) ---------

  it('survives a guest reassigning globalThis.console', async () => {
    const ex = spawn();
    // stdout is what the host hands back as the run's observation. A writable
    // console let guest code mute or forge it for every LATER run in the
    // session - stdout="" or spoofed lines, error=null, listGlobals() clean.
    const hijack = await ex.runCode(`
      globalThis.console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} };
      console.log('should still be captured');
    `);
    expect(hijack.stdout).toBe('should still be captured');

    const later = await ex.runCode('console.log("later run still captured");');
    expect(later.error).toBeNull();
    expect(later.stdout).toBe('later run still captured');
  });

  it('survives a guest reassigning console.log on the frozen console', async () => {
    const ex = spawn();
    const r = await ex.runCode(`
      try { console.log = () => {}; } catch (e) { /* strict-mode TypeError is fine too */ }
      console.log('captured');
    `);
    expect(r.stdout).toBe('captured');
  });

  it('refuses a guest attempt to redefine or delete console', async () => {
    const ex = spawn();
    const r = await ex.runCode(`
      let redefined = 'no';
      try {
        Object.defineProperty(globalThis, 'console', { value: { log: () => {} } });
        redefined = 'yes';
      } catch (e) { redefined = 'threw'; }
      const deleted = delete globalThis.console;
      console.log(redefined + '|' + deleted + '|' + (typeof console.log));
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toMatch(/^threw\|false\|function$/);
  });

  // --- the in-isolate tool registrar is host-only ---------------------------

  it('does not expose __registerTools to guest code', async () => {
    const ex = spawn();
    ex.setTools({ ping: async () => 'pong' });
    // Guest-reachable, it was two attacks: __registerTools(['console'])
    // overwrites the console binding with a tool stub, and `delete`-ing it
    // makes the host's next setTools() throw.
    const r = await ex.runCode('console.log(typeof globalThis.__registerTools + "|" + typeof __registerTools);');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('undefined|undefined');
  });

  it('keeps setTools working after a guest tries to delete the registrar', async () => {
    const ex = spawn();
    ex.setTools({ first: async () => 'a' });

    const attack = await ex.runCode('console.log(delete globalThis.__registerTools);');
    expect(attack.error).toBeNull();

    // The host holds the registrar through a Reference, so a later setTools
    // cannot be broken from inside the isolate.
    expect(() => ex.setTools({ second: async () => 'b' })).not.toThrow();
    const r = await ex.runCode('console.log(await first(), await second());');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('a b');
  });

  it('cannot be made to hang a host setTools() through Array.prototype', async () => {
    const ex = spawn();
    // The host calls the registrar with a COPIED array whose iterator comes
    // from the guest's Array.prototype, so a for..of loop there was a
    // guest-controlled hang (or hijack) of a host-side call. The registrar
    // indexes instead.
    const poison = await ex.runCode(`
      Array.prototype[Symbol.iterator] = function* () { while (true) yield 'console'; };
      console.log('poisoned');
    `);
    expect(poison.error).toBeNull();

    ex.setTools({ afterPoison: async () => 'ok' });
    const r = await ex.runCode('console.log(await afterPoison());');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('ok');
  });

  // --- WebAssembly is a session-kill primitive in an isolate ---------------

  it('removes WebAssembly, whose promises never settle in an isolate', async () => {
    const ex = spawn({ timeoutMs: 300 });
    // WebAssembly.instantiate never settles in-isolate (no host task runner),
    // so `await` on it parked the run until the host deadline - which kills
    // the isolate and costs the session its sandbox. One line, from the guest.
    const r = await ex.runCode('console.log(typeof WebAssembly);');
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('undefined');

    const attempt = await ex.runCode('await WebAssembly.instantiate(new Uint8Array([0,97,115,109]));');
    expect(attempt.error).toMatch(/WebAssembly is not defined/);
    // Crucially the isolate is still alive - it was not killed by a deadline.
    await expect(ex.runCode('console.log("alive")')).resolves.toMatchObject({ error: null });
  });

  it('releases the host-side References when the host deadline kills the isolate', async () => {
    const ex = spawn({ timeoutMs: 300 });
    // Private by design; the leak is only observable at this seam. `new
    // ivm.Reference(fn)` allocates in the HOST isolate, so disposing the guest
    // isolate does not reclaim it - only release() does.
    const internals = ex as unknown as {
      captureRef: { release: () => void };
      callToolRef: { release: () => void };
    };
    // An `ivm.Reference` is non-extensible, so vi.spyOn cannot patch it -
    // swap the field for a stub that records the call and delegates to the
    // real handle, so the observation does not itself leak one.
    const realCapture = internals.captureRef;
    const realCallTool = internals.callToolRef;
    const captureRelease = vi.fn(() => realCapture.release());
    const callToolRelease = vi.fn(() => realCallTool.release());
    internals.captureRef = { release: captureRelease };
    internals.callToolRef = { release: callToolRelease };

    const r = await ex.runCode('await new Promise(() => {});');
    expect(r.error).toMatch(/cap|terminated|timed out/i);

    // runCode sets `disposed` on this path and dispose() early-returns on that
    // flag, so a release gated behind it would strand both handles plus their
    // closures for the life of the process.
    expect(captureRelease).toHaveBeenCalledTimes(1);
    expect(callToolRelease).toHaveBeenCalledTimes(1);

    ex.dispose();
    expect(captureRelease).toHaveBeenCalledTimes(1);
    expect(callToolRelease).toHaveBeenCalledTimes(1);
  });
});
