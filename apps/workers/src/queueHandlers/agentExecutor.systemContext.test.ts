import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROMPT_TEXT_MAX } from '@bike4mind/common';
import { StartExecutionSchema } from './agentExecutor.schemas';

const basePayload = {
  executionId: 'exec-1',
  userId: 'user-1',
  sessionId: 'session-1',
  query: 'go',
  model: 'model-1',
  connectionId: 'conn-1',
};

describe('StartExecutionSchema - per-send systemContext', () => {
  it('accepts and keeps systemContext', () => {
    const parsed = StartExecutionSchema.parse({ ...basePayload, systemContext: 'Extra instructions for this send.' });
    expect(parsed.systemContext).toBe('Extra instructions for this send.');
  });

  it('leaves it undefined when absent', () => {
    expect(StartExecutionSchema.parse(basePayload).systemContext).toBeUndefined();
  });

  it('rejects a systemContext over the prompt-text cap', () => {
    expect(
      StartExecutionSchema.safeParse({ ...basePayload, systemContext: 'x'.repeat(PROMPT_TEXT_MAX + 1) }).success
    ).toBe(false);
  });
});

/**
 * Static-analysis guard on the call site. `processExecution` has no harness (see
 * agentExecutor.resolveQuestId.test.ts), so this locks that the start payload's
 * systemContext reaches `runIteration` as ReActAgent's `context` - which appends it to the
 * run's system message - and that it is spread only when set, so a run without it calls
 * `runIteration` exactly as before.
 */
describe('systemContext call site in agentExecutor', () => {
  const source = readFileSync(resolve(__dirname, 'agentExecutor.ts'), 'utf8');

  // The whole options object, brace-matched. A lazy regex would stop at the spread's own
  // `: {})` and never see a later key that overrides it.
  const runIterationOptions = (): string => {
    const opener = 'agent.runIteration(firstIterationMessage, {';
    const start = source.indexOf(opener);
    expect(start, 'agent.runIteration call site not found in agentExecutor.ts').toBeGreaterThan(-1);
    const braceStart = start + opener.length - 1;
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(braceStart, i + 1);
    }
    throw new Error('Unbalanced braces in the agent.runIteration options object');
  };

  it('passes startPayload.systemContext to runIteration as context, only when set', () => {
    const options = runIterationOptions();
    expect(options).toContain('...(startPayload?.systemContext ? { context: startPayload.systemContext } : {})');
    // Exactly one `context:` key, so nothing later in the object can overwrite the spread.
    expect(options.match(/\bcontext:/g)).toHaveLength(1);
  });

  // Only what this checks: the executor never reads or writes a `systemContext` field on the
  // execution doc. The content does reach the doc's server-only checkpoint via messages[0].
  it('never reads or writes systemContext as a field of the execution doc', () => {
    expect(source).not.toMatch(/execution\.systemContext/);
  });
});
