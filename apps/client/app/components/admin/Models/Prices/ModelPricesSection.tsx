import { useEffect, useRef, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ADMIN_MODELS_QUERY_KEY } from '@client/app/hooks/data/adminModels';
import { ModelPricingCatalog } from '../../CreditAnalysis/components/ModelPricingCatalog';
import type { AdminSearch } from '../../adminTabParams';
import { SEARCH_TERM_URL_DEBOUNCE_MS } from '../../shared/useAdminListUrlState';
import { MODELS_PRICE_MODEL_PARAM } from '../modelsSearch';
import { ModelWriteAction } from '../ModelWriteAction';
import { useRunNowStore } from '../Discovery/runDiscoveryNow';
import { AddPriceDialog } from './AddPriceDialog';

/** Prices: the price catalog for every model, narrowed by the `model` param, plus a first price for a text model. */
export function ModelPricesSection() {
  const search = useSearch({ strict: false }) as AdminSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlModel = search[MODELS_PRICE_MODEL_PARAM] ?? '';
  // Local, because a router-bound input lags a navigation behind each keystroke (see useAdminListUrlState.ts).
  const [model, setModelText] = useState(urlModel);
  // The last value this section wrote to the URL, so its own echo does not re-seed the box.
  const writtenModelRef = useRef(urlModel);
  const pendingWriteRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const finishedRuns = useRunNowStore(state => state.finishedRuns);

  useEffect(() => {
    if (urlModel === writtenModelRef.current) return;
    clearTimeout(pendingWriteRef.current);
    writtenModelRef.current = urlModel;
    setModelText(urlModel);
  }, [urlModel]);

  useEffect(() => () => clearTimeout(pendingWriteRef.current), []);

  const setModel = (value: string) => {
    writtenModelRef.current = value;
    setModelText(value);
    clearTimeout(pendingWriteRef.current);
    pendingWriteRef.current = setTimeout(
      () =>
        void navigate({
          to: '/admin',
          search: (previous: AdminSearch) => ({ ...previous, [MODELS_PRICE_MODEL_PARAM]: value || undefined }),
          replace: true,
        }),
      SEARCH_TERM_URL_DEBOUNCE_MS
    );
  };

  const refreshModels = () => queryClient.invalidateQueries({ queryKey: ADMIN_MODELS_QUERY_KEY });

  return (
    <Stack gap={1.5} data-testid="model-prices-section">
      <Typography level="body-sm" data-testid="model-prices-units">
        Provider cost in USD; token rates per 1M
      </Typography>
      <ModelPricingCatalog
        hideHeading
        modelFilter={model}
        onModelFilterChange={setModel}
        refreshKey={refreshKey + finishedRuns}
        onPricesChanged={refreshModels}
        toolbarActions={
          <ModelWriteAction>
            {disabled => (
              <Button size="sm" disabled={disabled} onClick={() => setAdding(true)} data-testid="model-prices-add-btn">
                Add price
              </Button>
            )}
          </ModelWriteAction>
        }
      />
      {adding && (
        <AddPriceDialog
          presetModelId={model}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setRefreshKey(key => key + 1);
            void refreshModels();
          }}
        />
      )}
    </Stack>
  );
}
