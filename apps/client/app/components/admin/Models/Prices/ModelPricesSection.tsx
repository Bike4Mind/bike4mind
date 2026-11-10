import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ADMIN_MODELS_QUERY_KEY } from '@client/app/hooks/data/adminModels';
import { ModelPricingCatalog } from '../../CreditAnalysis/components/ModelPricingCatalog';
import type { AdminSearch } from '../../adminTabParams';
import { MODELS_PRICE_MODEL_PARAM } from '../modelsSearch';
import { ModelWriteAction } from '../ModelWriteAction';
import { useRunNowStore } from '../Discovery/runDiscoveryNow';
import { AddPriceDialog } from './AddPriceDialog';

/** Prices: the price catalog for every model, narrowed by the `model` param, plus a first price for a text model. */
export function ModelPricesSection() {
  const search = useSearch({ strict: false }) as AdminSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const model = search[MODELS_PRICE_MODEL_PARAM] ?? '';
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const finishedRuns = useRunNowStore(state => state.finishedRuns);

  const setModel = (value: string) =>
    navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({ ...previous, [MODELS_PRICE_MODEL_PARAM]: value || undefined }),
      replace: true,
    });

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
