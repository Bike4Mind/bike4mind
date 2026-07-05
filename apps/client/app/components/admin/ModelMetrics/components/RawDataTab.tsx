import React, { useState } from 'react';
import { Box, Stack, Typography, Button, Chip, Table, Sheet, IconButton, Divider, Card } from '@mui/joy';
import SortIcon from '@mui/icons-material/Sort';
import InfoIcon from '@mui/icons-material/Info';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import dayjs from 'dayjs';
import { ModelMetric, SortField, SortDirection } from '../types';
import { formatDuration, getDisplayName } from '../utils/formatters';
import UsernameText from '@client/app/components/common/UsernameText';
import StatusTimeline from '@client/app/components/Session/StatusTimeline';

interface RawDataTabProps {
  metrics: ModelMetric[];
  modelInfos: any[];
  simplifiedNames: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  onShowInfoModal: () => void;
}

export const RawDataTab: React.FC<RawDataTabProps> = ({
  metrics,
  modelInfos,
  simplifiedNames,
  sortField,
  sortDirection,
  onSort,
  onShowInfoModal,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const itemsPerPage = 20;
  const isMobile = useIsMobile();

  const toggleRowExpansion = (metricId: string) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(metricId)) {
        newSet.delete(metricId);
      } else {
        newSet.add(metricId);
      }
      return newSet;
    });
  };

  const totalPages = Math.ceil(metrics.length / itemsPerPage);
  const currentItems = metrics.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  return (
    <Box mb={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <IconButton
          size="sm"
          variant="soft"
          color="neutral"
          onClick={onShowInfoModal}
          sx={{ '--IconButton-size': '28px' }}
        >
          <InfoIcon fontSize="small" />
        </IconButton>

        {/* Top Pagination */}
        {totalPages > 1 && (
          <Stack direction="row" justifyContent="center" alignItems="center" spacing={2}>
            <Button
              size="sm"
              variant="outlined"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(currentPage - 1)}
            >
              Previous
            </Button>
            <Typography level="body-sm">
              Page {currentPage} of {totalPages}
            </Typography>
            <Button
              size="sm"
              variant="outlined"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage(currentPage + 1)}
            >
              Next
            </Button>
          </Stack>
        )}

        {/* Spacer for alignment */}
        <Box sx={{ width: '28px' }} />
      </Stack>

      {/* Mobile card layout */}
      {isMobile && (
        <Stack spacing={1} sx={{ mb: 2 }}>
          {currentItems.map(metric => {
            const isExpanded = expandedRows.has(metric.id);
            return (
              <Card key={metric.id} variant="outlined" sx={{ p: 1, gap: 0 }}>
                {/* Row 1: date + status */}
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {dayjs(metric.timestamp).format('MM/DD/YY HH:mm')}
                  </Typography>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={metric.status === 'done' ? 'success' : metric.status === 'error' ? 'danger' : 'warning'}
                  >
                    {metric.status}
                  </Chip>
                </Stack>

                {/* Row 2: model */}
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Typography level="body-xs" fontWeight="bold">
                    {getDisplayName(metric.model?.name || 'N/A', modelInfos, simplifiedNames)}
                  </Typography>
                  {metric.model?.backend && (
                    <Chip size="sm" variant="soft" color="neutral">
                      {metric.model.backend}
                    </Chip>
                  )}
                </Stack>

                {/* Row 3: tokens + credits + response */}
                <Stack direction="row" spacing={1.5}>
                  <Typography level="body-xs">
                    {metric.tokenUsage?.inputTokens || 0}/{metric.tokenUsage?.outputTokens || 0} tk
                  </Typography>
                  <Typography level="body-xs" fontWeight="bold" color="primary">
                    {(metric.tokenUsage?.creditsUsed || 0).toFixed(0)} cr
                  </Typography>
                  <Typography level="body-xs">
                    {formatDuration(metric.performance?.totalResponseTime)}
                    {metric.performance?.firstTokenTime &&
                      ` · ${formatDuration(metric.performance.firstTokenTime)} ttfvt`}
                  </Typography>
                </Stack>

                {/* Expand toggle */}
                <Button
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => toggleRowExpansion(metric.id)}
                  sx={{ alignSelf: 'flex-start', p: 0, minHeight: 'auto', fontSize: 'xs' }}
                >
                  {isExpanded ? '▲ Less' : '▼ Details'}
                </Button>

                {/* Expanded details */}
                {isExpanded && (
                  <Box sx={{ pt: 0.5, borderTop: '1px solid', borderColor: 'divider' }}>
                    <Stack spacing={0}>
                      <Typography level="body-xs">
                        Context: {formatDuration(metric.performance?.contextRetrievalTime)}
                      </Typography>
                      <Typography level="body-xs">
                        Inference: {formatDuration(metric.performance?.modelInferenceTime)}
                      </Typography>
                      <Typography level="body-xs">Total tokens: {metric.tokenUsage?.totalTokens || 0}</Typography>
                      {metric.session?.userId && (
                        <Typography level="body-xs">
                          User: <UsernameText id={metric.session.userId} />
                        </Typography>
                      )}
                    </Stack>
                    {metric.statusLog && metric.statusLog.length > 0 && (
                      <Box sx={{ mt: 1 }}>
                        <Typography level="body-xs" sx={{ fontWeight: 'bold', mb: 0.25 }}>
                          🕒 Status Log Timeline
                        </Typography>
                        <StatusTimeline statusLog={metric.statusLog} />
                      </Box>
                    )}
                  </Box>
                )}
              </Card>
            );
          })}
        </Stack>
      )}

      {/* Desktop table */}
      {!isMobile && (
        <Box sx={{ overflowX: 'auto' }}>
          <Sheet variant="outlined" sx={{ borderRadius: 'md' }}>
            <Table
              hoverRow
              size="sm"
              sx={{
                '& thead th:nth-of-type(1)': { width: '15%' },
                '& thead th:nth-of-type(2)': { width: '15%' },
                '& thead th:nth-of-type(3)': { width: '15%' },
                '& thead th:nth-of-type(4)': { width: '15%' },
                '& thead th:nth-of-type(5)': { width: '15%' },
                '& thead th:nth-of-type(6)': { width: '15%' },
                '& thead th:nth-of-type(7)': { width: '10%' },
              }}
            >
              <thead>
                <tr>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('timestamp')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Timestamp {sortField === 'timestamp' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('model')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Model {sortField === 'model' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('inputTokens')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Tokens (In/Out) {sortField === 'inputTokens' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('creditsUsed')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Credits {sortField === 'creditsUsed' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('responseTime')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Response Time {sortField === 'responseTime' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('contextTime')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Context/Inference Time {sortField === 'contextTime' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                  <th>
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={() => onSort('status')}
                      startDecorator={<SortIcon />}
                      sx={{ fontWeight: 'bold' }}
                    >
                      Status {sortField === 'status' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </Button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {currentItems.map(metric => (
                  <React.Fragment key={metric.id}>
                    <tr
                      onClick={() => toggleRowExpansion(metric.id)}
                      style={{
                        cursor: 'pointer',
                        backgroundColor: expandedRows.has(metric.id)
                          ? 'var(--joy-palette-background-level1)'
                          : undefined,
                      }}
                    >
                      <td>
                        <Typography level="body-xs">{dayjs(metric.timestamp).format('MM/DD/YY HH:mm:ss')}</Typography>
                      </td>
                      <td>
                        <Stack spacing={0.5}>
                          <Typography level="body-sm" fontWeight="bold">
                            {getDisplayName(metric.model?.name || 'N/A', modelInfos, simplifiedNames)}
                          </Typography>
                          {metric.model?.backend && (
                            <Chip size="sm" variant="soft" color="neutral">
                              {metric.model.backend}
                            </Chip>
                          )}
                        </Stack>
                      </td>
                      <td>
                        <Typography level="body-sm">
                          {metric.tokenUsage?.inputTokens || 0} / {metric.tokenUsage?.outputTokens || 0}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Total: {metric.tokenUsage?.totalTokens || 0}
                        </Typography>
                      </td>
                      <td>
                        <Typography level="body-sm">
                          {(metric.tokenUsage?.creditsUsed || 0).toFixed(0)} credits
                        </Typography>
                      </td>
                      <td>
                        <Stack spacing={0.5}>
                          <Typography level="body-sm" fontWeight="bold">
                            {formatDuration(metric.performance?.totalResponseTime)}
                          </Typography>
                          {metric.performance?.firstTokenTime && (
                            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                              TTFVT: {formatDuration(metric.performance.firstTokenTime)}
                            </Typography>
                          )}
                        </Stack>
                      </td>
                      <td>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <Stack>
                            <Typography level="body-xs">
                              Context Retrieval: {formatDuration(metric.performance?.contextRetrievalTime)}
                            </Typography>
                            <Typography level="body-xs">
                              Model Inference: {formatDuration(metric.performance?.modelInferenceTime)}
                            </Typography>
                          </Stack>
                          <Typography level="body-xs" sx={{ color: 'text.tertiary', fontSize: '10px', opacity: 0.7 }}>
                            {expandedRows.has(metric.id) ? '▲' : '▼'}
                          </Typography>
                        </Stack>
                      </td>
                      <td>
                        <Chip
                          size="sm"
                          variant="soft"
                          color={
                            metric.status === 'done' ? 'success' : metric.status === 'error' ? 'danger' : 'warning'
                          }
                        >
                          {metric.status}
                        </Chip>
                      </td>
                    </tr>

                    {/* Expanded Performance Details */}
                    {expandedRows.has(metric.id) && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0, backgroundColor: 'var(--joy-palette-background-level1)' }}>
                          <Box sx={{ p: 2, borderTop: '1px solid var(--joy-palette-divider)' }}>
                            <Box
                              sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(min(250px, 100%), 1fr))',
                                gap: 2,
                                alignItems: 'start',
                              }}
                            >
                              {/* Core Timing Metrics */}
                              <Box sx={{ p: 1.5, bgcolor: 'background.level2', borderRadius: 'sm' }}>
                                <Typography level="title-sm" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                                  ⏱️ Core Timing
                                </Typography>
                                <Stack spacing={1}>
                                  <Stack direction="row" justifyContent="space-between">
                                    <Typography level="body-sm">Context Retrieval:</Typography>
                                    <Typography level="body-sm">
                                      {formatDuration(metric.performance?.contextRetrievalTime)}
                                    </Typography>
                                  </Stack>
                                  <Stack direction="row" justifyContent="space-between">
                                    <Typography level="body-sm">Model Inference:</Typography>
                                    <Typography level="body-sm">
                                      {formatDuration(metric.performance?.modelInferenceTime)}
                                    </Typography>
                                  </Stack>
                                  {metric.performance?.firstTokenTime && (
                                    <Stack direction="row" justifyContent="space-between">
                                      <Typography level="body-sm">Time to First Token (TTFVT):</Typography>
                                      <Typography level="body-sm" fontWeight="bold" color="success">
                                        {formatDuration(metric.performance.firstTokenTime)}
                                      </Typography>
                                    </Stack>
                                  )}
                                  {metric.performance?.clientFirstTokenTime && (
                                    <Stack direction="row" justifyContent="space-between">
                                      <Typography level="body-sm">Client First Token Time:</Typography>
                                      <Typography level="body-sm" fontWeight="bold" color="primary">
                                        {formatDuration(metric.performance.clientFirstTokenTime)}
                                      </Typography>
                                    </Stack>
                                  )}
                                </Stack>
                              </Box>

                              {/* Streaming Performance - Only show if data exists and has meaningful values */}
                              {metric.performance?.streamingPerformance &&
                                ((metric.performance.streamingPerformance.chunkCount ?? 0) > 0 ||
                                  (metric.performance.streamingPerformance.totalStreamTime ?? 0) > 0) && (
                                  <Box sx={{ p: 1.5, bgcolor: 'background.level2', borderRadius: 'sm' }}>
                                    <Typography level="title-sm" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                                      🔄 Streaming Performance
                                    </Typography>
                                    <Stack spacing={1}>
                                      <Stack direction="row" justifyContent="space-between">
                                        <Typography level="body-sm">Chunk Count:</Typography>
                                        <Typography level="body-sm">
                                          {metric.performance.streamingPerformance.chunkCount || 0}
                                        </Typography>
                                      </Stack>
                                      <Stack direction="row" justifyContent="space-between">
                                        <Typography level="body-sm">Total Stream Time:</Typography>
                                        <Typography level="body-sm">
                                          {formatDuration(metric.performance.streamingPerformance.totalStreamTime)}
                                        </Typography>
                                      </Stack>
                                      <Stack direction="row" justifyContent="space-between">
                                        <Typography level="body-sm">Characters/Second:</Typography>
                                        <Typography level="body-sm" fontWeight="bold" color="success">
                                          {metric.performance.streamingPerformance.charsPerSecond?.toFixed(1) || 0}{' '}
                                          chars/s
                                        </Typography>
                                      </Stack>
                                    </Stack>
                                  </Box>
                                )}

                              {/* Feature Execution Times */}
                              {metric.performance?.featureExecutionTimes &&
                                Object.keys(metric.performance.featureExecutionTimes).length > 0 && (
                                  <Box sx={{ p: 1.5, bgcolor: 'background.level2', borderRadius: 'sm' }}>
                                    <Typography level="title-sm" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                                      🔧 Feature Execution
                                    </Typography>
                                    <Stack spacing={1}>
                                      {Object.entries(metric.performance.featureExecutionTimes).map(
                                        ([feature, time]) => (
                                          <Stack key={feature} direction="row" justifyContent="space-between">
                                            <Typography level="body-sm" sx={{ textTransform: 'capitalize' }}>
                                              {feature.replace(/([A-Z])/g, ' $1').trim()}:
                                            </Typography>
                                            <Typography level="body-sm">{formatDuration(time)}</Typography>
                                          </Stack>
                                        )
                                      )}
                                    </Stack>
                                  </Box>
                                )}

                              {/* Database Operations */}
                              {metric.performance?.databaseOperationTimes &&
                                Object.keys(metric.performance.databaseOperationTimes).length > 0 && (
                                  <Box sx={{ p: 1.5, bgcolor: 'background.level2', borderRadius: 'sm' }}>
                                    <Typography level="title-sm" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                                      💾 Database Operations
                                    </Typography>
                                    <Stack spacing={1}>
                                      {Object.entries(metric.performance.databaseOperationTimes).map(
                                        ([operation, time]) => (
                                          <Stack key={operation} direction="row" justifyContent="space-between">
                                            <Typography level="body-sm" sx={{ textTransform: 'capitalize' }}>
                                              {operation.replace(/([A-Z])/g, ' $1').trim()}:
                                            </Typography>
                                            <Typography level="body-sm">{formatDuration(time)}</Typography>
                                          </Stack>
                                        )
                                      )}
                                    </Stack>
                                  </Box>
                                )}
                            </Box>

                            {/* Request lifecycle status-log timeline */}
                            {metric.statusLog && metric.statusLog.length > 0 && (
                              <Box sx={{ mt: 2, p: 1.5, bgcolor: 'background.level2', borderRadius: 'sm' }}>
                                <Typography level="title-sm" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                                  🕒 Status Log Timeline
                                </Typography>
                                <StatusTimeline statusLog={metric.statusLog} />
                              </Box>
                            )}

                            {/* Session Details */}
                            <Divider sx={{ my: 1 }} />
                            <Stack
                              direction="row"
                              spacing={2}
                              flexWrap="wrap"
                              sx={{ fontSize: 'sm', color: 'text.secondary' }}
                            >
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
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </Table>
          </Sheet>
        </Box>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <Stack direction="row" justifyContent="center" alignItems="center" spacing={2} sx={{ mt: 2 }}>
          <Button
            size="sm"
            variant="outlined"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(currentPage - 1)}
          >
            Previous
          </Button>
          <Typography level="body-sm">
            Page {currentPage} of {totalPages}
          </Typography>
          <Button
            size="sm"
            variant="outlined"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(currentPage + 1)}
          >
            Next
          </Button>
        </Stack>
      )}
    </Box>
  );
};
