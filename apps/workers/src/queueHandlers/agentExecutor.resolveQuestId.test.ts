import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveExecutionQuestId } from './agentExecutor.resolveQuestId';

describe('resolveExecutionQuestId', () => {
  it('prefers the start payload on the first invocation', () => {
    const result = resolveExecutionQuestId({
      startPayloadQuestId: 'quest-from-payload',
      executionLinkedQuestId: 'quest-from-doc',
    });
    expect(result).toBe('quest-from-payload');
  });

  it('falls back to the persisted linkedQuestId on a resumed invocation (no start payload)', () => {
    // A resumed/checkpointed Lambda invocation has no start payload at all - this is the case
    // `linkedQuestId` exists specifically to cover.
    const result = resolveExecutionQuestId({ executionLinkedQuestId: 'quest-from-doc' });
    expect(result).toBe('quest-from-doc');
  });

  it('is undefined when neither source has it - the dispatch-time Quest write failed', () => {
    const result = resolveExecutionQuestId({});
    expect(result).toBeUndefined();
  });
});

/**
 * Static-analysis guard on the CALL SITE, not the function.
 *
 * The three cases above only exercise `??`. The regression this module was extracted to prevent
 * lives at the wiring: `processExecution` has no test harness (nothing in this directory drives
 * it - the files that mention it do so only in comments), so swapping
 * `executionLinkedQuestId: execution.linkedQuestId` for `execution.questId` leaves every unit test
 * above green while writing session ids into agent-mode `LakeAccessEvent.questId` rows on the WS
 * dispatch lineage. Same string-parsing approach as `server/__tests__/lakeAccessEventsWiring.test.ts`,
 * and for the same reason: an optional field wired to the wrong source fails silently.
 */
describe('resolveExecutionQuestId call site in agentExecutor', () => {
  const source = readFileSync(resolve(__dirname, 'agentExecutor.ts'), 'utf8');

  it('passes execution.linkedQuestId, never execution.questId', () => {
    const call = source.match(/resolveExecutionQuestId\(\{[\s\S]*?\}\)/);
    expect(call, 'resolveExecutionQuestId call site not found in agentExecutor.ts').not.toBeNull();
    expect(call![0]).toContain('executionLinkedQuestId: execution.linkedQuestId');
    // `execution.questId` holds the sessionId on the WS lineage and the real Quest id on the V5
    // lineage - not interpretable either way, so it must never reach this helper.
    expect(call![0]).not.toContain('execution.questId');
  });
});
