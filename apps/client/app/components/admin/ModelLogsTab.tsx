import React, { useEffect, useState } from 'react';
import {
  Box,
  Card,
  Stack,
  Typography,
  Button,
  FormControl,
  RadioGroup,
  Radio,
  LinearProgress,
  Grid,
  Alert,
  Select,
  Option,
  Input,
  Divider,
} from '@mui/joy';
import { MODEL_LOGS_MAX_PAGE } from '@client/shared/modelLogs';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoIcon from '@mui/icons-material/Info';
import { DateFilterComponent } from './Analytics/filters/DateFilterComponent';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useModelLogDetail, useModelLogs, ModelLogSummary } from '@client/app/hooks/useModelLogs';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { ErrorState } from './shared';
import {
  MODEL_LOGS_MODEL_OPTIONS,
  MODEL_LOGS_PAGE_SIZE_OPTIONS,
  MODEL_LOGS_SEARCH_PARSERS,
  type ModelLogsView,
} from './modelLogsTabSearch';
import { useModelLogsView } from './useModelLogsView';

const ALL_MODELS = 'all';

interface ModelLogsTabProps {
  loading?: boolean;
  onRefresh?: () => void;
}

const PaginationControls = ({
  currentPage,
  totalPages,
  onPageChange,
  itemsPerPage,
  onItemsPerPageChange,
  totalCount,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemsPerPage: number;
  onItemsPerPageChange: (size: number) => void;
  totalCount: number;
}) => (
  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2, mb: 2 }}>
    <Stack direction="row" spacing={2} justifyContent="center" alignItems="center">
      <Button
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
        data-testid="model-logs-prev-page-btn"
      >
        Previous
      </Button>
      <Typography>
        Page {currentPage} of {totalPages}
      </Typography>
      <Button
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
        data-testid="model-logs-next-page-btn"
      >
        Next
      </Button>
    </Stack>

    <Stack direction="row" spacing={2} alignItems="center">
      <FormControl>
        <RadioGroup
          orientation="horizontal"
          value={itemsPerPage}
          onChange={e => onItemsPerPageChange(Number(e.target.value))}
        >
          {MODEL_LOGS_PAGE_SIZE_OPTIONS.map(value => (
            <Radio
              key={value}
              value={value}
              label={`${value} per page`}
              size="sm"
              sx={{ mr: 2 }}
              slotProps={{ input: { 'data-testid': `model-logs-page-size-${value}-radio` } }}
            />
          ))}
        </RadioGroup>
      </FormControl>
      <Typography level="body-sm" fontWeight={800}>
        Total Logs: {totalCount}
      </Typography>
    </Stack>
  </Stack>
);

// The full promptMeta is fetched only when expanded; the list response carries just the card fields.
const ModelLogDetails = ({ id }: { id: string }) => {
  const [expanded, setExpanded] = useState(false);
  const detailQuery = useModelLogDetail(id, expanded);

  return (
    <Box>
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        data-testid="model-logs-details-toggle-btn"
      >
        {expanded ? 'Hide details' : 'Show details'}
      </Button>
      {expanded &&
        (detailQuery.isError ? (
          <ErrorState message="Could not load log details." onRetry={() => detailQuery.refetch()} />
        ) : detailQuery.data ? (
          <Box
            component="pre"
            data-testid="model-logs-details"
            sx={{
              m: 0,
              mt: 1,
              maxHeight: 480,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'code',
              fontSize: 'xs',
            }}
          >
            {JSON.stringify(detailQuery.data, null, 2)}
          </Box>
        ) : (
          <LinearProgress sx={{ mt: 1 }} data-testid="model-logs-details-loading" />
        ))}
    </Box>
  );
};

export const ModelLogsTab: React.FC<ModelLogsTabProps> = ({ loading, onRefresh }) => {
  const queryClient = useQueryClient();
  const [view, updateView] = useModelLogsView();
  const { page: currentPage, limit: itemsPerPage, startDate, endDate } = view;
  const modelFilter = view.model ?? ALL_MODELS;
  const { value: searchQuery, debouncedValue: debouncedSearch, setValue: setSearchQuery } = useDebounceValue('');

  const modelLogsQuery = useModelLogs({
    startDate,
    endDate,
    model: view.model,
    search: debouncedSearch || undefined,
    page: currentPage,
    limit: itemsPerPage,
  });

  // Any filter change goes back to the first page.
  const setDateRange = (range: Partial<Pick<ModelLogsView, 'startDate' | 'endDate'>>) =>
    updateView({ ...range, page: 1 });
  const selectLastDays = (days: number) =>
    setDateRange({
      startDate: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
      endDate: dayjs().format('YYYY-MM-DD'),
    });
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

  const isLoadingLogs = loading || modelLogsQuery.isLoading;
  // keepPreviousData leaves isLoading false on a refetch, so the old rows stay up under this.
  const isFetchingLogs = loading || modelLogsQuery.isFetching;

  return (
    <Box>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1 }}>
          <Typography level="h4">Model Response Logs</Typography>
          <ContextHelpButton helpId="admin/model-logs" tooltipText="Model Logs Help" />
        </Stack>
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

      <Card variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack spacing={2}>
          <Grid container spacing={2}>
            {/* Full row: two date inputs plus three range buttons overflow a narrower cell. */}
            <Grid xs={12}>
              <DateFilterComponent
                startDate={startDate}
                endDate={endDate}
                onStartDateChange={date => setDateRange({ startDate: date })}
                onEndDateChange={date => setDateRange({ endDate: date })}
                onRangeSelect={selectLastDays}
              />
            </Grid>
            <Grid xs={12} md={6}>
              <FormControl>
                <Select
                  value={modelFilter}
                  // The parser reads "All Models" (and anything unknown) as no model filter.
                  onChange={(_, value) =>
                    updateView({ model: MODEL_LOGS_SEARCH_PARSERS.modelLogsModel(value), page: 1 })
                  }
                  placeholder="Filter by Model"
                  data-testid="model-logs-model-select"
                >
                  <Option value={ALL_MODELS}>All Models</Option>
                  {MODEL_LOGS_MODEL_OPTIONS.map(option => (
                    <Option key={option.value} value={option.value}>
                      {option.label}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid xs={12} md={6}>
              <Input
                placeholder="Search logs..."
                value={searchQuery}
                slotProps={{ input: { 'data-testid': 'model-logs-search-input' } }}
                onChange={e => handleSearchChange(e.target.value)}
              />
            </Grid>
          </Grid>
        </Stack>
      </Card>

      <Alert variant="soft" color="neutral" startDecorator={<InfoIcon />} sx={{ mb: 2 }}>
        View detailed logs of model responses, including performance metrics, token usage, and execution tracking.
      </Alert>

      {/* Only the results swap while loading: re-rendering the filters in another layout would
          remount them and drop focus on every keystroke. */}
      {!isLoadingLogs && isFetchingLogs && <LinearProgress sx={{ mb: 2 }} data-testid="model-logs-refetching" />}
      {isLoadingLogs ? (
        <LinearProgress data-testid="model-logs-loading" />
      ) : modelLogsQuery.isError ? (
        <Card variant="outlined" sx={{ p: 2 }} data-testid="model-logs-error">
          <ErrorState message="Could not load model logs." onRetry={() => modelLogsQuery.refetch()} />
        </Card>
      ) : currentItems.length === 0 ? (
        <Card variant="outlined" sx={{ p: 2 }} data-testid="model-logs-empty">
          <Typography>No logs found for the selected filters.</Typography>
        </Card>
      ) : (
        <>
          <Stack spacing={2}>
            {currentItems.map((log: ModelLogSummary) => (
              <Card key={log.id} variant="outlined">
                <Stack spacing={2}>
                  <Grid container spacing={2}>
                    <Grid xs={12} md={3}>
                      <Typography level="body-sm" fontWeight="bold">
                        Model
                      </Typography>
                      <Typography>{log.modelName}</Typography>
                    </Grid>
                    <Grid xs={12} md={3}>
                      <Typography level="body-sm" fontWeight="bold">
                        Timestamp
                      </Typography>
                      <Typography>{dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}</Typography>
                    </Grid>
                    <Grid xs={12} md={3}>
                      <Typography level="body-sm" fontWeight="bold">
                        Response Time
                      </Typography>
                      <Typography>{log.totalResponseTime}ms</Typography>
                    </Grid>
                    <Grid xs={12} md={3}>
                      <Typography level="body-sm" fontWeight="bold">
                        Token Usage
                      </Typography>
                      <Typography>
                        {log.inputTokens} in / {log.outputTokens} out
                      </Typography>
                    </Grid>
                  </Grid>

                  <Divider />

                  <Grid container spacing={2}>
                    <Grid xs={12} md={6}>
                      <Typography level="body-sm" fontWeight="bold">
                        Context
                      </Typography>
                      <Typography>
                        Files: {log.attachedFileCount} | History: {log.messageHistoryLength}
                      </Typography>
                    </Grid>
                    <Grid xs={12} md={6}>
                      <Typography level="body-sm" fontWeight="bold">
                        Execution Steps
                      </Typography>
                      <Typography>
                        {log.completedStepCount} completed / {log.failedStepCount} failed
                      </Typography>
                    </Grid>
                  </Grid>

                  {log.artifacts.length > 0 && (
                    <>
                      <Divider />
                      <Typography level="body-sm" fontWeight="bold">
                        Artifacts ({log.artifacts.length})
                      </Typography>
                      <Stack spacing={1}>
                        {log.artifacts.map((artifact, idx: number) => (
                          <Typography key={idx} level="body-sm">
                            {artifact.type}: {artifact.preview}...
                          </Typography>
                        ))}
                      </Stack>
                    </>
                  )}

                  <ModelLogDetails id={log.id} />
                </Stack>
              </Card>
            ))}
          </Stack>
          {matchingPages > MODEL_LOGS_MAX_PAGE && (
            <Alert color="neutral" sx={{ mt: 2 }} data-testid="model-logs-page-limit">
              You can browse the first {MODEL_LOGS_MAX_PAGE.toLocaleString()} pages. Narrow the filters to see
              additional logs.
            </Alert>
          )}
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={page => updateView({ page })}
            itemsPerPage={itemsPerPage}
            onItemsPerPageChange={size => updateView({ limit: size, page: 1 })}
            totalCount={totalCount}
          />
        </>
      )}
    </Box>
  );
};
