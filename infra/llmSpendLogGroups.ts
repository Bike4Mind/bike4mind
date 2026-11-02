import { chatCompletionLogGroupName } from './chatCompletionLogGroup';
import { cliCompletionRoute } from './websocket';

export type LlmSpendLogSource = {
  /** Appended to logical and physical filter names; empty keeps the original ChatCompletion resources. */
  key: string;
  logGroupName: $util.Output<string>;
};

/**
 * Every log group that emits `llm-usage-settled` and the credit-overdraft line, i.e. every runtime
 * of executeCompletion (b4m-core/services/src/cliCompletions.ts). infra/llmSpend.ts filters each
 * into the same metrics, and the alarm relay (infra/dlqAlarms.ts) queries all of them to name the
 * accounts behind a young-account spend alarm, so both must read this one list.
 */
export function llmSpendLogSources(): LlmSpendLogSource[] {
  const cliCompletionLogGroupName = cliCompletionRoute.nodes.function
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('cli_completion_request function is missing its CloudWatch log group');
      return logGroup.name;
    });
  return [
    { key: '', logGroupName: chatCompletionLogGroupName },
    { key: 'cli-completion', logGroupName: cliCompletionLogGroupName },
  ];
}
