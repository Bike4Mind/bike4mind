import { BadRequestError } from '@bike4mind/utils';

/** A BadRequestError so the SPA route keeps its 400; the public v1 route reports it as a 429. */
export class SystemPromptRateLimitError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPromptRateLimitError';
  }
}

/**
 * Throws when an agent's system prompt was generated less than rateLimitSeconds ago.
 * Keyed on lastSystemPromptGeneratedAt, which only an actual generation sets - an
 * agent that has never been generated for is always allowed through.
 */
export const assertSystemPromptGenerationAllowed = (
  agent: { lastSystemPromptGeneratedAt?: Date | string | null },
  rateLimitSeconds: number,
  now: number = Date.now()
): void => {
  if (rateLimitSeconds <= 0) return;

  const lastGeneration = agent.lastSystemPromptGeneratedAt;
  if (!lastGeneration) return;

  const lastGenerationMs = new Date(lastGeneration).getTime();
  if (Number.isNaN(lastGenerationMs)) return;

  const timeRemainingMs = rateLimitSeconds * 1000 - (now - lastGenerationMs);
  if (timeRemainingMs <= 0) return;

  throw new SystemPromptRateLimitError(
    `Rate limit exceeded. Please wait ${Math.ceil(
      timeRemainingMs / 1000
    )} seconds before generating another system prompt.`
  );
};
