import { useDialogRequestScope } from '../useDialogRequestScope';
import { useMemo, useState } from 'react';
import { Alert, Autocomplete, Box, Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { getPriceMargin } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { LOOKUP_TRUNCATED_NOTICE, useAdminModelsOfType } from '@client/app/hooks/data/adminModels';
import {
  RATE_FIELDS,
  RATE_LABELS,
  UNIT_FIELD_SUFFIX,
  VOICE_REQUIRED_FIELDS,
  apiErrorMessage,
  bandConfirmToken,
  markedUpRate,
  toStoredRate,
  voiceRateProblem,
  type RateField,
} from '../../CreditAnalysis/components/ModelPricingCatalog';
import { ActionDialog } from '../../shared';

const REASON_PRESETS = ['Provider published price list', 'Matches the provider invoice', 'New model, price confirmed'];
/** POST /api/admin/model-prices takes any non-blank note, the same rule as the table's Reprice. */
const NOTE_MIN_LENGTH = 1;
const REQUIRED_FIELDS: readonly RateField[] = ['input', 'output'];
const UNIT = 'per_token';

type TierDraft = { threshold: string; rates: Partial<Record<RateField, string>> };

const isRate = (raw: string | undefined) =>
  raw !== undefined && raw.trim() !== '' && Number(raw) >= 0 && Number.isFinite(Number(raw));

/** The drafts as the stored pricing map the API takes; blank optional rates are left out. */
const toPricing = (tiers: TierDraft[]) => {
  const pricing: Record<string, Record<string, number>> = {};
  for (const tier of tiers) {
    const entry: Record<string, number> = {};
    for (const field of RATE_FIELDS) {
      const raw = tier.rates[field]?.trim();
      if (raw) entry[field] = toStoredRate(UNIT, Number(raw));
    }
    pricing[String(Number(tier.threshold))] = entry;
  }
  return pricing;
};

/** Why the tier drafts cannot be sent yet, or null. */
const draftProblem = (tiers: TierDraft[], voice: boolean): string | null => {
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
  // Mirrors the API's refusal: no tier with an input or output rate above 0 would settle every call free.
  if (!tiers.some(tier => Number(tier.rates.input) > 0 || Number(tier.rates.output) > 0)) {
    return 'Enter an input or output rate above 0: a price of 0 everywhere makes every call free.';
  }
  return voice ? voiceRateProblem(toPricing(tiers)) : null;
};

type AddPriceDialogProps = {
  onClose: () => void;
  /** A model id from the page's filter; preselected when this dialog can price it. */
  presetModelId?: string;
  onAdded: () => void;
};

/**
 * First per-token price for a model whose price rows bill (text and realtime-voice; see
 * b4m-core/common/src/modelPriceCatalog.ts), with its tiers and the markup preview.
 */
export function AddPriceDialog({ onClose, presetModelId, onAdded }: AddPriceDialogProps) {
  const captureRequest = useDialogRequestScope(presetModelId ?? 'new-price');
  const text = useAdminModelsOfType('text');
  const voice = useAdminModelsOfType('realtime-voice');
  const models = {
    isLoading: text.isLoading || voice.isLoading,
    isError: text.isError || voice.isError,
    truncated: !!text.data?.truncated || !!voice.data?.truncated,
  };
  // A model with a price row in force (`price.source === 'row'`) is repriced from the table, not here. The API
  // takes a first voice price only for a model the build prices (a seed entry), so voice needs `source === 'build'`.
  const voiceIds = useMemo(
    () => new Set((voice.data?.rows ?? []).filter(model => model.price?.source === 'build').map(model => model.id)),
    [voice.data]
  );
  const ids = useMemo(
    () => [
      ...(text.data?.rows ?? []).filter(model => model.price?.source !== 'row').map(model => model.id),
      ...voiceIds,
    ],
    [text.data, voiceIds]
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

  const isVoice = modelId !== null && voiceIds.has(modelId);
  const blockedReason = !modelId ? 'Choose a model.' : draftProblem(tiers, isVoice);

  const submit = async (reason: string) => {
    const isCurrent = captureRequest();
    if (!modelId) return;
    const pricing = toPricing(tiers);
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
      if (!isCurrent()) return;
      setError(apiErrorMessage(err, 'Adding the price failed'));
      setConfirmToken(bandConfirmToken(err));
      return;
    }
    onAdded();
    if (!isCurrent()) return;
    toast.success('Price added. Open pickers update within about 15 seconds.');
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Add price"
      description="A first price row for a model that has none. Provider cost in USD per 1M tokens, as the provider publishes it; it takes effect immediately."
      reasonPresets={REASON_PRESETS}
      reasonMinLength={NOTE_MIN_LENGTH}
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
        {models.truncated && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="add-price-model-truncated">
            {LOOKUP_TRUNCATED_NOTICE}
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
                <FormControl
                  key={field}
                  required={
                    REQUIRED_FIELDS.includes(field) || (isVoice && index === 0 && VOICE_REQUIRED_FIELDS.includes(field))
                  }
                  sx={{ width: 130 }}
                >
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
