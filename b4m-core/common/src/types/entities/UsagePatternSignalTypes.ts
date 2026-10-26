export const USAGE_PATTERN_SIGNAL_IDS = ['apiOnlyUsage', 'regularCadence', 'creditPolling', 'quickApiKey'] as const;
export type UsagePatternSignalId = (typeof USAGE_PATTERN_SIGNAL_IDS)[number];

/** One per-user usage pattern feature, as stored and as shown to a reviewer. */
export interface UsagePatternSignal {
  id: UsagePatternSignalId;
  /** The measured feature; null when there was not enough data to measure it. */
  value: number | null;
  triggered: boolean;
  /** Points this signal adds to the score when triggered (the configured weight). */
  weight: number;
  /** Short neutral sentence naming the evidence, for a reviewer. */
  explanation: string;
}

export interface UsagePatternSignalsResult {
  signals: UsagePatternSignal[];
  /** Sum of triggered weights, capped at 100. */
  score: number;
  needsReview: boolean;
}

/** The latest result for one user, one document per user. */
export interface IUserUsagePatternSignals extends UsagePatternSignalsResult {
  id: string;
  userId: string;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
