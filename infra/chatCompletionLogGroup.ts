import { chatCompletion } from './chatCompletion';

/**
 * Name of the ChatCompletion container log group, the source of the `llm-usage-settled` lines
 * behind the LLM spend metrics (infra/llmSpend.ts) and the young-account breakdown the alarm
 * relay queries (apps/workers/src/events/youngAccountSpendDetail.ts).
 * Same resolution as logMonitor.ts: SST does not expose the container log group as a node.
 */
export const chatCompletionLogGroupName = chatCompletion.nodes.taskDefinition
  .apply(taskDefinition => taskDefinition.containerDefinitions)
  .apply(json => {
    const containerDefinitions = JSON.parse(json) as Array<{
      logConfiguration?: { options?: Record<string, string> };
    }>;
    const name = containerDefinitions[0]?.logConfiguration?.options?.['awslogs-group'];
    if (!name) throw new Error('Could not resolve the ChatCompletion container log group from its task definition');
    return name;
  });
