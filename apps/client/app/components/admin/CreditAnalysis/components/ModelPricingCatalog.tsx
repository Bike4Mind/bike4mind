import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Textarea,
  Typography,
} from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy/styles';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import HistoryIcon from '@mui/icons-material/History';
import ReplayIcon from '@mui/icons-material/Replay';
// getPriceMargin is read-only here: markup is applied when calls settle, so it
// informs the editor's derived line and never reaches a stored rate.
import { getPriceMargin, type IModelPriceTier } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useCreditAnalysisStore } from '../store';

/** Wire shape of a catalog row (dates arrive as ISO strings). */
interface PriceRow {
  modelId: string;
  unit: string;
  pricing: Record<string, IModelPriceTier>;
  effectiveFrom: string;
  note?: string;
  repricedBy?: string;
}

// Mirrors SEED_NOTE in @bike4mind/database (a server-only package; importing
// it here would pull mongoose into the client bundle). Pinned by a test there.
const SEED_NOTE = 'adapter-seed';
const isSeedRow = (row: PriceRow) => row.note === SEED_NOTE;

// Mirrors DISCOVERY_PRICE_NOTE_PREFIX in @bike4mind/common; discovery stamps
// notes as 'discovery:<source>@<iso-date>'. Kept as a literal so the whole note
// vocabulary this file classifies on reads in one place, next to SEED_NOTE,
// which cannot be imported at all. Pinned by the model-prices API test.
const DISCOVERY_NOTE_PREFIX = 'discovery:';
const isDiscoveryRow = (row: PriceRow) => row.note?.startsWith(DISCOVERY_NOTE_PREFIX) === true;

/** 'discovery:openrouter@2026-07-20' -> 'openrouter': which feed priced the row. */
const discoverySource = (row: PriceRow): string | undefined =>
  isDiscoveryRow(row) ? row.note?.slice(DISCOVERY_NOTE_PREFIX.length).split('@')[0] || undefined : undefined;

type Provenance = 'seed' | 'discovery' | 'operator';
const provenanceOf = (row: PriceRow): Provenance =>
  isSeedRow(row) ? 'seed' : isDiscoveryRow(row) ? 'discovery' : 'operator';

// Seed reads muted in the catalog but highlighted in the audit trail, so the
// two chips keep separate color maps.
const SOURCE_CHIP_COLOR: Record<Provenance, ColorPaletteProp> = {
  seed: 'neutral',
  discovery: 'warning',
  operator: 'primary',
};
const HISTORY_CHIP_COLOR: Record<Provenance, ColorPaletteProp> = {
  seed: 'primary',
  discovery: 'warning',
  operator: 'neutral',
};

/** Every rate field a tier can carry, in display order. */
const RATE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'audio_input',
  'audio_cache_read',
  'audio_output',
] as const;
type RateField = (typeof RATE_FIELDS)[number];
const RATE_LABELS: Record<RateField, string> = {
  input: 'Input',
  output: 'Output',
  cache_read: 'Cache read',
  cache_write: 'Cache write',
  audio_input: 'Audio in',
  audio_cache_read: 'Audio cache',
  audio_output: 'Audio out',
};

const UNIT_SUFFIX: Record<string, string> = {
  per_token: 'per 1M tokens',
  per_minute: 'per minute',
  per_image: 'per image',
};

/** Compact form for the narrow editor inputs; the modal states the full unit. */
const UNIT_FIELD_SUFFIX: Record<string, string> = {
  per_token: '$/M',
  per_minute: '$/min',
  per_image: '$/img',
};

// The one place the token scale lives: display, editing, and submission all go
// through it, because a scaling applied in one direction and missed in the
// other is a 1e6 mispricing that takes effect the instant the row is appended.
const TOKENS_PER_MILLION = 1_000_000;

// per_token rates are USD per single token and read best scaled to 1M; other
// units are already human-scale and must NOT be inflated.
const formatRate = (unit: string, value: number | undefined) => {
  if (value === undefined) return '-';
  const scaled = unit === 'per_token' ? value * TOKENS_PER_MILLION : value;
  return `$${scaled.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
};

// Both directions trim to 10 significant digits: the 1e6 round trip leaves
// float noise at either end (stored 1.4999999999999999e-05 must present as 15,
// and an entered 0.2 must store as 2e-7, not 2.0000000000000002e-7, or the
// API's idempotency compare sees a change that isn't one). Same choice as
// readable() in b4m-core/services/src/modelDiscoveryService/pricePlan.ts.
const trimRoundTripNoise = (value: number) => Number(value.toPrecision(10));

/** Stored per-single-token rate -> the value the editor shows and edits. */
const toDisplayedRate = (unit: string, stored: number) =>
  trimRoundTripNoise(unit === 'per_token' ? stored * TOKENS_PER_MILLION : stored);

/** Inverse of toDisplayedRate: the edited value back to the stored wire rate. */
const toStoredRate = (unit: string, displayed: number) =>
  trimRoundTripNoise(unit === 'per_token' ? displayed / TOKENS_PER_MILLION : displayed);

/**
 * What a user pays for a rate the editor is showing. Display only: the markup
 * is applied when calls settle (usdToCredits), so it must never reach the wire
 * or the catalog would carry cost times markup and be marked up again on read.
 */
const markedUpRate = (displayed: string | undefined) => {
  const value = Number(displayed);
  if (displayed === undefined || !Number.isFinite(value)) return '-';
  return `$${(value * getPriceMargin()).toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
};

const firstTier = (row: PriceRow): IModelPriceTier => Object.values(row.pricing)[0] ?? { input: 0, output: 0 };

const numberCell = { fontVariantNumeric: 'tabular-nums' } as const;

// Axios errors carry the server's validation reason in response.data, while
// err.message is the useless generic 'Request failed with status code 400'.
// The envelope names it 'error' (server/middlewares/errorHandler.ts); 'message'
// stays as a fallback for endpoints that answer outside that envelope.
const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e?.response?.data?.error || e?.response?.data?.message || e?.message || fallback;
};

// Mirrors MANUAL_REPRICE_BAND_ERROR_CODE in pages/api/admin/model-prices.ts
// (importing an API route here would drag the server into the SPA bundle);
// pinned by that route's test. It marks the one rejection an operator may waive,
// so a magnitude slip costs a second, deliberate click instead of nothing.
const BAND_ERROR_CODE = 'manual-reprice-over-band';

/**
 * The waiver token from a guardrail rejection, or null when the failure was
 * anything else. It is echoed back verbatim as `confirm`: the server recomputes
 * it from the resubmitted draft, so it can only ever waive the exact values
 * this rejection enumerated.
 */
const bandConfirmToken = (err: unknown): string | null => {
  const data = (err as { response?: { data?: { code?: string; confirmToken?: string } } })?.response?.data;
  return data?.code === BAND_ERROR_CODE && typeof data.confirmToken === 'string' ? data.confirmToken : null;
};

/**
 * Admin manager for the versioned model price catalog. Rates are provider
 * cost beliefs in USD (shown AND edited per 1M tokens, stored per token); what
 * users pay is always this cost times the published uniform markup, so nothing
 * here writes markup.
 * All writes are append-only rows via /api/admin/model-prices.
 */
export const ModelPricingCatalog: React.FC = () => {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const pricingModelId = useCreditAnalysisStore(state => state.pricingModelId);
  const clearPricingModelId = useCreditAnalysisStore(state => state.clearPricingModelId);

  const [repriceTarget, setRepriceTarget] = useState<PriceRow | null>(null);
  const [draftRates, setDraftRates] = useState<Record<string, Record<string, string>>>({});
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  // Waiver token from the server's guardrails; cleared on any edit so a confirm
  // can only ever waive the exact values the server rejected (the server also
  // re-derives the token, so a stale one is refused there too).
  const [confirmToken, setConfirmToken] = useState<string | null>(null);

  const [revertTarget, setRevertTarget] = useState<PriceRow | null>(null);
  const [historyModel, setHistoryModel] = useState<string | null>(null);
  const [history, setHistory] = useState<PriceRow[] | null>(null);
  // Latest requested history model; a slower earlier response must not
  // overwrite the drawer for the model currently displayed.
  const historyRequestRef = useRef<string | null>(null);

  const fetchRows = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<{ rows: PriceRow[] }>('/api/admin/model-prices');
      setRows([...res.data.rows].sort((a, b) => a.modelId.localeCompare(b.modelId)));
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load the price catalog'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  // A cross-surface jump (a discovery price flag) names one model out of ~110
  // rows. Consumed once so a later manual visit does not open still filtered.
  useEffect(() => {
    if (!pricingModelId) return;
    setFilter(pricingModelId);
    clearPricingModelId();
  }, [pricingModelId, clearPricingModelId]);

  // Drafts are held in the DISPLAYED unit (per 1M for token rows), so what the
  // editor shows always matches the table it was opened from.
  const openReprice = (row: PriceRow) => {
    const drafts: Record<string, Record<string, string>> = {};
    for (const [threshold, tier] of Object.entries(row.pricing)) {
      drafts[threshold] = {};
      for (const field of RATE_FIELDS) {
        const value = tier[field];
        if (value !== undefined) drafts[threshold][field] = String(toDisplayedRate(row.unit, value));
      }
    }
    setDraftRates(drafts);
    setNote('');
    setError(null);
    setConfirmToken(null);
    setRepriceTarget(row);
  };

  const editRate = (threshold: string, field: string, value: string) => {
    setConfirmToken(null);
    setDraftRates(prev => ({ ...prev, [threshold]: { ...prev[threshold], [field]: value } }));
  };

  const submitReprice = async (waiver?: string) => {
    if (!repriceTarget) return;
    setIsSaving(true);
    setError(null);
    try {
      const pricing: Record<string, Record<string, number>> = {};
      for (const [threshold, fields] of Object.entries(draftRates)) {
        pricing[threshold] = {};
        for (const [field, raw] of Object.entries(fields)) {
          pricing[threshold][field] = toStoredRate(repriceTarget.unit, Number(raw));
        }
      }
      await api.post('/api/admin/model-prices', {
        modelId: repriceTarget.modelId,
        unit: repriceTarget.unit,
        pricing,
        note: note.trim(),
        ...(waiver ? { confirm: waiver } : {}),
      });
      setRepriceTarget(null);
      setConfirmToken(null);
      await fetchRows();
    } catch (err) {
      setError(apiErrorMessage(err, 'Reprice failed'));
      setConfirmToken(bandConfirmToken(err));
    } finally {
      setIsSaving(false);
    }
  };

  const submitRevert = async () => {
    if (!revertTarget) return;
    setIsSaving(true);
    setError(null);
    try {
      await api.post('/api/admin/model-prices', {
        modelId: revertTarget.modelId,
        unit: revertTarget.unit,
        action: 'revert-to-seed',
      });
      setRevertTarget(null);
      await fetchRows();
    } catch (err) {
      setError(apiErrorMessage(err, 'Revert failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const openHistory = async (modelId: string) => {
    historyRequestRef.current = modelId;
    setHistoryModel(modelId);
    setHistory(null);
    try {
      const res = await api.get<{ history: PriceRow[] }>(
        `/api/admin/model-prices?history=${encodeURIComponent(modelId)}`
      );
      if (historyRequestRef.current !== modelId) return;
      setHistory(res.data.history);
    } catch (err) {
      if (historyRequestRef.current !== modelId) return;
      setError(apiErrorMessage(err, 'Failed to load history'));
      setHistoryModel(null);
    }
  };

  const repriceUnit = repriceTarget?.unit ?? '';
  const repriceUnitLabel = UNIT_SUFFIX[repriceUnit] ?? repriceUnit;

  const visibleRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? rows.filter(row => row.modelId.toLowerCase().includes(needle)) : rows;
  }, [rows, filter]);

  const draftInvalid = useMemo(
    () =>
      Object.values(draftRates).some(fields =>
        Object.values(fields).some(raw => raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0)
      ),
    [draftRates]
  );

  return (
    <Box data-testid="model-pricing-catalog">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Box>
          <Typography level="title-md">Model pricing (provider cost, USD; token rates shown per 1M)</Typography>
          <Typography level="body-sm" color="neutral">
            Users pay this cost times the published uniform markup. Changes append versioned rows; history is never
            edited.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Input
            size="sm"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by model id"
            sx={{ width: 220 }}
            slotProps={{ input: { 'data-testid': 'model-pricing-filter-input', 'aria-label': 'Filter by model id' } }}
          />
          <IconButton
            size="sm"
            onClick={fetchRows}
            disabled={isLoading}
            aria-label="Refresh the price catalog"
            data-testid="model-pricing-refresh-btn"
          >
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Stack>

      {error && (
        <Alert color="danger" sx={{ mb: 1 }} data-testid="model-pricing-error">
          {error}
        </Alert>
      )}

      {isLoading && rows.length === 0 ? (
        <CircularProgress size="sm" />
      ) : (
        // Viewport-relative so the catalog fills the tab; scroll stays internal.
        <Sheet sx={{ maxHeight: 'calc(100vh - 240px)', minHeight: 320, overflow: 'auto' }}>
          <Table stickyHeader hoverRow size="sm" data-testid="model-pricing-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Unit</th>
                <th>Input</th>
                <th>Output</th>
                <th>Audio in</th>
                <th>Audio out</th>
                <th>Effective from</th>
                <th>Source</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && rows.length > 0 && (
                <tr>
                  <td colSpan={9}>
                    <Typography level="body-sm" color="neutral" data-testid="model-pricing-filter-empty">
                      No model id matches &quot;{filter}&quot;.
                    </Typography>
                  </td>
                </tr>
              )}
              {visibleRows.map(row => {
                const tier = firstTier(row);
                const provenance = provenanceOf(row);
                const source = discoverySource(row);
                return (
                  <tr key={`${row.modelId}|${row.unit}`} data-testid={`model-pricing-row-${row.modelId}-${row.unit}`}>
                    <td>
                      <Typography level="body-sm">{row.modelId}</Typography>
                      {Object.keys(row.pricing).length > 1 && (
                        <Typography level="body-xs" color="neutral">
                          {Object.keys(row.pricing).length} tiers
                        </Typography>
                      )}
                    </td>
                    <td>{UNIT_SUFFIX[row.unit] ?? row.unit}</td>
                    <td style={numberCell}>{formatRate(row.unit, tier.input)}</td>
                    <td style={numberCell}>{formatRate(row.unit, tier.output)}</td>
                    <td style={numberCell}>{formatRate(row.unit, tier.audio_input)}</td>
                    <td style={numberCell}>{formatRate(row.unit, tier.audio_output)}</td>
                    <td>{new Date(row.effectiveFrom).toLocaleDateString()}</td>
                    <td>
                      <Chip
                        size="sm"
                        color={SOURCE_CHIP_COLOR[provenance]}
                        variant="soft"
                        title={source ? `priced by ${source}` : undefined}
                        // The color is the visual cue; this is the assertable one.
                        data-provenance={provenance}
                        data-testid={`model-pricing-source-${row.modelId}-${row.unit}`}
                      >
                        {provenance}
                      </Chip>
                    </td>
                    <td>
                      <Stack direction="row" spacing={0.5}>
                        <IconButton
                          size="sm"
                          title="Reprice"
                          aria-label={`Reprice ${row.modelId}`}
                          onClick={() => openReprice(row)}
                          data-testid={`model-pricing-reprice-${row.modelId}-${row.unit}`}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="sm"
                          title="History"
                          aria-label={`Price history for ${row.modelId}`}
                          onClick={() => openHistory(row.modelId)}
                          data-testid={`model-pricing-history-${row.modelId}-${row.unit}`}
                        >
                          <HistoryIcon fontSize="small" />
                        </IconButton>
                        {!isSeedRow(row) && (
                          <IconButton
                            size="sm"
                            title="Revert to seed pricing"
                            aria-label={`Revert ${row.modelId} to seed pricing`}
                            onClick={() => setRevertTarget(row)}
                            data-testid={`model-pricing-revert-${row.modelId}-${row.unit}`}
                          >
                            <ReplayIcon fontSize="small" />
                          </IconButton>
                        )}
                      </Stack>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      <Modal open={repriceTarget !== null} onClose={() => setRepriceTarget(null)}>
        <ModalDialog sx={{ minWidth: 420 }} data-testid="reprice-modal">
          <Typography level="title-md">Reprice {repriceTarget?.modelId}</Typography>
          {error && (
            // pre-line: a guardrail rejection enumerates one violation per
            // line, and every line has to be readable before "Apply anyway".
            <Alert color="danger" size="sm" sx={{ whiteSpace: 'pre-line' }} data-testid="reprice-modal-error">
              {error}
            </Alert>
          )}
          <Typography level="body-sm" color="neutral" data-testid="reprice-unit-help">
            Raw provider cost in USD {repriceUnitLabel}, as providers publish it. This appends a new operator row taking
            effect immediately; seeding will no longer manage this model until reverted.
          </Typography>
          <Stack spacing={1} sx={{ mt: 1 }}>
            {Object.entries(draftRates).map(([threshold, fields]) => (
              <Box key={threshold}>
                {Object.keys(draftRates).length > 1 && (
                  <Typography level="body-xs" color="neutral">
                    Tier threshold {Number(threshold).toLocaleString()} tokens
                  </Typography>
                )}
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {Object.entries(fields).map(([field, raw]) => (
                    <FormControl key={field} sx={{ width: 130 }}>
                      <FormLabel>
                        {RATE_LABELS[field as RateField]} {UNIT_FIELD_SUFFIX[repriceUnit] ?? repriceUnit}
                      </FormLabel>
                      <Input
                        size="sm"
                        value={raw}
                        onChange={e => editRate(threshold, field, e.target.value)}
                        slotProps={{ input: { 'data-testid': `reprice-rate-${threshold}-${field}` } }}
                      />
                    </FormControl>
                  ))}
                </Stack>
                <Typography level="body-xs" color="neutral" data-testid={`reprice-markup-${threshold}`}>
                  At the published {getPriceMargin()}x markup a user pays about {markedUpRate(fields.input)} in /{' '}
                  {markedUpRate(fields.output)} out {repriceUnitLabel}. Entered rates stay raw cost.
                </Typography>
              </Box>
            ))}
            <FormControl required>
              <FormLabel>Note (audit trail: where does this price come from?)</FormLabel>
              <Textarea
                minRows={2}
                value={note}
                onChange={e => setNote(e.target.value)}
                slotProps={{ textarea: { 'data-testid': 'reprice-note-input' } }}
              />
            </FormControl>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button variant="plain" color="neutral" onClick={() => setRepriceTarget(null)}>
                Cancel
              </Button>
              <Button
                disabled={note.trim() === '' || draftInvalid || isSaving}
                loading={isSaving}
                onClick={() => submitReprice()}
                data-testid="reprice-save-btn"
              >
                Append price row
              </Button>
              {confirmToken !== null && (
                <Button
                  color="danger"
                  disabled={note.trim() === '' || draftInvalid || isSaving}
                  loading={isSaving}
                  onClick={() => submitReprice(confirmToken)}
                  data-testid="reprice-confirm-band-btn"
                >
                  Apply anyway
                </Button>
              )}
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={revertTarget !== null} onClose={() => setRevertTarget(null)}>
        <ModalDialog data-testid="revert-modal">
          <Typography level="title-md">Revert {revertTarget?.modelId} to seed pricing?</Typography>
          {error && (
            <Alert color="danger" size="sm" data-testid="revert-modal-error">
              {error}
            </Alert>
          )}
          <Typography level="body-sm" color="neutral">
            Appends the adapter table&apos;s current rates under the seed note, so future adapter reprices flow to this
            model automatically again. The operator row stays in history.
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setRevertTarget(null)}>
              Cancel
            </Button>
            <Button color="warning" loading={isSaving} onClick={submitRevert} data-testid="revert-confirm-btn">
              Revert
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Drawer anchor="right" open={historyModel !== null} onClose={() => setHistoryModel(null)} size="md">
        <Box sx={{ p: 2 }} data-testid="history-drawer">
          <Typography level="title-md" sx={{ mb: 1 }}>
            Price history: {historyModel}
          </Typography>
          {history === null ? (
            <CircularProgress size="sm" />
          ) : (
            <Stack spacing={1}>
              {history.map((row, idx) => {
                const tier = firstTier(row);
                // Diff against the chronologically previous row (history is newest
                // first), across EVERY tier: a reprice touching only a higher
                // threshold must not read as "no rate changes" in an audit view.
                const prior = history[idx + 1];
                const thresholds = prior
                  ? Array.from(new Set([...Object.keys(row.pricing), ...Object.keys(prior.pricing)])).sort(
                      (a, b) => Number(a) - Number(b)
                    )
                  : [];
                const multiTier = thresholds.length > 1;
                const changes = prior
                  ? thresholds.flatMap(threshold =>
                      RATE_FIELDS.filter(
                        f => (row.pricing[threshold]?.[f] ?? undefined) !== (prior.pricing[threshold]?.[f] ?? undefined)
                      ).map(f => ({ threshold, f }))
                    )
                  : [];
                return (
                  <Sheet key={idx} variant="soft" sx={{ p: 1, borderRadius: 'sm' }} data-testid="history-row">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography level="body-sm">{new Date(row.effectiveFrom).toLocaleString()}</Typography>
                      <Chip
                        size="sm"
                        color={HISTORY_CHIP_COLOR[provenanceOf(row)]}
                        variant="soft"
                        data-provenance={provenanceOf(row)}
                        data-testid="history-who"
                      >
                        {row.repricedBy ?? (isSeedRow(row) ? 'seed' : isDiscoveryRow(row) ? 'discovery' : '-')}
                      </Chip>
                    </Stack>
                    <Typography level="body-sm" sx={{ fontStyle: 'italic' }}>
                      {row.note || 'no note'}
                    </Typography>
                    {prior ? (
                      changes.length === 0 ? (
                        <Typography level="body-xs">no rate changes</Typography>
                      ) : (
                        changes.map(({ threshold, f }) => (
                          <Typography
                            key={`${threshold}-${f}`}
                            level="body-xs"
                            sx={numberCell}
                            data-testid={`history-diff-${threshold}-${f}`}
                          >
                            {RATE_LABELS[f]}
                            {multiTier ? ` (tier ${Number(threshold).toLocaleString()})` : ''}:{' '}
                            <Typography component="span" color="danger" sx={{ textDecoration: 'line-through' }}>
                              {formatRate(row.unit, prior.pricing[threshold]?.[f])}
                            </Typography>{' '}
                            {'->'}{' '}
                            <Typography component="span" color="success">
                              {formatRate(row.unit, row.pricing[threshold]?.[f])}
                            </Typography>
                          </Typography>
                        ))
                      )
                    ) : (
                      <Typography level="body-xs" sx={numberCell}>
                        in {formatRate(row.unit, tier.input)} / out {formatRate(row.unit, tier.output)}
                        {tier.audio_input !== undefined &&
                          ` / audio in ${formatRate(row.unit, tier.audio_input)} / audio out ${formatRate(row.unit, tier.audio_output)}`}{' '}
                        ({UNIT_SUFFIX[row.unit] ?? row.unit})
                      </Typography>
                    )}
                  </Sheet>
                );
              })}
            </Stack>
          )}
        </Box>
      </Drawer>
    </Box>
  );
};
