import { useMemo } from 'react';
import {
  ModelBackend,
  isClaudeModelId,
  resolvePromptCacheTtl,
  supportsOneHourPromptCache,
  type ModelInfo,
} from '@bike4mind/common';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import type { SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';
import useSetPromptCacheTtl from '@client/app/hooks/useSetPromptCacheTtl';
import { usePromptCacheExpired } from '@client/app/utils/promptCacheExpiry';
import { getCacheExpiryCostNotice, getModelSwitchCostNotice } from './modelSwitchCost';
import { promptCacheTtlPrices } from './promptCacheTtlPrices';

// Only Claude bills a cache write, so only there does an expired cache cost more than a warm one.
const writesPromptCache = (model: ModelInfo | undefined): boolean =>
  !!model &&
  (model.backend === ModelBackend.Anthropic || (model.backend === ModelBackend.Bedrock && isClaudeModelId(model.id)));

/**
 * Everything the composer shows about this chat's prompt cache: the model-switch and expired-cache
 * notes (credits or null) and the TTL chip's state (null when the model has one TTL only).
 */
export function usePromptCacheComposer({
  selectedModel,
  contextUsage,
  isGenerating,
}: {
  selectedModel: ModelInfo | undefined;
  contextUsage: SessionContextUsage | null;
  isGenerating: boolean;
}) {
  const { settings } = useUserSettings();
  const { chatTtl, setTtl, isPending, hasSession } = useSetPromptCacheTtl();
  const cacheTtl = resolvePromptCacheTtl({
    model: selectedModel,
    chatTtl,
    userDefaultTtl: settings.promptCacheTtl,
  });

  const cacheExpiresAt = contextUsage?.cacheExpiresAt ?? null;
  const expired = usePromptCacheExpired(cacheExpiresAt);

  const notices = useMemo(() => {
    const input = {
      selectedModel,
      answeredModelId: contextUsage?.answeredModelId,
      previousInputTokens: contextUsage?.actualInputTokens,
      previousInputModelId: contextUsage?.inputModelId,
      providerInputTokens: contextUsage?.providerInputTokens,
      cacheTtl,
    };
    return {
      modelSwitchCredits: getModelSwitchCostNotice(input),
      cacheExpiryCredits:
        writesPromptCache(selectedModel) && !isGenerating ? getCacheExpiryCostNotice({ ...input, expired }) : null,
    };
  }, [selectedModel, contextUsage, cacheTtl, expired, isGenerating]);

  const ttlChip = useMemo(() => {
    if (!hasSession || !supportsOneHourPromptCache(selectedModel)) return null;
    return {
      value: cacheTtl,
      prices: contextUsage?.providerInputTokens
        ? promptCacheTtlPrices(selectedModel, contextUsage.providerInputTokens, contextUsage.answeredModelId)
        : promptCacheTtlPrices(selectedModel, contextUsage?.actualInputTokens, contextUsage?.inputModelId),
      onChange: setTtl,
      disabled: isPending,
    };
  }, [hasSession, selectedModel, cacheTtl, contextUsage, setTtl, isPending]);

  return { ...notices, cacheExpiresAt, ttlChip };
}
