import { useMemo, useState } from 'react';
import { Alert, Autocomplete, Box, Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { getPriceMargin } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useAdminModelsOfType } from '@client/app/hooks/data/adminModels';
import {
  RATE_FIELDS,
  RATE_LABELS,
  UNIT_FIELD_SUFFIX,
  apiErrorMessage,
  bandConfirmToken,
  markedUpRate,
  toStoredRate,
  type RateField,
} from '../../CreditAnalysis/components/ModelPricingCatalog';
import { ActionDialog } from '../../shared';

const REASON_PRESETS = ['Provider published price list', 'Matches the provider invoice', 'New model, price confirmed'];
const REQUIRED_FIELDS: readonly RateField[] = ['input', 'output'];
const UNIT = 'per_token';

type TierDraft = { threshold: string; rates: Partial<Record<RateField, string>> };

const isRate = (raw: string | undefined) =>
  raw !== undefined && raw.trim() !== '' && Number(raw) >= 0 && Number.isFinite(Number(raw));

/** Why the tier drafts cannot be sent yet, or null. */
const draftProblem = (tiers: TierDraft[]): string | null => {
  const thresholds = new Set<string>();
  for (const tier of tiers) {
    if (!/^\d+$/.test(tier.threshold.trim())) return 'Tier thresholds are whole token counts.';
    if (thresholds.has(String(Number(tier.threshold)))) return 'Each tier needs its own threshold.';
    thresholds.add(String(Number(tier.threshold)));
    if (!REQUIRED_FIELDS.every(field => isRate(tier.rates[field]))) return 'Enter input and output rates of 0 or more.';
    const optionalBad = RATE_FIELDS.some(field => {
      const raw = tier.rates[field]?.trim();
      return !REQUIRED_FIELDS.includes(field) && raw !== undefined && raw !== '' && !isRate(raw);
    });
    if (optionalBad) return 'Rates must be numbers of 0 or more.';
  }
  return null;
};

type AddPriceDialogProps = {
  onClose: () => void;
  /** A model id from the page's filter; preselected when it is a text model. */
  presetModelId?: string;
  onAdded: () => void;
};

/** First per-token price for a model whose price rows bill (text and realtime-voice; see b4m-core/common/src/modelPriceCatalog.ts), with its tiers and the markup preview (docs/admin-models-spec.md 5.4). */
export function AddPriceDialog({ onClose, presetModelId, onAdded }: AddPriceDialogProps) {
  const text = useAdminModelsOfType('text');
  const voice = useAdminModelsOfType('realtime-voice');
  const models = { isLoading: text.isLoading || voice.isLoading, isError: text.isError || voice.isError };
  const ids = useMemo(
    () => [...(text.data ?? []), ...(voice.data ?? [])].map(model => model.id),
    [text.data, voice.data]
  );
  const [picked, setPicked] = useState<string | null>(null);
  const modelId = picked ?? (presetModelId && ids.includes(presetModelId) ? presetModelId : null);
  const [tiers, setTiers] = useState<TierDraft[]>([{ threshold: '0', rates: {} }]);
  const [error, setError] = useState<string | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);

  const edit = (update: (current: TierDraft[]) => TierDraft[]) => {
    setConfirmToken(null);
    setTiers(update);
  };
  const setRate = (index: number, field: RateField, value: string) =>
    edit(current =>
      current.map((tier, i) => (i === index ? { ...tier, rates: { ...tier.rates, [field]: value } } : tier))
    );

  const blockedReason = !modelId ? 'Choose a model.' : draftProblem(tiers);

  const submit = async (reason: string) => {
    if (!modelId) return;
    const pricing: Record<string, Record<string, number>> = {};
    for (const tier of tiers) {
      const entry: Record<string, number> = {};
      for (const field of RATE_FIELDS) {
        const raw = tier.rates[field]?.trim();
        if (raw) entry[field] = toStoredRate(UNIT, Number(raw));
      }
      pricing[String(Number(tier.threshold))] = entry;
    }
    setError(null);
    try {
      await api.post('/api/admin/model-prices', {
        modelId,
        unit: UNIT,
        pricing,
        note: reason,
        ...(confirmToken ? { confirm: confirmToken } : {}),
      });
    } catch (err) {
      setError(apiErrorMessage(err, 'Adding the price failed'));
      setConfirmToken(bandConfirmToken(err));
      return;
    }
    toast.success('Price added. Open pickers update within about 15 seconds.');
    onAdded();
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Add price"
      description="A first price for a model that has none. Provider cost in USD per 1M tokens, as the provider publishes it; it takes effect immediately."
      reasonPresets={REASON_PRESETS}
      confirmLabel={confirmToken ? 'Apply anyway' : 'Add price'}
      tone={confirmToken ? 'danger' : 'neutral'}
      blockedReason={blockedReason}
      onConfirm={submit}
      data-testid="add-price-dialog"
    >
      <FormControl required>
        <FormLabel>Model</FormLabel>
        <Autocomplete
          options={ids}
          value={modelId}
          loading={models.isLoading}
          onChange={(_, value) => {
            setConfirmToken(null);
            setPicked(value);
          }}
          placeholder="Search models"
          slotProps={{ input: { 'data-testid': 'add-price-model-input' } }}
        />
        {models.isError && (
          <Typography level="body-xs" color="danger">
            The model list failed to load.
          </Typography>
        )}
      </FormControl>
      <Stack gap={2}>
        {tiers.map((tier, index) => (
          <Box key={index} data-testid={`add-price-tier-${index}`}>
            <Stack direction="row" alignItems="flex-end" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>
              <FormControl sx={{ width: 160 }}>
                <FormLabel>Tier from tokens</FormLabel>
                <Input
                  size="sm"
                  value={tier.threshold}
                  disabled={index === 0}
                  onChange={event =>
                    edit(current => current.map((t, i) => (i === index ? { ...t, threshold: event.target.value } : t)))
                  }
                  slotProps={{ input: { inputMode: 'numeric', 'data-testid': `add-price-threshold-${index}` } }}
                />
              </FormControl>
              {index > 0 && (
                <Button
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => edit(current => current.filter((_, i) => i !== index))}
                  data-testid={`add-price-remove-tier-${index}`}
                >
                  Remove tier
                </Button>
              )}
            </Stack>
            <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap>
              {RATE_FIELDS.map(field => (
                <FormControl key={field} required={REQUIRED_FIELDS.includes(field)} sx={{ width: 130 }}>
                  <FormLabel>
                    {RATE_LABELS[field]} {UNIT_FIELD_SUFFIX[UNIT]}
                  </FormLabel>
                  <Input
                    size="sm"
                    value={tier.rates[field] ?? ''}
                    onChange={event => setRate(index, field, event.target.value)}
                    slotProps={{ input: { inputMode: 'decimal', 'data-testid': `add-price-rate-${index}-${field}` } }}
                  />
                </FormControl>
              ))}
            </Stack>
            <Typography level="body-xs" sx={{ mt: 0.5 }} data-testid={`add-price-markup-${index}`}>
              At the published {getPriceMargin()}x markup a user pays about {markedUpRate(tier.rates.input)} in /{' '}
              {markedUpRate(tier.rates.output)} out per 1M tokens. Entered rates stay raw cost.
            </Typography>
          </Box>
        ))}
        <Box>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => edit(current => [...current, { threshold: '', rates: {} }])}
            data-testid="add-price-add-tier-btn"
          >
            Add tier
          </Button>
        </Box>
      </Stack>
      {error && (
        <Alert color="danger" size="sm" sx={{ whiteSpace: 'pre-line' }} data-testid="add-price-error">
          {error}
        </Alert>
      )}
    </ActionDialog>
  );
}
