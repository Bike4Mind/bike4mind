import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Link,
  MenuItem,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { PerMTokRate } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { api } from '@client/app/contexts/ApiContext';
import { DiscoveryStatusCard } from './DiscoveryStatusCard';
import { SuccessorCostChip, SuccessorCostPanel } from './SuccessorCostDelta';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';
import { NOTE_QUICK_PICKS, appendQuickPick, buildBulkLifecycleNote, buildLifecycleNote } from './modelLifecycleNotes';
import { replacementBlockers, runBulkResolution, type BulkAction, type BulkRowResult } from './modelLifecycleBulk';
import {
  AdminDialog,
  AdminPageHeader,
  BulkActionBar,
  DataTable,
  EmptyState,
  ErrorState,
  StatusChip,
  UpdatingBar,
  type AdminSelection,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { RowActionsMenu } from './shared/RowActionsMenu';

/** Wire shapes of /api/admin/model-deprecation-status (dates arrive as strings). */
interface QueueItem {
  modelId: string;
  /** The serving backend, when the server could resolve it; picks the vendor page for the note. */
  backend?: string;
  /** Consecutive misses, sent only for absence-raised suggestions. */
  missCount?: number;
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
  /** null when the server could not build the report; staleReferencesError says why. */
  staleReferences: StaleReference[] | null;
  staleReferencesError?: string;
  /** Per-MTok rates in force, by model id, for pricing a proposed successor. */
  perMTokRates?: Record<string, PerMTokRate>;
}

const PROBLEM_TONE: Record<StaleReference['problem'], AdminStatusTone> = {
  deprecated: 'warn',
  retired: 'bad',
  // The catalog knows the id but the merged list does not carry it, so routing
  // to it fails the same way an unknown id does.
  'not-invocable': 'warn',
  unknown: 'neutral',
};

const Dash = () => (
  <Box component="span" sx={{ color: 'admin.inkMuted' }}>
    -
  </Box>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
    {children}
  </Typography>
);

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
 * One-click phrases under a note field. They append, so the prefilled evidence
 * line stays in the audit trail.
 */
const NoteQuickPicks = ({
  note,
  onChange,
  testIdPrefix,
}: {
  note: string;
  onChange: (next: string) => void;
  testIdPrefix: string;
}) => (
  <Stack direction="row" gap={0.5} flexWrap="wrap">
    {NOTE_QUICK_PICKS.map(pick => (
      <Button
        key={pick.id}
        size="sm"
        variant="soft"
        color="neutral"
        onClick={() => onChange(appendQuickPick(note, pick.text))}
        data-testid={`${testIdPrefix}-quickpick-${pick.id}`}
      >
        {pick.label}
      </Button>
    ))}
  </Stack>
);

const BULK_OUTCOME_LABEL: Record<Exclude<BulkRowResult['outcome'], 'settled'>, string> = {
  blocked: 'needs a per-row decision',
  failed: 'failed',
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
  // True from the first render, so the tables open on skeletons rather than empty states.
  const [isLoading, setIsLoading] = useState(true);
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

  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });
  // The bulk dialog: which verdict, the one shared note, progress while it runs,
  // and the rows that did not settle once it has.
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkNote, setBulkNote] = useState('');
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkRowResult[] | null>(null);

  const setAdminTab = useAdminModal(state => state.setActiveTab);
  const setCreditAnalysisTab = useCreditAnalysisStore(state => state.setActiveTab);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<LifecycleStatus>('/api/admin/model-deprecation-status');
      setStatus(res.data);
      // A row settled elsewhere (single-row dialog, another admin) must not linger in the selected count.
      const pending = new Set(res.data.queue.map(item => item.modelId));
      setSelection(current =>
        current.mode === 'explicit' && current.ids.some(id => !pending.has(id))
          ? { mode: 'explicit', ids: current.ids.filter(id => pending.has(id)) }
          : current
      );
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
    // Prefilled, not submitted: the operator still reads the evidence line and edits it.
    setNote(buildLifecycleNote(item));
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

  const queue = status?.queue ?? [];
  const selectedItems =
    selection.mode === 'allMatching' ? queue : queue.filter(item => selection.ids.includes(item.modelId));
  const clearSelection = () => setSelection({ mode: 'explicit', ids: [] });

  const openBulk = (action: BulkAction) => {
    // Accept gets the evidence template; a dismiss note is optional and starts empty.
    setBulkNote(action === 'accept' ? buildBulkLifecycleNote(selectedItems) : '');
    setBulkProgress(null);
    setBulkResults(null);
    setBulkAction(action);
  };

  const closeBulk = () => {
    if (bulkProgress && !bulkResults) return; // running: closing would hide rows still in flight
    setBulkAction(null);
    setBulkProgress(null);
    setBulkResults(null);
  };

  const submitBulk = async () => {
    if (!bulkAction || selectedItems.length === 0) return;
    const modelIds = selectedItems.map(item => item.modelId);
    setBulkProgress({ done: 0, total: modelIds.length });
    const results = await runBulkResolution({
      modelIds,
      action: bulkAction,
      note: bulkNote,
      post: body => api.post('/api/admin/model-deprecation-status', body),
      onProgress: (done, total) => setBulkProgress({ done, total }),
    });
    const unsettled = results.filter(result => result.outcome !== 'settled');
    // Keep what still needs a decision selected, so the next pass starts from it.
    setSelection({ mode: 'explicit', ids: unsettled.map(result => result.modelId) });
    await fetchStatus();
    if (unsettled.length === 0) {
      setBulkAction(null);
      setBulkProgress(null);
      return;
    }
    setBulkResults(results);
  };

  /** A blocked row leaves the bulk path for the single-row dialog, where acknowledging is an explicit choice. */
  const reviewBlocked = (modelId: string) => {
    const item = queue.find(candidate => candidate.modelId === modelId);
    setBulkAction(null);
    setBulkProgress(null);
    setBulkResults(null);
    if (item) openAccept(item);
  };

  const bulkRunning = bulkProgress !== null && bulkResults === null;
  const bulkSettledCount = bulkResults?.filter(result => result.outcome === 'settled').length ?? 0;

  const horizon = status ? horizonRows(status) : [];
  const rates = status?.perMTokRates ?? {};

  const refreshButton = (testId: string) => (
    <Button variant="outlined" onClick={fetchStatus} disabled={isLoading} data-testid={testId}>
      Refresh
    </Button>
  );

  const queueColumns: DataColumn<QueueItem>[] = [
    {
      id: 'model',
      label: 'Model',
      width: '14rem',
      render: item => (
        <Typography level="body-sm" noWrap title={item.modelId} sx={{ fontFamily: 'monospace' }}>
          {item.modelId}
        </Typography>
      ),
    },
    { id: 'suggested', label: 'Suggested', width: '8rem', render: item => item.suggestion?.status ?? <Dash /> },
    {
      id: 'dates',
      label: 'Dates',
      width: '12rem',
      render: item => (
        <>
          {item.suggestion?.deprecationDate ?? <Dash />}
          {item.suggestion?.retirementDate ? ` / ${item.suggestion.retirementDate}` : ''}
        </>
      ),
    },
    {
      id: 'successor',
      label: 'Successor',
      render: item => (
        <>
          {item.suggestion?.replacedBy ?? <Dash />}
          {item.suggestion?.replacedBy && (
            <Box sx={{ mt: 0.25 }}>
              <SuccessorCostChip modelId={item.modelId} successorId={item.suggestion.replacedBy} rates={rates} />
            </Box>
          )}
        </>
      ),
    },
    {
      id: 'source',
      label: 'Source',
      width: '10rem',
      render: item => (
        <Stack gap={0.25} sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap>
            {item.suggestion?.source ?? 'unknown'}
          </Typography>
          {item.suggestion?.suggestedAt && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {new Date(item.suggestion.suggestedAt).toLocaleDateString()}
            </Typography>
          )}
        </Stack>
      ),
    },
  ];

  const queueMenu = (item: QueueItem) => (
    <RowActionsMenu
      testId={`model-lifecycle-queue-actions-${item.modelId}`}
      ariaLabel={`Actions for ${item.modelId}`}
      disabled={pendingDismissId === item.modelId}
    >
      <MenuItem onClick={() => openAccept(item)} data-testid={`model-lifecycle-accept-${item.modelId}`}>
        Accept suggestion
      </MenuItem>
      <MenuItem
        color="danger"
        onClick={() => openDismiss(item)}
        data-testid={`model-lifecycle-dismiss-${item.modelId}`}
      >
        Dismiss suggestion
      </MenuItem>
    </RowActionsMenu>
  );

  const horizonColumns: DataColumn<ExpiringRow>[] = [
    {
      id: 'model',
      label: 'Model',
      render: row => (
        <Typography level="body-sm" noWrap title={row.modelId} sx={{ fontFamily: 'monospace' }}>
          {row.modelId}
        </Typography>
      ),
    },
    { id: 'status', label: 'Status', width: '9rem', render: row => row.status ?? <Dash /> },
    { id: 'deprecation', label: 'Deprecation', width: '9rem', render: row => row.deprecationDate ?? <Dash /> },
    { id: 'retirement', label: 'Retirement', width: '9rem', render: row => row.retirementDate ?? <Dash /> },
    {
      id: 'when',
      label: 'When',
      width: '7rem',
      render: row => (row.daysRemaining === undefined ? <Dash /> : formatDays(row.daysRemaining)),
    },
  ];

  const staleColumns: DataColumn<StaleReference>[] = [
    { id: 'surface', label: 'Surface', width: '10rem', render: ref => ref.surface },
    {
      id: 'entry',
      label: 'Entry',
      render: ref => (
        <Typography level="body-sm" noWrap title={ref.key} sx={{ fontFamily: 'monospace' }}>
          {ref.key}
        </Typography>
      ),
    },
    {
      id: 'pointsAt',
      label: 'Points at',
      render: ref => (
        <Typography level="body-sm" noWrap title={ref.referencedId} sx={{ fontFamily: 'monospace' }}>
          {ref.referencedId}
        </Typography>
      ),
    },
    {
      id: 'problem',
      label: 'Problem',
      width: '9rem',
      render: ref => (
        // ?? covers a problem kind the classifier gains before this file does.
        <StatusChip
          tone={PROBLEM_TONE[ref.problem] ?? 'neutral'}
          label={PROBLEM_LABEL[ref.problem] ?? ref.problem}
          data-testid={`model-lifecycle-stale-problem-${ref.surface}-${ref.referencedId}`}
        />
      ),
    },
  ];

  const firstLoad = isLoading && !status;
  // No count until there is data: a "(0)" while loading reads as an empty list.
  const count = (n: number | undefined) => (n === undefined ? '' : ` (${n})`);

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="model-lifecycle-panel">
      <AdminPageHeader
        title="Model lifecycle"
        description={
          <>
            Detected deprecations awaiting a verdict; accepting one appends an operator catalog row. Prices live in the{' '}
            {/* Already inside /admin, so setting the tab is the whole navigation. component="button":
                a Joy Link with an onClick and no href is an <a> without href, which no keyboard reaches. */}
            <Link
              component="button"
              onClick={() => {
                setCreditAnalysisTab('pricing');
                setAdminTab(AdminTab.CreditAnalytics);
              }}
              sx={{ verticalAlign: 'baseline' }}
              data-testid="model-lifecycle-model-pricing-link"
            >
              model pricing catalog
            </Link>
            .
          </>
        }
        actions={
          <IconButton
            size="sm"
            variant="outlined"
            onClick={fetchStatus}
            disabled={isLoading}
            aria-label="Refresh model lifecycle status"
            data-testid="model-lifecycle-refresh-btn"
          >
            <RefreshIcon />
          </IconButton>
        }
      />

      {error && status && (
        <Alert color="warning" variant="soft" data-testid="model-lifecycle-error">
          {`${error}. Showing the last loaded status.`}
        </Alert>
      )}

      <DiscoveryStatusCard onRunFinished={() => void fetchStatus()} />

      {error && !status ? (
        <Box data-testid="model-lifecycle-error">
          <ErrorState message={error} onRetry={fetchStatus} retrying={isLoading} />
        </Box>
      ) : (
        <Stack gap={1}>
          <UpdatingBar active={isLoading && !!status} testId="model-lifecycle-updating" />
          <Stack sx={{ gap: ADMIN_REGION_GAP }}>
            <Stack component="section" gap={1}>
              <SectionTitle>Deprecation queue{count(status?.queue.length)}</SectionTitle>
              <DataTable
                label="Deprecation queue"
                testId="model-lifecycle-queue-table"
                rows={status?.queue ?? []}
                columns={queueColumns}
                getRowId={item => item.modelId}
                rowTestId={item => `model-lifecycle-queue-row-${item.modelId}`}
                selection={selection}
                onSelectionChange={setSelection}
                loading={firstLoad}
                onRetry={fetchStatus}
                rowActions={queueMenu}
                // Fixed columns total 44rem plus the checkbox and 3.5rem actions columns; the successor takes the rest.
                minWidth="65rem"
                maxHeight="none"
                pagination={false}
                empty={
                  <Box data-testid="model-lifecycle-queue-empty">
                    <EmptyState
                      title="Nothing awaiting a decision"
                      description="Discovery adds a model here when it detects a deprecation."
                      action={refreshButton('model-lifecycle-queue-refresh-btn')}
                    />
                  </Box>
                }
              />
              <BulkActionBar
                selection={selection}
                totalMatching={queue.length}
                onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
                selectAllLabel={`Select all ${queue.length} pending`}
                onClear={clearSelection}
              >
                <Button
                  variant="outlined"
                  disabled={selectedItems.length === 0}
                  onClick={() => openBulk('accept')}
                  data-testid="model-lifecycle-bulk-accept-btn"
                >
                  Accept selected
                </Button>
                <Button
                  variant="outlined"
                  color="danger"
                  disabled={selectedItems.length === 0}
                  onClick={() => openBulk('dismiss')}
                  data-testid="model-lifecycle-bulk-dismiss-btn"
                >
                  Dismiss selected
                </Button>
              </BulkActionBar>
            </Stack>

            <Stack component="section" gap={1}>
              <SectionTitle>Expired and expiring{count(status ? horizon.length : undefined)}</SectionTitle>
              <DataTable
                label="Expired and expiring models"
                testId="model-lifecycle-horizon-table"
                rows={horizon}
                columns={horizonColumns}
                getRowId={row => row.modelId}
                rowTestId={row => `model-lifecycle-horizon-row-${row.modelId}`}
                loading={firstLoad}
                onRetry={fetchStatus}
                minWidth="48rem"
                maxHeight="none"
                pagination={false}
                empty={
                  <Box data-testid="model-lifecycle-horizon-empty">
                    <EmptyState
                      title="No expired or expiring models"
                      description={
                        status
                          ? `Nothing reaches its deprecation date in the next ${status.daysAhead} days.`
                          : undefined
                      }
                      action={refreshButton('model-lifecycle-horizon-refresh-btn')}
                    />
                  </Box>
                }
              />
            </Stack>

            <Stack component="section" gap={1}>
              <Box>
                <SectionTitle>Stale references{count(status?.staleReferences?.length)}</SectionTitle>
                <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                  A report: these model ids are hardcoded, so fixing one takes a code change.
                </Typography>
              </Box>
              {status?.staleReferences === null ? (
                <Box data-testid="model-lifecycle-stale-error">
                  <ErrorState
                    message={status.staleReferencesError ?? 'Stale reference report is unavailable'}
                    onRetry={fetchStatus}
                    retrying={isLoading}
                  />
                </Box>
              ) : (
                <DataTable
                  label="Stale references"
                  testId="model-lifecycle-stale-table"
                  rows={status?.staleReferences ?? []}
                  columns={staleColumns}
                  getRowId={ref => `${ref.surface}|${ref.key}|${ref.referencedId}`}
                  rowTestId={ref => `model-lifecycle-stale-row-${ref.surface}-${ref.referencedId}`}
                  loading={firstLoad}
                  onRetry={fetchStatus}
                  minWidth="48rem"
                  maxHeight="none"
                  pagination={false}
                  empty={
                    <Box data-testid="model-lifecycle-stale-empty">
                      <EmptyState
                        title="No stale references"
                        description="Every hardcoded model id points at a live model."
                        action={refreshButton('model-lifecycle-stale-refresh-btn')}
                      />
                    </Box>
                  }
                />
              )}
            </Stack>
          </Stack>
        </Stack>
      )}

      <AdminDialog
        open={acceptTarget !== null}
        onClose={closeAccept}
        title={`Accept lifecycle change for ${acceptTarget?.modelId ?? ''}`}
        width={560}
        data-testid="model-lifecycle-accept-modal"
      >
        <Stack gap={1}>
          {modalError && (
            <Alert color="danger" size="sm" data-testid="model-lifecycle-accept-error">
              {modalError}
            </Alert>
          )}
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Appends an operator row owning the lifecycle group, effective immediately. The model drops out of pickers
            once its deprecation date passes.
          </Typography>
          {acceptTarget?.suggestion?.detail && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="model-lifecycle-accept-detail">
              {acceptTarget.suggestion.detail}
            </Typography>
          )}
          {blockers && (
            <Alert color="warning" size="sm" data-testid="model-lifecycle-accept-blockers">
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
          {/* Priced against what is typed, not what was suggested: the override is the
              decision that needs the number, and it is the one the queue cannot precompute. */}
          {acceptTarget && (
            <SuccessorCostPanel modelId={acceptTarget.modelId} successorId={replacedBy.trim()} rates={rates} />
          )}
          <FormControl required>
            <FormLabel>Note (audit trail: what confirms this deprecation?)</FormLabel>
            <Textarea
              minRows={2}
              value={note}
              onChange={e => setNote(e.target.value)}
              slotProps={{ textarea: { 'data-testid': 'model-lifecycle-note-input' } }}
            />
          </FormControl>
          <NoteQuickPicks note={note} onChange={setNote} testIdPrefix="model-lifecycle-note" />
          <Stack direction="row" gap={1} justifyContent="flex-end" sx={{ mt: 1 }}>
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
              onClick={() => submitAccept(blockers !== null)}
              data-testid="model-lifecycle-accept-confirm-btn"
            >
              {blockers ? 'Accept anyway' : 'Append lifecycle row'}
            </Button>
          </Stack>
        </Stack>
      </AdminDialog>

      <AdminDialog
        open={dismissTarget !== null}
        onClose={closeDismiss}
        title={`Dismiss the suggestion for ${dismissTarget?.modelId ?? ''}?`}
        role="alertdialog"
        width={480}
        data-testid="model-lifecycle-dismiss-modal"
      >
        <Stack gap={1}>
          {modalError && (
            <Alert color="danger" size="sm" data-testid="model-lifecycle-dismiss-error">
              {modalError}
            </Alert>
          )}
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            This retires the suggestion for good: it cannot be settled again, and discovery will not re-raise it while
            the upstream signal is unchanged. There is no undo.
          </Typography>
          <Stack direction="row" gap={1} justifyContent="flex-end" sx={{ mt: 1 }}>
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
        </Stack>
      </AdminDialog>

      <AdminDialog
        open={bulkAction !== null}
        onClose={closeBulk}
        title={
          bulkResults
            ? `Bulk ${bulkAction === 'dismiss' ? 'dismiss' : 'accept'} finished`
            : bulkAction === 'dismiss'
              ? `Dismiss ${selectedItems.length} suggestions?`
              : `Accept ${selectedItems.length} lifecycle changes`
        }
        role={bulkAction === 'dismiss' ? 'alertdialog' : undefined}
        width={600}
        data-testid="model-lifecycle-bulk-modal"
      >
        {bulkResults ? (
          <Stack gap={1}>
            <Typography level="body-sm" data-testid="model-lifecycle-bulk-summary">
              {`${bulkSettledCount} of ${bulkResults.length} settled. These still need a decision:`}
            </Typography>
            <Box component="ul" sx={{ my: 0, pl: 2.5 }}>
              {bulkResults.map(result =>
                result.outcome === 'settled' ? null : (
                  <li key={result.modelId} data-testid={`model-lifecycle-bulk-result-${result.modelId}`}>
                    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                      <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                        {result.modelId}
                      </Typography>
                      <StatusChip
                        tone={result.outcome === 'blocked' ? 'warn' : 'bad'}
                        label={BULK_OUTCOME_LABEL[result.outcome]}
                      />
                      {result.outcome === 'blocked' && (
                        <Button
                          size="sm"
                          variant="plain"
                          onClick={() => reviewBlocked(result.modelId)}
                          data-testid={`model-lifecycle-bulk-review-${result.modelId}`}
                        >
                          Review
                        </Button>
                      )}
                    </Stack>
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      {result.outcome === 'blocked' ? result.blockers.join('; ') : result.message}
                    </Typography>
                  </li>
                )
              )}
            </Box>
            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
              <Button variant="plain" color="neutral" onClick={closeBulk} data-testid="model-lifecycle-bulk-close-btn">
                Close
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack gap={1}>
            <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
              {bulkAction === 'dismiss'
                ? 'Each suggestion is retired for good and gets its own audit entry. There is no undo.'
                : 'Each model gets its own operator row and audit entry, with its suggested dates and successor. A row whose successor fails the auto-remap checks is skipped and listed for a per-row decision.'}
            </Typography>
            <FormControl required={bulkAction === 'accept'}>
              <FormLabel>
                {bulkAction === 'accept'
                  ? 'Note for every row (audit trail: what confirms these deprecations?)'
                  : 'Note (optional, recorded in each audit entry)'}
              </FormLabel>
              <Textarea
                minRows={2}
                value={bulkNote}
                onChange={e => setBulkNote(e.target.value)}
                slotProps={{ textarea: { 'data-testid': 'model-lifecycle-bulk-note-input' } }}
              />
            </FormControl>
            <NoteQuickPicks note={bulkNote} onChange={setBulkNote} testIdPrefix="model-lifecycle-bulk-note" />
            {bulkProgress && (
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="model-lifecycle-bulk-progress">
                {`${bulkProgress.done} of ${bulkProgress.total} done`}
              </Typography>
            )}
            <Stack direction="row" gap={1} justifyContent="flex-end" sx={{ mt: 1 }}>
              <Button
                variant="plain"
                color="neutral"
                disabled={bulkRunning}
                onClick={closeBulk}
                data-testid="model-lifecycle-bulk-cancel-btn"
              >
                Cancel
              </Button>
              <Button
                color={bulkAction === 'dismiss' ? 'danger' : 'primary'}
                disabled={(bulkAction === 'accept' && bulkNote.trim() === '') || bulkRunning}
                loading={bulkRunning}
                onClick={() => void submitBulk()}
                data-testid="model-lifecycle-bulk-confirm-btn"
              >
                {bulkAction === 'dismiss'
                  ? `Dismiss ${selectedItems.length}`
                  : `Append ${selectedItems.length} lifecycle rows`}
              </Button>
            </Stack>
          </Stack>
        )}
      </AdminDialog>
    </Stack>
  );
};

export default ModelLifecycleTab;
