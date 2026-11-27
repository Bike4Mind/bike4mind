import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Link,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminModelRow, PerMTokRate } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ADMIN_MODELS_QUERY_KEY } from '@client/app/hooks/data/adminModels';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  BulkActionBar,
  ChangePreview,
  DataTable,
  EmptyState,
  MissingPermissionState,
  StatusChip,
  UpdatingBar,
  maxAdminReasonNoteLength,
  useMissingAdminPermission,
  type AdminSelection,
  type DataColumn,
} from '../../shared';
import { adminFocus } from '../../shared/adminStyles';
import { SuccessorCostChip, SuccessorCostPanel } from '../../SuccessorCostDelta';
import { countOf } from '../List/modelBulkAccess';
import { ModelWriteAction, useModelWriteBlock } from '../ModelWriteAction';
import { useModelsNavigation } from '../modelsNavigation';
import {
  LIFECYCLE_QUEUE_QUERY_KEY,
  STALE_REFERENCES_OUTDATED_QUERY_KEY,
  STALE_REFERENCES_QUERY_KEY,
  LIFECYCLE_STATUS_PATH,
  apiErrorMessage,
  useLifecycleQueue,
  type LifecycleQueue,
  type LifecycleQueueItem,
} from './discoveryApi';
import { lifecycleWord } from './discoveryCopy';
import { replacementBlockers, runBulkResolution, type BulkAction, type BulkRowResult } from './modelLifecycleBulk';
import { buildBulkLifecycleNote, buildLifecycleNote, type NoteSubject } from './modelLifecycleNotes';
import { modelName, useModelIndex } from './useModelIndex';

const ACCEPT_REASONS = ADMIN_REASON_PRESETS.modelLifecycleAccept;
const DISMISS_REASONS = ADMIN_REASON_PRESETS.modelLifecycleDismiss;
const NO_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

type ModelIndex = ReadonlyMap<string, AdminModelRow> | undefined;

/** The queue view carries no backend, so the evidence line takes it from the model index. */
const noteSubject = (item: LifecycleQueueItem, index: ModelIndex): NoteSubject => ({
  ...item,
  backend: item.backend ?? index?.get(item.modelId)?.backend,
});

/**
 * What accepting does to the pickers: the catalog's retired fold disables a retired model at once, and
 * getAvailableModels drops a deprecated one from its deprecation date (see adminModelList in services).
 */
export const acceptEffect = (status: string, deprecationDate: string | undefined): string => {
  if (status === 'retired') return 'It leaves every picker now.';
  if (status === 'deprecated') {
    return deprecationDate
      ? `It drops out of pickers after ${deprecationDate}.`
      : 'It stays in pickers until a date is set.';
  }
  return 'Its place in pickers does not change.';
};

function ModelCell({ id, index, testId }: { id: string; index: ModelIndex; testId?: string }) {
  const name = modelName(index, id);
  return (
    <Stack sx={{ minWidth: 0 }} data-testid={testId}>
      <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
        {name}
      </Typography>
      {name !== id && (
        <Typography level="body-xs" fontFamily="code" noWrap sx={{ color: 'admin.inkMuted' }}>
          {id}
        </Typography>
      )}
    </Stack>
  );
}

const suggestedDates = (item: LifecycleQueueItem) =>
  [
    item.suggestion?.deprecationDate && `deprecates ${item.suggestion.deprecationDate}`,
    item.suggestion?.retirementDate && `retires ${item.suggestion.retirementDate}`,
  ]
    .filter(Boolean)
    .join(', ');

function suggestionColumns(index: ModelIndex, rates: Record<string, PerMTokRate>): DataColumn<LifecycleQueueItem>[] {
  return [
    {
      id: 'model',
      label: 'Model',
      render: item => <ModelCell id={item.modelId} index={index} />,
      sortValue: item => modelName(index, item.modelId),
    },
    {
      id: 'suggested',
      label: 'Suggested',
      width: '13rem',
      wrap: true,
      render: item => (
        <Stack>
          <Typography level="body-sm">{lifecycleWord(item.suggestion?.status)}</Typography>
          {suggestedDates(item) && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {suggestedDates(item)}
            </Typography>
          )}
        </Stack>
      ),
    },
    {
      id: 'successor',
      label: 'Successor',
      render: item => {
        const successor = item.suggestion?.replacedBy;
        if (!successor) return <Box sx={{ color: 'admin.inkMuted' }}>-</Box>;
        return (
          <Stack gap={0.25} sx={{ minWidth: 0 }}>
            <ModelCell id={successor} index={index} testId={`discovery-suggestion-successor-${item.modelId}`} />
            <Box>
              <SuccessorCostChip modelId={item.modelId} successorId={successor} rates={rates} />
            </Box>
          </Stack>
        );
      },
    },
    {
      id: 'source',
      label: 'Source',
      width: '10rem',
      wrap: true,
      render: item => (
        <Stack>
          <Typography level="body-sm">{item.suggestion?.source ?? 'unknown'}</Typography>
          {item.suggestion?.suggestedAt && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {new Date(item.suggestion.suggestedAt).toLocaleDateString()}
            </Typography>
          )}
        </Stack>
      ),
    },
  ];
}

function SuggestionMenu({
  item,
  name,
  onAccept,
  onDismiss,
}: {
  item: LifecycleQueueItem;
  name: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <ModelWriteAction>
      {disabled => (
        <Dropdown>
          <MenuButton
            disabled={disabled}
            slots={{ root: IconButton }}
            slotProps={{
              root: {
                size: 'sm',
                variant: 'plain',
                'aria-label': `Decide the suggestion for ${name}`,
                sx: { ...adminFocus, color: 'admin.inkMuted' },
              },
            }}
            data-testid={`discovery-suggestion-actions-${item.modelId}`}
          >
            <MoreHorizIcon sx={{ fontSize: 18 }} />
          </MenuButton>
          <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
            <MenuItem onClick={onAccept} data-testid={`discovery-suggestion-accept-${item.modelId}`}>
              Accept change
            </MenuItem>
            <MenuItem color="danger" onClick={onDismiss} data-testid={`discovery-suggestion-dismiss-${item.modelId}`}>
              Dismiss suggestion
            </MenuItem>
          </Menu>
        </Dropdown>
      )}
    </ModelWriteAction>
  );
}

function AcceptSuggestionDialog({
  item,
  index,
  rates,
  initialBlockers,
  onClose,
  onAccepted,
}: {
  item: LifecycleQueueItem;
  index: ModelIndex;
  rates: Record<string, PerMTokRate>;
  /** Blockers a bulk run already got for this row, so "Accept anyway" is offered without a first refusal. */
  initialBlockers?: string[];
  onClose: () => void;
  onAccepted: (status: string) => void;
}) {
  const [replacedBy, setReplacedBy] = useState(item.suggestion?.replacedBy ?? '');
  // Set only by a 409: the clauses the chosen successor missed, held until it is overruled or changed.
  const [blockers, setBlockers] = useState<string[] | null>(initialBlockers ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const name = modelName(index, item.modelId);
  const suggestion = item.suggestion;
  const current = index?.get(item.modelId)?.lifecycle;
  // Resolved as the accept route resolves them: the suggestion, then what is recorded. An empty successor field
  // sends nothing, so the suggested or recorded successor stays.
  const status = suggestion?.status ?? current?.status ?? 'deprecated';
  const typed = replacedBy.trim();
  const keptSuccessor = suggestion?.replacedBy ?? current?.replacedBy;
  const successor = typed || keptSuccessor || '';
  const successorRow = successor ? index?.get(successor) : undefined;
  const statusWord = lifecycleWord(status).toLowerCase();
  const deprecationDate = suggestion?.deprecationDate ?? current?.deprecationDate;
  const retirementDate = suggestion?.retirementDate ?? current?.retirementDate;
  const dates = [deprecationDate && `Deprecation ${deprecationDate}`, retirementDate && `retirement ${retirementDate}`]
    .filter(Boolean)
    .join(', ');

  const accept = async (reason: string) => {
    setFailure(null);
    try {
      await api.post(LIFECYCLE_STATUS_PATH, {
        modelId: item.modelId,
        action: 'accept',
        note: reason,
        ...(typed ? { replacedBy: typed } : {}),
        ...(blockers ? { acknowledgeBlockers: true } : {}),
      });
    } catch (error) {
      const refused = replacementBlockers(error);
      if (refused) setBlockers(refused);
      else {
        setFailure(apiErrorMessage(error, 'Accept failed'));
        // Another admin may have settled it already; the queue should stop offering it.
        void queryClient.invalidateQueries({ queryKey: LIFECYCLE_QUEUE_QUERY_KEY });
      }
      throw error;
    }
    onAccepted(status);
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Accept lifecycle change"
      description={
        suggestion?.status
          ? `Records ${name} as ${statusWord}, effective now. ${acceptEffect(status, deprecationDate)}`
          : `Records the successor for ${name}. Its lifecycle stays ${statusWord}.`
      }
      reasonPresets={ACCEPT_REASONS}
      // A draft of the evidence, not a submission: the admin reads and edits it before accepting.
      initialReason={{ preset: null, note: buildLifecycleNote(noteSubject(item, index)) }}
      confirmLabel={blockers ? 'Accept anyway' : suggestion?.status ? `Mark as ${statusWord}` : 'Accept change'}
      onConfirm={accept}
      data-testid="discovery-accept-dialog"
    >
      <Stack gap={1.5}>
        <ChangePreview
          before={lifecycleWord(current?.status ?? 'active')}
          after={lifecycleWord(status)}
          data-testid="discovery-accept-preview"
        />
        {dates && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            {dates}
          </Typography>
        )}
        {suggestion?.detail && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-accept-detail">
            {suggestion.detail}
          </Typography>
        )}
        {failure && (
          <Alert color="danger" size="sm" data-testid="discovery-accept-error">
            {failure}
          </Alert>
        )}
        {blockers && (
          <Alert color="warning" size="sm" data-testid="discovery-accept-blockers">
            <Box>
              <Typography level="body-sm">
                Discovery would not apply {successor ? modelName(index, successor) : 'this successor'} on its own:
              </Typography>
              <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
                {blockers.map(blocker => (
                  <li key={blocker}>
                    <Typography level="body-sm">{blocker}</Typography>
                  </li>
                ))}
              </Box>
              <Typography level="body-sm">
                Accepting anyway records the override and these reasons in its note.
              </Typography>
            </Box>
          </Alert>
        )}
        <FormControl>
          <FormLabel>Successor</FormLabel>
          <Input
            size="sm"
            value={replacedBy}
            onChange={event => {
              // The held blockers describe the previous successor.
              setBlockers(null);
              setReplacedBy(event.target.value);
            }}
            slotProps={{ input: { 'data-testid': 'discovery-accept-successor-input' } }}
          />
          <FormHelperText data-testid="discovery-accept-successor-name">
            {!successor
              ? 'No successor: users of this model are not moved.'
              : !typed
                ? `Left empty, ${modelName(index, successor)} stays the successor.`
                : successorRow
                  ? successorRow.name
                  : 'Not a model this console knows yet.'}
          </FormHelperText>
        </FormControl>
        {/* Priced against the successor this accept would write: the override is the decision that needs the number. */}
        <SuccessorCostPanel modelId={item.modelId} successorId={successor} rates={rates} />
      </Stack>
    </ActionDialog>
  );
}

function DismissSuggestionDialog({
  item,
  index,
  onClose,
  onDismissed,
}: {
  item: LifecycleQueueItem;
  index: ModelIndex;
  onClose: () => void;
  onDismissed: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const name = modelName(index, item.modelId);

  const dismiss = async (reason: string) => {
    setFailure(null);
    try {
      await api.post(LIFECYCLE_STATUS_PATH, { modelId: item.modelId, action: 'dismiss', note: reason });
    } catch (error) {
      setFailure(apiErrorMessage(error, 'Dismiss failed'));
      void queryClient.invalidateQueries({ queryKey: LIFECYCLE_QUEUE_QUERY_KEY });
      throw error;
    }
    onDismissed();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Dismiss suggestion"
      description={`Dismisses the suggestion for ${name} for good: it cannot be settled again, and discovery does not raise it again while the provider's signal is unchanged. There is no undo.`}
      reasonPresets={DISMISS_REASONS}
      confirmLabel="Dismiss suggestion"
      tone="danger"
      typedConfirm={{ expected: item.modelId, noun: 'model id' }}
      onConfirm={dismiss}
      data-testid="discovery-dismiss-dialog"
    >
      {failure && (
        <Alert color="danger" size="sm" data-testid="discovery-dismiss-error">
          {failure}
        </Alert>
      )}
    </ActionDialog>
  );
}

type BulkRequest = { action: BulkAction; items: LifecycleQueueItem[] };
// What the blockers of a blocked row were computed against: the successor and status the run saw.
type Unsettled = Exclude<BulkRowResult, { outcome: 'settled' }> & { basis: string };
const blockerBasis = (item: LifecycleQueueItem | undefined) =>
  `${item?.suggestion?.replacedBy ?? ''}|${item?.suggestion?.status ?? ''}`;
type BulkOutcome = { action: BulkAction; total: number; settled: number; unsettled: Unsettled[] };

// The reason must still fit once the longest preset is picked in front of it.
const BULK_NOTE_MAX = Math.min(...ACCEPT_REASONS.map(maxAdminReasonNoteLength));

/**
 * Settles the selection one suggestion at a time through the single-row route (see modelLifecycleBulk), with one
 * shared reason. A blocked or failed row is reported back to the queue; it never stops the rest.
 */
function BulkSettleDialog({
  request,
  index,
  onClose,
  onDone,
}: {
  request: BulkRequest;
  index: ModelIndex;
  onClose: () => void;
  onDone: (results: BulkRowResult[]) => void;
}) {
  const { action, items } = request;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const accept = action === 'accept';
  const count = items.length;

  const settle = async (reason: string) => {
    setProgress({ done: 0, total: count });
    try {
      const results = await runBulkResolution({
        modelIds: items.map(item => item.modelId),
        action,
        note: reason,
        post: body => api.post(LIFECYCLE_STATUS_PATH, body),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      onDone(results);
    } finally {
      setProgress(null);
    }
  };

  return (
    <ActionDialog
      open
      // Closing mid-run would hide rows still in flight.
      onClose={() => {
        if (!progress) onClose();
      }}
      title={accept ? 'Accept lifecycle changes' : 'Dismiss suggestions'}
      description={
        accept
          ? `Records each of the ${countOf(count, 'model')} as suggested, effective now, with its own lifecycle row and audit entry. A model whose successor fails the auto-remap checks is skipped and listed for a decision of its own.`
          : `Dismisses ${countOf(count, 'suggestion')} for good: none can be settled again, and discovery does not raise them again while the provider's signal is unchanged. There is no undo.`
      }
      reasonPresets={accept ? ACCEPT_REASONS : DISMISS_REASONS}
      initialReason={
        accept
          ? {
              preset: null,
              note: buildBulkLifecycleNote(
                items.map(item => noteSubject(item, index)),
                BULK_NOTE_MAX
              ),
            }
          : undefined
      }
      confirmLabel={accept ? `Accept ${countOf(count, 'change')}` : `Dismiss ${countOf(count, 'suggestion')}`}
      tone={accept ? 'neutral' : 'danger'}
      typedConfirm={accept ? undefined : { expected: String(count), noun: 'number of suggestions' }}
      onConfirm={settle}
      data-testid="discovery-bulk-dialog"
    >
      <Stack gap={1}>
        <Box
          component="ul"
          data-testid="discovery-bulk-models"
          sx={{ my: 0, pl: 2.5, maxHeight: '12rem', overflowY: 'auto' }}
        >
          {items.map(item => {
            const successor = item.suggestion?.replacedBy;
            const change = [
              item.suggestion?.status && lifecycleWord(item.suggestion.status),
              suggestedDates(item),
              successor && `successor ${modelName(index, successor)}`,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <li key={item.modelId}>
                <Typography level="body-sm">
                  {modelName(index, item.modelId)}
                  {change && (
                    <Typography component="span" sx={{ color: 'admin.inkMuted' }}>
                      {` - ${change}`}
                    </Typography>
                  )}
                </Typography>
              </li>
            );
          })}
        </Box>
        {progress && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-bulk-progress">
            {`${progress.done} of ${progress.total} done`}
          </Typography>
        )}
      </Stack>
    </ActionDialog>
  );
}

/** The rows a bulk run left unsettled that are still waiting; a blocked one goes to the single-row dialog. */
function BulkOutcomeAlert({
  outcome,
  waiting,
  index,
  onReview,
  onClose,
}: {
  outcome: BulkOutcome;
  waiting: Unsettled[];
  index: ModelIndex;
  onReview: (result: Extract<Unsettled, { outcome: 'blocked' }>) => void;
  onClose: () => void;
}) {
  const verb = outcome.action === 'accept' ? 'accepted' : 'dismissed';
  return (
    <Alert
      color="warning"
      size="sm"
      data-testid="discovery-bulk-result"
      endDecorator={
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close summary"
          onClick={onClose}
          data-testid="discovery-bulk-result-dismiss-btn"
        >
          <CloseRoundedIcon />
        </IconButton>
      }
    >
      <Stack gap={0.75} sx={{ minWidth: 0 }}>
        <Typography level="body-sm" sx={{ fontWeight: 600 }} data-testid="discovery-bulk-summary">
          {`${outcome.settled} of ${outcome.total} ${verb}. These still need a decision:`}
        </Typography>
        {waiting.map(result => (
          <Stack key={result.modelId} gap={0.25} data-testid={`discovery-bulk-result-${result.modelId}`}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <Typography level="body-sm">{modelName(index, result.modelId)}</Typography>
              <StatusChip
                tone={result.outcome === 'blocked' ? 'warn' : 'bad'}
                label={result.outcome === 'blocked' ? 'Needs its own decision' : 'Failed'}
              />
              {result.outcome === 'blocked' && (
                <ModelWriteAction>
                  {disabled => (
                    <Button
                      size="sm"
                      variant="plain"
                      disabled={disabled}
                      onClick={() => onReview(result)}
                      data-testid={`discovery-bulk-review-${result.modelId}`}
                    >
                      Review
                    </Button>
                  )}
                </ModelWriteAction>
              )}
            </Stack>
            <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
              {result.outcome === 'blocked' ? result.blockers.join('; ') : result.message}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Alert>
  );
}

/**
 * The lifecycle suggestion queue (pendingSuggestions of GET /api/admin/model-deprecation-status) with Accept and
 * Dismiss, one row at a time or for a selection.
 */
export function LifecycleSuggestions() {
  const queryClient = useQueryClient();
  const missing = useMissingAdminPermission('settings:manage');
  const writeBlock = useModelWriteBlock();
  const lifecycle = useLifecycleQueue(!missing);
  const index = useModelIndex().data?.byId;
  const { openModel, openPrices } = useModelsNavigation();
  const [accepting, setAccepting] = useState<LifecycleQueueItem | null>(null);
  const [acceptBlockers, setAcceptBlockers] = useState<string[] | undefined>(undefined);
  const [dismissing, setDismissing] = useState<LifecycleQueueItem | null>(null);
  const [selection, setSelection] = useState<AdminSelection>(NO_SELECTION);
  const [bulk, setBulk] = useState<BulkRequest | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const queue = lifecycle.data?.queue ?? [];
  const rates = lifecycle.data?.perMTokRates ?? {};

  const waitingIds = new Set(queue.map(item => item.modelId));
  // A row settled elsewhere (its own dialog, another admin) must not linger in the selected count.
  const liveSelection: AdminSelection =
    selection.mode === 'explicit'
      ? { mode: 'explicit', ids: selection.ids.filter(id => waitingIds.has(id)) }
      : selection;
  const selectedItems =
    liveSelection.mode === 'allMatching' ? queue : queue.filter(item => liveSelection.ids.includes(item.modelId));
  const outcomeWaiting = outcome?.unsettled.filter(result => waitingIds.has(result.modelId)) ?? [];

  const removeSettled = (modelIds: readonly string[], changedCatalog: boolean) => {
    const settled = new Set(modelIds);
    queryClient.setQueryData<LifecycleQueue>(LIFECYCLE_QUEUE_QUERY_KEY, current =>
      current ? { ...current, queue: current.queue.filter(item => !settled.has(item.modelId)) } : current
    );
    void queryClient.invalidateQueries({ queryKey: LIFECYCLE_QUEUE_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ADMIN_MODELS_QUERY_KEY });
    // A dismiss writes no catalog row, so only an accept can change the references. A loaded report is
    // only marked; re-running it asks every provider, which only a request may do.
    if (changedCatalog && queryClient.getQueryData(STALE_REFERENCES_QUERY_KEY) !== undefined) {
      queryClient.setQueryData(STALE_REFERENCES_OUTDATED_QUERY_KEY, true);
    }
  };

  const settle = (modelId: string, message: string, changedCatalog: boolean) => {
    removeSettled([modelId], changedCatalog);
    toast.success(message);
  };

  const finishBulk = (action: BulkAction, results: BulkRowResult[]) => {
    setBulk(null);
    const settled = results.filter(result => result.outcome === 'settled').map(result => result.modelId);
    const unsettled = results.flatMap((result): Unsettled[] =>
      result.outcome === 'settled'
        ? []
        : [{ ...result, basis: blockerBasis(bulk?.items.find(item => item.modelId === result.modelId)) }]
    );
    if (settled.length > 0) removeSettled(settled, action === 'accept');
    else void queryClient.invalidateQueries({ queryKey: LIFECYCLE_QUEUE_QUERY_KEY });
    // What still needs a decision stays selected, so the next pass starts from it.
    setSelection({ mode: 'explicit', ids: unsettled.map(result => result.modelId) });
    setOutcome(unsettled.length > 0 ? { action, total: results.length, settled: settled.length, unsettled } : null);
    if (settled.length > 0) {
      toast.success(
        action === 'accept'
          ? `Accepted ${countOf(settled.length, 'lifecycle change')}.`
          : `Dismissed ${countOf(settled.length, 'suggestion')}.`
      );
    }
  };

  return (
    <Stack component="section" gap={1} data-testid="discovery-suggestions">
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Box>
          <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
            Lifecycle suggestions
          </Typography>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Models a provider marked deprecated or retired. Accept to record it, or dismiss it.
          </Typography>
        </Box>
        <Link
          component="button"
          type="button"
          level="body-sm"
          onClick={() => void openPrices()}
          data-testid="discovery-suggestions-prices-link"
        >
          Model prices
        </Link>
      </Stack>
      {missing ? (
        <MissingPermissionState requirement="settings:manage" />
      ) : (
        <>
          <UpdatingBar active={lifecycle.isFetching && !lifecycle.isLoading} testId="discovery-suggestions-updating" />
          {lifecycle.isError && lifecycle.data && (
            <Alert color="warning" variant="soft" size="sm" data-testid="discovery-suggestions-refresh-error">
              Showing the last loaded suggestions; the refresh failed:{' '}
              {apiErrorMessage(lifecycle.error, 'Could not load lifecycle suggestions')}
            </Alert>
          )}
          {outcome && outcomeWaiting.length > 0 && (
            <BulkOutcomeAlert
              outcome={outcome}
              waiting={outcomeWaiting}
              index={index}
              onReview={result => {
                const item = queue.find(row => row.modelId === result.modelId) ?? null;
                // Blockers computed for another successor must not be acknowledged against the current one.
                setAcceptBlockers(item && blockerBasis(item) === result.basis ? result.blockers : undefined);
                setAccepting(item);
              }}
              onClose={() => setOutcome(null)}
            />
          )}
          <DataTable
            label="Lifecycle suggestions"
            testId="discovery-suggestions-table"
            rows={queue}
            columns={suggestionColumns(index, rates)}
            getRowId={item => item.modelId}
            selection={liveSelection}
            onSelectionChange={setSelection}
            selectionDisabled={!!writeBlock}
            // The default 40rem plus the selection column, so the name and successor columns keep their room.
            minWidth="43rem"
            loading={lifecycle.isLoading}
            error={
              lifecycle.isError && !lifecycle.data
                ? apiErrorMessage(lifecycle.error, 'Could not load lifecycle suggestions')
                : undefined
            }
            onRetry={() => void lifecycle.refetch()}
            onRowActivate={item => void openModel(item.modelId)}
            rowTestId={item => `discovery-suggestion-row-${item.modelId}`}
            rowActions={item => (
              <SuggestionMenu
                item={item}
                name={modelName(index, item.modelId)}
                onAccept={() => {
                  setAcceptBlockers(undefined);
                  setAccepting(item);
                }}
                onDismiss={() => setDismissing(item)}
              />
            )}
            pagination={queue.length > 25 ? undefined : false}
            empty={
              <Box data-testid="discovery-suggestions-empty">
                <EmptyState title="No lifecycle suggestions are waiting" action={null} />
              </Box>
            }
          />
          <BulkActionBar
            selection={liveSelection}
            totalMatching={queue.length}
            onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
            selectAllLabel={`Select all ${countOf(queue.length, 'suggestion')}`}
            onClear={() => setSelection(NO_SELECTION)}
          >
            <ModelWriteAction>
              {disabled => (
                <Button
                  size="sm"
                  variant="outlined"
                  disabled={disabled || selectedItems.length === 0}
                  onClick={() => setBulk({ action: 'accept', items: selectedItems })}
                  data-testid="discovery-bulk-accept-btn"
                >
                  Accept selected
                </Button>
              )}
            </ModelWriteAction>
            <ModelWriteAction>
              {disabled => (
                <Button
                  size="sm"
                  variant="outlined"
                  color="danger"
                  disabled={disabled || selectedItems.length === 0}
                  onClick={() => setBulk({ action: 'dismiss', items: selectedItems })}
                  data-testid="discovery-bulk-dismiss-btn"
                >
                  Dismiss selected
                </Button>
              )}
            </ModelWriteAction>
          </BulkActionBar>
        </>
      )}
      {accepting && (
        <AcceptSuggestionDialog
          key={accepting.modelId}
          item={accepting}
          index={index}
          rates={rates}
          initialBlockers={acceptBlockers}
          onClose={() => setAccepting(null)}
          onAccepted={status => {
            setAccepting(current => (current === accepting ? null : current));
            settle(accepting.modelId, `Recorded ${modelName(index, accepting.modelId)} as ${status}.`, true);
          }}
        />
      )}
      {dismissing && (
        <DismissSuggestionDialog
          key={dismissing.modelId}
          item={dismissing}
          index={index}
          onClose={() => setDismissing(null)}
          onDismissed={() => {
            setDismissing(current => (current === dismissing ? null : current));
            settle(dismissing.modelId, `Dismissed the suggestion for ${modelName(index, dismissing.modelId)}.`, false);
          }}
        />
      )}
      {bulk && (
        <BulkSettleDialog
          request={bulk}
          index={index}
          onClose={() => setBulk(null)}
          onDone={results => finishBulk(bulk.action, results)}
        />
      )}
    </Stack>
  );
}
