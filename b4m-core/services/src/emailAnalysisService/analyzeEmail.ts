import { BadRequestError } from '@bike4mind/utils';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { ChatModels } from '@bike4mind/common';
import {
  EmailAnalysisInput,
  EmailAnalysisResult,
  EmailAnalysisOptions,
  llmAnalysisResponseSchema,
  EmailActionItem,
} from './types';
import { DEFAULT_EMAIL_ANALYSIS_PROMPT } from './defaultPrompt';
import { buildPrompt } from './templateEngine';

/**
 * Adapter interface for LLM operations
 */
export interface ILLMAdapter {
  /**
   * LLM backend instance (Anthropic, OpenAI, Bedrock, etc.)
   */
  backend: ICompletionBackend;
}

/**
 * Adapters required for email analysis
 */
export interface EmailAnalysisAdapters {
  llm: ILLMAdapter;
}

/**
 * Parse deadline string to Date object
 * Supports formats: YYYY-MM-DD, ISO 8601, natural language hints
 */
function parseDeadline(deadlineStr: string | undefined): Date | undefined {
  if (!deadlineStr) return undefined;

  try {
    // Try to parse as ISO date
    const date = new Date(deadlineStr);
    if (!isNaN(date.getTime())) {
      return date;
    }
  } catch (error) {
    Logger.warn('Failed to parse deadline:', deadlineStr);
  }

  return undefined;
}

/**
 * Extract JSON from LLM response that might contain markdown code blocks
 */
function extractJsonFromResponse(response: string): string {
  // Remove markdown code blocks if present
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  // Also try just ``` blocks
  const codeBlockMatch = response.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Return as-is if no code blocks found
  return response.trim();
}

/**
 * Analyze an email using AI to extract structured information
 *
 * This function:
 * 1. Builds a prompt from the meta-prompt template and email data
 * 2. Sends the prompt to the LLM (Claude 3.5 Sonnet by default)
 * 3. Parses the JSON response
 * 4. Validates and transforms the data into EmailAnalysisResult
 *
 * @param email - Email data to analyze
 * @param adapters - LLM adapter for making completion requests
 * @param options - Optional configuration (custom prompt, model, temperature)
 * @returns Promise<EmailAnalysisResult> - Structured analysis result
 * @throws ValidationError if LLM response doesn't match expected schema
 */
export async function analyzeEmail(
  email: EmailAnalysisInput,
  adapters: EmailAnalysisAdapters,
  options?: EmailAnalysisOptions
): Promise<EmailAnalysisResult> {
  const logger = new Logger();

  // 1. Build the prompt by substituting variables into the template
  const metaPrompt = options?.metaPrompt || DEFAULT_EMAIL_ANALYSIS_PROMPT;
  const prompt = buildPrompt(metaPrompt, email, {
    userEmail: options?.context?.userEmail,
  });

  logger.info('Starting email analysis', {
    from: email.from,
    subject: email.subject,
    model: options?.model || ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
  });

  // 2. Prepare LLM request
  const model = options?.model || ChatModels.CLAUDE_4_5_HAIKU_BEDROCK;
  const temperature = options?.temperature ?? 0.3; // Low temperature for structured output

  const messages = [
    {
      role: 'user' as const,
      content: prompt,
    },
  ];

  // 3. Call LLM and collect response
  let responseText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  await adapters.llm.backend.complete(
    model,
    messages,
    {
      temperature,
      maxTokens: 2000, // Sufficient for structured JSON output
      stream: false, // Don't stream for structured output
    },
    async (texts, completionInfo) => {
      // Concatenate all response chunks
      if (texts && texts.length > 0) {
        responseText += texts.join('');
      }

      // Capture token usage
      if (completionInfo) {
        inputTokens = completionInfo.inputTokens || 0;
        outputTokens = completionInfo.outputTokens || 0;
      }
    }
  );

  logger.info('LLM analysis completed', {
    responseLength: responseText.length,
    inputTokens,
    outputTokens,
  });

  // 4. Parse and validate the JSON response
  const jsonStr = extractJsonFromResponse(responseText);

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(jsonStr);
  } catch (error) {
    logger.error('Failed to parse LLM response as JSON', {
      response: responseText.substring(0, 500),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new BadRequestError('LLM returned invalid JSON response');
  }

  // Validate against Zod schema
  const validationResult = llmAnalysisResponseSchema.safeParse(parsedResponse);

  if (!validationResult.success) {
    logger.error('LLM response failed schema validation', {
      errors: validationResult.error.issues,
      response: parsedResponse,
    });
    throw new BadRequestError(`Invalid analysis structure: ${validationResult.error.message}`);
  }

  const validated = validationResult.data;

  // 5. Transform action items with parsed deadlines
  const actionItems: EmailActionItem[] = validated.actionItems.map(item => ({
    description: item.description,
    deadline: parseDeadline(item.deadline),
  }));

  // 6. Build final result with token usage
  const result: EmailAnalysisResult = {
    summary: validated.summary,
    entities: {
      companies: validated.entities.companies,
      people: validated.entities.people,
      products: validated.entities.products,
      technologies: validated.entities.technologies,
    },
    sentiment: validated.sentiment,
    actionItems,
    privacyRecommendation: validated.privacyRecommendation,
    embargoDetected: validated.embargoDetected,
    suggestedTags: validated.suggestedTags,
    tokensUsed: {
      input: inputTokens,
      output: outputTokens,
    },
  };

  logger.info('Email analysis successful', {
    summary: result.summary.substring(0, 100),
    entityCount:
      result.entities.companies.length +
      result.entities.people.length +
      result.entities.products.length +
      result.entities.technologies.length,
    sentiment: result.sentiment,
    actionItemCount: result.actionItems.length,
    tagCount: result.suggestedTags.length,
    inputTokens,
    outputTokens,
  });

  return result;
}
