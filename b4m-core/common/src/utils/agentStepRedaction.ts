import type { IAgentStep } from '../schemas/actions';

type RedactableStep = Pick<IAgentStep, 'type' | 'content' | 'metadata'>;

const hasToolOutput = (step: RedactableStep) => step.type === 'observation' && step.content !== '';

const hasOwnerOnlyMetadata = (step: RedactableStep) =>
  step.metadata !== undefined && ('toolInput' in step.metadata || 'confidenceReason' in step.metadata);

function redactStep<T extends RedactableStep>(step: T): T {
  let next = step;
  if (hasToolOutput(step)) next = { ...next, content: '' };
  if (step.metadata && hasOwnerOnlyMetadata(step)) {
    const metadata = { ...step.metadata };
    delete metadata.toolInput;
    delete metadata.confidenceReason;
    next = { ...next, metadata };
  }
  return next;
}

/**
 * Strip what the owner's run produced on the owner's behalf from the steps of a trace read by a
 * viewer who only holds a share on the run's session. A share grant to read the conversation does
 * not extend to: the verbatim tool output on `observation` steps (file contents, retrieved passages,
 * integration data), the tool's input (`metadata.toolInput`), or the model's free-text
 * `metadata.confidenceReason`. Observation content follows the same policy as
 * `OWNER_ONLY_FUNCTION_CALL_FIELDS` for `promptMeta`; `promptMeta.functionCalls[].parameters` is
 * governed separately, see promptMetaRedaction.ts.
 *
 * The step itself is kept (type, tool name, iteration, timestamp) so the trace still groups and
 * renders by iteration; observation `content` is emptied and the two metadata fields are dropped.
 *
 * Returns the input array when there is nothing to redact, and never mutates it.
 */
export function redactAgentStepsForViewer<T extends RedactableStep>(steps: T[], isOwner: boolean): T[] {
  if (isOwner || !steps.some(step => hasToolOutput(step) || hasOwnerOnlyMetadata(step))) return steps;
  return steps.map(redactStep);
}
