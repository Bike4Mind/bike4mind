import { useState } from 'react';
import { Alert, Button, Link, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FeedbackStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ActionDialog, DataTable, EmptyState, SectionCard, StatusChip } from '../shared';
import { AdminPermissionAction } from '../shared/MissingPermission';
import { adminActionCountsQueryKey } from '@client/app/hooks/data/adminActionCounts';
import { FEEDBACK_LIST_QUERY_KEY, FEEDBACK_RECORD_QUERY_KEY, FEEDBACK_TRENDS_QUERY_KEY } from './queryKeys';
import { FEEDBACK_STATUS_LABELS } from './constants';
import type { SimilarFeedbackResponse } from './feedbackSimilar';

const QUERY_KEY = [...FEEDBACK_RECORD_QUERY_KEY, 'similar'] as const;

export default function FeedbackSimilarReports({ feedbackId }: { feedbackId: string }) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<{ ids: string[]; count: number; fingerprint: string } | null>(null);
  const query = useQuery({
    queryKey: [...QUERY_KEY, feedbackId],
    queryFn: async () => (await api.get<SimilarFeedbackResponse>(`/api/feedback/${feedbackId}/similar`)).data,
  });
  const change = {
    action: 'status',
    status: FeedbackStatus.Closed,
    resolution: 'duplicate',
    resolutionDuplicateId: feedbackId,
  } as const;
  const dryRun = useMutation({
    mutationFn: async () => {
      const ids = (query.data?.items ?? []).filter(item => item.status !== FeedbackStatus.Closed).map(item => item.id);
      const { data } = await api.post<{ count: number; fingerprint: string }>('/api/feedback/bulk', {
        selection: { mode: 'explicit', ids },
        change,
        preview: true,
      });
      setPreview({ ids, ...data });
    },
  });
  const apply = useMutation({
    mutationFn: async (reason: string) => {
      if (!preview) return;
      await api.post('/api/feedback/bulk', {
        selection: { mode: 'explicit', ids: preview.ids },
        change,
        preview: false,
        reason,
        expectedCount: preview.count,
        fingerprint: preview.fingerprint,
      });
      setPreview(null);
      await Promise.all(
        [
          QUERY_KEY,
          FEEDBACK_LIST_QUERY_KEY,
          FEEDBACK_RECORD_QUERY_KEY,
          FEEDBACK_TRENDS_QUERY_KEY,
          ['feedback-history'],
          adminActionCountsQueryKey,
        ].map(queryKey => client.invalidateQueries({ queryKey }))
      );
    },
  });
  const openCount = query.isError
    ? 0
    : (query.data?.items.filter(item => item.status !== FeedbackStatus.Closed).length ?? 0);
  return (
    <SectionCard title="Similar reports" body="custom" data-testid="feedback-similar-section">
      <Stack gap={1} sx={{ p: 2 }}>
        <Typography level="body-sm">
          Same type, matching text from the last 14 days. Open reports appear first.
        </Typography>
        {query.data?.limited && (
          <Alert color="warning">
            Showing up to 50 matches from the newest 500 reports. Closing affects only the displayed open reports.
          </Alert>
        )}
        <DataTable
          rows={query.data?.items ?? []}
          columns={[
            {
              id: 'report',
              label: 'Report',
              render: item => (
                <Link
                  href={`/admin?tab=feedback&feedbackId=${item.id}`}
                  data-testid={`feedback-similar-link-${item.id}`}
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {item.excerpt}
                </Link>
              ),
            },
            {
              id: 'status',
              label: 'Status',
              render: item => (
                <StatusChip
                  tone={item.status === FeedbackStatus.Closed ? 'neutral' : 'info'}
                  label={FEEDBACK_STATUS_LABELS[item.status]}
                />
              ),
            },
          ]}
          getRowId={item => item.id}
          label="Similar feedback reports"
          loading={query.isPending}
          error={query.isError ? 'Could not load similar reports.' : undefined}
          onRetry={() => void query.refetch()}
          empty={
            <EmptyState
              title="No similar reports found"
              action={
                <Button variant="plain" onClick={() => void query.refetch()} data-testid="feedback-similar-refresh-btn">
                  Check again
                </Button>
              }
            />
          }
          pagination={false}
          framed={false}
          minWidth="20rem"
          testId="feedback-similar-table"
        />
        {openCount > 0 && (
          <AdminPermissionAction requirement="users:moderate">
            {disabled => (
              <Button
                variant="outlined"
                disabled={disabled || dryRun.isPending || query.isFetching}
                loading={dryRun.isPending}
                onClick={() => {
                  apply.reset();
                  dryRun.mutate();
                }}
                data-testid="feedback-similar-close-btn"
              >
                Close all as duplicate of this ({openCount})
              </Button>
            )}
          </AdminPermissionAction>
        )}
        {dryRun.isError && (
          <Alert color="danger">Could not preview duplicate closure. Refresh the reports and try again.</Alert>
        )}
      </Stack>
      <ActionDialog
        open={Boolean(preview)}
        onClose={() => {
          if (!apply.isPending) setPreview(null);
        }}
        title="Close similar reports as duplicates"
        description={`Closes ${preview?.count ?? 0} displayed open reports with resolution Duplicate and a link to this report (${feedbackId}). This report stays unchanged. Each closure is audited.`}
        reasonPresets={['Same issue reported more than once']}
        confirmLabel={`Close ${preview?.count ?? 0} as duplicate`}
        blockedReason={preview?.count ? null : 'No open reports to close.'}
        pending={apply.isPending}
        onConfirm={async reason => {
          await apply.mutateAsync(reason).catch(() => undefined);
        }}
        data-testid="feedback-similar-close-dialog"
      >
        {apply.isError && (
          <Alert color="danger">Could not close the reports. They may have changed. Cancel and preview again.</Alert>
        )}
      </ActionDialog>
    </SectionCard>
  );
}
