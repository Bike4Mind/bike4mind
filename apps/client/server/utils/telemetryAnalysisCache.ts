import { isValidObjectId } from 'mongoose';
import { Quest } from '@bike4mind/database';
import type { HistoricalBaselines } from '@bike4mind/common';
import type { AnalysisSource, LLMAnalysis } from '@bike4mind/server-utils/utils/telemetryAnalysis';

export interface CachedTelemetryAnalysis {
  analysis: LLMAnalysis;
  analysisSource: AnalysisSource;
  historicalBaselines: HistoricalBaselines | null;
  cachedAt: string;
}

/**
 * Stores a telemetry analysis on the quest it describes, keyed by the quest `_id`.
 * Quest has no top-level `requestId`, so never filter on one (it matches nothing and scans).
 * Returns null without querying when `questId` is not a valid ObjectId.
 */
export async function cacheTelemetryAnalysisOnQuest(questId: string, cached: CachedTelemetryAnalysis) {
  if (!isValidObjectId(questId)) return null;
  return Quest.updateOne({ _id: questId }, { $set: { 'promptMeta.contextTelemetry.cachedAnalysis': cached } });
}
