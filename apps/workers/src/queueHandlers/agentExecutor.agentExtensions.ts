/**
 * The agent executor's extension registry: the executor's own tool-map guards, registered as
 * built-ins, plus whatever a mounted package contributes (surface profiles included).
 *
 * Built once at module load and frozen, so a run can neither add nor drop an entry. Built-in
 * guard order is fixed by priority (100, 200, 300 = innermost to outermost); contributions take
 * 1-99 and therefore always wrap inside the built-ins.
 */

import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import { z } from 'zod';
import {
  createAgentExtensionRegistry,
  type AgentExtensionContribution,
  type AgentExtensionLogger,
  type AgentExtensionRegistry,
} from '@bike4mind/agents';
import { Logger } from '@bike4mind/observability';
import type { IOptiPlanState } from '@bike4mind/database';
import type { ToolDefinition } from '@bike4mind/services/llm';
import { premiumAgentExtensions } from '@bike4mind/server-utils/premium-generated/premiumAgentExtensions.generated';
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
