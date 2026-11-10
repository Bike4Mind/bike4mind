import { useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DEFAULT_MODEL_DETAIL_TAB, type ModelDetailTab } from './modelDetailSearch';
import { MODELS_PRICE_MODEL_PARAM, modelsSectionSearch, type ModelsSection } from './modelsSearch';

/**
 * Links between the Models sections, the model detail page (`/admin/models/$`, a splat so ids with `/` need no
 * encoding) and the discovery run page (`/admin/models/runs/$runId`).
 */
export function useModelsNavigation() {
  const navigate = useNavigate();

  const openModel = useCallback(
    (id: string, tab: ModelDetailTab = DEFAULT_MODEL_DETAIL_TAB) =>
      navigate({
        to: '/admin/models/$',
        params: { _splat: id },
        search: { tab: tab === DEFAULT_MODEL_DETAIL_TAB ? undefined : tab },
      }),
    [navigate]
  );

  const openRun = useCallback(
    (runId: string) => navigate({ to: '/admin/models/runs/$runId', params: { runId } }),
    [navigate]
  );

  const openSection = useCallback(
    (section: ModelsSection, extra?: Record<string, string | undefined>) =>
      navigate({ to: '/admin', search: modelsSectionSearch(section, extra) }),
    [navigate]
  );

  /** Prices, narrowed to one model when given. */
  const openPrices = useCallback(
    (modelId?: string) => openSection('prices', { [MODELS_PRICE_MODEL_PARAM]: modelId }),
    [openSection]
  );

  return useMemo(
    () => ({ openModel, openRun, openSection, openPrices }),
    [openModel, openRun, openSection, openPrices]
  );
}
