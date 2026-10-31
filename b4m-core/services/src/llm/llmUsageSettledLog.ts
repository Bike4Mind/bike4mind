import { Logger } from '@bike4mind/observability';

/** Must stay in sync with the metric filters in infra/llmSpend.ts. */
export const LLM_USAGE_SETTLED_MESSAGE = 'llm-usage-settled';
export const LLM_SPEND_PROVIDERS = ['anthropic', 'openai', 'bedrock', 'google', 'other'] as const;
export type LlmSpendProvider = (typeof LLM_SPEND_PROVIDERS)[number];

/** Same window as newAccountExpression in CounterLogModel. */
const YOUNG_ACCOUNT_WINDOW_MS = 168 * 60 * 60 * 1000;

export type LlmUsageSource = 'chat' | 'api' | 'cli' | 'desktop' | 'agent' | 'web' | 'system';

export type LlmUsageSettled = {
  backend: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usd: number;
  source: LlmUsageSource;
  /** Lets the young-account spend alarm name the accounts behind a breach; see youngAccountSpendDetail.ts. */
  userId?: string | null;
  accountCreatedAt?: Date | null;
};

export function llmSpendProvider(backend: string): LlmSpendProvider {
  switch (backend) {
    case 'anthropic':
    case 'openai':
    case 'bedrock':
      return backend;
    case 'gemini':
      return 'google';
    default:
      return 'other';
  }
}

export function isYoungAccount(createdAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  return created > now.getTime() - YOUNG_ACCOUNT_WINDOW_MS && created <= now.getTime();
}

export function llmUsageSettledFields(usage: LlmUsageSettled, now: Date = new Date()) {
  return {
    provider: llmSpendProvider(usage.backend),
    backend: usage.backend,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    usd: Number.isFinite(usage.usd) ? Number(usage.usd.toFixed(6)) : 0,
    source: usage.source,
    isYoungAccount: isYoungAccount(usage.accountCreatedAt, now),
    ...(usage.userId ? { userId: String(usage.userId) } : {}),
    ...(usage.accountCreatedAt ? { accountCreatedAt: new Date(usage.accountCreatedAt).toISOString() } : {}),
  };
}

/** One line per settled text completion; CloudWatch metric filters turn it into the LLM spend metrics. */
export function logLlmUsageSettled(usage: LlmUsageSettled): void {
  try {
    // Request loggers inherit request metadata. Metrics carry only the fields above (the account
    // id is deliberate, not inherited), and must survive a higher application log-level threshold.
    const logger = new Logger({
      metadata: { service: 'llmSpend' },
      logInJson: true,
      prettyPrint: false,
      minLevel: 'info',
    });
    logger.info(LLM_USAGE_SETTLED_MESSAGE, llmUsageSettledFields(usage));
  } catch {
    // Observability only: never let it fail a settled completion.
  }
}
