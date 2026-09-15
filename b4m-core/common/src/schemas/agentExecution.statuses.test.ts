import { describe, it, expect } from 'vitest';
import { AGENT_EXECUTION_STATUSES } from '../constants/agentExecutionStatus';
import { PUBLIC_AGENT_EXECUTION_STATUSES } from './agentExecution';

/**
 * `AGENT_EXECUTION_STATUSES` is the database's value space and grows with the
 * executor's internal states. The published tuple is a deliberate copy so a new
 * internal status cannot reach `openapi.json` and every generated client by default.
 * This test is what makes the copy safe: adding one internally fails here, and whoever
 * adds it decides whether it is public - either by extending the published tuple or by
 * recording the exclusion in the list below.
 */
describe('PUBLIC_AGENT_EXECUTION_STATUSES', () => {
  /** Internal statuses deliberately not published. Empty today; add with a reason. */
  const NOT_PUBLISHED: readonly string[] = [];

  it('publishes every internal status that is not explicitly held back', () => {
    const expected = AGENT_EXECUTION_STATUSES.filter(s => !NOT_PUBLISHED.includes(s));
    expect([...PUBLIC_AGENT_EXECUTION_STATUSES]).toEqual([...expected]);
  });

  it('never publishes a status the database cannot produce', () => {
    for (const status of PUBLIC_AGENT_EXECUTION_STATUSES) {
      expect(AGENT_EXECUTION_STATUSES).toContain(status);
    }
  });
});
