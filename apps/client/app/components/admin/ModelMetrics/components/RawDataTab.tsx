import React, { useState } from 'react';
import { Box, Stack, Typography, Chip, IconButton, Divider } from '@mui/joy';
import InfoIcon from '@mui/icons-material/Info';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import dayjs from 'dayjs';
import { ModelMetric, SortField, SortDirection } from '../types';
import { formatDuration, formatTtfvt, ttfvtColor, getDisplayName } from '../utils/formatters';
import UsernameText from '@client/app/components/common/UsernameText';
import StatusTimeline from '@client/app/components/Session/StatusTimeline';
import { DataTable, EmptyState, type DataColumn } from '../../shared';

interface RawDataTabProps {
  metrics: ModelMetric[];
  modelInfos: any[];
  simplifiedNames: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  onShowInfoModal: () => void;
}

// DataTable requires a retry handler; the parent renders the error state and `empty` has no action.
const noRetry = () => undefined;

const statusColor = (status: ModelMetric['status']) =>
  status === 'done' ? 'success' : status === 'error' ? 'danger' : 'warning';

const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Stack direction="row" justifyContent="space-between" spacing={1}>
    <Typography level="body-xs">{label}</Typography>
    <Typography level="body-xs">{children}</Typography>
  </Stack>
);

const DetailSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Box sx={{ p: 1, bgcolor: 'background.level2', borderRadius: 'sm' }}>
    <Typography level="title-sm" sx={{ mb: 0.5 }}>
      {title}
    </Typography>
    <Stack spacing={0.5}>{children}</Stack>
  </Box>
);

const camelToWords = (key: string) => key.replace(/([A-Z])/g, ' $1').trim();

const MetricDetails = ({ metric }: { metric: ModelMetric }) => {
  const performance = metric.performance;
  const streaming = performance?.streamingPerformance;
  const hasStreaming = !!streaming && ((streaming.chunkCount ?? 0) > 0 || (streaming.totalStreamTime ?? 0) > 0);
  return (
    // The row toggles on click; keep clicks here (selecting an id to copy) from collapsing it.
    <Box
      sx={{ mt: 1, display: 'grid', gridTemplateColumns: '1fr', gap: 1 }}
      data-testid="model-metrics-raw-row-details"
      onClick={event => event.stopPropagation()}
    >
      <DetailSection title="Core timing">
        <DetailRow label="Context retrieval">{formatDuration(performance?.contextRetrievalTime)}</DetailRow>
        <DetailRow label="Model inference">{formatDuration(performance?.modelInferenceTime)}</DetailRow>
        <Stack direction="row" justifyContent="space-between" spacing={1}>
          <Typography level="body-xs">Time to first token (TTFVT)</Typography>
          <Typography
            level="body-xs"
            fontWeight="bold"
            sx={{ color: ttfvtColor(performance?.firstTokenTime, performance?.firstChunkTime) }}
          >
            {formatTtfvt(performance?.firstTokenTime, performance?.firstChunkTime)}
          </Typography>
        </Stack>
        {performance?.clientFirstTokenTime && (
          <DetailRow label="Client first token time">{formatDuration(performance.clientFirstTokenTime)}</DetailRow>
        )}
      </DetailSection>
      {hasStreaming && (
        <DetailSection title="Streaming performance">
          <DetailRow label="Chunk count">{streaming.chunkCount || 0}</DetailRow>
          <DetailRow label="Total stream time">{formatDuration(streaming.totalStreamTime)}</DetailRow>
          <DetailRow label="Characters/second">{`${streaming.charsPerSecond?.toFixed(1) || 0} chars/s`}</DetailRow>
        </DetailSection>
      )}
      {performance?.featureExecutionTimes && Object.keys(performance.featureExecutionTimes).length > 0 && (
        <DetailSection title="Feature execution">
          {Object.entries(performance.featureExecutionTimes).map(([feature, time]) => (
            <DetailRow key={feature} label={camelToWords(feature)}>
              {formatDuration(time)}
            </DetailRow>
          ))}
        </DetailSection>
      )}
      {performance?.databaseOperationTimes && Object.keys(performance.databaseOperationTimes).length > 0 && (
        <DetailSection title="Database operations">
          {Object.entries(performance.databaseOperationTimes).map(([operation, time]) => (
            <DetailRow key={operation} label={camelToWords(operation)}>
              {formatDuration(time)}
            </DetailRow>
          ))}
        </DetailSection>
      )}
      {metric.statusLog && metric.statusLog.length > 0 && (
        <DetailSection title="Status log timeline">
          <StatusTimeline statusLog={metric.statusLog} />
        </DetailSection>
      )}
      <Divider />
      <Stack spacing={0.25}>
        <Typography level="body-xs">
          <strong>Request ID:</strong> {metric.id}
        </Typography>
        {metric.session?.userId && (
          <Typography level="body-xs">
            <strong>User:</strong> <UsernameText id={metric.session.userId} />
          </Typography>
        )}
        {metric.session?.organizationId && (
          <Typography level="body-xs">
            <strong>Org:</strong> {metric.session.organizationId}
          </Typography>
        )}
        {metric.session?.projectId && (
          <Typography level="body-xs">
            <strong>Project:</strong> {metric.session.projectId}
          </Typography>
        )}
      </Stack>
    </Box>
  );
};

export const RawDataTab: React.FC<RawDataTabProps> = ({
  metrics,
  modelInfos,
  simplifiedNames,
  sortField,
  sortDirection,
  onSort,
  onShowInfoModal,
}) => {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleRowExpansion = (metricId: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(metricId)) next.delete(metricId);
      else next.add(metricId);
      return next;
    });
  };

  const columns: DataColumn<ModelMetric>[] = [
    {
      id: 'expand',
      label: '',
      width: '3rem',
      render: metric => {
        const expanded = expandedRows.has(metric.id);
        return (
          <IconButton
            size="sm"
            variant="plain"
            aria-label={expanded ? 'Hide details' : 'Show details'}
            aria-expanded={expanded}
            data-testid="model-metrics-raw-row-toggle-btn"
            onClick={() => toggleRowExpansion(metric.id)}
          >
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        );
      },
    },
    {
      id: 'timestamp',
      label: 'Timestamp',
      width: '9rem',
      sortable: true,
      render: metric => dayjs(metric.timestamp).format('MM/DD/YY HH:mm:ss'),
    },
    {
      id: 'model',
      label: 'Model',
      width: '12rem',
      sortable: true,
      wrap: true,
      render: metric => (
        <Stack spacing={0.5} alignItems="flex-start">
          <Typography level="body-sm" fontWeight="bold">
            {getDisplayName(metric.model?.name || 'N/A', modelInfos, simplifiedNames)}
          </Typography>
          {metric.model?.backend && (
            <Chip size="sm" variant="soft" color="neutral">
              {metric.model.backend}
            </Chip>
          )}
        </Stack>
      ),
    },
    {
      id: 'inputTokens',
      label: 'Tokens (in/out)',
      width: '9rem',
      numeric: true,
      sortable: true,
      render: metric => (
        <>
          <Typography level="body-sm">
            {metric.tokenUsage?.inputTokens || 0} / {metric.tokenUsage?.outputTokens || 0}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
            Total: {metric.tokenUsage?.totalTokens || 0}
          </Typography>
        </>
      ),
    },
    {
      id: 'creditsUsed',
      label: 'Credits',
      width: '7rem',
      numeric: true,
      sortable: true,
      render: metric => `${(metric.tokenUsage?.creditsUsed || 0).toFixed(0)} credits`,
    },
    {
      id: 'responseTime',
      label: 'Response time',
      width: '9rem',
      sortable: true,
      render: metric => (
        <>
          <Typography level="body-sm" fontWeight="bold">
            {formatDuration(metric.performance?.totalResponseTime)}
          </Typography>
          <Typography
            level="body-xs"
            sx={{ color: ttfvtColor(metric.performance?.firstTokenTime, metric.performance?.firstChunkTime) }}
          >
            TTFVT: {formatTtfvt(metric.performance?.firstTokenTime, metric.performance?.firstChunkTime)}
          </Typography>
        </>
      ),
    },
    {
      id: 'contextTime',
      label: 'Context/inference time',
      width: '13rem',
      sortable: true,
      wrap: true,
      render: metric => (
        <>
          <Typography level="body-xs">
            Context retrieval: {formatDuration(metric.performance?.contextRetrievalTime)}
          </Typography>
          <Typography level="body-xs">
            Model inference: {formatDuration(metric.performance?.modelInferenceTime)}
          </Typography>
          {expandedRows.has(metric.id) && <MetricDetails metric={metric} />}
        </>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      width: '6rem',
      sortable: true,
      render: metric => (
        <Chip size="sm" variant="soft" color={statusColor(metric.status)}>
          {metric.status}
        </Chip>
      ),
    },
  ];

  return (
    <Box mb={2}>
      <Stack direction="row" alignItems="center" sx={{ mb: 2 }}>
        <IconButton
          size="sm"
          variant="soft"
          color="neutral"
          aria-label="About these metrics"
          onClick={onShowInfoModal}
          sx={{ '--IconButton-size': '28px' }}
        >
          <InfoIcon fontSize="small" />
        </IconButton>
      </Stack>
      <DataTable<ModelMetric>
        rows={metrics}
        columns={columns}
        getRowId={metric => metric.id}
        label="Model calls"
        onRetry={noRetry}
        empty={<EmptyState title="No model calls to show" action={null} />}
        testId="model-metrics-raw-table"
        sort={{ columnId: sortField, direction: sortDirection }}
        onSortChange={next => onSort(next.columnId as SortField)}
        onRowActivate={metric => toggleRowExpansion(metric.id)}
        minWidth="68rem"
      />
    </Box>
  );
};
