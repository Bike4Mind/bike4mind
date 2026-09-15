import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { BadRequestError, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';
import { z } from 'zod';
import { stripFabricatedLinks } from '@server/utils/sanitizeHelpLinks';
import { searchHelpContext, type RelevantArticle } from '@server/help/retrieval';

/** Max tokens for the LLM response */
const MAX_RESPONSE_TOKENS = 1000;

/**
 * Help Chat Schema - validates incoming chat requests
 */
const HelpChatSchema = z.object({
  question: z.string().min(1).max(2000),
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(10000),
      })
    )
    .max(20)
    .optional()
    .prefault([]),
  currentHelpSlug: z
    .string()
    .regex(/^[a-zA-Z0-9\-_\/]+$/)
    .optional(),
});

// ===========================
// System prompt
// ===========================

// Brand is resolved at module load from APP_NAME (no brand fallback - empty when unconfigured),
// so the prompt stays brand-neutral on a fresh clone. process.env is available server-side.
const HELP_BRAND = process.env.APP_NAME || '';
const HELP_ASSISTANT_NAME = HELP_BRAND ? `${HELP_BRAND} Help Assistant` : 'Help Assistant';

const HELP_SYSTEM_PROMPT_BASE = `You are the ${HELP_ASSISTANT_NAME}. You help users understand and use ${HELP_BRAND || 'this platform'} — a powerful AI-powered knowledge management and productivity platform.

Users are chatting with you from inside the help system, so assume their questions are about the platform${HELP_BRAND ? ` even if they don't mention "${HELP_BRAND}" by name` : ''}. For example, "How can I collaborate on AI chats with coworkers?" is a question about the platform's collaboration features.

When answering questions:
1. Be concise and direct — users want quick answers
2. Use bullet points and formatting to make responses scannable
3. Only decline to answer if the question is clearly off-topic (e.g., cooking recipes, sports scores, math homework). When declining, briefly mention you're the ${HELP_ASSISTANT_NAME} and suggest a relevant on-topic question they could ask.
4. NEVER write URLs or markdown links, and NEVER guess at link targets, file paths, or page addresses (e.g. do not output things like "/ai-models.md", "[AI Models](...)", or any "https://your-deployment.example.com/..." URL). You do not know the real addresses of documentation pages, so any link you write will be wrong. Relevant help articles are shown to the user automatically as clickable links beneath your answer — so just refer to features by name in plain text (e.g. **AI Models**) and let those links handle navigation.`;

const HELP_SYSTEM_PROMPT_SUFFIX = `Answer the user's question based ONLY on the documentation above. Never invent or guess at features that aren't documented — if the question seems on-topic but the docs don't cover it, let the user know the specific topic isn't covered in the current documentation and suggest they contact support for more details.`;

/**
 * Build the complete system prompt by injecting a documentation context section
 */
function buildSystemPrompt(contextSection: string): string {
  return `${HELP_SYSTEM_PROMPT_BASE}
${contextSection}
${HELP_SYSTEM_PROMPT_SUFFIX}`;
}

// ===========================
// Main handler
// ===========================

/**
 * Help Chat API Endpoint
 *
 * Provides AI-powered help chat grounded in documentation. Retrieval (vector search with keyword
 * fallback) lives in the shared `@server/help/retrieval` module; this endpoint wraps the retrieved
 * context in the help-assistant system prompt and runs a fast LLM over it.
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 100 : 20,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const startTime = Date.now();

    try {
      // Validate request
      const { question, conversationHistory, currentHelpSlug } = HelpChatSchema.parse(req.body);
      const userId = req.user?.id;

      if (!userId) {
        throw new BadRequestError('User not authenticated');
      }

      req.logger.info(`[HelpChat] Question received: "${question.slice(0, 50)}..."`);

      // Get API keys early - needed for both embedding query and LLM call
      const dbAdapters = {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      };
      const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);

      // Retrieve relevant documentation (vector search -> keyword fallback) and wrap it in the
      // help-assistant system prompt.
      const helpResult = await searchHelpContext({
        question,
        currentHelpSlug,
        isAdmin: !!req.user?.isAdmin,
        apiKeys: apiKeyTable,
        logger: req.logger,
      });
      const systemPrompt = buildSystemPrompt(helpResult.context);
      const relevantArticles: RelevantArticle[] = helpResult.relevantArticles;

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...conversationHistory.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
        { role: 'user' as const, content: question },
      ];

      // Get LLM - use a fast, cost-effective model for help chat
      const models = await getAvailableModels(apiKeyTable);

      // Prefer fast, cheap models for help chat (not charged to users)
      const preferredModels = [
        ChatModels.GPT4_1_MINI,
        ChatModels.CLAUDE_4_5_HAIKU,
        ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
        ChatModels.GEMINI_2_5_FLASH,
        ChatModels.GPT4o_MINI,
      ];
      let modelInfo = null;
      for (const modelId of preferredModels) {
        modelInfo = models.find(m => m.id === modelId);
        if (modelInfo) break;
      }

      // Fall back to any available model
      if (!modelInfo && models.length > 0) {
        modelInfo = models[0];
      }

      if (!modelInfo) {
        throw new BadRequestError('No AI model available. Please check your API keys.');
      }

      const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: userId });
      if (!llm) {
        throw new BadRequestError(`Model "${modelInfo.id}" is not available.`);
      }

      req.logger.info(`[HelpChat] Using model: ${modelInfo.id} (retrieval: ${helpResult.method})`);

      // Generate completion (non-streaming for simplicity)
      const options = {
        max_tokens: MAX_RESPONSE_TOKENS,
        temperature: 0.7,
        stream: false,
      };

      let responseText = '';

      await llm.complete(
        // any: modelInfo.id is a dynamic string that can't be narrowed to the union of model ID literals
        modelInfo.id as any,
        messages,
        options,
        async (streamedTexts: (string | null | undefined)[]) => {
          const text = streamedTexts[0] || streamedTexts[1] || '';
          if (text) {
            responseText = text;
          }
        }
      );

      const latency = Date.now() - startTime;
      req.logger.info(`[HelpChat] Completed in ${latency}ms`);

      res.json({
        response: stripFabricatedLinks(responseText),
        model: modelInfo.id,
        latency,
        relevantArticles,
      });
    } catch (error) {
      req.logger.error('[HelpChat] Error:', error);
      res.status(error instanceof BadRequestError ? 400 : 500).json({
        error: error instanceof Error ? error.message : 'An error occurred',
      });
    }
  });

export default handler;
