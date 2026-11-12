import { useCallback, useMemo } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { DEFAULT_MODEL_DETAIL_TAB, type ModelDetailTab } from './modelDetailSearch';
import { MODELS_PRICE_MODEL_PARAM, modelsSectionSearch, type ModelsSection } from './modelsSearch';

const modelLocation = (id: string, tab: ModelDetailTab) =>
  ({
    to: '/admin/models/$',
    params: { _splat: id },
    search: { tab: tab === DEFAULT_MODEL_DETAIL_TAB ? undefined : tab },
  }) as const;

/**
 * Links between the Models sections, the model detail page (`/admin/models/$`, a splat so ids with `/` need no
 * encoding) and the discovery run page (`/admin/models/runs/$runId`).
 */
export function useModelsNavigation() {
  const navigate = useNavigate();
  const router = useRouter();

  const openModel = useCallback(
    (id: string, tab: ModelDetailTab = DEFAULT_MODEL_DETAIL_TAB) => navigate(modelLocation(id, tab)),
    [navigate]
  );

  /** A model page's URL, for a link that opens in a new tab. */
  const modelHref = useCallback(
    (id: string, tab: ModelDetailTab = DEFAULT_MODEL_DETAIL_TAB) => router.buildLocation(modelLocation(id, tab)).href,
    [router]
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
    () => ({ openModel, modelHref, openRun, openSection, openPrices }),
    [openModel, modelHref, openRun, openSection, openPrices]
  );
}
