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
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import HistoryIcon from '@mui/icons-material/History';
import ReplayIcon from '@mui/icons-material/Replay';
import { api } from '@client/app/contexts/ApiContext';

/** Wire shape of one pricing tier (mirrors ModelPriceTier in common, which
 * gains optional audio fields in the realtime-voice catalog PR). */
interface PriceTier {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  audio_input?: number;
  audio_cache_read?: number;
  audio_output?: number;
}

/** Wire shape of a catalog row (dates arrive as ISO strings). */
interface PriceRow {
  modelId: string;
  unit: string;
  pricing: Record<string, PriceTier>;
  effectiveFrom: string;
  note?: string;
}

// Mirrors SEED_NOTE in @bike4mind/database (a server-only package; importing
// it here would pull mongoose into the client bundle). Pinned by a test there.
const SEED_NOTE = 'adapter-seed';
const isSeedRow = (row: PriceRow) => row.note === SEED_NOTE;

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

// per_token rates are USD per single token and read best scaled to 1M; other
// units are already human-scale and must NOT be inflated.
const formatRate = (unit: string, value: number | undefined) => {
  if (value === undefined) return '-';
  const scaled = unit === 'per_token' ? value * 1_000_000 : value;
  return `$${scaled.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
};

const firstTier = (row: PriceRow): PriceTier => Object.values(row.pricing)[0] ?? { input: 0, output: 0 };

const numberCell = { fontVariantNumeric: 'tabular-nums' } as const;

// Axios errors carry the server's validation reason in response.data, while
// err.message is the useless generic 'Request failed with status code 400'.
const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
};

/**
 * Admin manager for the versioned model price catalog. Rates are provider
 * cost beliefs in USD (shown per 1M tokens); what users pay is always this
 * cost times the published uniform markup, so nothing here touches markup.
 * All writes are append-only rows via /api/admin/model-prices.
 */
export const ModelPricingCatalog: React.FC = () => {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repriceTarget, setRepriceTarget] = useState<PriceRow | null>(null);
  const [draftRates, setDraftRates] = useState<Record<string, Record<string, string>>>({});
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);

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

  const openReprice = (row: PriceRow) => {
    const drafts: Record<string, Record<string, string>> = {};
    for (const [threshold, tier] of Object.entries(row.pricing)) {
      drafts[threshold] = {};
      for (const field of RATE_FIELDS) {
        const value = tier[field];
        if (value !== undefined) drafts[threshold][field] = String(value);
      }
    }
    setDraftRates(drafts);
    setNote('');
    setError(null);
    setRepriceTarget(row);
  };

  const submitReprice = async () => {
    if (!repriceTarget) return;
    setIsSaving(true);
    setError(null);
    try {
      const pricing: Record<string, Record<string, number>> = {};
      for (const [threshold, fields] of Object.entries(draftRates)) {
        pricing[threshold] = {};
        for (const [field, raw] of Object.entries(fields)) {
          pricing[threshold][field] = Number(raw);
        }
      }
      await api.post('/api/admin/model-prices', {
        modelId: repriceTarget.modelId,
        unit: repriceTarget.unit,
        pricing,
        note: note.trim(),
      });
      setRepriceTarget(null);
      await fetchRows();
    } catch (err) {
      setError(apiErrorMessage(err, 'Reprice failed'));
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
        <IconButton size="sm" onClick={fetchRows} disabled={isLoading} data-testid="model-pricing-refresh-btn">
          <RefreshIcon />
        </IconButton>
      </Stack>

      {error && (
        <Alert color="danger" sx={{ mb: 1 }} data-testid="model-pricing-error">
          {error}
        </Alert>
      )}

      {isLoading && rows.length === 0 ? (
        <CircularProgress size="sm" />
      ) : (
        <Sheet sx={{ maxHeight: 480, overflow: 'auto' }}>
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
              {rows.map(row => {
                const tier = firstTier(row);
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
                        color={isSeedRow(row) ? 'neutral' : 'primary'}
                        variant="soft"
                        data-testid={`model-pricing-source-${row.modelId}-${row.unit}`}
                      >
                        {isSeedRow(row) ? 'seed' : 'operator'}
                      </Chip>
                    </td>
                    <td>
                      <Stack direction="row" spacing={0.5}>
                        <IconButton
                          size="sm"
                          title="Reprice"
                          onClick={() => openReprice(row)}
                          data-testid={`model-pricing-reprice-${row.modelId}-${row.unit}`}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="sm"
                          title="History"
                          onClick={() => openHistory(row.modelId)}
                          data-testid={`model-pricing-history-${row.modelId}-${row.unit}`}
                        >
                          <HistoryIcon fontSize="small" />
                        </IconButton>
                        {!isSeedRow(row) && (
                          <IconButton
                            size="sm"
                            title="Revert to seed pricing"
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
            <Alert color="danger" size="sm" data-testid="reprice-modal-error">
              {error}
            </Alert>
          )}
          <Typography level="body-sm" color="neutral">
            USD per token. This appends a new operator row taking effect immediately; seeding will no longer manage this
            model until reverted.
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
                      <FormLabel>{RATE_LABELS[field as RateField]}</FormLabel>
                      <Input
                        size="sm"
                        value={raw}
                        onChange={e =>
                          setDraftRates(prev => ({
                            ...prev,
                            [threshold]: { ...prev[threshold], [field]: e.target.value },
                          }))
                        }
                        slotProps={{ input: { 'data-testid': `reprice-rate-${threshold}-${field}` } }}
                      />
                    </FormControl>
                  ))}
                </Stack>
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
                onClick={submitReprice}
                data-testid="reprice-save-btn"
              >
                Append price row
              </Button>
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
                return (
                  <Sheet key={idx} variant="soft" sx={{ p: 1, borderRadius: 'sm' }} data-testid="history-row">
                    <Typography level="body-sm">
                      {new Date(row.effectiveFrom).toLocaleString()} - {row.note || 'no note'}
                    </Typography>
                    <Typography level="body-xs" sx={numberCell}>
                      in {formatRate(row.unit, tier.input)} / out {formatRate(row.unit, tier.output)}
                      {tier.audio_input !== undefined &&
                        ` / audio in ${formatRate(row.unit, tier.audio_input)} / audio out ${formatRate(row.unit, tier.audio_output)}`}{' '}
                      ({UNIT_SUFFIX[row.unit] ?? row.unit})
                    </Typography>
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
