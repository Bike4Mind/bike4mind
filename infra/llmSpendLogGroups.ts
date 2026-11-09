import { chatCompletionLogGroupName } from './chatCompletionLogGroup';
import { slackQuestProcessor } from './functions';
import { web } from './web';
import { cliCompletionRoute } from './websocket';
import { websocketRouteLogGroup } from './websocketRouteLogGroup';

export type LlmSpendLogSource = {
  /** Appended to logical and physical filter names; empty keeps the original ChatCompletion resources. */
  key: string;
  logGroupName: $util.Output<string>;
  /** Set when the log group is an SST node; otherwise the relay looks its arn up by name. */
  logGroupArn?: $util.Output<string>;
};

function requireLogGroupName(logGroup: sst.aws.Function['nodes']['logGroup'], label: string): $util.Output<string> {
  return logGroup.apply(group => {
    if (!group) throw new Error(`${label} function is missing its CloudWatch log group`);
    return group.name;
  });
}

/**
 * Every log group that emits `llm-usage-settled` and the credit-overdraft line, i.e. every runtime
 * of executeCompletion (b4m-core/services/src/cliCompletions.ts) or ChatCompletionProcess.process():
 * the ChatCompletion container, the cli_completion_request route, the Slack quest processor, and
 * the Next.js server (/api/chat?wait=true and the voice v2 LLM proxy run process() inline).
 * infra/llmSpend.ts filters each into the same metrics, and the alarm relay (infra/dlqAlarms.ts)
 * queries all of them to name the accounts behind a young-account spend alarm, so both must read
 * this one list.
 */
export function llmSpendLogSources(): LlmSpendLogSource[] {
  if (!web.nodes.server) throw new Error('LLM spend log sources require the Next.js server function');
  const cliCompletionLogGroup = websocketRouteLogGroup(cliCompletionRoute, 'cli_completion_request');
  return [
    { key: '', logGroupName: chatCompletionLogGroupName },
    {
      key: 'cli-completion',
      logGroupName: cliCompletionLogGroup.apply(logGroup => logGroup.name),
      logGroupArn: cliCompletionLogGroup.apply(logGroup => logGroup.arn),
    },
    {
      key: 'slack-quest',
      logGroupName: requireLogGroupName(slackQuestProcessor.nodes.logGroup, 'SlackQuestProcessor'),
    },
    {
      key: 'web-server',
      logGroupName: requireLogGroupName(
        web.nodes.server.apply(fn => fn.nodes.logGroup),
        'Next.js server'
      ),
    },
  ];
}
