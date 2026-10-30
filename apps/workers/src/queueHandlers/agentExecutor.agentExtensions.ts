/**
 * The agent executor's extension registry: the executor's own surface profile and tool-map guards,
 * registered as built-ins, plus whatever a mounted package contributes.
 *
 * Built once at module load and frozen, so a run can neither add nor drop an entry. Built-in
 * guard order is fixed by priority (100, 200, 300 = innermost to outermost); contributions take
 * 1-99 and therefore always wrap inside the built-ins.
 */

import '@client/lib/settings/registerContributedSettings';
import { z } from 'zod';
import {
  createAgentExtensionRegistry,
  type AgentExtensionContribution,
  type AgentExtensionLogger,
  type AgentExtensionRegistry,
} from '@bike4mind/agents';
import { OPTI_SURFACE } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { IOptiPlanState } from '@bike4mind/database';
import type { ToolDefinition } from '@bike4mind/services/llm';
import { premiumAgentExtensions } from '@server/premium-generated/premiumAgentExtensions.generated';
import { buildOptiOrchestrationProfile } from './agentExecutor.optiProfile';
import { guardDecomposeOnce } from './agentExecutorUtils/decomposeGuard';
import { guardPlanCompletion } from './agentExecutorUtils/planCompletionGuard';
import { injectBriefContext } from './agentExecutorUtils/briefContextInjector';

export type ExecutorToolMap = Record<string, ToolDefinition>;
export type ExecutorAgentExtensions = AgentExtensionRegistry<ExecutorToolMap, IOptiPlanState>;
export type ExecutorAgentExtensionContribution = AgentExtensionContribution<ExecutorToolMap, IOptiPlanState>;

const executorToolMapSchema = z.record(
  z.string(),
  z.object({
    name: z.string(),
    implementation: z.custom<ToolDefinition['implementation']>(value => typeof value === 'function'),
    artifactType: z.string().optional(),
  })
);

function registerBuiltIns(registry: ExecutorAgentExtensions): void {
  registry.registerSurfaceProfile(
    {
      id: 'synthetic:opti-orchestration',
      surface: OPTI_SURFACE,
      build: ({ contributedToolNames, executionId, logger }) => {
        // An empty list means codegen ran with nothing mounted. The loop then has no surface tools
        // at all and answers in prose, which reads as a model failure rather than a build one -
        // so say it once, here, where the cause is known.
        if (contributedToolNames.length === 0) {
          logger.warn('[opti] optimizer surface resolved no premium tools; the agent has only core generics', {
            executionId,
          });
        }
        return buildOptiOrchestrationProfile({ premiumToolNames: contributedToolNames });
      },
    },
    'builtin'
  );

  // The three guards share the run's plan ledger through `runState`: the inner two record and
  // read plan progress on it, the outermost only augments real tool observations.
  registry.registerToolMapGuard(
    {
      id: 'decompose-once',
      priority: 100,
      apply: (tools, { runState, logger, executionId }) =>
        guardDecomposeOnce(tools, runState, () =>
          logger.info('[opti] blocked a repeat optihashi_decompose call (advancing existing plan)', { executionId })
        ),
    },
    'builtin'
  );
  registry.registerToolMapGuard(
    {
      id: 'plan-completion',
      priority: 200,
      apply: (tools, { runState, logger, executionId }) =>
        guardPlanCompletion(tools, runState, () =>
          logger.info('[opti] plan complete -- all planned steps solved; steering to final summary', { executionId })
        ),
    },
    'builtin'
  );
  registry.registerToolMapGuard(
    { id: 'brief-context', priority: 300, apply: tools => injectBriefContext(tools) },
    'builtin'
  );
}

export function createExecutorAgentExtensions(
  contributions: readonly ExecutorAgentExtensionContribution[],
  logger?: Pick<AgentExtensionLogger, 'warn'>
): ExecutorAgentExtensions {
  const registry = createAgentExtensionRegistry<ExecutorToolMap, IOptiPlanState>({
    logger,
    validateToolMap: tools => executorToolMapSchema.safeParse(tools).success,
  });
  registerBuiltIns(registry);
  for (const contribution of contributions) registry.registerContribution(contribution);
  registry.freeze();
  return registry;
}

// The generated module is typed against the registry's default generics; a contribution's guards
// receive and return this executor's tool map at runtime.
export const executorAgentExtensions: ExecutorAgentExtensions = createExecutorAgentExtensions(
  premiumAgentExtensions as unknown as readonly ExecutorAgentExtensionContribution[],
  new Logger({ metadata: { handler: 'agentExtensions' } })
);
