import { AgentValidationError } from '@server/utils/agentValidation';
import { UnprocessableEntityError } from '@server/utils/errors';

/**
 * The shared agent validators (createAgent, server/utils/agentValidation) reject an invalid body field
 * with an AgentValidationError, a 400 the SPA routes keep. On /api/v1 a body rejection is a 422
 * (CONVENTIONS.md status table); every other error, including the tier cap's 400, passes through.
 */
export function toV1AgentError(error: unknown): unknown {
  if (error instanceof AgentValidationError) {
    return new UnprocessableEntityError(error.message);
  }
  return error;
}

// The shared validators name the stored camelCase field; a v1 error names the caller's snake_case spelling.
const V1_FIELD_NAMES: Record<string, string> = { allowedTools: 'allowed_tools', deniedTools: 'denied_tools' };

export const v1FieldLabel = (field: string) => V1_FIELD_NAMES[field] ?? field;
