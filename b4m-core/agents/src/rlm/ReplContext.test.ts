import { describe, it, expect } from 'vitest';
import { ReplContext } from './ReplContext';

describe('ReplContext', () => {
  it('captures console.log output and returns it as stdout', async () => {
    const ctx = new ReplContext();
    const r = await ctx.runCode('console.log("hello world");');
    expect(r.stdout).toBe('hello world');
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it('preserves variables across runCode calls (the persistence guarantee)', async () => {
    const ctx = new ReplContext();

    const r1 = await ctx.runCode('x = 5; console.log(x * 2);');
    expect(r1.stdout).toBe('10');
    expect(r1.error).toBeNull();

    const r2 = await ctx.runCode('console.log(x);');
    expect(r2.stdout).toBe('5');
    expect(r2.error).toBeNull();
  });

  it('exposes injected tools as async functions inside the REPL', async () => {
    const ctx = new ReplContext({
      tools: {
        fakeSearch: async (query: unknown) => ({ q: String(query), hits: 3 }),
      },
    });
    const r = await ctx.runCode(`
      const result = await fakeSearch("widgets");
      console.log(JSON.stringify(result));
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('{"q":"widgets","hits":3}');
  });

  it('lets tools added via setTools() be called from later runCode invocations', async () => {
    const ctx = new ReplContext();
    ctx.setTools({ doubler: async (n: unknown) => Number(n) * 2 });
    const r = await ctx.runCode('console.log(await doubler(21));');
    expect(r.stdout).toBe('42');
    expect(r.error).toBeNull();
  });

  it('serializes thrown errors without crashing the context', async () => {
    const ctx = new ReplContext();

    const r1 = await ctx.runCode('throw new Error("nope");');
    expect(r1.error).toContain('Error: nope');

    // Context survives - variables set after the throw still work
    const r2 = await ctx.runCode('y = 7; console.log(y);');
    expect(r2.stdout).toBe('7');
    expect(r2.error).toBeNull();
  });

  it('allows top-level await via the IIFE wrapper', async () => {
    const ctx = new ReplContext();
    const r = await ctx.runCode(`
      const v = await Promise.resolve(123);
      console.log(v);
    `);
    expect(r.stdout).toBe('123');
    expect(r.error).toBeNull();
  });

  it('truncates very long stdout and reports truncation', async () => {
    const ctx = new ReplContext();
    // Print enough to exceed 5K + 2K = 7K chars
    const r = await ctx.runCode(`
      for (let i = 0; i < 200; i++) {
        console.log("line " + i + ": " + "x".repeat(100));
      }
    `);
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain('[...');
    expect(r.stdout).toContain('truncated');
  });

  it('does NOT expose process / require / fs (deliberate — narrow surface)', async () => {
    const ctx = new ReplContext();
    const r = await ctx.runCode(`
      try { console.log(typeof process); } catch (e) { console.log('process err: ' + e.message); }
      try { console.log(typeof require); } catch (e) { console.log('require err: ' + e.message); }
    `);
    // Both should be 'undefined' - vm.createContext gives a fresh global,
    // and we deliberately do not inject process or require.
    expect(r.stdout).toContain('undefined');
    expect(r.error).toBeNull();
  });

  it('handles a long-running but finite computation under the timeout', async () => {
    const ctx = new ReplContext({ timeoutMs: 5_000 });
    const r = await ctx.runCode(`
      let sum = 0;
      for (let i = 0; i < 1_000_000; i++) sum += i;
      console.log(sum);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('499999500000');
  });

  it('lists user-defined globals via listGlobals() (sanity for debugging)', async () => {
    const ctx = new ReplContext();
    await ctx.runCode('alpha = 1; beta = "two";');
    const globals = ctx.listGlobals();
    expect(globals).toContain('alpha');
    expect(globals).toContain('beta');
  });
});
