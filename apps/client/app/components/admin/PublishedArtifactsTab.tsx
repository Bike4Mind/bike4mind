import * as React from 'react';
import { Box, Button, IconButton, Link, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { isAxiosError } from 'axios';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { AdminPermissionAction } from './shared/MissingPermission';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  Fact,
  RelativeTime,
  SegmentedControl,
  StatusChip,
  UpdatingBar,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

/**
 * Admin moderation queue for published `/p/...` pages. Lists artifacts by moderation status
 * (reported pages first), shows report counts, and lets an admin take a page down (soft-delete)
 * or restore it. The takedown is the same soft-delete the serve route already 404s on, so a
 * removed page is immediately unreachable.
 */

type ModerationStatusFilter = 'reported' | 'active' | 'taken_down' | 'all';
type ModerationStatus = 'active' | 'reported' | 'taken_down';

interface AdminArtifact {
  publicId: string;
  tier: string;
  scopeId: string;
  slug: string;
  title: string;
  visibility: string;
  ownerId: string;
  moderationStatus: ModerationStatus;
  reportCount: number;
  takedownReason?: string | null;
  size?: { totalBytes: number; fileCount: number };
  source?: { kind: string };
  publishedAt?: string;
  deletedAt?: string | null;
}

interface ArtifactReport {
  reason: string;
  details?: string;
  status: string;
  reporterId?: string | null;
  createdAt: string;
}

const STATUS_OPTIONS: { value: ModerationStatusFilter; label: string }[] = [
  { value: 'reported', label: 'Reported' },
  { value: 'active', label: 'Active' },
  { value: 'taken_down', label: 'Taken down' },
  { value: 'all', label: 'All' },
];

const STATUS_CHIP: Record<ModerationStatus, { tone: AdminStatusTone; label: string }> = {
  reported: { tone: 'warn', label: 'Reported' },
  active: { tone: 'good', label: 'Active' },
  taken_down: { tone: 'neutral', label: 'Taken down' },
};

const TIER_PREFIX: Record<string, string> = { user: 'u', project: 'pj', organization: 'o' };

/** The pretty `/p/...` URL for an artifact, mirroring the serve route's namespace. */
function publicPagePath(a: AdminArtifact): string {
  if (a.source?.kind === 'reply') return `/p/r/${a.publicId}`;
  if (a.source?.kind === 'fabfile') return `/p/f/${a.publicId}`;
  return `/p/${TIER_PREFIX[a.tier] ?? 'u'}/${a.scopeId}/${a.slug}`;
}

const LIST_KEY = 'admin-published-artifacts';

/** A 404 (already taken down) or 409 (slug re-published) will not succeed on retry, so show the server's reason. */
function writeFailureMessage(err: unknown, fallback: string): string {
  if (!isAxiosError<{ error?: string }>(err)) return fallback;
  const status = err.response?.status;
  return (status === 404 || status === 409) && err.response?.data?.error ? err.response.data.error : fallback;
}

const OpenPageButton: React.FC<{ artifact: AdminArtifact }> = ({ artifact }) => (
  <Tooltip title="Open the public page">
    <IconButton
      size="sm"
      variant="plain"
      component={Link}
      href={publicPagePath(artifact)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${artifact.title || 'page'} in a new tab`}
      data-testid={`admin-published-open-${artifact.publicId}`}
    >
      <OpenInNewIcon />
    </IconButton>
  </Tooltip>
);

const PublishedArtifactsTab: React.FC = () => {
  const [status, setStatus] = React.useState<ModerationStatusFilter>('reported');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<'takedown' | 'restore' | null>(null);
  const queryClient = useQueryClient();

  const { data, isPending, isError, isFetching, isPlaceholderData, refetch } = useQuery({
    queryKey: [LIST_KEY, status, page, pageSize],
    queryFn: async () => {
      const { data } = await api.get<{ artifacts: AdminArtifact[]; total: number }>(
        `/api/admin/published-artifacts?status=${status}&limit=${pageSize}&skip=${(page - 1) * pageSize}`
      );
      return data;
    },
    placeholderData: keepPreviousData,
  });

  const artifacts = data?.artifacts ?? [];
  // Kept while a takedown refetch drops the row from the current filter, so the dialogs stay open.
  const [selected, setSelected] = React.useState<AdminArtifact | null>(null);
  const listed = artifacts.find(a => a.publicId === selectedId);
  if (listed && listed !== selected) setSelected(listed);

  const total = data?.total ?? 0;
  // Server paging is not clamped by DataTable, so a takedown that empties the last page would strand it.
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (data && !isPlaceholderData && page > lastPage) setPage(lastPage);

  const onWriteSuccess = () => queryClient.invalidateQueries({ queryKey: [LIST_KEY] });

  const takedown = useMutation({
    mutationFn: (vars: { publicId: string; reason: string }) =>
      api.post(`/api/admin/published-artifacts/${vars.publicId}/takedown`, { reason: vars.reason }),
    onSuccess: onWriteSuccess,
  });

  const restore = useMutation({
    mutationFn: (publicId: string) => api.delete(`/api/admin/published-artifacts/${publicId}/takedown`),
    onSuccess: onWriteSuccess,
  });

  const closeAll = () => {
    setConfirm(null);
    setSelectedId(null);
    setSelected(null);
  };

  const confirmTakedown = async (reason: string) => {
    if (!selected) return;
    try {
      await takedown.mutateAsync({ publicId: selected.publicId, reason });
      toast.success('Page taken down');
      closeAll();
    } catch (err) {
      toast.error(writeFailureMessage(err, 'The page could not be taken down. Try again.'));
    }
  };

  const confirmRestore = async () => {
    if (!selected) return;
    try {
      await restore.mutateAsync(selected.publicId);
      toast.success('Page restored');
      closeAll();
    } catch (err) {
      toast.error(writeFailureMessage(err, 'The page could not be restored. Try again.'));
    }
  };

  const columns: DataColumn<AdminArtifact>[] = [
    {
      id: 'title',
      label: 'Page',
      render: a => (
        <Stack gap={0.25} sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap title={a.title} sx={{ color: 'admin.ink', fontWeight: 500 }}>
            {a.title || 'Untitled'}
          </Typography>
          <Typography
            level="body-xs"
            noWrap
            sx={{ color: 'admin.inkMuted', fontFamily: 'code' }}
            title={publicPagePath(a)}
          >
            {publicPagePath(a)}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'kind',
      label: 'Kind',
      width: '7rem',
      render: a => a.source?.kind ?? '-',
    },
    {
      id: 'status',
      label: 'Status',
      width: '9rem',
      render: a => (
        <StatusChip
          tone={STATUS_CHIP[a.moderationStatus].tone}
          label={STATUS_CHIP[a.moderationStatus].label}
          data-testid={`admin-published-status-${a.publicId}`}
        />
      ),
    },
    {
      id: 'reports',
      label: 'Reports',
      width: '6rem',
      numeric: true,
      render: a => (
        <Box
          component="span"
          sx={{ color: a.reportCount > 0 ? 'admin.ink' : 'admin.inkMuted' }}
          data-testid={`admin-published-reportcount-${a.publicId}`}
        >
          {a.reportCount.toLocaleString()}
        </Box>
      ),
    },
    {
      id: 'published',
      label: 'Published',
      width: '9rem',
      render: a => (a.publishedAt ? <RelativeTime at={a.publishedAt} /> : '-'),
    },
  ];

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-published-pages">
      <AdminPageHeader
        title="Published pages"
        count={data ? total : undefined}
        description="Pages published under /p/. Reported pages need review; a takedown makes the page unreachable at once."
      />

      <Box>
        <SegmentedControl
          options={STATUS_OPTIONS}
          value={status}
          onChange={value => {
            setStatus(value);
            setPage(1);
          }}
          aria-label="Moderation status"
          data-testid="admin-published-pages-status"
        />
      </Box>

      <Box sx={{ position: 'relative' }}>
        <UpdatingBar active={isFetching && !isPending} placement="overlay" testId="admin-published-pages-updating" />
        <DataTable
          label="Published pages"
          testId="admin-published-pages-table"
          rows={isPlaceholderData ? [] : artifacts}
          columns={columns}
          getRowId={a => a.publicId}
          rowTestId={a => `admin-published-row-${a.publicId}`}
          loading={isPending || isPlaceholderData}
          error={isError && !data ? 'Published pages could not be loaded.' : undefined}
          onRetry={() => void refetch()}
          onRowActivate={a => setSelectedId(a.publicId)}
          activeRowId={selectedId ?? undefined}
          rowActions={a => (a.moderationStatus === 'taken_down' ? null : <OpenPageButton artifact={a} />)}
          pagination={{
            page,
            pageSize,
            total,
            onPageChange: setPage,
            onPageSizeChange: size => {
              setPageSize(size);
              setPage(1);
            },
          }}
          minWidth="52rem"
          maxHeight="none"
          empty={
            <EmptyState
              title="No pages for this filter"
              description={status === 'reported' ? 'Nothing is waiting for review.' : undefined}
              action={
                <Button variant="outlined" onClick={() => void refetch()} data-testid="admin-published-refresh-btn">
                  Refresh
                </Button>
              }
            />
          }
        />
      </Box>

      {selected && (
        <AdminDialog
          open={selectedId !== null && confirm === null}
          onClose={closeAll}
          title={selected.title || 'Untitled'}
          width={640}
          data-testid="admin-published-detail"
        >
          <PageDetail
            artifact={selected}
            onTakedown={() => setConfirm('takedown')}
            onRestore={() => setConfirm('restore')}
          />
        </AdminDialog>
      )}

      <ActionDialog
        open={confirm === 'takedown'}
        onClose={() => setConfirm(null)}
        title="Take down page"
        description={
          selected && (
            <>
              <strong>{selected.title || 'Untitled'}</strong> stops being served at once and its open reports are
              resolved. You can restore it later.
            </>
          )
        }
        reasonPresets={ADMIN_REASON_PRESETS.publishedPageTakedown}
        confirmLabel="Take down page"
        tone="danger"
        pending={takedown.isPending}
        onConfirm={confirmTakedown}
        data-testid="admin-published-takedown-dialog"
      />

      <ActionDialog
        open={confirm === 'restore'}
        onClose={() => setConfirm(null)}
        title="Restore page"
        description={
          selected && (
            <>
              <strong>{selected.title || 'Untitled'}</strong> is served again at its public URL.
            </>
          )
        }
        // The restore route records the admin but takes no reason field.
        reasonPresets={ADMIN_REASON_PRESETS.publishedPageRestore}
        reasonAudited={false}
        confirmLabel="Restore page"
        pending={restore.isPending}
        onConfirm={confirmRestore}
        data-testid="admin-published-restore-dialog"
      />
    </Stack>
  );
};

/** The details of one page and its individual abuse reports, with the moderation commands. */
const PageDetail: React.FC<{ artifact: AdminArtifact; onTakedown: () => void; onRestore: () => void }> = ({
  artifact,
  onTakedown,
  onRestore,
}) => {
  const { data, isPending, isError } = useQuery({
    queryKey: ['admin-published-reports', artifact.publicId],
    queryFn: async () => {
      const { data } = await api.get<{ reports: ArtifactReport[] }>(
        `/api/admin/published-artifacts/${artifact.publicId}/reports`
      );
      return data;
    },
  });
  const reports = data?.reports ?? [];
  const takenDown = artifact.moderationStatus === 'taken_down';

  return (
    <Stack gap={2}>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, 30%) 1fr',
          columnGap: 1.5,
          rowGap: 1,
          fontSize: 14,
          '& dt': { color: 'admin.inkMuted' },
          '& dd': { m: 0, minWidth: 0, overflowWrap: 'anywhere', color: 'admin.ink' },
        }}
      >
        <Fact label="Status">
          <StatusChip
            tone={STATUS_CHIP[artifact.moderationStatus].tone}
            label={STATUS_CHIP[artifact.moderationStatus].label}
          />
        </Fact>
        <Fact label="URL">
          <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
            {publicPagePath(artifact)}
          </Box>
        </Fact>
        <Fact label="Kind">{artifact.source?.kind}</Fact>
        <Fact label="Owner">
          <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
            {artifact.ownerId}
          </Box>
        </Fact>
        <Fact label="Published">{artifact.publishedAt && <RelativeTime at={artifact.publishedAt} />}</Fact>
        {takenDown && <Fact label="Takedown reason">{artifact.takedownReason}</Fact>}
      </Box>

      <Stack gap={1}>
        <Typography level="title-sm" component="h3" sx={{ color: 'admin.ink' }}>
          Reports ({artifact.reportCount.toLocaleString()})
        </Typography>
        {isPending ? (
          <Skeleton variant="text" data-testid="admin-published-reports-loading" />
        ) : isError ? (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Reports could not be loaded.
          </Typography>
        ) : reports.length === 0 ? (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            No report details.
          </Typography>
        ) : (
          <Stack
            component="ul"
            sx={{
              m: 0,
              p: 0,
              listStyle: 'none',
              '& > li + li': { borderTop: '1px solid', borderColor: 'admin.border' },
            }}
            data-testid="admin-published-reports"
          >
            {reports.map((r, i) => (
              <Stack key={i} component="li" gap={0.5} sx={{ py: 1 }}>
                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                  <StatusChip tone="warn" label={r.reason} />
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    <RelativeTime at={r.createdAt} />
                  </Typography>
                </Stack>
                {r.details && (
                  <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                    {r.details}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>

      <Stack direction="row" gap={1} justifyContent="flex-end" flexWrap="wrap">
        {!takenDown && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            component="a"
            href={publicPagePath(artifact)}
            target="_blank"
            rel="noopener noreferrer"
            startDecorator={<OpenInNewIcon />}
          >
            Open page
          </Button>
        )}
        <AdminPermissionAction requirement="users:moderate">
          {missing =>
            takenDown ? (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                disabled={missing}
                onClick={onRestore}
                data-testid={`admin-published-restore-${artifact.publicId}`}
              >
                Restore
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                disabled={missing}
                onClick={onTakedown}
                data-testid={`admin-published-takedown-${artifact.publicId}`}
              >
                Take down
              </Button>
            )
          }
        </AdminPermissionAction>
      </Stack>
    </Stack>
  );
};

export default PublishedArtifactsTab;
