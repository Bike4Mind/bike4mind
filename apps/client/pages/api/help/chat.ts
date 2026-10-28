import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { blockedAtZeroTierLimit } from '@server/middlewares/perUserRateLimit';
import {
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  organizationRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { apiKeyService, recordOperationalUsage } from '@bike4mind/services';
import { BadRequestError, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import {
  ChatModels,
  CreditHolderType,
  ForbiddenError,
  UnprocessableEntityError,
  getEmbeddingModelCost,
  getTextModelCost,
  type IMessage,
  type ModelInfo,
} from '@bike4mind/common';
import { z } from 'zod';
import { stripFabricatedLinks } from '@server/utils/sanitizeHelpLinks';
import { searchHelpContext, type RelevantArticle } from '@server/help/retrieval';
import {
  completionRequestCeilingUsd,
  completionUsd,
  createModelAdmission,
  hasReportedUsage,
  latchUsage,
  reserveCompletionCredits,
  settleCompletion,
  type CompletionUsage,
} from '@server/billing/meterPlatformCompletion';

/** Max tokens for the LLM response */
const MAX_RESPONSE_TOKENS = 1000;

/**
 * Input-token allowance for the retrieved documentation, which is only known after the hold is
 * placed (retrieval embeds the question, so it must not run before the credit check). Sized to
 * MAX_CONTEXT_TOKENS in server/help/retrieval.ts; keep the two in sync.
 */
const HELP_CONTEXT_TOKEN_ALLOWANCE = 4000;

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
      limit: blockedAtZeroTierLimit(process.env.NODE_ENV === 'development' ? 100 : 20),
      windowMs: 60 * 1000,
    })
  )
  .post(
    withRequestCompletionQuota(async (req, res) => {
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

        // Pick the model first so the credit hold lands before retrieval's query embedding.
        const models = await getAvailableModels(apiKeyTable);

        // Prefer fast, cheap models for help chat, then any model the catalog admits for this user.
        const preferredModels = [
          ChatModels.GPT4_1_MINI,
          ChatModels.CLAUDE_4_5_HAIKU,
          ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
          ChatModels.GEMINI_2_5_FLASH,
          ChatModels.GPT4o_MINI,
        ];
        const candidates = [
          ...preferredModels.flatMap(id => models.filter(m => m.id === id)),
          ...models.filter(m => m.type === 'text'),
        ];
        if (candidates.length === 0) {
          throw new BadRequestError('No AI model available. Please check your API keys.');
        }
        const admission = await createModelAdmission(req.user, models);
        let modelInfo: ModelInfo | undefined;
        for (const candidate of candidates) {
          if (await admission.admits(candidate.id)) {
            modelInfo = candidate;
            break;
          }
        }
        if (!modelInfo) {
          throw new ForbiddenError(`Model "${candidates[0].id}" is not accessible and no fallback available`);
        }

        const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: userId });
        if (!llm) {
          throw new BadRequestError(`Model "${modelInfo.id}" is not available.`);
        }

        const history: IMessage[] = conversationHistory.map(msg => ({ role: msg.role, content: msg.content }));
        const ceilingUsd =
          completionRequestCeilingUsd(
            modelInfo,
            [{ role: 'system', content: buildSystemPrompt('') }, ...history, { role: 'user', content: question }],
            MAX_RESPONSE_TOKENS
          ) + getTextModelCost(modelInfo, HELP_CONTEXT_TOKEN_ALLOWANCE, 0);
        const reservation = await reserveCompletionCredits(req, ceilingUsd, 'help chat');

        let responseText = '';
        let relevantArticles: RelevantArticle[];
        const usage: CompletionUsage = {};
        const settleUsage = (usd: number) =>
          settleCompletion(reservation, req, {
            model: modelInfo.id,
            provider: modelInfo.backend,
            usd,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
        try {
          // Retrieve relevant documentation (vector search -> keyword fallback) and wrap it in the
          // help-assistant system prompt.
          const helpResult = await searchHelpContext({
            question,
            currentHelpSlug,
            isAdmin: !!req.user?.isAdmin,
            apiKeys: apiKeyTable,
            logger: req.logger,
          });
          relevantArticles = helpResult.relevantArticles;
          if (helpResult.embedding) {
            const { model, provider, inputTokens } = helpResult.embedding;
            // Same owner as the hold (reserveRequestCredits applies the API-key billing-owner rule).
            const organization =
              reservation.ownerType === CreditHolderType.Organization
                ? await organizationRepository.findById(reservation.ownerId)
                : null;
            await recordOperationalUsage(
              {
                requestId: userId,
                user: req.user,
                organization,
                feature: 'embedding',
                provider,
                model,
                inputTokens,
                costUsd: getEmbeddingModelCost(model, inputTokens),
                forceCreditBilling: true,
              },
              {
                db: {
                  usageEvents: usageEventRepository,
                  adminSettings: adminSettingsRepository,
                  creditTransactions: creditTransactionRepository,
                  users: userRepository,
                  organizations: organizationRepository,
                },
                logger: req.logger,
              }
            );
          }

          const messages: IMessage[] = [
            { role: 'system', content: buildSystemPrompt(helpResult.context) },
            ...history,
            { role: 'user', content: question },
          ];

          req.logger.info(`[HelpChat] Using model: ${modelInfo.id} (retrieval: ${helpResult.method})`);

          // Generate completion (non-streaming for simplicity)
          const options = {
            maxTokens: MAX_RESPONSE_TOKENS,
            temperature: 0.7,
            stream: false,
          };

          await llm.complete(
            // any: modelInfo.id is a dynamic string that can't be narrowed to the union of model ID literals
            modelInfo.id as any,
            messages,
            options,
            async (streamedTexts: (string | null | undefined)[], info) => {
              const text = streamedTexts[0] || streamedTexts[1] || '';
              if (text) {
                responseText = text;
              }
              latchUsage(usage, info);
            }
          );
        } catch (error) {
          // A stream can report billable usage before a later provider failure.
          if (hasReportedUsage(usage)) {
            await settleUsage(completionUsd(modelInfo, usage));
          } else {
            await reservation.refund();
          }
          throw error;
        }

        // An adapter that reports no usage is charged the reservation ceiling rather than nothing.
        const reported = hasReportedUsage(usage);
        await settleUsage(reported ? completionUsd(modelInfo, usage) : ceilingUsd);

        const latency = Date.now() - startTime;
        req.logger.info(`[HelpChat] Completed in ${latency}ms`);

        res.json({
          response: stripFabricatedLinks(responseText),
          model: modelInfo.id,
          latency,
          relevantArticles,
        });
      } catch (error) {
        // Model admission and the credit reservation keep their own 403 / 422.
        if (error instanceof ForbiddenError || error instanceof UnprocessableEntityError) throw error;
        req.logger.error('[HelpChat] Error:', error);
        res.status(error instanceof BadRequestError ? 400 : 500).json({
          error: error instanceof Error ? error.message : 'An error occurred',
        });
      }
    })
  );

export default handler;
