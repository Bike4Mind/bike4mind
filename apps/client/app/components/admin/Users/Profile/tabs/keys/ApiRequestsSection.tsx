import React, { useState } from 'react';
import { Button, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { API_COMPLETION_OUTCOME_LABELS, API_REQUEST_LOG_COVERAGE, type IUserApiKeyDocument } from '@bike4mind/common';
import { useUserTimeline } from '@client/app/hooks/data/adminUserTimeline';
import { DataTable, RelativeTime, SectionCard, StatusChip } from '../../../../shared';

export const ApiRequestsSection: React.FC<{ userId: string; apiKeys: readonly IUserApiKeyDocument[] }> = ({
  userId,
  apiKeys,
}) => {
  const [apiKeyId, setApiKeyId] = useState<string | undefined>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const timeline = useUserTimeline(userId, {
    types: ['api_request'],
    apiKeyId,
    from: from || undefined,
    to: to || undefined,
  });
  const entries = (timeline.data?.pages.flatMap(page => page.entries) ?? []).filter(
    entry => entry.type === 'api_request'
  );
  return (
    <SectionCard title="Recent API requests" body="custom" data-testid="user-api-requests-section">
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} sx={{ p: 2 }}>
        <Select
          value={apiKeyId ?? ''}
          onChange={(_, value) => setApiKeyId(value || undefined)}
          slotProps={{ button: { 'aria-label': 'Filter requests by API key' } }}
          data-testid="user-api-requests-key-filter"
        >
          <Option value="">All keys, including deleted keys</Option>
          {apiKeys.map(key => (
            <Option key={key.id} value={key.id}>
              {key.name} ({key.keyPrefix})
            </Option>
          ))}
        </Select>
        <Input
          type="date"
          value={from}
          onChange={event => setFrom(event.target.value)}
          slotProps={{ input: { 'aria-label': 'Requests from UTC date', max: to || undefined } }}
          data-testid="user-api-requests-from"
        />
        <Input
          type="date"
          value={to}
          onChange={event => setTo(event.target.value)}
          slotProps={{ input: { 'aria-label': 'Requests to UTC date', min: from || undefined } }}
          data-testid="user-api-requests-to"
        />
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => void timeline.refetch()}
          loading={timeline.isRefetching}
          data-testid="user-api-requests-refresh-btn"
        >
          Refresh
        </Button>
      </Stack>
      <DataTable
        rows={entries}
        getRowId={entry => entry.id}
        label="Recent API requests"
        loading={timeline.isLoading}
        error={timeline.isError ? 'API requests could not be loaded.' : undefined}
        onRetry={() => void timeline.refetch()}
        testId="user-api-requests-table"
        minWidth="64rem"
        framed={false}
        pagination={false}
        pageResetKey={`${apiKeyId ?? ''}:${from}:${to}`}
        empty={
          <Typography level="body-sm" sx={{ p: 2 }}>
            No retained requests match this key filter.
          </Typography>
        }
        columns={[
          { id: 'at', label: 'When', render: entry => <RelativeTime at={entry.at} /> },
          { id: 'method', label: 'Method', render: entry => entry.request.method },
          {
            id: 'endpoint',
            label: 'Endpoint',
            render: entry => (
              <Typography level="body-xs" sx={{ fontFamily: 'code', overflowWrap: 'anywhere' }}>
                {entry.request.endpoint}
              </Typography>
            ),
          },
          {
            id: 'status',
            label: 'Status',
            render: entry => (
              <StatusChip
                tone={entry.request.statusCode >= 400 ? 'bad' : 'neutral'}
                label={entry.request.statusCode === 0 ? 'No response recorded' : String(entry.request.statusCode)}
              />
            ),
          },
          {
            id: 'completion',
            label: 'Completion outcome',
            wrap: true,
            render: entry => {
              const observation = entry.request.completionObservation;
              if (!observation) return 'Not captured';
              return (
                <Stack>
                  <Typography level="body-xs">{API_COMPLETION_OUTCOME_LABELS[observation.outcome]}</Typography>
                  <Typography level="body-xs">Requested: {observation.requestedModel}</Typography>
                  <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
                    {observation.requestId}
                  </Typography>
                </Stack>
              );
            },
          },
          { id: 'latency', label: 'Latency', render: entry => `${entry.request.responseTimeMs} ms`, numeric: true },
          { id: 'ip', label: 'IP', render: entry => entry.request.ip },
          {
            id: 'key',
            label: 'Key',
            render: entry => apiKeys.find(key => key.id === entry.request.keyId)?.name ?? entry.request.keyId,
          },
        ]}
      />
      {timeline.hasNextPage && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          loading={timeline.isFetchingNextPage}
          onClick={() => void timeline.fetchNextPage()}
          data-testid="user-api-requests-more-btn"
        >
          Load more requests
        </Button>
      )}
      <Typography level="body-xs" sx={{ px: 2, py: 1.5, color: 'admin.inkMuted' }}>
        {API_REQUEST_LOG_COVERAGE}
      </Typography>
    </SectionCard>
  );
};
