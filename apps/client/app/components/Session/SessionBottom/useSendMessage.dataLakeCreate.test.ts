import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard: when a Data Lake seam session is created on the send path
 * (`!currentSession && useDataLakeMode.getState().enabled`), the later agent-executor
 * branch must reuse it via `dataLakeCreated?.id` instead of falling into its own
 * `generateNewSession` - otherwise the grounded session is orphaned and the first
 * message dispatches ungrounded on a second, freshly-minted session.
 *
 * A source-level assertion is used (rather than a full `renderHook`) - see
 * `useSendMessage.hostCreate.test.ts` for the same rationale.
 */
describe('useSendMessage — Data Lake grounded-session creation (regression)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('reuses the grounded session id when seeding the agent-executor dispatch id', () => {
    expect(source).toContain('dataLakeCreated?.id');
    expect(source).toMatch(/let dispatchSessionId = currentSessionId \?\? dataLakeCreated\?\.id;/);
  });

  it('gates the grounded-session create behind the Data Lake guard', () => {
    expect(source).toContain('!currentSession && useDataLakeMode.getState().enabled');
  });

  it('creates the grounded session with forceKnowledgeRetrieval and no surface field', () => {
    const guardIdx = source.indexOf('!currentSession && useDataLakeMode.getState().enabled');
    expect(guardIdx).toBeGreaterThan(-1);

    const postIdx = source.indexOf('/api/sessions/create', guardIdx);
    expect(postIdx).toBeGreaterThan(guardIdx);

    // Isolate the create call block up to its closing `});` for scoped assertions.
    const blockEnd = source.indexOf('});', postIdx);
    const block = source.slice(postIdx, blockEnd);

    expect(block).toContain('forceKnowledgeRetrieval: true');
    expect(block).not.toContain('surface:');
  });
});
