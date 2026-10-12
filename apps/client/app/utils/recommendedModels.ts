import { settingsMap } from '@bike4mind/common';

/**
 * The model ids the picker's Recommended group shows, in display order and de-duplicated.
 * An empty or malformed `recommendedModelIds` follows the DefaultAPIModel setting, so an
 * admin who only changes the default model sees it recommended; the compiled-in default
 * is the last fallback. Shared by the picker and the admin editor so both agree.
 */
export function resolveRecommendedModelIds(storedIds: unknown, defaultModelId: unknown): string[] {
  const ids = Array.isArray(storedIds) ? storedIds.filter((id): id is string => typeof id === 'string' && !!id) : [];
  if (ids.length > 0) return [...new Set(ids)];
  const fallback =
    typeof defaultModelId === 'string' && defaultModelId ? defaultModelId : settingsMap.DefaultAPIModel.defaultValue;
  return fallback ? [fallback] : [];
}
