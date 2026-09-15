import React, { useState, useMemo } from 'react';
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
import dayjs from 'dayjs';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoIcon from '@mui/icons-material/Info';
import { DateFilterComponent } from './Analytics/filters/DateFilterComponent';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useModelLogs, ModelLog } from '@client/app/hooks/useModelLogs';

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
      <Button disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>
        Previous
      </Button>
      <Typography>
        Page {currentPage} of {totalPages}
      </Typography>
      <Button disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)}>
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
          {[10, 25, 50].map(value => (
            <Radio key={value} value={value} label={`${value} per page`} size="sm" sx={{ mr: 2 }} />
          ))}
        </RadioGroup>
      </FormControl>
      <Typography level="body-sm" fontWeight={800}>
        Total Logs: {totalCount}
      </Typography>
    </Stack>
  </Stack>
);

export const ModelLogsTab: React.FC<ModelLogsTabProps> = ({ loading, onRefresh }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [dateRange, setDateRange] = useState({
    startDate: dayjs().subtract(7, 'days').format('YYYY-MM-DD'),
    endDate: dayjs().format('YYYY-MM-DD'),
  });
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const modelLogsQuery = useModelLogs({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    model: modelFilter !== 'all' ? modelFilter : undefined,
    search: searchQuery || undefined,
  });

  const handleRefresh = () => {
    modelLogsQuery.refetch();
    onRefresh?.();
  };

  const logs = useMemo(() => {
    if (!modelLogsQuery.data?.logs) return [];
    return modelLogsQuery.data.logs.sort((a: ModelLog, b: ModelLog) => dayjs(b.timestamp).diff(dayjs(a.timestamp)));
  }, [modelLogsQuery.data]);

  const totalPages = Math.ceil((logs?.length || 0) / itemsPerPage);
  const currentItems = logs?.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage) || [];

  if (loading || modelLogsQuery.isLoading) {
    return (
      <Box>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography level="h4" sx={{ flex: 1 }}>
            Model Response Logs
          </Typography>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<RefreshIcon />}
            onClick={handleRefresh}
            disabled={loading || modelLogsQuery.isLoading}
          >
            Refresh
          </Button>
        </Stack>

        <Card variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack spacing={2}>
            <DateFilterComponent
              startDate={dateRange.startDate}
              endDate={dateRange.endDate}
              onStartDateChange={date => setDateRange(prev => ({ ...prev, startDate: date }))}
              onEndDateChange={date => setDateRange(prev => ({ ...prev, endDate: date }))}
              onRangeSelect={days => {
                setDateRange({
                  startDate: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
                  endDate: dayjs().format('YYYY-MM-DD'),
                });
              }}
            />
          </Stack>
        </Card>

        <LinearProgress />
      </Box>
    );
  }

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
          disabled={loading || modelLogsQuery.isLoading}
        >
          Refresh
        </Button>
      </Stack>

      <Card variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack spacing={2}>
          <Grid container spacing={2}>
            <Grid xs={12} md={4}>
              <DateFilterComponent
                startDate={dateRange.startDate}
                endDate={dateRange.endDate}
                onStartDateChange={date => setDateRange(prev => ({ ...prev, startDate: date }))}
                onEndDateChange={date => setDateRange(prev => ({ ...prev, endDate: date }))}
                onRangeSelect={days => {
                  setDateRange({
                    startDate: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
                    endDate: dayjs().format('YYYY-MM-DD'),
                  });
                }}
              />
            </Grid>
            <Grid xs={12} md={4}>
              <FormControl>
                <Select
                  value={modelFilter}
                  onChange={(_, value) => setModelFilter(value || 'all')}
                  placeholder="Filter by Model"
                >
                  <Option value="all">All Models</Option>
                  <Option value="gpt-4">GPT-4</Option>
                  <Option value="gpt-3.5-turbo">GPT-3.5 Turbo</Option>
                  <Option value="claude-3-opus">Claude 3 Opus</Option>
                  <Option value="claude-3-sonnet">Claude 3 Sonnet</Option>
                </Select>
              </FormControl>
            </Grid>
            <Grid xs={12} md={4}>
              <Input placeholder="Search logs..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </Grid>
          </Grid>
        </Stack>
      </Card>

      <Alert variant="soft" color="neutral" startDecorator={<InfoIcon />} sx={{ mb: 2 }}>
        View detailed logs of model responses, including performance metrics, token usage, and execution tracking.
      </Alert>

      {currentItems.length === 0 ? (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography>No logs found for the selected filters.</Typography>
        </Card>
      ) : (
        <>
          <Stack spacing={2}>
            {currentItems.map((log: ModelLog, index: number) => (
              <Card key={index} variant="outlined">
                <Stack spacing={2}>
                  <Grid container spacing={2}>
                    <Grid xs={12} md={3}>
                      <Typography level="body-sm" fontWeight="bold">
                        Model
                      </Typography>
                      <Typography>{log.model?.name}</Typography>
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
                      <Typography>{log.performance?.totalResponseTime}ms</Typography>
                    </Grid>
                    <Grid xs={12} md={3}>
                      <Typography level="body-sm" fontWeight="bold">
                        Token Usage
                      </Typography>
                      <Typography>
                        {log.tokenUsage?.inputTokens} in / {log.tokenUsage?.outputTokens} out
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
                        Files: {log.context?.attachedFiles?.length || 0} | History: {log.context?.messageHistoryLength}
                      </Typography>
                    </Grid>
                    <Grid xs={12} md={6}>
                      <Typography level="body-sm" fontWeight="bold">
                        Execution Steps
                      </Typography>
                      <Typography>
                        {log.executionTracking?.completedSteps?.length || 0} completed /{' '}
                        {log.executionTracking?.failedSteps?.length || 0} failed
                      </Typography>
                    </Grid>
                  </Grid>

                  {log.artifacts && log.artifacts.length > 0 && (
                    <>
                      <Divider />
                      <Typography level="body-sm" fontWeight="bold">
                        Artifacts ({log.artifacts.length})
                      </Typography>
                      <Stack spacing={1}>
                        {log.artifacts.map((artifact, idx: number) => (
                          <Typography key={idx} level="body-sm">
                            {artifact.type}: {artifact.content.substring(0, 100)}...
                          </Typography>
                        ))}
                      </Stack>
                    </>
                  )}
                </Stack>
              </Card>
            ))}
          </Stack>
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            itemsPerPage={itemsPerPage}
            onItemsPerPageChange={size => {
              setItemsPerPage(size);
              setCurrentPage(1);
            }}
            totalCount={logs?.length || 0}
          />
        </>
      )}
    </Box>
  );
};
