import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest, adminSettingsRepository } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { TELEMETRY_SAFE_PROJECTION } from '@server/utils/telemetryProjection';
import {
  ContextTelemetryAlertsSchema,
  getRecommendedAction,
  type ContextTelemetry,
  type HistoricalBaselines,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  computeHistoricalBaselines,
  generateRuleBasedAnalysis,
  generateLLMAnalysis,
  DEFAULT_SLOS,
  type LLMAnalysis,
  type SloConfig,
} from '@server/utils/telemetryAnalysis';

// Route parameter schema (includes optional force flag to bypass cache)
const paramsSchema = z.object({
  id: z.string().min(1),
  force: z
    .string()
    .optional()
    .transform(v => v === 'true'),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const logger = new Logger({ metadata: { service: 'ContextTelemetryAnalyze' } });
    const { id, force } = paramsSchema.parse(req.query);

    const quest = await Quest.findById(id).select(TELEMETRY_SAFE_PROJECTION).lean();

    if (!quest) {
      throw new NotFoundError(`Telemetry entry not found: ${id}`);
    }

    if (!quest.promptMeta?.contextTelemetry) {
      throw new NotFoundError(`No telemetry data for quest: ${id}`);
    }

    // Cast is safe: contextTelemetry is stored as Mixed in Mongoose but always
    // written as ContextTelemetry by ChatCompletionProcess. The existence check
    // above guarantees the field is present.
    const telemetry = quest.promptMeta.contextTelemetry as ContextTelemetry & {
      cachedAnalysis?: {
        analysis: LLMAnalysis;
        analysisSource: string;
        historicalBaselines: HistoricalBaselines | null;
        cachedAt: string;
      };
    };

    // Return cached analysis if available and not forced to re-analyze
    if (!force && telemetry.cachedAnalysis) {
      return res.json({
        id,
        timestamp: quest.timestamp?.toISOString() ?? '',
        analysis: telemetry.cachedAnalysis.analysis,
        analysisSource: telemetry.cachedAnalysis.analysisSource,
        historicalBaselines: telemetry.cachedAnalysis.historicalBaselines,
        cached: true,
        cachedAt: telemetry.cachedAnalysis.cachedAt,
        telemetrySummary: {
          anomalyScore: telemetry.anomalies.anomalyScore,
          primaryAnomaly: telemetry.anomalies.primaryAnomaly,
          model: telemetry.model.modelId,
          provider: telemetry.model.provider,
          inputTokens: telemetry.contextWindow.inputTokens,
          utilizationPercent: telemetry.contextWindow.utilizationPercentage,
          responseTimeMs: telemetry.performance.totalResponseTimeMs,
        },
      });
    }

    // Get alert settings to check for LLM configuration
    const alertSettingsRaw = await adminSettingsRepository.getSettingsValue('contextTelemetryAlerts');
    const alertSettings = ContextTelemetryAlertsSchema.safeParse(alertSettingsRaw);
    const config = alertSettings.success ? alertSettings.data : null;

    // Extract SLO config from settings
    const slos: SloConfig = {
      sloResponseTimeP95Ms: config?.sloResponseTimeP95Ms ?? DEFAULT_SLOS.sloResponseTimeP95Ms,
      sloFirstTokenTimeMs: config?.sloFirstTokenTimeMs ?? DEFAULT_SLOS.sloFirstTokenTimeMs,
      sloErrorRatePercent: config?.sloErrorRatePercent ?? DEFAULT_SLOS.sloErrorRatePercent,
      sloContextUtilizationPercent: config?.sloContextUtilizationPercent ?? DEFAULT_SLOS.sloContextUtilizationPercent,
    };

    // Compute historical baselines (async but fast - aggregation pipeline)
    const baselineWindowDays = config?.baselineWindowDays ?? 7;
    let baselines: HistoricalBaselines | null = null;
    try {
      baselines = await computeHistoricalBaselines(
        telemetry.model.modelId,
        telemetry.model.provider,
        baselineWindowDays
      );
      if (baselines) {
        logger.info(
          `[ContextTelemetry] Historical baselines: N=${baselines.sampleCount}, avgResponse=${baselines.avgResponseTimeMs}ms`
        );
      }
    } catch (err) {
      logger.warn(`[ContextTelemetry] Failed to compute baselines: ${err instanceof Error ? err.message : err}`);
    }

    let analysis: LLMAnalysis;
    let analysisSource: 'llm' | 'rule-based' = 'rule-based';

    // Use LLM analysis if configured and score meets threshold, otherwise rule-based
    const llmThreshold = config?.llmAnalysisThreshold ?? 30;
    const llmModelId = config?.modelId;
    const shouldUseLlm = llmModelId && telemetry.anomalies.anomalyScore >= llmThreshold;
    if (shouldUseLlm) {
      try {
        logger.info(`[ContextTelemetry] Using LLM analysis with model: ${llmModelId}`);
        analysis = await generateLLMAnalysis(
          telemetry,
          {
            modelId: llmModelId,
            temperature: config.temperature ?? 0.3,
            maxTokens: config.maxTokens ?? 2000,
            timeoutMs: config.timeoutMs ?? 60000,
          },
          logger,
          slos,
          baselines
        );
        analysisSource = 'llm';
        // Force system-calculated severity and recommended action (never LLM-determined)
        analysis = {
          ...analysis,
          severity: telemetry.anomalies.severity,
          recommendedAction: getRecommendedAction(telemetry.anomalies.anomalyScore),
        };
      } catch (error) {
        // Log error and fall back to rule-based analysis
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[ContextTelemetry] LLM analysis failed, falling back to rule-based: ${errorMessage}`);
        analysis = generateRuleBasedAnalysis(telemetry, slos, baselines);
      }
    } else {
      if (config?.modelId) {
        logger.info(
          `[ContextTelemetry] Score ${telemetry.anomalies.anomalyScore} below LLM threshold ${llmThreshold}, using rule-based analysis`
        );
      } else {
        logger.info('[ContextTelemetry] No LLM configured, using rule-based analysis');
      }
      analysis = generateRuleBasedAnalysis(telemetry, slos, baselines);
    }

    // Cache analysis on the telemetry document. The auto-alert handler may also
    // write cachedAnalysis; last-write-wins is acceptable. Use ?force=true to re-analyze.
    const cachedAt = new Date().toISOString();
    try {
      await Quest.updateOne(
        { _id: id },
        {
          $set: {
            'promptMeta.contextTelemetry.cachedAnalysis': {
              analysis,
              analysisSource,
              historicalBaselines: baselines,
              cachedAt,
            },
          },
        }
      );
    } catch (cacheErr) {
      logger.warn(
        `[ContextTelemetry] Failed to cache analysis: ${cacheErr instanceof Error ? cacheErr.message : cacheErr}`
      );
    }

    res.json({
      id,
      timestamp: quest.timestamp?.toISOString() ?? '',
      analysis,
      analysisSource,
      historicalBaselines: baselines,
      cached: false,
      telemetrySummary: {
        anomalyScore: telemetry.anomalies.anomalyScore,
        primaryAnomaly: telemetry.anomalies.primaryAnomaly,
        model: telemetry.model.modelId,
        provider: telemetry.model.provider,
        inputTokens: telemetry.contextWindow.inputTokens,
        utilizationPercent: telemetry.contextWindow.utilizationPercentage,
        responseTimeMs: telemetry.performance.totalResponseTimeMs,
      },
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
