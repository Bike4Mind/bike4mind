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
import { DiscoveryStatusCard } from './DiscoveryStatusCard';

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
    /**
     * The run's own sentence about the suggestion, including why it would not
     * apply the remap itself. Optional because only runs that persist it carry
     * one; older queue rows have none.
     */
    detail?: string;
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
  // Mirrors StaleReferenceProblem in @bike4mind/llm-adapters - the two unions are
  // independent, so a value added there compiles fine here and must be added by hand.
  problem: 'deprecated' | 'retired' | 'not-invocable' | 'unknown';
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
  // The catalog knows the id but the merged list does not carry it, so routing
  // to it fails the same way an unknown id does.
  'not-invocable': 'warning',
  unknown: 'neutral',
};

const PROBLEM_LABEL: Record<StaleReference['problem'], string> = {
  deprecated: 'deprecated',
  retired: 'retired',
  'not-invocable': 'not invocable',
  unknown: 'unknown',
};

// Axios errors carry the server's validation reason in response.data; err.message
// is the useless generic 'Request failed with status code 400'.
const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
};

/**
 * The accept route's 409 is the auto-remap clauses this successor missed - the
 * one refusal an operator is allowed to overrule, so it renders as a decision
 * rather than as an error. Anything else is a plain failure.
 */
const replacementBlockers = (err: unknown): string[] | null => {
  const res = (err as { response?: { status?: number; data?: { code?: string; details?: string[] } } })?.response;
  if (res?.status !== 409 || res.data?.code !== 'replacement-blocked') return null;
  return res.data.details?.length ? res.data.details : ['the automation refused this successor'];
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
  const [dismissTarget, setDismissTarget] = useState<QueueItem | null>(null);
  // Modal failures stay inside the modal that caused them; the page banner is
  // only for the fetch. Sharing one state painted a failed accept twice and
  // left a stale banner behind after Cancel.
  const [modalError, setModalError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [replacedBy, setReplacedBy] = useState('');
  // Set only by a 409: the constraints the chosen successor missed, held until
  // the operator either overrules them or picks a different successor.
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDismissId, setPendingDismissId] = useState<string | null>(null);

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
    setModalError(null);
    setBlockers(null);
    setAcceptTarget(item);
  };

  const closeAccept = () => {
    setAcceptTarget(null);
    setModalError(null);
    setBlockers(null);
  };

  const submitAccept = async (acknowledgeBlockers = false) => {
    if (!acceptTarget) return;
    setIsSaving(true);
    setModalError(null);
    try {
      await api.post('/api/admin/model-deprecation-status', {
        modelId: acceptTarget.modelId,
        action: 'accept',
        note: note.trim(),
        ...(replacedBy.trim() ? { replacedBy: replacedBy.trim() } : {}),
        ...(acknowledgeBlockers ? { acknowledgeBlockers: true } : {}),
      });
      setAcceptTarget(null);
      setBlockers(null);
      await fetchStatus();
    } catch (err) {
      const refused = replacementBlockers(err);
      if (refused) setBlockers(refused);
      else setModalError(apiErrorMessage(err, 'Accept failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const openDismiss = (item: QueueItem) => {
    setModalError(null);
    setDismissTarget(item);
  };

  const closeDismiss = () => {
    setDismissTarget(null);
    setModalError(null);
  };

  // Confirmed because it is final: the route rejects re-settling a suggestion and
  // discovery will not re-suggest while the upstream signal is unchanged.
  const confirmDismiss = async () => {
    if (!dismissTarget || pendingDismissId) return;
    const modelId = dismissTarget.modelId;
    setPendingDismissId(modelId);
    setModalError(null);
    try {
      await api.post('/api/admin/model-deprecation-status', { modelId, action: 'dismiss' });
      setDismissTarget(null);
      await fetchStatus();
    } catch (err) {
      setModalError(apiErrorMessage(err, 'Dismiss failed'));
    } finally {
      setPendingDismissId(null);
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
        <IconButton
          size="sm"
          onClick={fetchStatus}
          disabled={isLoading}
          aria-label="Refresh model lifecycle status"
          data-testid="model-lifecycle-refresh-btn"
        >
          <RefreshIcon />
        </IconButton>
      </Stack>

      {error && (
        <Alert color="danger" sx={{ mb: 1 }} data-testid="model-lifecycle-error">
          {error}
        </Alert>
      )}

      <Box sx={{ mb: 2 }}>
        <DiscoveryStatusCard />
      </Box>

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
                            disabled={pendingDismissId === item.modelId}
                            data-testid={`model-lifecycle-accept-${item.modelId}`}
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="plain"
                            color="neutral"
                            onClick={() => openDismiss(item)}
                            disabled={pendingDismissId === item.modelId}
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
                      {/* ?? covers a problem kind the classifier gains before this file does. */}
                      <Chip size="sm" variant="soft" color={PROBLEM_COLOR[ref.problem] ?? 'neutral'}>
                        {PROBLEM_LABEL[ref.problem] ?? ref.problem}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>
        </Stack>
      )}

      <Modal open={acceptTarget !== null} onClose={closeAccept}>
        <ModalDialog sx={{ minWidth: 420 }} data-testid="model-lifecycle-accept-modal">
          <Typography level="title-md">Accept lifecycle change for {acceptTarget?.modelId}</Typography>
          {modalError && (
            <Alert color="danger" size="sm" data-testid="model-lifecycle-accept-error">
              {modalError}
            </Alert>
          )}
          <Typography level="body-sm" color="neutral">
            Appends an operator row owning the lifecycle group, effective immediately. The model drops out of pickers
            once its deprecation date passes.
          </Typography>
          {acceptTarget?.suggestion?.detail && (
            <Typography level="body-xs" color="neutral" data-testid="model-lifecycle-accept-detail">
              {acceptTarget.suggestion.detail}
            </Typography>
          )}
          {blockers && (
            <Alert color="warning" size="sm" sx={{ mt: 1 }} data-testid="model-lifecycle-accept-blockers">
              <Box>
                <Typography level="body-sm">
                  Discovery would not apply {replacedBy.trim() || 'this successor'} on its own:
                </Typography>
                <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
                  {blockers.map(blocker => (
                    <li key={blocker}>
                      <Typography level="body-xs">{blocker}</Typography>
                    </li>
                  ))}
                </Box>
                <Typography level="body-xs">
                  Accepting anyway records the override and these reasons in the row&apos;s note.
                </Typography>
              </Box>
            </Alert>
          )}
          <Stack spacing={1} sx={{ mt: 1 }}>
            <FormControl>
              <FormLabel>Successor (optional override of the suggested replacement)</FormLabel>
              <Input
                size="sm"
                value={replacedBy}
                onChange={e => {
                  // The held blockers describe the previous successor.
                  setBlockers(null);
                  setReplacedBy(e.target.value);
                }}
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
              <Button
                variant="plain"
                color="neutral"
                onClick={closeAccept}
                data-testid="model-lifecycle-accept-cancel-btn"
              >
                Cancel
              </Button>
              <Button
                disabled={note.trim() === '' || isSaving}
                loading={isSaving}
                color={blockers ? 'warning' : 'primary'}
                onClick={() => submitAccept(blockers !== null)}
                data-testid="model-lifecycle-accept-confirm-btn"
              >
                {blockers ? 'Accept anyway' : 'Append lifecycle row'}
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={dismissTarget !== null} onClose={closeDismiss}>
        <ModalDialog sx={{ minWidth: 420 }} data-testid="model-lifecycle-dismiss-modal">
          <Typography level="title-md">Dismiss the suggestion for {dismissTarget?.modelId}?</Typography>
          {modalError && (
            <Alert color="danger" size="sm" data-testid="model-lifecycle-dismiss-error">
              {modalError}
            </Alert>
          )}
          <Typography level="body-sm" color="neutral">
            This retires the suggestion for good: it cannot be settled again, and discovery will not re-raise it while
            the upstream signal is unchanged. There is no undo.
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button
              variant="plain"
              color="neutral"
              onClick={closeDismiss}
              data-testid="model-lifecycle-dismiss-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              color="danger"
              disabled={pendingDismissId !== null}
              loading={pendingDismissId !== null}
              onClick={confirmDismiss}
              data-testid="model-lifecycle-dismiss-confirm-btn"
            >
              Dismiss suggestion
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default ModelLifecycleTab;
