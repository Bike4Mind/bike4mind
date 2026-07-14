import { BadRequestError, InternalServerError } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { ChatModels } from '@bike4mind/common';

const SingleMementoEvalSchema = z.object({
  importance: z.number().min(1).max(10), // 1-10 scale for personal info importance
  summary: z.string(),
  tags: z.array(z.string()).optional(),
});

const MementoEvalResponseSchema = z.object({
  isPersonal: z.boolean(),
  mementos: z.array(SingleMementoEvalSchema).optional(), // Array of distinct personal information
});

/**
 * The extraction prompt. Exported and pure because it is the single highest-leverage piece of text in
 * the memory system, and no retrieval metric can see it going wrong: a memento written as narration
 * retrieves EXACTLY as well as one written as a fact (filler is common-mode in the embedding and cancels
 * in the cosine). What it costs is what the user experiences - narration-style memories lost 13-1 to
 * fact-style ones under a blind judge, because the assistant ends up reading a transcript back under a
 * heading that says KNOWN FACTS ABOUT THE USER.
 */
export const buildMementoExtractionPrompt = (prompt: string): string => `
      You are a memory evaluator for a personal AI assistant. Your task is to identify ALL distinct pieces of personally significant information in a user interaction, similar to ChatGPT's memory feature.

      IMPORTANT: A single prompt may contain MULTIPLE distinct pieces of personal information. Identify and separate each one.

      ONLY mark interactions as personal (isPersonal: true) if they contain information ABOUT THE USER, such as:
      - Personal preferences (e.g., "I prefer dark mode", "I like coffee without sugar")
      - Life circumstances (e.g., "I'm a software engineer", "I live in Tokyo", "I have two kids")
      - Goals and aspirations (e.g., "I'm learning Spanish", "I want to build a startup")
      - Relationships (e.g., "My dog's name is Max", "My partner loves gardening")
      - Personal experiences (e.g., "I visited Paris last year", "I enjoy hiking on weekends")
      - Important context about the user's work, hobbies, or interests

      DO NOT mark as personal (isPersonal: false) for:
      - General questions or knowledge queries (e.g., "What is React?", "How do I center a div?")
      - Technical assistance without personal context (e.g., "Fix this bug", "Explain this code")
      - Casual conversation without revealing user information
      - Requests for generic information or explanations
      - Code generation or debugging tasks

      For EACH piece of personal information, rate importance on a 1-10 scale:
      - 9-10: Critical information (health issues, core values, major life goals)
      - 7-8: Very important (job role, family details, significant preferences)
      - 5-6: Moderately important (hobbies, casual preferences, interests)
      - 3-4: Somewhat important (minor preferences, casual facts)
      - 1-2: Low importance (trivial preferences)

      HOW TO WRITE THE SUMMARY - this is the part that decides whether the memory is any good:

      Write the FACT. Do not narrate the conversation. A memory is a durable statement about the PERSON,
      and it has to still read as one a year later with no conversation around it. It gets injected into
      a future prompt under the heading "KNOWN FACTS ABOUT THE USER", so anything that describes an
      exchange rather than a person makes the assistant sound like it is reading back a transcript.

      NEVER write:
        - "The user said/shared/asked/mentioned that ..."   <- narration
        - "The assistant replied/correctly informed ..."     <- the assistant is not a fact about the user
        - "This indicates that ..." / "suggesting that ..."  <- hedging. State it or drop it.
      ALWAYS write the bare fact:
        BAD : "The user shared his middle name, Paul, but clarified he does not generally use it."
        GOOD: "Middle name is Paul, though he rarely uses it."
        BAD : "The user conducts discovery calls, suggesting a role in sales."
        GOOD: "Works in sales."
        BAD : "The user asked the assistant for their name, and the AI declined."
        GOOD: (nothing - this is a record of an exchange, not a fact about the person. isPersonal: false.)

      Keep every specific - names, numbers, places, products, models. Those ARE the value.
      Keep a fact whole; do not shred one memento into many fragments. Split only genuinely unrelated
      facts (a job and an allergy are two mementos; a city and the state it is in are one).

      LIMIT: Return a maximum of 10 distinct mementos per evaluation to keep responses focused.

      User Prompt:
      ${prompt}

      Respond in JSON format:
      {
        "isPersonal": true/false,
        "mementos": [
          {
            "importance": 1-10,
            "summary": "The fact itself, stated plainly - NOT a description of the conversation",
            "tags": ["tag1", "tag2"] (optional)
          },
          // ... more mementos for each distinct piece of information
        ] (ONLY if isPersonal is true)
      }

      If isPersonal is false, you can omit the mementos array.

      Example:
      User Prompt: "I'm a software engineer living in Tokyo, and my dog Max loves hiking"
      Response:
      {
        "isPersonal": true,
        "mementos": [
          {
            "importance": 7,
            "summary": "User is a software engineer",
            "tags": ["profession", "career"]
          },
          {
            "importance": 6,
            "summary": "User lives in Tokyo",
            "tags": ["location", "residence"]
          },
          {
            "importance": 5,
            "summary": "User has a dog named Max who loves hiking",
            "tags": ["pet", "hobbies"]
          }
        ]
      }
    `;

export class MementoEvaluationService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async evaluate({
    apiKeyTable,
    model = ChatModels.GPT4_1_MINI,
    prompt,
    endUserId,
  }: {
    apiKeyTable: ApiKeyTable;
    model?: ChatModels;
    prompt: string;
    /** End user whose prompt is being evaluated, for provider abuse attribution. */
    endUserId?: string;
  }): Promise<Array<z.infer<typeof SingleMementoEvalSchema>> | null> {
    let responseContent = '';

    try {
      // TODO: Pass `settings` to getAvailableModels()
      const modelInfo = (await getAvailableModels(apiKeyTable)).find(m => m.id === model);
      if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

      const llm = getLlmByModel(apiKeyTable, {
        modelInfo,
        logger: this.logger,
        endUserId,
      });
      if (!llm) throw new InternalServerError(`Failed to initialize LLM for model: "${model}"`);

      const llmPrompt = buildMementoExtractionPrompt(prompt);

      this.logger.debug('Prepared LLM prompt for evaluation', { promptLength: llmPrompt.length });

      await llm.complete(
        model,
        [{ role: 'user', content: llmPrompt }],
        {
          temperature: 0.7,
          maxTokens: 800, // Increased to accommodate multiple mementos
        },
        async texts => {
          responseContent += texts.join('');
          this.logger.debug('Received streaming response chunk', { chunkLength: texts.join('').length });
        }
      );

      this.logger.debug('Raw LLM response received', { responseContent });

      // Get string containing open and close brackets only {}
      const validJsonStringOnly = responseContent.match(/\{[\s\S]*\}/)?.[0];
      const content = JSON.parse(validJsonStringOnly || '{}');
      const parsedContent = MementoEvalResponseSchema.parse(content);

      // Return null if the interaction is not personally significant
      if (!parsedContent.isPersonal) {
        this.logger.info('Interaction not personally significant, skipping memento creation');
        return null;
      }

      // Return null if no mementos were identified
      if (!parsedContent.mementos || parsedContent.mementos.length === 0) {
        this.logger.info('No mementos identified in personal interaction, skipping memento creation');
        return null;
      }

      this.logger.info('Successfully evaluated mementos', {
        count: parsedContent.mementos.length,
        summaries: parsedContent.mementos.map(m => m.summary),
      });

      return parsedContent.mementos;
    } catch (error) {
      this.logger.updateMetadata({
        responseContent,
      });
      this.logger.warn('Failed to evaluate memento:', error);
      return null;
    }
  }
}
