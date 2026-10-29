import { useMemo } from 'react';
import type { PromptMeta } from '@bike4mind/common';
import { useGetSessionQuests } from '@client/app/hooks/data/sessions';
import { promptCacheExpiresAt } from '@client/app/utils/promptCacheExpiry';

type ContextWindowUsage = NonNullable<NonNullable<PromptMeta['context']>['contextWindowUsage']>;

/** Utilization band thresholds, as a percent of the model's safe input budget. */
export const CONTEXT_WARN_THRESHOLD = 70;
export const CONTEXT_DANGER_THRESHOLD = 90;

/**
 * Minimum assembled-input size for a missing caching discount to be worth
 * flagging. Below this the per-turn cost delta from re-billing uncached input
 * is noise, so we stay quiet to avoid crying wolf on short conversations.
 */
const CACHE_NOTE_MIN_INPUT_TOKENS = 20_000;

export type ContextUsageBand = 'normal' | 'warning' | 'danger';

export interface SessionContextUsage {
  /** Tokens the last completed turn actually assembled as input. */
  actualInputTokens: number;
  /** Model whose tokenizer sized the assembled input, before any generation fallback. */
  inputModelId?: string;
  /** Model that answered the last turn, so the one holding this conversation's prompt cache. */
  answeredModelId?: string;
  /**
   * The last turn's prompt as the answering model's provider counted it (uncached + cache read + cache
   * write). Absent when settlement fell back to the local estimate, and for a turn that called tools,
   * whose usage sums every model call.
   */
  providerInputTokens?: number;
  /** The model's full context window. */
  contextLimit: number;
  /** Input budget after reserving output + safety buffer (the real ceiling). */
  safeMaxInputTokens: number;
  /** actualInputTokens / safeMaxInputTokens, as a percent. */
  utilizationPercentage: number;
  band: ContextUsageBand;
  isApproachingLimit: boolean;
  overflowDetected: boolean;
  /**
   * The turn ran a large context but earned no cache-read discount, so it was
   * re-billed at full input rate. Empirical (observed cache reads == 0) rather
   * than catalog-derived, so it stays correct regardless of provider quirks.
   */
  cachingIneffective: boolean;
  /**
   * Older turns the last completed turn folded into working memory (context
   * summary) instead of re-sending verbatim. > 0 means compaction just ran.
   */
  compactedTurns: number;
  /** When the prompt cache the last turn left expires (epoch ms); see promptCacheExpiresAt. */
  cacheExpiresAt: number | null;
}

function bandFor(pct: number, overflow: boolean): ContextUsageBand {
  if (overflow || pct >= CONTEXT_DANGER_THRESHOLD) return 'danger';
  if (pct >= CONTEXT_WARN_THRESHOLD) return 'warning';
  return 'normal';
}

function providerPromptTokens(promptMeta: PromptMeta | undefined): number | undefined {
  const usage = promptMeta?.tokenUsage;
  if (usage?.settledBasis !== 'provider' || usage.actualInputTokens == null) return undefined;
  if (promptMeta?.functionCalls?.length) return undefined;
  return usage.actualInputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

/** Compact token count for display, e.g. 86000 -> "86K". */
export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;
}

/**
 * Effective context-window usage for a session, read from the most recent
 * completed turn.
 *
 * The source is `promptMeta.context.contextWindowUsage`, which the backend
 * already records on every quest (ChatCompletionProcess) and the chat-history
 * endpoint returns in full - so this adds no request. Returns null until a turn
 * has completed with telemetry (a brand-new or still-streaming session).
 */
export function useSessionContextUsage(sessionId: string | null): SessionContextUsage | null {
  const { data } = useGetSessionQuests(sessionId);

  return useMemo(() => {
    // Pick the newest quest carrying telemetry. Quest ids are Mongo ObjectIds
    // (monotonic hex), so a lexical max is the latest turn - order-independent
    // of how pages happen to be sorted, and optimistic/in-flight quests are
    // skipped because they have no contextWindowUsage yet.
    let latestId = '';
    let latest: ContextWindowUsage | null = null;
    let latestCacheReadTokens = 0;
    let latestCacheExpiresAt: number | null = null;
    let latestInputModelId: string | undefined;
    let latestAnsweredModelId: string | undefined;
    let latestProviderInputTokens: number | undefined;

    for (const page of data?.pages ?? []) {
      for (const quest of page.data) {
        const usage = quest.promptMeta?.context?.contextWindowUsage;
        if (!usage || !usage.safeMaxInputTokens) continue;
        if (quest.id && quest.id > latestId) {
          latestId = quest.id;
          latest = usage;
          latestInputModelId = quest.fallbackInfo?.primaryModel ?? quest.promptMeta?.model?.name;
          latestAnsweredModelId = quest.promptMeta?.model?.name;
          latestCacheReadTokens = quest.promptMeta?.tokenUsage?.cacheReadInputTokens ?? 0;
          latestCacheExpiresAt = promptCacheExpiresAt(quest);
          latestProviderInputTokens = providerPromptTokens(quest.promptMeta);
        }
      }
    }

    if (!latest) return null;

    const pct = latest.utilizationPercentage ?? (latest.actualInputTokens / latest.safeMaxInputTokens) * 100;
    const overflowDetected = latest.overflowDetected ?? latest.actualInputTokens > latest.safeMaxInputTokens;

    return {
      actualInputTokens: latest.actualInputTokens,
      inputModelId: latestInputModelId,
      answeredModelId: latestAnsweredModelId,
      providerInputTokens: latestProviderInputTokens,
      contextLimit: latest.contextLimit,
      safeMaxInputTokens: latest.safeMaxInputTokens,
      utilizationPercentage: pct,
      band: bandFor(pct, overflowDetected),
      isApproachingLimit: pct >= CONTEXT_WARN_THRESHOLD,
      overflowDetected,
      cachingIneffective: latest.actualInputTokens >= CACHE_NOTE_MIN_INPUT_TOKENS && latestCacheReadTokens === 0,
      compactedTurns: latest.verbatimTurnsExcluded ?? 0,
      cacheExpiresAt: latestCacheExpiresAt,
    };
  }, [data?.pages]);
}
