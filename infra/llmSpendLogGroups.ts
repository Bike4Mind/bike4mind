import { chatCompletionLogGroupName } from './chatCompletionLogGroup';
import { cliCompletionRoute } from './websocket';
import { websocketRouteLogGroup } from './websocketRouteLogGroup';

export type LlmSpendLogSource = {
  /** Appended to logical and physical filter names; empty keeps the original ChatCompletion resources. */
  key: string;
  logGroupName: $util.Output<string>;
  /** Set when the log group is an SST node; otherwise the relay looks its arn up by name. */
  logGroupArn?: $util.Output<string>;
};

/**
 * Every log group that emits `llm-usage-settled` and the credit-overdraft line, i.e. every runtime
 * of executeCompletion (b4m-core/services/src/cliCompletions.ts). infra/llmSpend.ts filters each
 * into the same metrics, and the alarm relay (infra/dlqAlarms.ts) queries all of them to name the
 * accounts behind a young-account spend alarm, so both must read this one list.
 */
export function llmSpendLogSources(): LlmSpendLogSource[] {
  const cliCompletionLogGroup = websocketRouteLogGroup(cliCompletionRoute, 'cli_completion_request');
  return [
    { key: '', logGroupName: chatCompletionLogGroupName },
    {
      key: 'cli-completion',
      logGroupName: cliCompletionLogGroup.apply(logGroup => logGroup.name),
      logGroupArn: cliCompletionLogGroup.apply(logGroup => logGroup.arn),
    },
  ];
}
