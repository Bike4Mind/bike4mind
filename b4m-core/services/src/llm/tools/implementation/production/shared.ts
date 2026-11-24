import { NotFoundError, StudioCompositionIdSchema, UnprocessableEntityError, type StudioShot } from '@bike4mind/common';
import { isTerminalToolError } from '@bike4mind/llm-adapters';
import type { ToolContext } from '../../base/types';
import type { ProductionComposition, ProductionToolConfig } from './config';

export const CompositionIdArg = StudioCompositionIdSchema.describe(
  'The production (composition) id, from the context that started this run.'
);

/** A tool failure the model can act on, as opposed to an unexpected one, which is logged. */
export class ProductionToolError extends Error {}

const issueList = (error: UnprocessableEntityError): string => {
  const issues = error.additionalInfo?.issues;
  if (!Array.isArray(issues)) return '';
  return issues
    .slice(0, 5)
    .map(issue => {
      const { path, message } = issue as { path?: unknown[]; message?: string };
      return `${Array.isArray(path) ? path.join('.') : ''}: ${message ?? ''}`;
    })
    .join('; ');
};

/** Maps the composition service's refusals to text for the model; terminal errors are rethrown, anything else is logged and reported. */
export function describeProductionError(
  error: unknown,
  logger: Pick<ToolContext['logger'], 'error'>,
  toolName: string
): string {
  // Terminal errors (permission, credits) still end the turn.
  if (isTerminalToolError(error)) throw error;
  if (error instanceof ProductionToolError) return `Error: ${error.message}`;
  if (error instanceof NotFoundError)
    return 'Error: that production was not found. Use the production id from this conversation (the Direct message names it), not a file id.';
  if (error instanceof UnprocessableEntityError) {
    const issues = issueList(error);
    return `Error: the production was not saved (${error.message}${issues ? `: ${issues}` : ''}).`;
  }
  // Anything else is logged and reported so the director can tell the user what failed.
  logger.error(`[${toolName}] unexpected failure`, error);
  const message = error instanceof Error ? error.message : String(error);
  return `Error: this step failed unexpectedly (${message}). Tell the user what this step was and that it failed.`;
}

/**
 * Read-modify-write of the shots, re-reading first so a write by another call (or the editor) since this call
 * started is kept. Last write still wins: compositions carry no version to compare.
 */
export async function updateShots(
  config: ProductionToolConfig,
  compositionId: string,
  update: (shots: StudioShot[]) => StudioShot[]
): Promise<ProductionComposition> {
  const fresh = await config.compositions.get(compositionId);
  return config.compositions.update(compositionId, { shots: update(fresh.shots) });
}

/** The aspect ratio the takes are framed for: the first output's, which the editor previews. */
export const primaryAspectRatio = (composition: ProductionComposition): string =>
  composition.timeline.outputs[0]?.aspectRatio ?? '16:9';
