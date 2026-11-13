import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Box,
  Button,
  Dropdown,
  IconButton,
  Link,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import MoreHorizRoundedIcon from '@mui/icons-material/MoreHorizRounded';
import { useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  ADMIN_MODEL_SOURCES,
  ADMIN_MODEL_STATUSES,
  ADMIN_MODEL_VIEWS,
  MODEL_ACCESS_UNDO_EXPIRED_CODE,
  type AdminModelFilter,
  type AdminModelRow,
  type AdminModelSort,
  type AdminModelSource,
  type AdminModelView,
  type ModelAccessBulkResult,
  type ModelAccessChange,
  type ModelAccessSelection,
} from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import {
  apiErrorOf,
  postModelAccessBulk,
  useAdminModelList,
  useInvalidateModelAccess,
} from '@client/app/hooks/data/adminModels';
import {
  AdminSearchInput,
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterChip,
  StatStrip,
  StatTile,
  StatusChip,
  UpdatingBar,
  ViewTabs,
  readAdminListState,
  undoAdminReason,
  useAdminListUrlState,
  useUndoToast,
  useUndoToastIsCurrent,
  useUndoToastOffersUndo,
  type AdminSelection,
  type DataColumn,
  type DataTableSort,
} from '../../shared';
import { ADMIN_PAGE_SIZES, ADMIN_REGION_GAP } from '../../shared/adminStyles';
import { MODEL_PICKER_FRESHNESS, ModelAccessDialog, type ModelAccessTarget } from '../Access/ModelAccessDialog';
import { effectiveAccess } from '../Access/modelAccessChange';
import { ModelFixAction } from '../ModelFixAction';
import { ModelIdText } from '../ModelIdText';
import { ModelWriteAction, useModelWriteBlock } from '../ModelWriteAction';
import {
  MODEL_SOURCE_LABEL,
  MODEL_STATUS_LABEL,
  MODEL_STATUS_TONE,
  MODEL_VIEW_LABEL,
  accessSummary,
  modelTypeLabel,
  priceSummary,
  sunsetDistance,
} from '../modelPresentation';
import { MODELS_LIST_SEARCH_KEYS, parseModelSort, parseModelView } from '../modelsSearch';
import { useModelsNavigation } from '../modelsNavigation';
import { ModelBulkAccessDialog, type ModelBulkApplied, type ModelBulkRequest } from './ModelBulkAccessDialog';
import {
  BULK_FAILURE_LABEL,
  MODEL_BULK_KINDS,
  MODEL_BULK_LABEL,
  UNDO_FAILURE_LABEL,
  countOf,
  failedResults,
} from './modelBulkAccess';

const DEFAULT_PAGE_SIZE = 50;
const SEARCH_MAX = 200;
const NO_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

const SORT_BY_COLUMN: Record<string, AdminModelSort> = {
  model: 'name',
  type: 'type',
  status: 'status',
  sunset: 'sunset',
  rank: 'rank',
};
const COLUMN_BY_SORT: Record<AdminModelSort, string> = {
  name: 'model',
  type: 'type',
  status: 'status',
  rank: 'rank',
  provider: 'provider',
  sunset: 'sunset',
};

const splitList = (value: string) =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

const positiveInt = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

type AccessEdit = { target: ModelAccessTarget; change: ModelAccessChange; title: string; confirmLabel: string };
type FailedEntry = ReturnType<typeof failedResults>[number];
/**
 * One bulk write and its retries: each unsent undo token with the reason its write was made under, a label naming the
 * write, and the models it updated; how many retries the batch has had, and the toast offering its undo. Shared, never
 * copied: an undo shifts each token off as it goes, so none is sent twice. `uncertain`: a send of it failed in transit
 * and may have committed.
 */
type BulkBatch = {
  undo: { token: string; reason: string; label: string; ids: string[]; uncertain?: boolean }[];
  retries: number;
  toastId: number | null;
};
/**
 * A retry open in the bulk dialog, by its request. `batch` is the batch its token joins, or null once an undo of that
 * batch started: a retry already sent then lands in a batch of its own, still labelled as a retry.
 */
type PendingRetry = { request: ModelBulkRequest; batch: BulkBatch | null; retries: number; outcome: BulkOutcome };
/** A write an undo did not revert, because its undo expired or the undo stopped first, and the models it changed. */
type UndoLeftover = { label: string; ids: string[]; expired: boolean; uncertain: boolean };
/**
 * A bulk apply that left models unwritten, with the request that retries them inside the same batch; or what an undo
 * could not do: the models it left as they are, and the writes it did not revert. A model left as it is gets no retry:
 * it changed since the batch, so reversing the batch's change on it could reach past what it did. `resumable` while
 * the batch's toast can still send the writes the undo stopped before.
 */
type BulkOutcome =
  | { kind: 'failed'; summary: string; failed: FailedEntry[]; retry: ModelBulkRequest; batch: BulkBatch }
  | {
      kind: 'not-reverted';
      summary: string;
      failed: FailedEntry[];
      unconfirmed: FailedEntry[];
      leftovers: UndoLeftover[];
      resumable: boolean;
      batch: BulkBatch;
    };

const isExpiredUndo = (error: unknown) => {
  const { status, data } = apiErrorOf(error);
  return status === 409 && data.code === MODEL_ACCESS_UNDO_EXPIRED_CODE;
};

const EMPTY_CELL = (
  <Box component="span" sx={{ color: 'admin.inkMuted' }} data-testid="models-row-empty">
    -
  </Box>
);

/** An undo POST that got no response or a 5xx may have committed before it failed; a 4xx was refused. */
const mayHaveCommitted = (error: unknown) => {
  const { status } = apiErrorOf(error);
  return status === undefined || status >= 500;
};

const asSentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const leftoverSentence = ({ label, ids, expired, uncertain }: UndoLeftover, resumable: boolean) => {
  const subject = `${capitalize(label)} (${countOf(ids.length, 'model')})`;
  if (uncertain) return `${subject} may not have been undone; check each model's page.`;
  return `${subject} was not undone${expired ? ': its undo had expired.' : resumable ? ' yet.' : '.'}`;
};

type UndoLeftoversProps = {
  failed: FailedEntry[];
  unconfirmed: FailedEntry[];
  leftovers: UndoLeftover[];
  resumable: boolean;
  /** Set while the undo toast offers Undo: leaving this page would drop it and the writes it can still revert. */
  newTab: boolean;
  modelHref: (id: string) => string;
  onOpen: (id: string) => void;
};

/** What an undo left behind, each model linked to its page: the ones it left as they are, then each unreverted write. */
function UndoLeftovers({ failed, unconfirmed, leftovers, resumable, newTab, modelHref, onOpen }: UndoLeftoversProps) {
  const modelLink = (id: string, testId: string) =>
    newTab ? (
      <Link href={modelHref(id)} target="_blank" rel="noopener noreferrer" level="body-xs" data-testid={testId}>
        {id}
      </Link>
    ) : (
      <Link component="button" type="button" level="body-xs" onClick={() => onOpen(id)} data-testid={testId}>
        {id}
      </Link>
    );
  const canResume = resumable && leftovers.some(leftover => !leftover.expired);
  return (
    <>
      {failed.map(entry => (
        <Typography
          key={entry.id}
          level="body-xs"
          sx={{ overflowWrap: 'anywhere' }}
          data-testid="models-bulk-not-reverted-item"
        >
          {modelLink(entry.id, 'models-bulk-not-reverted-link')}:{' '}
          {entry.reason ? UNDO_FAILURE_LABEL[entry.reason] : 'not reverted'}
        </Typography>
      ))}
      {failed.length > 0 && <Typography level="body-xs">Change these back from each model&apos;s page.</Typography>}
      {unconfirmed.map(entry => (
        <Typography
          key={entry.id}
          level="body-xs"
          sx={{ overflowWrap: 'anywhere' }}
          data-testid="models-bulk-unconfirmed-item"
        >
          {modelLink(entry.id, 'models-bulk-unconfirmed-link')}: may already be undone; check each model&apos;s page.
        </Typography>
      ))}
      {leftovers.map(leftover => (
        <Typography
          key={leftover.label}
          level="body-xs"
          sx={{ overflowWrap: 'anywhere' }}
          data-testid="models-bulk-not-undone-item"
        >
          {capitalize(leftover.label)}:{' '}
          {leftover.ids.map((id, index) => (
            <Fragment key={id}>
              {index > 0 && ', '}
              {modelLink(id, 'models-bulk-not-undone-link')}
            </Fragment>
          ))}
        </Typography>
      ))}
      {canResume && <Typography level="body-xs">Undo again from the undo toast while it is open.</Typography>}
      {leftovers.length > 0 && (
        <Typography level="body-xs">
          {canResume ? 'Once it has closed, change' : 'Change'} these back from each model&apos;s page.
        </Typography>
      )}
    </>
  );
}

const createFlagStore = (initial: boolean) => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: boolean) => {
      if (next === value) return;
      value = next;
      listeners.forEach(listener => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};
type FlagStore = ReturnType<typeof createFlagStore>;

/** UndoLeftovers in an undo's notice, which the toaster renders outside this page's providers. */
function NoticeLeftovers({ newTabStore, ...props }: Omit<UndoLeftoversProps, 'newTab'> & { newTabStore: FlagStore }) {
  const newTab = useSyncExternalStore(newTabStore.subscribe, newTabStore.get);
  return <UndoLeftovers {...props} newTab={newTab} />;
}

const toggleEdit = (row: AdminModelRow): AccessEdit => {
  const on = effectiveAccess(row.access.entry).enabled;
  const verb = on ? 'Turn off' : 'Turn on';
  return { target: row, change: { enabled: !on }, title: `${verb} ${row.name}`, confirmLabel: verb };
};

/** Models > Models: every model the server knows, its status and why. */
export function ModelListSection() {
  const [state, update] = useAdminListUrlState(MODELS_LIST_SEARCH_KEYS);
  // The fetch follows the URL's search term, which the list state writes once typing pauses.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const urlQuery = readAdminListState(search, MODELS_LIST_SEARCH_KEYS).query.trim().slice(0, SEARCH_MAX);
  const { filters } = state;
  const { openModel, openPrices, modelHref } = useModelsNavigation();
  const invalidate = useInvalidateModelAccess();
  const showUndo = useUndoToast();
  const isUndoToastCurrent = useUndoToastIsCurrent();
  const undoOffered = useUndoToastOffersUndo();
  const [undoOfferedStore] = useState(() => createFlagStore(undoOffered));
  useEffect(() => undoOfferedStore.set(undoOffered), [undoOffered, undoOfferedStore]);
  const writeBlock = useModelWriteBlock();

  const providers = splitList(filters.providers);
  const types = splitList(filters.types);
  const sources = splitList(filters.sources).filter((value): value is AdminModelSource =>
    (ADMIN_MODEL_SOURCES as readonly string[]).includes(value)
  );
  const showFoundationIds = filters.foundation === '1';
  const dir = filters.dir === 'desc' ? 'desc' : filters.dir === 'asc' ? 'asc' : undefined;
  const page = positiveInt(filters.page, 1);
  const pageSize = (ADMIN_PAGE_SIZES as readonly number[]).includes(Number(filters.pageSize))
    ? Number(filters.pageSize)
    : DEFAULT_PAGE_SIZE;
  const urlView = parseModelView(state.view);

  // Chosen once, from the first Needs review count (which does not depend on the view shown): a refetch that moves
  // the count must not switch the view, and clear the selection, under the admin.
  const [defaultView, setDefaultView] = useState<AdminModelView | undefined>(undefined);
  const view: AdminModelView = urlView ?? defaultView ?? 'needs-review';
  const sort = parseModelSort(filters.sort) ?? (view === 'retiring' ? 'sunset' : undefined);

  const baseFilter: Omit<AdminModelFilter, 'view' | 'showFoundationIds'> & { showFoundationIds: boolean } = {
    ...(urlQuery ? { search: urlQuery } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(types.length > 0 ? { types } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    showFoundationIds,
  };
  const list = useAdminModelList({ filter: { ...baseFilter, view }, sort, dir, page, pageSize });
  const data = list.data;
  const fetchedNeedsReview = data?.viewCounts['needs-review'];
  if (defaultView === undefined && fetchedNeedsReview !== undefined) {
    setDefaultView(fetchedNeedsReview > 0 ? 'needs-review' : 'all');
  }

  const [selection, setSelection] = useState<AdminSelection>(NO_SELECTION);
  const filterKey = JSON.stringify([view, urlQuery, providers, types, sources, showFoundationIds]);
  const [selectionKey, setSelectionKey] = useState(filterKey);
  if (selectionKey !== filterKey) {
    setSelectionKey(filterKey);
    setSelection(NO_SELECTION);
  }

  const [accessEdit, setAccessEdit] = useState<AccessEdit | null>(null);
  const [bulk, setBulk] = useState<ModelBulkRequest | null>(null);
  const [outcome, setOutcomeState] = useState<BulkOutcome | null>(null);
  // An undo settles after renders it did not see; it reads who holds the panel from here.
  const outcomeRef = useRef<BulkOutcome | null>(null);
  const setOutcome = (next: BulkOutcome | null) => {
    outcomeRef.current = next;
    setOutcomeState(next);
  };
  const pendingRetry = useRef<PendingRetry | null>(null);
  // While a batch's undo runs, its failed-models Retry stays disabled so no retry can join what is being reverted.
  const [undoingBatch, setUndoingBatch] = useState<BulkBatch | null>(null);

  // DataTable follows a sort change with onPageChange(1) in the same tick, before the URL comes back round; each
  // write builds on the last one so the second does not put the old sort back.
  const lastWrite = useRef<{ from: typeof filters; to: typeof filters } | null>(null);
  const writeList = (patch: typeof filters, rest: { query?: string; view?: string } = {}) => {
    const next = { ...(lastWrite.current?.from === filters ? lastWrite.current.to : filters), ...patch };
    lastWrite.current = { from: filters, to: next };
    update({ ...rest, filters: next });
  };
  const setFilters = (patch: typeof filters) => writeList({ page: '', ...patch });
  const filtered = !!state.query || providers.length > 0 || types.length > 0 || sources.length > 0 || showFoundationIds;
  const clearFilters = () =>
    writeList({ providers: '', types: '', sources: '', foundation: '', page: '' }, { query: '', view: '' });

  const total = data?.total ?? 0;
  // An empty placeholder is the previous view's result (Needs review before the switch to All), not this one's.
  const loading = list.isPending || (list.isPlaceholderData && (data?.models.length ?? 0) === 0);
  // A placeholder is the previous query's page: an all-matching selection would send this query's filter for it.
  const stale = list.isPlaceholderData;
  const selectedCount = selection.mode === 'allMatching' ? total : selection.ids.length;
  const bulkSelection = (): ModelAccessSelection =>
    selection.mode === 'allMatching' ? { filter: { ...baseFilter, view } } : { ids: [...selection.ids] };

  /**
   * Reverts every write in the batch, oldest first. An expired token is skipped and named, and the later ones still
   * go; any other failure stops the undo with what went through, and Undo again resumes at the first unsent token.
   * A newer write's toast and outcome may take the screen meanwhile: they stay, and this undo reports in a notice,
   * which stays up until dismissed when it is the only place naming the models still changed.
   */
  const undoBatch = (batch: BulkBatch) => {
    const results: ModelAccessBulkResult[] = [];
    const notReverted: FailedEntry[] = [];
    const unconfirmed: FailedEntry[] = [];
    const expired: UndoLeftover[] = [];
    return async () => {
      setUndoingBatch(batch);
      const retry = pendingRetry.current;
      if (retry?.batch === batch) {
        pendingRetry.current = { ...retry, batch: null };
        setBulk(current => (current === retry.request ? null : current));
      }
      let failure: unknown = null;
      try {
        while (batch.undo.length > 0) {
          const { token, reason, label, ids, uncertain } = batch.undo[0];
          try {
            const result = await postModelAccessBulk<ModelAccessBulkResult>({
              undoToken: token,
              reason: undoAdminReason(reason),
            });
            results.push(result);
            // A resend after an unconfirmed failure: the first send may have reverted these, so a stamp-moved or a
            // write error on the resend does not show they were left changed.
            (uncertain ? unconfirmed : notReverted).push(...failedResults(result));
          } catch (error) {
            if (!isExpiredUndo(error)) throw error;
            expired.push({ label, ids, expired: true, uncertain: uncertain === true });
          }
          batch.undo.shift();
        }
      } catch (error) {
        failure = error;
        if (batch.undo.length > 0 && mayHaveCommitted(error)) batch.undo[0].uncertain = true;
      }
      await invalidate();
      setUndoingBatch(current => (current === batch ? null : current));
      const ownToast = isUndoToastCurrent(batch.toastId);
      const resumable = failure !== null && ownToast;
      const leftovers = [
        ...expired,
        ...(failure !== null
          ? batch.undo.map(({ label, ids, uncertain }) => ({
              label,
              ids,
              expired: false,
              uncertain: uncertain === true,
            }))
          : []),
      ];
      const reverted = results.reduce((sum, result) => sum + result.counts.updated, 0);
      const nothingWent = failure !== null && results.length === 0 && expired.length === 0;
      const head = nothingWent
        ? asSentence(`Undo failed: ${getErrorMessage(failure)}`)
        : asSentence(
            `Undo: ${countOf(reverted, 'model')} reverted${
              notReverted.length > 0 ? `, ${notReverted.length.toLocaleString()} not reverted` : ''
            }${unconfirmed.length > 0 ? `, ${unconfirmed.length.toLocaleString()} unconfirmed` : ''}${failure !== null ? `; the rest failed: ${getErrorMessage(failure)}` : ''}`
          );
      const summary = [head, ...leftovers.map(leftover => leftoverSentence(leftover, resumable))].join(' ');

      const current = outcomeRef.current;
      const named = notReverted.length > 0 || unconfirmed.length > 0 || leftovers.length > 0;
      let noticed = false;
      if (current === null || current.batch === batch) {
        setOutcome(
          failure !== null || named
            ? { kind: 'not-reverted', summary, failed: notReverted, unconfirmed, leftovers, resumable, batch }
            : null
        );
      } else if (named) {
        // Another batch holds the panel, so this notice is the only place naming these models: it stays until dismissed.
        const notice = (
          <Stack gap={0.5} sx={{ minWidth: 0 }} data-testid="models-bulk-undo-notice">
            <Typography level="body-sm" sx={{ fontWeight: 600 }}>
              {summary}
            </Typography>
            <NoticeLeftovers
              failed={notReverted}
              unconfirmed={unconfirmed}
              leftovers={leftovers}
              resumable={resumable}
              newTabStore={undoOfferedStore}
              modelHref={modelHref}
              onOpen={id => void openModel(id)}
            />
          </Stack>
        );
        if (failure !== null) toast.error(notice, { duration: Infinity });
        else toast(notice, { duration: Infinity });
        noticed = true;
      }

      if (failure !== null) {
        if (ownToast) throw nothingWent ? failure : new Error(summary);
        if (!noticed) toast.error(summary);
      } else if (ownToast) {
        // Replaces this toast, so its Undo cannot resend tokens that already went.
        batch.toastId = showUndo({ message: summary });
      } else if (!noticed) {
        toast(summary);
      }
    };
  };

  const onBulkApplied = (applied: ModelBulkApplied) => {
    const { request, result, reason, values, alsoRemoveBase } = applied;
    setBulk(current => (current === request ? null : current));
    setSelection(NO_SELECTION);
    void invalidate();
    const retry = pendingRetry.current?.request === request ? pendingRetry.current : null;
    pendingRetry.current = null;
    const batch: BulkBatch = retry?.batch ?? { undo: [], retries: retry?.retries ?? 0, toastId: null };
    if (retry) batch.retries += 1;
    const label = retry ? `retry ${batch.retries}` : 'the original change';
    if (result.undoToken) {
      const ids = result.results.filter(entry => entry.outcome === 'updated').map(entry => entry.id);
      batch.undo.push({ token: result.undoToken, reason, label, ids });
    }
    const failed = failedResults(result);
    setOutcome(
      failed.length > 0
        ? {
            kind: 'failed',
            summary: result.summary,
            failed,
            retry: {
              kind: request.kind,
              selection: { ids: failed.map(entry => entry.id) },
              count: failed.length,
              values,
              alsoRemoveBase,
            },
            batch,
          }
        : null
    );
    batch.toastId = showUndo({
      message: `${result.summary} ${MODEL_PICKER_FRESHNESS}`,
      onUndo: batch.undo.length > 0 ? undoBatch(batch) : undefined,
    });
  };

  const retryFailed = () => {
    if (outcome?.kind !== 'failed' || outcome.batch === undoingBatch) return;
    pendingRetry.current = { request: outcome.retry, batch: outcome.batch, retries: outcome.batch.retries, outcome };
    setOutcome(null);
    setBulk(outcome.retry);
  };

  const columns: DataColumn<AdminModelRow>[] = [
    {
      id: 'model',
      label: 'Model',
      sortable: true,
      width: '22rem',
      render: row => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography level="body-sm" sx={{ fontWeight: 600, color: 'admin.ink', overflowWrap: 'anywhere' }}>
            {row.name}
          </Typography>
          <ModelIdText id={row.id} data-testid="models-row-copy-id-btn" />
        </Stack>
      ),
    },
    { id: 'type', label: 'Type', sortable: true, width: '8rem', render: row => modelTypeLabel(row.type) },
    {
      id: 'status',
      label: 'Status',
      sortable: true,
      width: '20rem',
      render: row => {
        const [first, ...rest] = row.reasons;
        return (
          <Stack gap={0.5} sx={{ minWidth: 0 }} data-testid="models-row-status">
            <Box>
              <StatusChip tone={MODEL_STATUS_TONE[row.status]} label={MODEL_STATUS_LABEL[row.status]} />
            </Box>
            {first && (
              <Stack direction="row" alignItems="center" gap={0.5} flexWrap="wrap">
                <Typography level="body-xs" sx={{ color: 'admin.inkSecondary' }} data-testid="models-row-reason">
                  {first.message}
                  {rest.length > 0 ? ` (+${rest.length} more)` : ''}
                </Typography>
                {first.fixAction && (
                  <ModelFixAction
                    action={first.fixAction}
                    model={row}
                    onTurnOn={() => setAccessEdit(toggleEdit(row))}
                    data-testid="models-row-fix-btn"
                  />
                )}
              </Stack>
            )}
          </Stack>
        );
      },
    },
    {
      id: 'sunset',
      label: 'Retires',
      sortable: true,
      width: '8rem',
      render: row =>
        row.sunsetDate === null || row.sunsetDays === null ? (
          EMPTY_CELL
        ) : (
          <Stack sx={{ minWidth: 0 }} data-testid="models-row-sunset">
            <Typography level="body-sm">{row.sunsetDate}</Typography>
            <Typography level="body-xs" sx={{ color: 'admin.inkSecondary' }}>
              {sunsetDistance(row.sunsetDays)}
            </Typography>
          </Stack>
        ),
    },
    {
      id: 'rank',
      label: 'Rank',
      sortable: true,
      numeric: true,
      width: '6rem',
      render: row =>
        row.rank === null ? (
          <Tooltip title="Unranked: the picker does not offer it">
            <span>-</span>
          </Tooltip>
        ) : row.rankProvisional ? (
          <Tooltip title="Provisional: no admin or catalog rank yet">
            <span data-testid="models-row-rank-provisional">{row.rank}*</span>
          </Tooltip>
        ) : (
          row.rank
        ),
    },
    {
      id: 'price',
      label: 'Price /1M in/out',
      width: '12rem',
      render: row => {
        const price = priceSummary(row.price, row.type);
        return price === '-' ? EMPTY_CELL : price;
      },
    },
    {
      id: 'access',
      label: 'Access',
      width: '12rem',
      render: row => {
        const summary = accessSummary(row.access);
        return summary.adminsOnly ? (
          <Tooltip title="Turned on, but with no tags and no entitlements no user can pick it">
            <span data-testid="models-row-admins-only">
              <StatusChip tone={summary.tone} label={summary.label} />
            </span>
          </Tooltip>
        ) : (
          summary.label
        );
      },
    },
  ];

  const tableSort: DataTableSort = { columnId: COLUMN_BY_SORT[sort ?? 'status'], direction: dir ?? 'asc' };
  const counts = data?.counts;
  const viewCounts = data?.viewCounts;

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="models-list">
      {counts && (
        <StatStrip aria-label="Models by status">
          {ADMIN_MODEL_STATUSES.filter(status => status !== 'retired' || counts.retired > 0).map(status => (
            <StatTile key={status} label={MODEL_STATUS_LABEL[status]} value={counts[status].toLocaleString()} />
          ))}
        </StatStrip>
      )}
      <ViewTabs
        views={ADMIN_MODEL_VIEWS.map(id => ({
          id,
          label: MODEL_VIEW_LABEL[id],
          count: viewCounts?.[id],
          testId: `models-view-${id}`,
        }))}
        activeId={view}
        // Retiring opens on the sunset sort, most overdue first, whatever the last view was sorted by.
        onSelect={id => writeList({ page: '', ...(id === 'retiring' ? { sort: '', dir: '' } : {}) }, { view: id })}
        aria-label="Model views"
        data-testid="models-views"
      />
      <Stack gap={1}>
        <Stack direction="row" flexWrap="wrap" gap={1} alignItems="center">
          <Box sx={{ flex: '1 1 16rem', minWidth: 0, maxWidth: { sm: 360 } }}>
            <AdminSearchInput
              value={state.query}
              onChange={query => {
                update({ query });
                if (page > 1) setFilters({});
              }}
              label="Search name or id"
              data-testid="models-search-input"
            />
          </Box>
          <FilterChip
            id="models-provider"
            label="Provider"
            multiple
            options={(data?.facets.providers ?? providers).map(value => ({ value, label: value }))}
            value={providers}
            onChange={next => setFilters({ providers: next.join(',') })}
          />
          <FilterChip
            id="models-type"
            label="Type"
            multiple
            options={(data?.facets.types ?? types).map(value => ({ value, label: modelTypeLabel(value) }))}
            value={types}
            onChange={next => setFilters({ types: next.join(',') })}
          />
          <FilterChip
            id="models-source"
            label="Source"
            multiple
            options={ADMIN_MODEL_SOURCES.map(value => ({ value, label: MODEL_SOURCE_LABEL[value] }))}
            value={sources}
            onChange={next => setFilters({ sources: next.join(',') })}
          />
        </Stack>
        {showFoundationIds ? (
          <Box>
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              endDecorator={<CloseRoundedIcon sx={{ fontSize: 16 }} />}
              onClick={() => setFilters({ foundation: '' })}
              data-testid="models-foundation-hide-btn"
            >
              Showing Bedrock foundation ids
            </Button>
          </Box>
        ) : (
          !!data?.foundationIds && (
            <Box>
              <Button
                size="sm"
                variant="plain"
                onClick={() => setFilters({ foundation: '1' })}
                data-testid="models-foundation-show-btn"
                sx={{ px: 1 }}
              >
                {countOf(data.foundationIds, 'Bedrock foundation id')} hidden
              </Button>
            </Box>
          )
        )}
      </Stack>

      {outcome && (
        <Alert
          color="warning"
          data-testid="models-bulk-failed"
          endDecorator={
            <Stack direction="row" gap={0.5}>
              {outcome.kind === 'failed' && (
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  onClick={retryFailed}
                  disabled={outcome.batch === undoingBatch}
                  data-testid="models-bulk-retry-btn"
                >
                  Retry failed
                </Button>
              )}
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label="Dismiss"
                onClick={() => setOutcome(null)}
                data-testid="models-bulk-failed-dismiss-btn"
              >
                <CloseRoundedIcon />
              </IconButton>
            </Stack>
          }
        >
          <Stack gap={0.5} sx={{ minWidth: 0 }}>
            <Typography level="body-sm" sx={{ fontWeight: 600 }}>
              {outcome.summary}
            </Typography>
            {outcome.kind === 'failed' ? (
              outcome.failed.map(entry => (
                <Typography key={entry.id} level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
                  {entry.id}: {entry.reason ? BULK_FAILURE_LABEL[entry.reason] : 'failed'}
                </Typography>
              ))
            ) : (
              <UndoLeftovers
                failed={outcome.failed}
                unconfirmed={outcome.unconfirmed}
                leftovers={outcome.leftovers}
                resumable={outcome.resumable}
                newTab={undoOffered}
                modelHref={modelHref}
                onOpen={id => void openModel(id)}
              />
            )}
          </Stack>
        </Alert>
      )}

      <UpdatingBar active={list.isFetching && !loading} testId="models-list-updating" />
      <DataTable
        rows={data?.models ?? []}
        columns={columns}
        getRowId={row => row.id}
        label="Models"
        loading={loading}
        error={list.error ? `Couldn't load the models. ${getErrorMessage(list.error)}` : undefined}
        onRetry={() => void list.refetch()}
        onRowActivate={row => void openModel(row.id)}
        testId="models-table"
        rowTestId={row => `models-row-${row.id}`}
        selection={selection}
        onSelectionChange={setSelection}
        selectionDisabled={stale || !!writeBlock}
        sort={tableSort}
        onSortChange={next => {
          const nextSort = SORT_BY_COLUMN[next.columnId];
          if (nextSort) setFilters({ sort: nextSort, dir: next.direction });
        }}
        pagination={{
          page,
          pageSize,
          total,
          onPageChange: next => writeList({ page: next > 1 ? String(next) : '' }),
          onPageSizeChange: next => setFilters({ pageSize: next === DEFAULT_PAGE_SIZE ? '' : String(next) }),
        }}
        rowActions={row => {
          const on = effectiveAccess(row.access.entry).enabled;
          return (
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    size: 'sm',
                    variant: 'plain',
                    'aria-label': `Actions for ${row.name}`,
                    'data-testid': 'models-row-menu-btn',
                  },
                }}
              >
                <MoreHorizRoundedIcon />
              </MenuButton>
              <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
                <MenuItem
                  disabled={!!writeBlock}
                  onClick={() => setAccessEdit(toggleEdit(row))}
                  data-testid="models-row-toggle-item"
                >
                  <Stack>
                    {on ? 'Turn off' : 'Turn on'}
                    {writeBlock && <Typography level="body-xs">{writeBlock}</Typography>}
                  </Stack>
                </MenuItem>
                <MenuItem onClick={() => void openPrices(row.id)} data-testid="models-row-price-item">
                  Open price
                </MenuItem>
                <MenuItem onClick={() => void openModel(row.id)} data-testid="models-row-open-item">
                  Open details
                </MenuItem>
              </Menu>
            </Dropdown>
          );
        }}
        empty={
          filtered ? (
            <EmptyState
              title="No models match these filters"
              action={
                <Button variant="outlined" onClick={clearFilters} data-testid="models-clear-filters-btn">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={`No models in ${MODEL_VIEW_LABEL[view]}`}
              action={
                <Button
                  variant="outlined"
                  onClick={() => writeList({ page: '' }, { view: 'all' })}
                  data-testid="models-show-all-btn"
                >
                  Show all models
                </Button>
              }
            />
          )
        }
      />
      {data?.models.some(row => row.rankProvisional && row.rank !== null) && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          * Provisional rank: no admin or catalog rank yet.
        </Typography>
      )}

      <BulkActionBar
        selection={selection}
        totalMatching={total}
        onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
        selectAllMatchingDisabled={stale}
        onClear={() => setSelection(NO_SELECTION)}
      >
        {MODEL_BULK_KINDS.map(kind => (
          <ModelWriteAction key={kind}>
            {disabled => (
              <Button
                size="sm"
                variant="outlined"
                disabled={disabled}
                data-testid={`models-bulk-${kind}-btn`}
                onClick={() => setBulk({ kind, selection: bulkSelection(), count: selectedCount })}
              >
                {MODEL_BULK_LABEL[kind]}
              </Button>
            )}
          </ModelWriteAction>
        ))}
      </BulkActionBar>

      <ModelAccessDialog
        target={accessEdit?.target ?? null}
        change={accessEdit?.change ?? null}
        title={accessEdit?.title ?? ''}
        confirmLabel={accessEdit?.confirmLabel ?? ''}
        onClose={() => setAccessEdit(null)}
        auditInNewTab
      />
      <ModelBulkAccessDialog
        request={bulk}
        onClose={() => {
          // A cancelled retry puts its failed-models report back, unless something newer took the panel meanwhile.
          const retry = pendingRetry.current;
          if (retry?.request === bulk && retry.batch && !outcomeRef.current) setOutcome(retry.outcome);
          pendingRetry.current = null;
          setBulk(null);
        }}
        onApplied={onBulkApplied}
      />
    </Stack>
  );
}
