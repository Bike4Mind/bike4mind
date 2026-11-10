import { useRef, useState } from 'react';
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
import {
  ADMIN_MODEL_SOURCES,
  ADMIN_MODEL_STATUSES,
  ADMIN_MODEL_VIEWS,
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
import { postModelAccessBulk, useAdminModelList, useInvalidateModelAccess } from '@client/app/hooks/data/adminModels';
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

const SORT_BY_COLUMN: Record<string, AdminModelSort> = { model: 'name', type: 'type', status: 'status', rank: 'rank' };
const COLUMN_BY_SORT: Record<AdminModelSort, string> = {
  name: 'model',
  type: 'type',
  status: 'status',
  rank: 'rank',
  provider: 'provider',
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
/** One bulk write and its retries: each undo token with the reason its write was made under. */
type BulkBatch = { undo: { token: string; reason: string }[] };
/**
 * A bulk apply that left models unwritten, with the request that retries them inside the same batch; or an undo
 * that left models as they are. An undo is not retried: those models changed since the batch, so reversing the
 * batch's change on them could reach past what it did.
 */
type BulkOutcome =
  | { kind: 'failed'; summary: string; failed: FailedEntry[]; retry: ModelBulkRequest; batch: BulkBatch }
  | { kind: 'not-reverted'; summary: string; failed: FailedEntry[] };

const toggleEdit = (row: AdminModelRow): AccessEdit => {
  const on = effectiveAccess(row.access.entry).enabled;
  const verb = on ? 'Turn off' : 'Turn on';
  return { target: row, change: { enabled: !on }, title: `${verb} ${row.name}`, confirmLabel: verb };
};

/** Models > Models: every model the server knows, its status and why (docs/admin-models-spec.md 5.1). */
export function ModelListSection() {
  const [state, update] = useAdminListUrlState(MODELS_LIST_SEARCH_KEYS);
  // The fetch follows the URL's search term, which the list state writes once typing pauses.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const urlQuery = readAdminListState(search, MODELS_LIST_SEARCH_KEYS).query.trim().slice(0, SEARCH_MAX);
  const { filters } = state;
  const { openModel, openPrices } = useModelsNavigation();
  const invalidate = useInvalidateModelAccess();
  const showUndo = useUndoToast();
  const writeBlock = useModelWriteBlock();

  const providers = splitList(filters.providers);
  const types = splitList(filters.types);
  const sources = splitList(filters.sources).filter((value): value is AdminModelSource =>
    (ADMIN_MODEL_SOURCES as readonly string[]).includes(value)
  );
  const showFoundationIds = filters.foundation === '1';
  const sort = parseModelSort(filters.sort);
  const dir = filters.dir === 'desc' ? 'desc' : filters.dir === 'asc' ? 'asc' : undefined;
  const page = positiveInt(filters.page, 1);
  const pageSize = (ADMIN_PAGE_SIZES as readonly number[]).includes(Number(filters.pageSize))
    ? Number(filters.pageSize)
    : DEFAULT_PAGE_SIZE;
  const urlView = parseModelView(state.view);

  // Needs review is the default view while it holds anything; its count does not depend on the view shown.
  const [needsReviewCount, setNeedsReviewCount] = useState<number | undefined>(undefined);
  const view: AdminModelView = urlView ?? (needsReviewCount === 0 ? 'all' : 'needs-review');

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
  if (fetchedNeedsReview !== undefined && fetchedNeedsReview !== needsReviewCount) {
    setNeedsReviewCount(fetchedNeedsReview);
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
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  // The batch a retry in the bulk dialog belongs to, so its undo token joins the original apply's.
  const retryBatch = useRef<BulkBatch | null>(null);

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

  /** Reverts every write in the batch, oldest first; a retried undo resumes after the tokens that already went. */
  const undoBatch = (batch: BulkBatch) => {
    const pending = [...batch.undo];
    const results: ModelAccessBulkResult[] = [];
    return async () => {
      while (pending.length > 0) {
        const { token, reason } = pending[0];
        results.push(
          await postModelAccessBulk<ModelAccessBulkResult>({ undoToken: token, reason: undoAdminReason(reason) })
        );
        pending.shift();
      }
      await invalidate();
      const reverted = results.reduce((sum, result) => sum + result.counts.updated, 0);
      const notReverted = results.flatMap(failedResults);
      const summary = `Undo: ${countOf(reverted, 'model')} reverted${
        notReverted.length > 0 ? `, ${notReverted.length.toLocaleString()} not reverted` : ''
      }.`;
      setOutcome(notReverted.length > 0 ? { kind: 'not-reverted', summary, failed: notReverted } : null);
      // Replaces this toast, so its Undo cannot resend tokens that already went.
      showUndo({ message: summary });
    };
  };

  const onBulkApplied = (applied: ModelBulkApplied) => {
    const { request, result, reason, values, alsoRemoveBase } = applied;
    setBulk(null);
    setSelection(NO_SELECTION);
    void invalidate();
    const prior = retryBatch.current;
    retryBatch.current = null;
    const batch: BulkBatch = {
      undo: [...(prior?.undo ?? []), ...(result.undoToken ? [{ token: result.undoToken, reason }] : [])],
    };
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
    showUndo({
      message: `${result.summary} ${MODEL_PICKER_FRESHNESS}`,
      onUndo: batch.undo.length > 0 ? undoBatch(batch) : undefined,
    });
  };

  const retryFailed = () => {
    if (outcome?.kind !== 'failed') return;
    retryBatch.current = outcome.batch;
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
      render: row => priceSummary(row.price, row.type),
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
        onSelect={id => writeList({ page: '' }, { view: id })}
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
            {outcome.kind === 'failed'
              ? outcome.failed.map(entry => (
                  <Typography key={entry.id} level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
                    {entry.id}: {entry.reason ? BULK_FAILURE_LABEL[entry.reason] : 'failed'}
                  </Typography>
                ))
              : outcome.failed.map(entry => (
                  <Typography
                    key={entry.id}
                    level="body-xs"
                    sx={{ overflowWrap: 'anywhere' }}
                    data-testid="models-bulk-not-reverted-item"
                  >
                    <Link
                      component="button"
                      type="button"
                      level="body-xs"
                      onClick={() => void openModel(entry.id)}
                      data-testid="models-bulk-not-reverted-link"
                    >
                      {entry.id}
                    </Link>
                    : {entry.reason ? UNDO_FAILURE_LABEL[entry.reason] : 'not reverted'}
                  </Typography>
                ))}
            {outcome.kind === 'not-reverted' && (
              <Typography level="body-xs">Change these back from each model&apos;s page.</Typography>
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
        minWidth="76rem"
        selection={selection}
        onSelectionChange={setSelection}
        selectionDisabled={stale}
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
      />
      <ModelBulkAccessDialog
        request={bulk}
        onClose={() => {
          retryBatch.current = null;
          setBulk(null);
        }}
        onApplied={onBulkApplied}
      />
    </Stack>
  );
}
