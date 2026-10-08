import { AGENT_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';
import { BadRequestError, UnprocessableEntityError } from '@server/utils/errors';

/**
 * The shared agent validators (createAgent, server/utils/agentValidation) reject a well-formed but
 * invalid body with a 400, which the SPA routes keep. On /api/v1 a body rejection is a 422
 * (CONVENTIONS.md status table); only the tier cap stays a 400, under its `agent_limit_reached` code.
 */
export function toV1AgentError(error: unknown): unknown {
  if (error instanceof BadRequestError && error.additionalInfo?.errorCode !== AGENT_LIMIT_REACHED_ERROR_CODE) {
    return new UnprocessableEntityError(error.message);
  }
  return error;
}
