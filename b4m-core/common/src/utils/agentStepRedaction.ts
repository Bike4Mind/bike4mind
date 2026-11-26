import type { IAgentStep } from '../schemas/actions';

/**
 * Blank the verbatim tool output on `observation` steps for a viewer who only holds a share on the
 * run's session. An observation is what the owner's tool returned on the owner's behalf (file
 * contents, retrieved passages, integration data), so a share grant to read the conversation does
 * not extend to it - the same policy as `OWNER_ONLY_FUNCTION_CALL_FIELDS` for `promptMeta`.
 *
 * The step itself is kept (type, tool name, iteration) so the trace still groups and renders by
 * iteration; only `content` is emptied. The tool's INPUT (`metadata.toolInput`) stays: it is the same
 * data as `promptMeta.functionCalls[].parameters`, which a share viewer keeps by the same policy.
 *
 * Returns the input array when there is nothing to redact, and never mutates it.
 */
export function redactAgentStepsForViewer<T extends Pick<IAgentStep, 'type' | 'content'>>(
  steps: T[],
  isOwner: boolean
): T[] {
  if (isOwner || !steps.some(step => step.type === 'observation' && step.content !== '')) return steps;
  return steps.map(step => (step.type === 'observation' ? { ...step, content: '' } : step));
}
