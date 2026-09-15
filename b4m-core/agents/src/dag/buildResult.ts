import type { PipelineExecutionResult, PipelineTaskResult } from './schemas';

const DEFAULT_MAX_RESULT_CHARS = 800;

/**
 * Build the final markdown summary + structured result for a DAG execution.
 *
 * Shared between the CLI's in-process executor and the web's Lambda-fan-out
 * executor so the synthesized tool_result that the parent agent sees has
 * consistent shape across surfaces.
 */
export function buildPipelineResult(
  taskResults: ReadonlyArray<PipelineTaskResult>,
  options: { maxResultChars?: number } = {}
): PipelineExecutionResult {
  const maxLen = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;

  const completed = taskResults.filter(t => t.status === 'completed');
  const failed = taskResults.filter(t => t.status === 'failed');
  const cascadeFailed = taskResults.filter(t => t.status === 'cascade_failed');
  const pending = taskResults.filter(t => t.status === 'pending' || t.status === 'running');
  const success = failed.length === 0 && cascadeFailed.length === 0 && pending.length === 0;

  const summaryParts: string[] = [];

  if (completed.length > 0) {
    summaryParts.push(`## Completed Tasks (${completed.length}/${taskResults.length})\n`);
    for (const task of completed) {
      summaryParts.push(`### ${task.id}: ${task.description}\n`);
      summaryParts.push(`*Agent: ${task.agentType}*\n`);
      if (task.result) {
        const truncated = task.result.length > maxLen ? task.result.slice(0, maxLen) + '\n...(truncated)' : task.result;
        summaryParts.push(truncated);
      }
      summaryParts.push('');
    }
  }

  if (failed.length > 0) {
    summaryParts.push(`## Failed Tasks (${failed.length})\n`);
    for (const task of failed) {
      summaryParts.push(`### ${task.id}: ${task.description}\n`);
      summaryParts.push(`*Agent: ${task.agentType}*\n`);
      summaryParts.push(`**Error:** ${task.error}\n`);
    }
  }

  if (cascadeFailed.length > 0) {
    summaryParts.push(`## Cascade-Failed Tasks (${cascadeFailed.length})\n`);
    for (const task of cascadeFailed) {
      summaryParts.push(`- ${task.id}: ${task.description} — ${task.error}\n`);
    }
  }

  if (pending.length > 0) {
    summaryParts.push(`## Skipped Tasks (${pending.length})\n`);
    for (const task of pending) {
      summaryParts.push(`- ${task.id}: ${task.description}\n`);
    }
  }

  return { success, taskResults, summary: summaryParts.join('\n') };
}
