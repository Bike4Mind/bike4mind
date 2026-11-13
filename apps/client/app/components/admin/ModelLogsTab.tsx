import React, { useEffect, useState } from 'react';
import { Box, Button, Input, Stack, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { MODEL_LOGS_MAX_PAGE } from '@client/shared/modelLogs';
import { isValidSupportCase, SUPPORT_CASE_MAX_LENGTH } from '@client/shared/supportCase';
import { useQueryClient } from '@tanstack/react-query';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useModelLogs, type ModelLogSummary } from '@client/app/hooks/useModelLogs';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  FilterChip,
  FilterInputLabel,
  FilterToolbar,
  SegmentedControl,
  UpdatingBar,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';
import { useDateDraft } from './EventMetrics/UserActivity/filters/DateFilterComponent';
import {
  DATE_PRESET_DAYS,
  getActivePreset,
  getPresetRange,
  isCompleteDateRange,
  today,
  type DatePresetDays,
  type DateRange,
} from './EventMetrics/UserActivity/dateRange';
import { MODEL_LOGS_MODEL_OPTIONS, MODEL_LOGS_SEARCH_PARSERS, type ModelLogsView } from './modelLogsTabSearch';
import { useModelLogsView } from './useModelLogsView';
import { formatCount, formatLogTime, ModelLogDrawer } from './ModelLogDrawer';

const PRESET_OPTIONS = DATE_PRESET_DAYS.map(days => ({
  value: String(days),
  label: days === 1 ? 'Today' : `${days} days`,
}));

interface ModelLogsTabProps {
  loading?: boolean;
  onRefresh?: () => void;
}

const columns: DataColumn<ModelLogSummary>[] = [
  {
    id: 'time',
    label: 'Time',
    width: '11rem',
    render: log => (
      <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {formatLogTime(log.timestamp)}
      </Box>
    ),
  },
  {
    id: 'model',
    label: 'Model',
    render: log => (
      <Typography level="body-sm" noWrap title={log.modelName} sx={{ color: 'admin.ink', fontWeight: 500 }}>
        {log.modelName ?? '-'}
      </Typography>
    ),
  },
  {
    id: 'response',
    label: 'Response time',
    width: '8rem',
    numeric: true,
    render: log => (log.totalResponseTime === undefined ? '-' : `${formatCount(log.totalResponseTime)} ms`),
  },
  {
    id: 'tokens',
    label: 'Tokens in / out',
    width: '9rem',
    numeric: true,
    render: log => `${formatCount(log.inputTokens) ?? '-'} / ${formatCount(log.outputTokens) ?? '-'}`,
  },
  {
    id: 'context',
    label: 'Files / history',
    width: '8rem',
    numeric: true,
    render: log => `${formatCount(log.attachedFileCount)} / ${formatCount(log.messageHistoryLength) ?? '-'}`,
  },
  {
    id: 'steps',
    label: 'Steps',
    width: '12rem',
    render: log => (
      <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
        {formatCount(log.completedStepCount)} completed
        {log.failedStepCount > 0 && (
          <Box component="span" sx={{ color: 'admin.danger' }}>
            , {formatCount(log.failedStepCount)} failed
          </Box>
        )}
      </Box>
    ),
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    width: '6rem',
    numeric: true,
    render: log => formatCount(log.artifacts.length),
  },
];

/**
 * Start and end date inputs plus the preset ranges. Emits only complete ranges; a partial date stays
 * in the input's draft (see useDateDraft) because the server rejects it.
 */
const DateRangeFilter = ({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) => {
  const { startDate, endDate } = value;
  const startDraft = useDateDraft(startDate);
  const endDraft = useDateDraft(endDate);
  const emitIfComplete = (range: DateRange) => {
    if (isCompleteDateRange(range)) onChange(range);
  };
  const activePreset = getActivePreset(value);

  return (
    <>
      <Input
        type="date"
        size="sm"
        value={startDraft.draft}
        startDecorator={<FilterInputLabel>From</FilterInputLabel>}
        onChange={event => {
          startDraft.setDraft(event.target.value);
          emitIfComplete({ startDate: event.target.value, endDate });
        }}
        onFocus={startDraft.onFocus}
        onBlur={startDraft.onBlur}
        slotProps={{
          input: { 'aria-label': 'Start date', max: endDate || today(), 'data-testid': 'model-logs-start-input' },
        }}
        sx={adminFocus}
      />
      <Input
        type="date"
        size="sm"
        value={endDraft.draft}
        startDecorator={<FilterInputLabel>To</FilterInputLabel>}
        onChange={event => {
          endDraft.setDraft(event.target.value);
          emitIfComplete({ startDate, endDate: event.target.value });
        }}
        onFocus={endDraft.onFocus}
        onBlur={endDraft.onBlur}
        slotProps={{
          input: { 'aria-label': 'End date', max: today(), min: startDate, 'data-testid': 'model-logs-end-input' },
        }}
        sx={adminFocus}
      />
      <SegmentedControl
        options={PRESET_OPTIONS}
        value={activePreset === null ? '' : String(activePreset)}
        onChange={days => onChange(getPresetRange(Number(days) as DatePresetDays))}
        aria-label="Date range"
        data-testid="model-logs-preset"
      />
    </>
  );
};

export const ModelLogsTab: React.FC<ModelLogsTabProps> = ({ loading, onRefresh }) => {
  const queryClient = useQueryClient();
  const [view, updateView] = useModelLogsView();
  const { page: currentPage, limit: itemsPerPage, startDate, endDate } = view;
  const { value: searchQuery, debouncedValue: debouncedSearch, setValue: setSearchQuery } = useDebounceValue('');
  // Committed on blur or Enter, never on a debounce: every request carrying the case writes an audit
  // row under it, so a half-typed case must not reach the server.
  const [supportCaseInput, setSupportCaseInput] = useState('');
  const [supportCase, setSupportCase] = useState('');
  const commitSupportCase = () => setSupportCase(supportCaseInput.trim());
  // A text search matches users' prompt text, so the server refuses it without a case.
  const canSearch = isValidSupportCase(supportCase);
  const [openLogId, setOpenLogId] = useState<string>();

  const modelLogsQuery = useModelLogs({
    startDate,
    endDate,
    model: view.model,
    search: (canSearch && debouncedSearch) || undefined,
    supportCase: canSearch ? supportCase : undefined,
    page: currentPage,
    limit: itemsPerPage,
  });

  // Any filter change goes back to the first page.
  const setDateRange = (range: Partial<Pick<ModelLogsView, 'startDate' | 'endDate'>>) =>
    updateView({ ...range, page: 1 });
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (currentPage !== 1) updateView({ page: 1 });
  };

  const handleRefresh = () => {
    modelLogsQuery.refetch();
    queryClient.invalidateQueries({ queryKey: ['modelLogDetail'] });
    onRefresh?.();
  };

  const totalCount = modelLogsQuery.data?.total ?? 0;
  const matchingPages = Math.ceil(totalCount / itemsPerPage);
  const totalPages = Math.min(matchingPages, MODEL_LOGS_MAX_PAGE);

  // A linked page can be past the end of the current results; clamp once they have loaded. A
  // placeholder is the previous filter's page, so its total says nothing about this one.
  const lastPage = Math.max(totalPages, 1);
  const isPagePastEnd = modelLogsQuery.isSuccess && !modelLogsQuery.isPlaceholderData && currentPage > lastPage;
  useEffect(() => {
    if (isPagePastEnd) updateView({ page: lastPage });
  }, [isPagePastEnd, lastPage, updateView]);

  const currentItems = modelLogsQuery.data?.logs ?? [];
  const openLog = currentItems.find(log => log.id === openLogId);

  const isLoadingLogs = loading || modelLogsQuery.isLoading;
  // keepPreviousData leaves isLoading false on a refetch, so the old rows stay up under this.
  const isFetchingLogs = loading || modelLogsQuery.isFetching;
  const showThirtyDays = getActivePreset({ startDate, endDate }) !== 30;

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-model-logs">
      <AdminPageHeader
        title="Model logs"
        count={modelLogsQuery.data ? totalCount : undefined}
        description="Each model response with its timing, token use, context and execution steps. Searching logs and reading a prompt are recorded against the support case you enter."
        actions={
          <Stack direction="row" alignItems="center" gap={1}>
            <ContextHelpButton helpId="admin/model-logs" tooltipText="Model Logs Help" />
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<RefreshIcon />}
              onClick={handleRefresh}
              disabled={isFetchingLogs}
              data-testid="model-logs-refresh-btn"
            >
              Refresh
            </Button>
          </Stack>
        }
      />

      {/* The filters never swap layout while loading: a remount would drop focus on every keystroke. */}
      <Stack gap={1}>
        <FilterToolbar data-testid="model-logs-toolbar">
          <DateRangeFilter value={{ startDate, endDate }} onChange={setDateRange} />
          <FilterChip
            id="model-logs-model"
            label="Model"
            options={MODEL_LOGS_MODEL_OPTIONS}
            value={view.model}
            onChange={value => updateView({ model: MODEL_LOGS_SEARCH_PARSERS.modelLogsModel(value), page: 1 })}
          />
        </FilterToolbar>
        <FilterToolbar data-testid="model-logs-support-toolbar">
          <Input
            size="sm"
            placeholder="Support case, then Enter"
            value={supportCaseInput}
            startDecorator={<FilterInputLabel>Case</FilterInputLabel>}
            slotProps={{
              input: {
                'data-testid': 'model-logs-support-case-input',
                'aria-label': 'Support case',
                maxLength: SUPPORT_CASE_MAX_LENGTH,
              },
            }}
            onChange={e => setSupportCaseInput(e.target.value)}
            onBlur={commitSupportCase}
            onKeyDown={e => {
              if (e.key === 'Enter') commitSupportCase();
            }}
            sx={{ ...adminFocus, flex: '0 1 16rem', minWidth: '12rem' }}
          />
          <Input
            size="sm"
            placeholder={canSearch ? 'Search prompts' : 'Enter a support case to search'}
            // Without a case the term is not sent, so showing it would read as an active filter.
            value={canSearch ? searchQuery : ''}
            disabled={!canSearch}
            startDecorator={<SearchIcon sx={{ fontSize: 16, color: 'admin.inkMuted' }} />}
            slotProps={{ input: { 'data-testid': 'model-logs-search-input', 'aria-label': 'Search prompts' } }}
            onChange={e => handleSearchChange(e.target.value)}
            sx={{ ...adminFocus, flex: '1 1 16rem', minWidth: '12rem', maxWidth: '26rem' }}
          />
        </FilterToolbar>
      </Stack>

      <Stack gap={1}>
        <Box sx={{ position: 'relative' }}>
          <UpdatingBar active={!isLoadingLogs && isFetchingLogs} placement="overlay" testId="model-logs-refetching" />
          <DataTable
            label="Model logs"
            testId="model-logs-table"
            rows={currentItems}
            columns={columns}
            getRowId={log => log.id}
            rowTestId={log => `model-logs-row-${log.id}`}
            loading={isLoadingLogs}
            error={modelLogsQuery.isError ? 'Could not load model logs.' : undefined}
            onRetry={() => void modelLogsQuery.refetch()}
            onRowActivate={log => setOpenLogId(log.id)}
            activeRowId={openLog?.id}
            pagination={{
              page: currentPage,
              pageSize: itemsPerPage,
              // Capped so Next stops at the last page the server will serve.
              total: Math.min(totalCount, MODEL_LOGS_MAX_PAGE * itemsPerPage),
              onPageChange: page => updateView({ page }),
              onPageSizeChange: size => updateView({ limit: size, page: 1 }),
            }}
            minWidth="64rem"
            maxHeight="none"
            empty={
              <Box data-testid="model-logs-empty">
                <EmptyState
                  title="No logs match these filters"
                  description="Try a longer date range or another model."
                  action={
                    showThirtyDays ? (
                      <Button
                        variant="outlined"
                        onClick={() => setDateRange(getPresetRange(30))}
                        data-testid="model-logs-empty-30-days-btn"
                      >
                        Show the last 30 days
                      </Button>
                    ) : (
                      <Button variant="outlined" onClick={handleRefresh} data-testid="model-logs-empty-refresh-btn">
                        Refresh
                      </Button>
                    )
                  }
                />
              </Box>
            }
          />
        </Box>
        {matchingPages > MODEL_LOGS_MAX_PAGE && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="model-logs-page-limit">
            You can browse the first {MODEL_LOGS_MAX_PAGE.toLocaleString()} pages. Narrow the filters to see additional
            logs.
          </Typography>
        )}
      </Stack>

      <ModelLogDrawer log={openLog} supportCase={supportCase} onClose={() => setOpenLogId(undefined)} />
    </Stack>
  );
};
