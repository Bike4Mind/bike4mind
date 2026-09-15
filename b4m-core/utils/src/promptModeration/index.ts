import OpenAI from 'openai';
import { Logger } from '@bike4mind/observability';

export interface ModerationService {
  /**
   * Function that checks the prompt for any potential harmful content.
   * If the prompt contains harmful content, the function will throw an error with the reason.
   */
  checkPrompt(prompt: string): Promise<void>;
}

/**
 * Thrown by {@link ModerationService.checkPrompt} when a prompt is flagged. Carries the
 * flagged category labels so callers can record a per-user moderation hit before
 * surfacing the block to the user. The `message` stays user-facing and unchanged.
 */
export class FlaggedContentError extends Error {
  constructor(
    message: string,
    public readonly categories: string[]
  ) {
    super(message);
    this.name = 'FlaggedContentError';
  }
}

export class OpenaiModerationsService implements ModerationService {
  private openai: OpenAI;

  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger
  ) {
    this.openai = new OpenAI({ apiKey: this.apiKey });
  }

  /**
   * Checks the prompt for any potential harmful content.
   * If the prompt contains harmful content, the function will throw an error with the reason.
   */
  async checkPrompt(prompt: string): Promise<void> {
    const moderation = await this.openai.moderations.create({
      model: 'text-moderation-latest',
      input: prompt,
    });

    const result = moderation.results[0];

    if (result.flagged) {
      const flaggedCategories = Object.entries(result.categories).reduce<string[]>((acc, [category, value]) => {
        if (value) {
          acc.push(category);
        }
        return acc;
      }, []);

      this.logger.error(`Prompt has been flagged for potential harmful content:`, JSON.stringify(moderation, null, 2));

      throw new FlaggedContentError(
        `We're sorry, your prompt has been flagged for potential harmful content on the following categories: ${flaggedCategories.join(
          ', '
        )}`,
        flaggedCategories
      );
    }
  }
}
