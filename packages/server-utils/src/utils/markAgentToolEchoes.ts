import { buildToolEchoSourcesFromSteps } from '@bike4mind/services/llm';
import { createToolEchoMatcher, markToolEchoes } from '@bike4mind/utils';

/**
 * The steps an execution persisted: `result.steps` once a terminal write landed, else the
 * in-flight `checkpoint.steps` (gate stop and abort persist before any result exists).
 */
export function persistedExecutionSteps(execution: { result?: unknown; checkpoint?: unknown }): unknown[] {
  const stepsOf = (holder: unknown): unknown =>
    holder && typeof holder === 'object' ? (holder as { steps?: unknown }).steps : undefined;
  const fromResult = stepsOf(execution.result);
  if (Array.isArray(fromResult)) return fromResult;
  const fromCheckpoint = stepsOf(execution.checkpoint);
  return Array.isArray(fromCheckpoint) ? fromCheckpoint : [];
}

/**
 * Marks web tool output an agent reply quoted back, so the client renders it as a code block
 * instead of promoting it to an artifact. Agent-path twin of ChatCompletionProcess post_process.
 */
export function createAgentToolEchoMarker(steps: readonly unknown[]): (text: string) => string {
  const sources = buildToolEchoSourcesFromSteps(steps);
  if (sources.length === 0) return text => text;
  const isToolEcho = createToolEchoMatcher(sources);
  return text => markToolEchoes(text, isToolEcho);
}
