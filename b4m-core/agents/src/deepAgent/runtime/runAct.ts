import type { ActContext, ActResult } from './types';

/**
 * Placeholder act executor.
 *
 * A real `runAct` builds a ReActAgent with the agent role's toolbelt profile,
 * runs it against the policy decision, and returns the actions taken +
 * observations + token/cost accounting (see `createReActRunAct`).
 *
 * With this noop, a wake is a "think-only" cycle: orient and reflect still run
 * (the agent reasons about its goal and grooms memory), but it takes no
 * external action. This keeps the loop runnable end-to-end behind a working
 * trigger without committing to a toolbelt.
 */
export const noopRunAct = async (_ctx: ActContext): Promise<ActResult> => ({
  actionsTaken: [],
  observations: [
    {
      kind: 'noop',
      summary: 'act step not wired — think-only wake (orient + reflect only)',
    },
  ],
  tokensSpent: 0,
  costUsd: 0,
});
