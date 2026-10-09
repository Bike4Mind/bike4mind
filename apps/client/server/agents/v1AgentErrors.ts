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
