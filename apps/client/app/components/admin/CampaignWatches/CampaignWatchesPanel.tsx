import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Alert, Button, Link, Stack, Typography } from '@mui/joy';
import {
  CampaignWatchIdSchema,
  hasAdminPermission,
  type CampaignWatch,
  type CampaignWatchChange,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useCampaignWatch,
  useCampaignWatches,
  useChangeCampaignWatch,
  watchErrorMessage,
} from '@client/app/hooks/data/campaignWatches';
import {
  ActionDialog,
  AdminDialog,
  DataTable,
  EmptyState,
  ErrorState,
  RelativeTime,
  SectionCard,
  StatusChip,
} from '../shared';

function WatchCommands({ watch }: { watch: CampaignWatch }) {
  const { currentUser: user } = useUser();
  const change = useChangeCampaignWatch(watch.id);
  const [action, setAction] = useState<CampaignWatchChange['action'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!hasAdminPermission(user, 'users:moderate')) return null;
  const labels = { close: 'Close watch', reopen: 'Reopen watch', claim: 'Assign to me', check: 'Mark checked' };
  const actions: CampaignWatchChange['action'][] = watch.status === 'closed' ? ['reopen'] : ['check', 'claim', 'close'];
  return (
    <>
      <Stack direction="row" gap={1} flexWrap="wrap">
        {actions.map(item => (
          <Button
            key={item}
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => {
              setAction(item);
              setError(null);
            }}
            data-testid={`campaign-watch-${item}-btn`}
          >
            {labels[item]}
          </Button>
        ))}
      </Stack>
      {action && (
        <ActionDialog
          open
          title={labels[action]}
          onClose={() => {
            if (!change.isPending) setAction(null);
          }}
          description={
            action === 'check'
              ? 'Records that you manually checked this group. It does not run an automated review.'
              : 'Updates this shared watch; account access and the AI verdict stay unchanged.'
          }
          reasonPresets={
            action === 'check'
              ? ['Reviewed account activity']
              : ['Monitoring complete', 'Continue monitoring', 'Take responsibility for this watch']
          }
          confirmLabel={labels[action]}
          pending={change.isPending}
          data-testid="campaign-watch-action-dialog"
          onConfirm={async reason => {
            try {
              await change.mutateAsync({ action, expectedRevision: watch.revision, reason });
              setAction(null);
            } catch (failure) {
              setError(watchErrorMessage(failure));
            }
          }}
        >
          {error && <Alert color="danger">{error}</Alert>}
        </ActionDialog>
      )}
    </>
  );
}

export function CampaignWatchesPanel({ compact = false }: { compact?: boolean }) {
  const { currentUser: user } = useUser();
  const canRead = hasAdminPermission(user, 'support:read');
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const list = useCampaignWatches(status, canRead);
  const search = useSearch({ strict: false });
  const parsed = CampaignWatchIdSchema.safeParse(search.campaignWatch);
  const selectedId = parsed.success ? parsed.data : undefined;
  const details = useCampaignWatch(compact ? undefined : selectedId, canRead);
  const navigate = useNavigate();
  const all = list.data?.pages.flatMap(page => page.items) ?? [];
  const rows = compact ? all.slice(0, 3) : all;
  if (!canRead) return null;
  const openWatch = (id: string) =>
    void navigate({ to: '/admin', search: { tab: 'shadow-detections', campaignWatch: id } });
  const closeDetails = () =>
    void navigate({ to: '/admin', search: previous => ({ ...previous, campaignWatch: undefined }), replace: true });
  return (
    <>
      <SectionCard
        title="Watched campaigns"
        body="custom"
        data-testid="campaign-watches-panel"
        action={
          compact ? (
            <Button
              variant="plain"
              size="sm"
              color="neutral"
              onClick={() => void navigate({ to: '/admin', search: { tab: 'shadow-detections' } })}
            >
              View all watches
            </Button>
          ) : (
            <Stack direction="row" gap={1}>
              {(['open', 'closed'] as const).map(value => (
                <Button
                  key={value}
                  size="sm"
                  color="neutral"
                  variant={status === value ? 'soft' : 'plain'}
                  onClick={() => setStatus(value)}
                  data-testid={`campaign-watches-${value}-btn`}
                >
                  {value === 'open' ? 'Open' : 'Closed'}
                </Button>
              ))}
            </Stack>
          )
        }
      >
        <Typography level="body-sm" sx={{ px: 2, py: 1.5, color: 'admin.inkMuted' }}>
          Fixed account groups stay here until closed, independently of AI advisory expiry. Watches are manual;
          automatic alerts are not enabled.
        </Typography>
        <DataTable
          rows={rows}
          getRowId={watch => watch.id}
          label="Watched campaigns"
          pagination={false}
          loading={list.isLoading}
          error={list.isError ? 'Watches could not be loaded.' : undefined}
          onRetry={() => void list.refetch()}
          testId="campaign-watches-table"
          empty={
            <EmptyState
              title={status === 'open' ? 'No open watches' : 'No closed watches'}
              description="Create a watch from an AI advisory or campaign detection."
              action={null}
            />
          }
          columns={[
            {
              id: 'name',
              label: 'Watch',
              render: watch => (
                <Link
                  component="button"
                  onClick={() => openWatch(watch.id)}
                  data-testid={`campaign-watch-open-${watch.id}`}
                >
                  {watch.name}
                </Link>
              ),
            },
            { id: 'members', label: 'Accounts', render: watch => watch.userIds.length, numeric: true },
            {
              id: 'owner',
              label: 'Owner',
              render: watch =>
                watch.ownerId ? (
                  <Link href={`/admin/users/${watch.ownerId}`}>
                    {watch.ownerId === user?.id ? 'You' : 'View owner'}
                  </Link>
                ) : (
                  'Unassigned'
                ),
            },
            {
              id: 'checked',
              label: 'Last checked',
              render: watch => (watch.lastCheckedAt ? <RelativeTime at={watch.lastCheckedAt} /> : 'Not checked yet'),
            },
          ]}
        />
        {!compact && list.hasNextPage && (
          <Button
            variant="plain"
            color="neutral"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
            data-testid="campaign-watches-more-btn"
          >
            Load more watches
          </Button>
        )}
      </SectionCard>
      {!compact && selectedId && (
        <AdminDialog
          title={details.data?.watch.name ?? 'Campaign watch'}
          onClose={closeDetails}
          width={800}
          data-testid="campaign-watch-detail"
        >
          {details.isLoading && <Typography>Loading watch...</Typography>}
          {details.isError && (
            <ErrorState message="This watch could not be loaded." onRetry={() => void details.refetch()} />
          )}
          {details.data && (
            <Stack gap={2}>
              <Stack direction="row" gap={1}>
                <StatusChip tone="neutral" label={details.data.watch.status === 'open' ? 'Open' : 'Closed'} />
                <Typography>
                  Owner: {details.data.ownerName ?? (details.data.watch.ownerId ? 'Account unavailable' : 'Unassigned')}
                </Typography>
              </Stack>
              <Typography level="body-sm">
                Membership is fixed when the watch is created. Deleted accounts are removed; new detections are not
                added automatically.
              </Typography>
              <Button
                variant="outlined"
                color="neutral"
                size="sm"
                onClick={() => void details.refetch()}
                loading={details.isRefetching}
                data-testid="campaign-watch-refresh-btn"
              >
                Refresh account data
              </Button>
              <DataTable
                rows={details.data.members}
                getRowId={member => member.id}
                label="Watched accounts"
                pagination={false}
                onRetry={() => void details.refetch()}
                columns={[
                  {
                    id: 'name',
                    label: 'Account',
                    render: member =>
                      member.available ? (
                        <Link href={`/admin/users/${member.id}`}>{member.name ?? member.id}</Link>
                      ) : (
                        'Account unavailable'
                      ),
                  },
                  {
                    id: 'status',
                    label: 'Status',
                    render: member => (!member.available ? 'Unavailable' : member.suspended ? 'Suspended' : 'Active'),
                  },
                  {
                    id: 'credits',
                    label: 'Current credits',
                    render: member => member.credits?.toLocaleString() ?? '-',
                    numeric: true,
                  },
                  {
                    id: 'activity',
                    label: 'Activity',
                    render: member =>
                      member.available ? (
                        <Link href={`/admin/users/${member.id}?tab=activity`}>View activity</Link>
                      ) : (
                        '-'
                      ),
                  },
                ]}
                empty={
                  <EmptyState
                    title="No remaining accounts"
                    description="The accounts in this watch have been deleted."
                    action={null}
                  />
                }
              />
              <Typography level="body-xs">
                Last manually checked:{' '}
                {details.data.watch.lastCheckedAt ? details.data.watch.lastCheckedAt.toISOString() : 'Not checked yet'}.
              </Typography>
              <WatchCommands key={details.data.watch.id} watch={details.data.watch} />
            </Stack>
          )}
        </AdminDialog>
      )}
    </>
  );
}
