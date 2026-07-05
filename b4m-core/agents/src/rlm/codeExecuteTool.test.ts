import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplSession } from './ReplSession';
import { makeCodeExecuteTool, CODE_EXECUTE_TOOL_NAME } from './codeExecuteTool';

describe('makeCodeExecuteTool', () => {
  let session: ReplSession;

  beforeEach(() => {
    session = new ReplSession({ sessionId: 'code-tool-test' });
  });

  it('returns a tool with the right name and schema shape', () => {
    const tool = makeCodeExecuteTool({ session });
    expect(tool.toolSchema.name).toBe(CODE_EXECUTE_TOOL_NAME);
    expect(tool.toolSchema.name).toBe('code_execute');
    expect(tool.toolSchema.parameters.required).toEqual(['code']);
    expect(tool.toolSchema.parameters.properties.code).toBeDefined();
    expect(typeof tool.toolFn).toBe('function');
  });

  it('runs code via the bound session and returns stdout in the observation', async () => {
    const tool = makeCodeExecuteTool({ session });
    const out = await tool.toolFn({ code: 'console.log("hello from agent");' });
    expect(out).toContain('[code_execute] ok');
    expect(out).toContain('hello from agent');
    expect(session.getUsage().executions).toBe(1);
  });

  it('persists variables across two consecutive tool calls (the whole point)', async () => {
    const tool = makeCodeExecuteTool({ session });

    const a = await tool.toolFn({ code: 'tally = [1, 2, 3];' });
    expect(a).toContain('[code_execute] ok');

    const b = await tool.toolFn({
      code: 'console.log(tally.reduce((s, n) => s + n, 0));',
    });
    expect(b).toContain('6');
  });

  it('reports REPL errors clearly without throwing', async () => {
    const tool = makeCodeExecuteTool({ session });
    const out = await tool.toolFn({ code: 'throw new Error("boom");' });
    expect(out).toContain('[code_execute] error');
    expect(out).toContain('--- error ---');
    expect(out).toContain('Error: boom');
  });

  it('rejects empty code with a clear message rather than silently no-oping', async () => {
    const tool = makeCodeExecuteTool({ session });
    const out = await tool.toolFn({ code: '   ' });
    expect(out).toContain('empty `code` argument');
  });

  it('reports budget exceeded distinctly so the agent knows to wrap up', async () => {
    const tightSession = new ReplSession({
      sessionId: 'budget-test',
      budget: { maxExecutions: 1 },
    });
    const tool = makeCodeExecuteTool({ session: tightSession });

    const a = await tool.toolFn({ code: 'console.log("first");' });
    expect(a).toContain('[code_execute] ok');

    const b = await tool.toolFn({ code: 'console.log("second");' });
    expect(b).toContain('BUDGET EXCEEDED');
    expect(b).toContain('Provide your final answer now');
  });

  it('logs at the right verbosity when a logger is provided', async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const tool = makeCodeExecuteTool({ session, logger: { log, warn, error } });

    await tool.toolFn({ code: 'console.log(1);' });
    expect(log).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    await tool.toolFn({ code: 'throw new Error("x");' });
    expect(warn).toHaveBeenCalled();
  });
});
