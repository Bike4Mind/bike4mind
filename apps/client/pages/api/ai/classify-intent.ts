import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService, classifyIntent, CascadeExhaustedError } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { IntentClassifierConfigSchema } from '@bike4mind/common';
import { z } from 'zod';

/**
 * POST /api/ai/classify-intent - dark-launched intent classifier.
 *
 * Computes a routing decision (`useAgent: boolean`) for a user message via
 * the multi-provider LLM cascade. The endpoint exists but no client wires it
 * into routing yet; it will eventually replace the `routeQuery()` heuristic.
 *
 * Shadow mode: when `orchestrationDefaults.intentClassifier.shadowMode` is
 * true (default), the decision is still computed and returned to the caller;
 * the field is surfaced so observability dashboards can compare classifier
 * vs heuristic decisions before flipping the routing layer.
 */

const RequestSchema = z.object({
  message: z.string().min(1).max(8000),
  hasFileAttachments: z.boolean().optional(),
  hasAgentMention: z.boolean().optional(),
});

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 200 : 60,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const userId = req.user.id;
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
    }

    const orchestrationDefaults = await adminSettingsRepository.getSettingsValue('orchestrationDefaults').catch(err => {
      req.logger.warn('[classify-intent] Failed to load orchestrationDefaults; using built-in defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    });
    const classifierConfig = orchestrationDefaults?.intentClassifier ?? IntentClassifierConfigSchema.parse({});

    if (!classifierConfig.enabled) {
      return res.status(200).json({
        skipped: true,
        reason: 'disabled',
        shadowMode: classifierConfig.shadowMode,
      });
    }

    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);
    const availableModels = await getAvailableModels(apiKeyTable);

    try {
      const decision = await classifyIntent(
        {
          userId,
          message: parsed.data.message,
          hasFileAttachments: parsed.data.hasFileAttachments,
          hasAgentMention: parsed.data.hasAgentMention,
        },
        { apiKeyTable, availableModels, logger: req.logger, config: classifierConfig }
      );

      return res.status(200).json({
        decision,
        shadowMode: classifierConfig.shadowMode,
      });
    } catch (err) {
      if (err instanceof CascadeExhaustedError) {
        req.logger.error('[classify-intent] cascade exhausted', { attempts: err.attempts });
        return res.status(503).json({ error: 'cascade exhausted', attempts: err.attempts });
      }
      const msg = err instanceof Error ? err.message : String(err);
      req.logger.error('[classify-intent] failed', { error: msg });
      return res.status(500).json({ error: msg });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
