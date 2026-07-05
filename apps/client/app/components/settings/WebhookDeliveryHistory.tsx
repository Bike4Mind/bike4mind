/**
 * Paginated delivery history (last 7 days) for a webhook subscription: status chips,
 * expandable payload/error rows, status filter, and manual retry of failed deliveries.
 */

import { FC, useState, useCallback, Fragment } from 'react';
import {
  Card,
  Typography,
  Box,
  Button,
  Stack,
  Chip,
  IconButton,
  Table,
  Select,
  Option,
  FormControl,
  Skeleton,
  Sheet,
  Alert,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ReplayIcon from '@mui/icons-material/Replay';
import { WebhookDeliveryStatus } from '@bike4mind/common';
import { useGetWebhookDeliveries, useRetryWebhookDelivery } from '@client/app/hooks/data/useWebhookDeliveries';

interface WebhookDeliveryHistoryProps {
  subscriptionId: string;
  organizationName?: string;
  onClose?: () => void;
}

function getStatusColor(status: WebhookDeliveryStatus): 'success' | 'danger' | 'warning' | 'neutral' {
  switch (status) {
    case WebhookDeliveryStatus.Success:
      return 'success';
    case WebhookDeliveryStatus.Failed:
      return 'danger';
    case WebhookDeliveryStatus.Pending:
      return 'warning';
    case WebhookDeliveryStatus.Skipped:
    default:
      return 'neutral';
  }
}

function formatTimestamp(timestamp: string | Date | undefined): string {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const WebhookDeliveryHistory: FC<WebhookDeliveryHistoryProps> = ({ subscriptionId, organizationName, onClose }) => {
  const [statusFilter, setStatusFilter] = useState<WebhookDeliveryStatus | 'all'>('all');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const { data, isLoading, error, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useGetWebhookDeliveries({
    subscriptionId,
    status: statusFilter === 'all' ? undefined : statusFilter,
    limit: 20,
  });

  const retryDelivery = useRetryWebhookDelivery();

  const deliveries = data?.pages.flatMap(page => page.deliveries) || [];

  const toggleExpand = useCallback((id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleRetry = useCallback(
    async (deliveryId: string) => {
      await retryDelivery.mutateAsync(deliveryId);
    },
    [retryDelivery]
  );

  if (isLoading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rectangular" height={40} />
        <Skeleton variant="rectangular" height={200} />
      </Stack>
    );
  }

  if (error) {
    return (
      <Card variant="outlined">
        <Box
          sx={{
            p: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography level="title-sm">
            Delivery History
            {organizationName && (
              <Typography level="body-xs" sx={{ ml: 1, color: 'text.tertiary' }}>
                ({organizationName})
              </Typography>
            )}
          </Typography>
          {onClose && (
            <Button size="sm" variant="plain" onClick={onClose}>
              Close
            </Button>
          )}
        </Box>
        <Box sx={{ p: 2 }}>
          <Alert
            color="danger"
            variant="soft"
            endDecorator={
              <Button size="sm" variant="soft" color="danger" onClick={() => refetch()}>
                Retry
              </Button>
            }
          >
            Failed to load delivery history. Please try again.
          </Alert>
        </Box>
      </Card>
    );
  }

  return (
    <Card variant="outlined">
      <Box
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography level="title-sm">
          Delivery History
          {organizationName && (
            <Typography level="body-xs" sx={{ ml: 1, color: 'text.tertiary' }}>
              ({organizationName})
            </Typography>
          )}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <FormControl size="sm">
            <Select<string>
              placeholder="Filter by status"
              value={statusFilter}
              onChange={(_, value) => setStatusFilter(value as WebhookDeliveryStatus | 'all')}
              sx={{ minWidth: 120 }}
              data-testid="delivery-status-filter"
            >
              <Option value="all">All</Option>
              <Option value={WebhookDeliveryStatus.Success}>Success</Option>
              <Option value={WebhookDeliveryStatus.Failed}>Failed</Option>
              <Option value={WebhookDeliveryStatus.Pending}>Pending</Option>
              <Option value={WebhookDeliveryStatus.Skipped}>Skipped</Option>
            </Select>
          </FormControl>
          <IconButton size="sm" variant="outlined" onClick={() => refetch()} data-testid="refresh-deliveries">
            <RefreshIcon />
          </IconButton>
          {onClose && (
            <Button size="sm" variant="plain" onClick={onClose}>
              Close
            </Button>
          )}
        </Box>
      </Box>

      {deliveries.length > 0 ? (
        <>
          <Table>
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Event</th>
                <th>Repository</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Time</th>
                <th style={{ width: 80 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map(delivery => (
                <Fragment key={delivery.id}>
                  <tr>
                    <td>
                      <IconButton size="sm" variant="plain" onClick={() => toggleExpand(delivery.id)}>
                        {expandedRows.has(delivery.id) ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </td>
                    <td>
                      <Typography level="body-sm" fontWeight="md">
                        {delivery.eventType}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        {delivery.repository || 'N/A'}
                      </Typography>
                    </td>
                    <td>
                      <Chip variant="soft" color={getStatusColor(delivery.status)} size="sm">
                        {delivery.status}
                      </Chip>
                    </td>
                    <td>
                      <Typography level="body-xs">
                        {delivery.processingDurationMs ? `${delivery.processingDurationMs}ms` : 'N/A'}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs">{formatTimestamp(delivery.createdAt)}</Typography>
                    </td>
                    <td>
                      {delivery.status === WebhookDeliveryStatus.Failed && (
                        <IconButton
                          size="sm"
                          variant="soft"
                          color="primary"
                          onClick={() => handleRetry(delivery.id)}
                          loading={retryDelivery.isPending}
                          data-testid={`retry-delivery-${delivery.id}`}
                        >
                          <ReplayIcon />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                  {expandedRows.has(delivery.id) && (
                    <tr>
                      <td colSpan={7}>
                        <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm', mx: 1, mb: 1 }}>
                          <Stack spacing={1}>
                            <Box>
                              <Typography level="body-xs" fontWeight="bold">
                                Delivery ID
                              </Typography>
                              <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                                {delivery.deliveryId}
                              </Typography>
                            </Box>
                            {delivery.correlationId && (
                              <Box>
                                <Typography level="body-xs" fontWeight="bold">
                                  Correlation ID
                                </Typography>
                                <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                                  {delivery.correlationId}
                                </Typography>
                              </Box>
                            )}
                            {delivery.retryCount !== undefined && delivery.retryCount > 0 && (
                              <Box>
                                <Typography level="body-xs" fontWeight="bold">
                                  Retry Count
                                </Typography>
                                <Typography level="body-xs">{delivery.retryCount}</Typography>
                              </Box>
                            )}
                            {delivery.errorMessage && (
                              <Box>
                                <Typography level="body-xs" fontWeight="bold" color="danger">
                                  Error
                                </Typography>
                                <Typography level="body-xs" sx={{ color: 'danger.500' }}>
                                  {delivery.errorMessage}
                                </Typography>
                              </Box>
                            )}
                          </Stack>
                        </Sheet>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>

          {/* Load more button */}
          {hasNextPage && (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Button
                variant="outlined"
                onClick={() => fetchNextPage()}
                loading={isFetchingNextPage}
                data-testid="load-more-deliveries"
              >
                Load More
              </Button>
            </Box>
          )}
        </>
      ) : (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            No deliveries found
            {statusFilter !== 'all' && ` with status "${statusFilter}"`}.
          </Typography>
        </Box>
      )}
    </Card>
  );
};

export default WebhookDeliveryHistory;
