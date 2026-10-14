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

  it('passes startPayload.systemContext to runIteration as context, only when set', () => {
    const call = source.match(/agent\.runIteration\(firstIterationMessage, \{[\s\S]*?\}\)/);
    expect(call, 'agent.runIteration call site not found in agentExecutor.ts').not.toBeNull();
    expect(call![0]).toContain('...(startPayload?.systemContext ? { context: startPayload.systemContext } : {})');
  });

  it('never persists systemContext on the execution doc', () => {
    expect(source).not.toMatch(/execution\.systemContext/);
  });
});
