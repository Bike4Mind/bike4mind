import { describe, it, expect } from 'vitest';
import { AgentStepSchema } from './actions';
import { PUBLIC_AGENT_STEP_TYPES } from './agentExecution';

/**
 * The published step-kind tuple is a hand-written copy of the internal one, because
 * `actions.ts` cannot be imported from the OpenAPI generation path (it reaches
 * `@bike4mind/hearth`, which is unbuilt in the spec CI job). This test is what makes
 * the copy safe: add a kind internally and the published enum has to follow, or the
 * build fails here rather than silently under-documenting the trace.
 */
describe('PUBLIC_AGENT_STEP_TYPES', () => {
  it('stays in lockstep with the internal AgentStepSchema step kinds', () => {
    const internal = AgentStepSchema.shape.type.options;
    expect([...PUBLIC_AGENT_STEP_TYPES]).toEqual([...internal]);
  });
});
