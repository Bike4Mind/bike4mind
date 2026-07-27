import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
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
import { api } from '@client/app/contexts/ApiContext';

/** Wire shapes of /api/admin/model-deprecation-status (dates arrive as strings). */
interface QueueItem {
  modelId: string;
  suggestion?: {
    status?: string;
    deprecationDate?: string;
    retirementDate?: string;
    replacedBy?: string;
    source: string;
    suggestedAt: string;
  };
}

interface ExpiringRow {
  modelId: string;
  name?: string;
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
  daysRemaining?: number;
}

interface StaleReference {
  surface: string;
  key: string;
  referencedId: string;
  problem: 'deprecated' | 'retired' | 'unknown';
}

interface LifecycleStatus {
  daysAhead: number;
  totalModels: number;
  expiringOrExpired: ExpiringRow[];
  expired: ExpiringRow[];
  queue: QueueItem[];
  staleReferences: StaleReference[];
}

const PROBLEM_COLOR: Record<StaleReference['problem'], ColorPaletteProp> = {
  deprecated: 'warning',
  retired: 'danger',
  unknown: 'neutral',
};

// Axios errors carry the server's validation reason in response.data; err.message
// is the useless generic 'Request failed with status code 400'.
const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
};

const formatDays = (days: number | undefined) => {
  if (days === undefined) return '-';
  return days <= 0 ? `${Math.abs(days)}d ago` : `in ${days}d`;
};

/**
 * Merged horizon view: the catalog's expired models (which the picker filter
 * hides, so they never reach the live list) plus the live models approaching
 * their date. Most overdue first.
 */
function horizonRows(status: LifecycleStatus): ExpiringRow[] {
  const byModel = new Map<string, ExpiringRow>();
  for (const row of status.expired) byModel.set(row.modelId, row);
  for (const row of status.expiringOrExpired) if (!byModel.has(row.modelId)) byModel.set(row.modelId, row);
  return [...byModel.values()].sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));
}

/**
 * Operator work queue for model lifecycle (spec sec 7): detected deprecations
 * awaiting a verdict, what is already expired, and the hardcoded model-id
 * surfaces pointing at dead models. Accepting appends an operator catalog row;
 * the stale-reference list is a report - those surfaces are code.
 */
export const ModelLifecycleTab: React.FC = () => {
  const [status, setStatus] = useState<LifecycleStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [acceptTarget, setAcceptTarget] = useState<QueueItem | null>(null);
  const [note, setNote] = useState('');
  const [replacedBy, setReplacedBy] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<LifecycleStatus>('/api/admin/model-deprecation-status');
      setStatus(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load model lifecycle status'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const openAccept = (item: QueueItem) => {
    setNote('');
    setReplacedBy(item.suggestion?.replacedBy ?? '');
    setError(null);
    setAcceptTarget(item);
  };

  const submitAccept = async () => {
    if (!acceptTarget) return;
    setIsSaving(true);
    setError(null);
    try {
      await api.post('/api/admin/model-deprecation-status', {
        modelId: acceptTarget.modelId,
        action: 'accept',
        note: note.trim(),
        ...(replacedBy.trim() ? { replacedBy: replacedBy.trim() } : {}),
      });
      setAcceptTarget(null);
      await fetchStatus();
    } catch (err) {
      setError(apiErrorMessage(err, 'Accept failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const dismiss = async (modelId: string) => {
    setError(null);
    try {
      await api.post('/api/admin/model-deprecation-status', { modelId, action: 'dismiss' });
      await fetchStatus();
    } catch (err) {
      setError(apiErrorMessage(err, 'Dismiss failed'));
    }
  };

  const horizon = status ? horizonRows(status) : [];

  return (
    <Box data-testid="model-lifecycle-panel">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Box>
          <Typography level="title-md">Model lifecycle</Typography>
          <Typography level="body-sm" color="neutral">
            Detected deprecations awaiting a verdict. Accepting appends an operator catalog row; the stale-reference
            list is a report - those chains live in code.
          </Typography>
        </Box>
        <IconButton size="sm" onClick={fetchStatus} disabled={isLoading} data-testid="model-lifecycle-refresh-btn">
          <RefreshIcon />
        </IconButton>
      </Stack>

      {error && (
        <Alert color="danger" sx={{ mb: 1 }} data-testid="model-lifecycle-error">
          {error}
        </Alert>
      )}

      {isLoading && !status ? (
        <CircularProgress size="sm" />
      ) : (
        <Stack spacing={2}>
          <Sheet variant="plain">
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Deprecation queue ({status?.queue.length ?? 0})
            </Typography>
            {status && status.queue.length === 0 ? (
              <Typography level="body-sm" color="neutral" data-testid="model-lifecycle-queue-empty">
                Nothing awaiting a decision.
              </Typography>
            ) : (
              <Table size="sm" data-testid="model-lifecycle-queue-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Suggested</th>
                    <th>Dates</th>
                    <th>Successor</th>
                    <th>Source</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {status?.queue.map(item => (
                    <tr key={item.modelId} data-testid={`model-lifecycle-queue-row-${item.modelId}`}>
                      <td>{item.modelId}</td>
                      <td>{item.suggestion?.status ?? '-'}</td>
                      <td>
                        {item.suggestion?.deprecationDate ?? '-'}
                        {item.suggestion?.retirementDate ? ` / ${item.suggestion.retirementDate}` : ''}
                      </td>
                      <td>{item.suggestion?.replacedBy ?? '-'}</td>
                      <td>
                        <Chip size="sm" variant="soft">
                          {item.suggestion?.source ?? 'unknown'}
                        </Chip>
                        {item.suggestion?.suggestedAt && (
                          <Typography level="body-xs" color="neutral">
                            {new Date(item.suggestion.suggestedAt).toLocaleDateString()}
                          </Typography>
                        )}
                      </td>
                      <td>
                        <Stack direction="row" spacing={0.5}>
                          <Button
                            size="sm"
                            onClick={() => openAccept(item)}
                            data-testid={`model-lifecycle-accept-${item.modelId}`}
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="plain"
                            color="neutral"
                            onClick={() => dismiss(item.modelId)}
                            data-testid={`model-lifecycle-dismiss-${item.modelId}`}
                          >
                            Dismiss
                          </Button>
                        </Stack>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Sheet>

          <Sheet variant="plain">
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Expired and expiring ({horizon.length})
            </Typography>
            <Table size="sm" data-testid="model-lifecycle-horizon-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Deprecation</th>
                  <th>Retirement</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {horizon.map(row => (
                  <tr key={row.modelId} data-testid={`model-lifecycle-horizon-row-${row.modelId}`}>
                    <td>{row.modelId}</td>
                    <td>{row.status ?? '-'}</td>
                    <td>{row.deprecationDate ?? '-'}</td>
                    <td>{row.retirementDate ?? '-'}</td>
                    <td>{formatDays(row.daysRemaining)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>

          <Sheet variant="plain">
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Stale references ({status?.staleReferences.length ?? 0})
            </Typography>
            <Table size="sm" data-testid="model-lifecycle-stale-table">
              <thead>
                <tr>
                  <th>Surface</th>
                  <th>Entry</th>
                  <th>Points at</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {status?.staleReferences.map(ref => (
                  <tr
                    key={`${ref.surface}|${ref.key}|${ref.referencedId}`}
                    data-testid={`model-lifecycle-stale-row-${ref.surface}-${ref.referencedId}`}
                  >
                    <td>{ref.surface}</td>
                    <td>{ref.key}</td>
                    <td>{ref.referencedId}</td>
                    <td>
                      <Chip size="sm" variant="soft" color={PROBLEM_COLOR[ref.problem]}>
                        {ref.problem}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>
        </Stack>
      )}

      <Modal open={acceptTarget !== null} onClose={() => setAcceptTarget(null)}>
        <ModalDialog sx={{ minWidth: 420 }} data-testid="model-lifecycle-accept-modal">
          <Typography level="title-md">Accept lifecycle change for {acceptTarget?.modelId}</Typography>
          {error && (
            <Alert color="danger" size="sm" data-testid="model-lifecycle-accept-error">
              {error}
            </Alert>
          )}
          <Typography level="body-sm" color="neutral">
            Appends an operator row owning the lifecycle group, effective immediately. The model drops out of pickers
            once its deprecation date passes.
          </Typography>
          <Stack spacing={1} sx={{ mt: 1 }}>
            <FormControl>
              <FormLabel>Successor (optional override of the suggested replacement)</FormLabel>
              <Input
                size="sm"
                value={replacedBy}
                onChange={e => setReplacedBy(e.target.value)}
                slotProps={{ input: { 'data-testid': 'model-lifecycle-replacedby-input' } }}
              />
            </FormControl>
            <FormControl required>
              <FormLabel>Note (audit trail: what confirms this deprecation?)</FormLabel>
              <Textarea
                minRows={2}
                value={note}
                onChange={e => setNote(e.target.value)}
                slotProps={{ textarea: { 'data-testid': 'model-lifecycle-note-input' } }}
              />
            </FormControl>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button variant="plain" color="neutral" onClick={() => setAcceptTarget(null)}>
                Cancel
              </Button>
              <Button
                disabled={note.trim() === '' || isSaving}
                loading={isSaving}
                onClick={submitAccept}
                data-testid="model-lifecycle-accept-confirm-btn"
              >
                Append lifecycle row
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default ModelLifecycleTab;
