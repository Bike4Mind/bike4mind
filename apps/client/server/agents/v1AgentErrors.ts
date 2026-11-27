import { AgentValidationError } from '@server/utils/agentValidation';
import { ExpectedImageGenerationError } from '@bike4mind/utils';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import {
  BadGatewayError,
  HTTPError,
  TooManyRequestsError,
  UnprocessableEntityError,
} from '@bike4mind/server-utils/utils/errors';
import { AuthoringResultError } from '@server/agents/authoring/authoringErrors';
import { SystemPromptRateLimitError } from '@server/agents/systemPromptRateLimit';

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

/**
 * The authoring assistants swallow nothing: a typed HTTP error (the feature is off, a quota or rate
 * limit, no model configured) keeps its own status, and every other failure is the model or image
 * provider not producing a result, a 502 whose message never carries the raw upstream text.
 */
export function toV1AuthoringError(error: unknown): HTTPError {
  // CONVENTIONS section 1: a rate limit is a 429 on /api/v1, where the SPA route keeps its 400.
  if (error instanceof SystemPromptRateLimitError) return new TooManyRequestsError(error.message);
  // An empty model result or a failed save is the provider side failing, not a bad request.
  if (error instanceof AuthoringResultError) return new BadGatewayError(error.message);
  if (error instanceof HTTPError) return error;
  if (error instanceof ExpectedImageGenerationError) return new BadGatewayError(error.message);
  if (error instanceof ImageModerationBlockedError) {
    return new BadGatewayError('The generated avatar was flagged by content moderation and could not be saved.');
  }
  return new BadGatewayError('The model failed to produce a result. Try again later.');
}
