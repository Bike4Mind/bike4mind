import OpenAI from 'openai';
import { Logger } from '@bike4mind/observability';
import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClientConfig } from '@bike4mind/common';

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

/**
 * Bedrock Guardrails moderation. Used as a fallback when no OpenAI key is
 * available, so Bedrock-routed traffic gets the same prompt-moderation coverage.
 * The client is constructed lazily so a missing BEDROCK_AWS_* config on self-host
 * only rejects at the first checkPrompt call, not at construction time.
 */
export class BedrockGuardrailsService implements ModerationService {
  private _client: BedrockRuntimeClient | null = null;

  constructor(
    private readonly guardrailId: string,
    private readonly guardrailVersion: string,
    private readonly logger: Logger
  ) {}

  private get client(): BedrockRuntimeClient {
    if (!this._client) {
      this._client = new BedrockRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-2',
        ...bedrockClientConfig(),
      });
    }
    return this._client;
  }

  async checkPrompt(prompt: string): Promise<void> {
    const response = await this.client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.guardrailId,
        guardrailVersion: this.guardrailVersion,
        source: 'INPUT',
        content: [{ text: { text: prompt } }],
      })
    );

    if (response.action === 'GUARDRAIL_INTERVENED') {
      const categories: string[] = [];
      for (const assessment of response.assessments ?? []) {
        for (const topic of assessment.topicPolicy?.topics ?? []) {
          if (topic.action === 'BLOCKED' && topic.name) categories.push(topic.name);
        }
        for (const filter of assessment.contentPolicy?.filters ?? []) {
          if (filter.action === 'BLOCKED' && filter.type) categories.push(filter.type);
        }
      }
      this.logger.error('Prompt flagged by Bedrock Guardrails:', { guardrailId: this.guardrailId, categories });
      throw new FlaggedContentError(
        `We're sorry, your prompt has been flagged for potential harmful content on the following categories: ${categories.join(', ')}`,
        categories
      );
    }
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
