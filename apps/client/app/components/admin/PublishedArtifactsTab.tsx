import * as React from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  LinearProgress,
  Link,
  Option,
  Select,
  Sheet,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import BlockIcon from '@mui/icons-material/Block';
import RestoreIcon from '@mui/icons-material/Restore';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/**
 * Admin moderation queue for published `/p/...` pages. Lists artifacts
 * by moderation status (reported pages first), surfaces report counts, and lets
 * an admin take a page down (soft-delete) or restore it. The takedown is the
 * same soft-delete the serve route already 404s on, so a removed page is
 * immediately unreachable.
 */

type ModerationStatusFilter = 'reported' | 'active' | 'taken_down' | 'all';

interface AdminArtifact {
  publicId: string;
  tier: string;
  scopeId: string;
  slug: string;
  title: string;
  visibility: string;
  ownerId: string;
  moderationStatus: 'active' | 'reported' | 'taken_down';
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
  { value: 'reported', label: 'Reported (needs review)' },
  { value: 'active', label: 'Active' },
  { value: 'taken_down', label: 'Taken down' },
  { value: 'all', label: 'All' },
];

function statusColor(s: AdminArtifact['moderationStatus']): 'danger' | 'warning' | 'neutral' {
  if (s === 'taken_down') return 'neutral';
  if (s === 'reported') return 'warning';
  return 'neutral';
}

const TIER_PREFIX: Record<string, string> = { user: 'u', project: 'pj', organization: 'o' };

/** The pretty `/p/...` URL for an artifact, mirroring the serve route's namespace. */
function publicPagePath(a: AdminArtifact): string {
  if (a.source?.kind === 'reply') return `/p/r/${a.publicId}`;
  if (a.source?.kind === 'fabfile') return `/p/f/${a.publicId}`;
  return `/p/${TIER_PREFIX[a.tier] ?? 'u'}/${a.scopeId}/${a.slug}`;
}

const PAGE_SIZE = 50;

const PublishedArtifactsTab: React.FC = () => {
  const [status, setStatus] = React.useState<ModerationStatusFilter>('reported');
  const [page, setPage] = React.useState(0);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  const listKey = ['admin-published-artifacts', status, page] as const;
  const { data, isLoading } = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const { data } = await api.get<{ artifacts: AdminArtifact[]; total: number }>(
        `/api/admin/published-artifacts?status=${status}&limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`
      );
      return data;
    },
  });

  const takedown = useMutation({
    mutationFn: async (publicId: string) => {
      const reason = window.prompt('Reason for takedown (optional):') ?? undefined;
      await api.post(`/api/admin/published-artifacts/${publicId}/takedown`, { reason });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-published-artifacts'] }),
  });

  const restore = useMutation({
    mutationFn: async (publicId: string) => {
      await api.delete(`/api/admin/published-artifacts/${publicId}/takedown`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-published-artifacts'] }),
  });

  const artifacts = data?.artifacts ?? [];

  return (
    <Box data-testid="admin-published-pages">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Typography level="h4">Published Pages</Typography>
        <Select
          size="sm"
          value={status}
          onChange={(_, v) => {
            if (v) {
              setStatus(v);
              setPage(0); // a new filter resets to the first page
            }
          }}
          sx={{ minWidth: 220 }}
          data-testid="admin-published-pages-status"
        >
          {STATUS_OPTIONS.map(o => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Select>
        <Typography level="body-sm" sx={{ opacity: 0.7 }}>
          {data ? `${data.total} page${data.total === 1 ? '' : 's'}` : ''}
        </Typography>
        {data && data.total > PAGE_SIZE && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 'auto' }}>
            <Button
              size="sm"
              variant="outlined"
              disabled={page === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
              data-testid="admin-published-prev"
            >
              Prev
            </Button>
            <Typography level="body-xs" sx={{ opacity: 0.7 }}>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}
            </Typography>
            <Button
              size="sm"
              variant="outlined"
              disabled={(page + 1) * PAGE_SIZE >= data.total}
              onClick={() => setPage(p => p + 1)}
              data-testid="admin-published-next"
            >
              Next
            </Button>
          </Box>
        )}
      </Box>

      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
        <Table size="sm" stickyHeader hoverRow>
          <thead>
            <tr>
              <th style={{ width: 70 }}>Reports</th>
              <th>Title</th>
              <th style={{ width: 90 }}>Kind</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 90 }}>Open</th>
              <th style={{ width: 200 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map(a => (
              <React.Fragment key={a.publicId}>
                <tr data-testid={`admin-published-row-${a.publicId}`}>
                  <td>
                    {a.reportCount > 0 ? (
                      <Chip
                        size="sm"
                        color="warning"
                        variant="soft"
                        onClick={() => setExpanded(expanded === a.publicId ? null : a.publicId)}
                        data-testid={`admin-published-reportcount-${a.publicId}`}
                      >
                        {a.reportCount}
                      </Chip>
                    ) : (
                      <Typography level="body-xs" sx={{ opacity: 0.5 }}>
                        0
                      </Typography>
                    )}
                  </td>
                  <td>
                    <Typography level="body-sm" noWrap title={a.title}>
                      {a.title}
                    </Typography>
                    <Typography level="body-xs" sx={{ opacity: 0.6 }} noWrap>
                      {a.tier}/{a.scopeId}/{a.slug}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs">{a.source?.kind ?? '—'}</Typography>
                  </td>
                  <td>
                    <Chip size="sm" variant="soft" color={statusColor(a.moderationStatus)}>
                      {a.moderationStatus}
                    </Chip>
                  </td>
                  <td>
                    {a.moderationStatus !== 'taken_down' && (
                      <Tooltip title="Open the public page">
                        <IconButton
                          size="sm"
                          component={Link}
                          href={publicPagePath(a)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <OpenInNewIcon />
                        </IconButton>
                      </Tooltip>
                    )}
                  </td>
                  <td>
                    {a.moderationStatus === 'taken_down' ? (
                      <Button
                        size="sm"
                        variant="soft"
                        color="neutral"
                        startDecorator={<RestoreIcon />}
                        loading={restore.isPending}
                        onClick={() => restore.mutate(a.publicId)}
                        data-testid={`admin-published-restore-${a.publicId}`}
                      >
                        Restore
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="soft"
                        color="danger"
                        startDecorator={<BlockIcon />}
                        loading={takedown.isPending}
                        onClick={() => takedown.mutate(a.publicId)}
                        data-testid={`admin-published-takedown-${a.publicId}`}
                      >
                        Take down
                      </Button>
                    )}
                  </td>
                </tr>
                {expanded === a.publicId && <ReportsRow publicId={a.publicId} />}
              </React.Fragment>
            ))}
            {!isLoading && artifacts.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Typography level="body-sm" sx={{ p: 2, textAlign: 'center', opacity: 0.6 }}>
                    No pages for this filter.
                  </Typography>
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </Sheet>
    </Box>
  );
};

/** Inline expansion showing the individual abuse reports for one page. */
const ReportsRow: React.FC<{ publicId: string }> = ({ publicId }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-published-reports', publicId],
    queryFn: async () => {
      const { data } = await api.get<{ reports: ArtifactReport[] }>(
        `/api/admin/published-artifacts/${publicId}/reports`
      );
      return data;
    },
  });
  return (
    <tr>
      <td colSpan={6} style={{ background: 'var(--joy-palette-background-level1)' }}>
        {isLoading ? (
          <LinearProgress sx={{ m: 1 }} />
        ) : (
          <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {(data?.reports ?? []).map((r, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                <Chip size="sm" variant="outlined" color="warning">
                  {r.reason}
                </Chip>
                <Typography level="body-xs" sx={{ opacity: 0.6 }}>
                  {new Date(r.createdAt).toLocaleString()}
                </Typography>
                {r.details && <Typography level="body-sm">{r.details}</Typography>}
              </Box>
            ))}
            {(data?.reports ?? []).length === 0 && (
              <Typography level="body-sm" sx={{ opacity: 0.6 }}>
                No report details.
              </Typography>
            )}
          </Box>
        )}
      </td>
    </tr>
  );
};

export default PublishedArtifactsTab;
