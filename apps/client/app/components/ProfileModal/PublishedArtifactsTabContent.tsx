import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Typography,
  Sheet,
  Chip,
  Switch,
  IconButton,
  Tooltip,
  Select,
  Option,
  LinearProgress,
  Link,
} from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LinkIcon from '@mui/icons-material/Link';
import RestoreIcon from '@mui/icons-material/Restore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CodeIcon from '@mui/icons-material/Code';
import NotesIcon from '@mui/icons-material/Notes';
import DownloadIcon from '@mui/icons-material/Download';
import PublishedWithChangesIcon from '@mui/icons-material/PublishedWithChanges';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { PublishVisibility } from '@bike4mind/common';
import {
  listMyPublishedArtifacts,
  deletePublishedArtifact,
  updatePublishedVisibility,
  updatePublishedCommentPolicy,
  restorePreviousVersion,
  toArtifactSharePath,
  fetchPublishedExport,
  canRefreshFromSource,
  refreshPublishedFromSource,
  type ManagedArtifact,
} from '@client/app/utils/publishApi';
import { EXPORT_CONTENT_TYPE, exportFilename, supportsExport } from '@client/app/utils/publishExport';
import { downloadData } from '@client/app/utils/download';
import { ManageSharingPanel } from '@client/app/components/common/ManageSharingPanel';

const QUERY_KEY = ['published-artifacts', 'mine'] as const;

function apiError(err: unknown, fallback: string): string {
  if (isAxiosError(err)) return (err.response?.data as { error?: string })?.error || err.message || fallback;
  return err instanceof Error ? err.message : fallback;
}

/** Public path for an artifact: bundles use the scope path, snapshots the short id. */
function sharePath(a: ManagedArtifact): string {
  if (a.source.kind === 'reply') return `/p/r/${a.publicId}`;
  if (a.source.kind === 'fabfile') return `/p/f/${a.publicId}`;
  return toArtifactSharePath(a.tier, a.scopeId, a.slug);
}

/**
 * Profile Published tab: manage the artifacts the caller has published. Toggle
 * who can view, turn comments on/off, refresh a link from its source artifact,
 * restore the previous version, copy/open the share link, export the content, or
 * delete - all reachable for ANY published artifact, not just one freshly shared
 * in-session.
 */
export default function PublishedArtifactsTabContent() {
  const qc = useQueryClient();
  const {
    data: artifacts = [],
    isLoading,
    isError,
  } = useQuery({ queryKey: QUERY_KEY, queryFn: listMyPublishedArtifacts });

  const invalidate = () => void qc.invalidateQueries({ queryKey: QUERY_KEY });

  const visibilityMut = useMutation({
    mutationFn: (v: { publicId: string; visibility: PublishVisibility }) =>
      updatePublishedVisibility(v.publicId, v.visibility),
    onSuccess: () => {
      toast.success('Visibility updated');
      invalidate();
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Failed to update visibility')),
  });
  const commentsMut = useMutation({
    mutationFn: (v: { publicId: string; on: boolean }) =>
      updatePublishedCommentPolicy(v.publicId, v.on ? 'open' : 'none'),
    onSuccess: (_d, v) => {
      toast.success(v.on ? 'Comments enabled' : 'Comments turned off');
      invalidate();
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Failed to update comments')),
  });
  const restoreMut = useMutation({
    mutationFn: (publicId: string) => restorePreviousVersion(publicId),
    onSuccess: () => {
      toast.success('Restored the previous version');
      invalidate();
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Restore failed')),
  });
  const refreshMut = useMutation({
    mutationFn: (a: ManagedArtifact) => refreshPublishedFromSource(a),
    onSuccess: () => {
      toast.success('Refreshed from source - a new version is live');
      invalidate();
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Refresh failed')),
  });
  const deleteMut = useMutation({
    mutationFn: (publicId: string) => deletePublishedArtifact(publicId),
    onSuccess: () => {
      toast.success('Artifact deleted');
      invalidate();
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Failed to delete')),
  });

  const busy =
    visibilityMut.isPending ||
    commentsMut.isPending ||
    restoreMut.isPending ||
    refreshMut.isPending ||
    deleteMut.isPending;
  // One row's sharing panel open at a time.
  const [manageOpen, setManageOpen] = useState<string | null>(null);
  // publicId+format of an export in flight, so only the clicked button disables.
  const [exporting, setExporting] = useState<string | null>(null);

  /**
   * Run an export through the authenticated api client (a plain download link would
   * navigate uncredentialed and get the loader shell for anything gated), then either
   * copy it or save it. Owner-side only: these buttons are the export path for private
   * and org-gated artifacts, whose public pages deliberately show no export links.
   */
  const runExport = async (a: ManagedArtifact, format: 'md' | 'html', action: 'copy' | 'download') => {
    const key = `${a.publicId}:${format}`;
    setExporting(key);
    try {
      const content = await fetchPublishedExport(sharePath(a), format);
      if (action === 'copy') {
        await navigator.clipboard.writeText(content);
        toast.success('Markdown copied');
      } else {
        downloadData(content, exportFilename(a.title, format), EXPORT_CONTENT_TYPE[format]);
      }
    } catch (e) {
      toast.error(apiError(e, format === 'md' ? 'Could not copy as Markdown' : 'Could not save as HTML'));
    } finally {
      setExporting(cur => (cur === key ? null : cur));
    }
  };

  if (isLoading) return <LinearProgress data-testid="published-artifacts-loading" />;
  if (isError) {
    return (
      <Typography color="danger" data-testid="published-artifacts-error">
        Failed to load your Live Artifacts.
      </Typography>
    );
  }

  return (
    <Box data-testid="published-artifacts-tab">
      <Typography level="title-md" sx={{ mb: 0.5 }}>
        Live Artifacts
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2, opacity: 0.8 }}>
        Everything you&apos;ve published as a live link. Change who can view, turn comments on or off, export the
        content, refresh a link from its source artifact, restore a previous version, or delete.
      </Typography>

      {artifacts.length === 0 ? (
        <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="published-artifacts-empty">
          You haven&apos;t published anything yet. Share an artifact or run the publish-to-bike4mind skill to get
          started.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {artifacts.map(a => {
            const path = sharePath(a);
            const url = `${window.location.origin}${path}`;
            const isBundle = a.source.kind === 'bundle';
            const canRefresh = canRefreshFromSource(a);
            const hasPrevious = Boolean(a.previousVersionMeta?.sha256Index);
            const commentsOn = a.commentPolicy === 'open' || a.commentPolicy === 'restricted';

            return (
              <Sheet
                key={a.publicId}
                variant="outlined"
                data-testid={`published-artifact-${a.publicId}`}
                sx={{ p: 1.5, borderRadius: 'md', display: 'flex', flexDirection: 'column', gap: 1 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Tooltip title="Opens in a new tab">
                    <Link
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      level="title-sm"
                      endDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                      sx={{ flex: 1, minWidth: 180 }}
                    >
                      {a.title}
                    </Link>
                  </Tooltip>
                  <Chip size="sm" variant="soft" startDecorator={<VisibilityIcon sx={{ fontSize: 13 }} />}>
                    {a.viewCount ?? 0}
                  </Chip>
                  <Chip size="sm" variant="soft" color="neutral">
                    {a.source.kind}
                  </Chip>
                  {isBundle && (a.versionsCount ?? 0) >= 2 && (
                    <Chip
                      size="sm"
                      variant="soft"
                      color="primary"
                      data-testid={`published-artifact-versions-${a.publicId}`}
                    >
                      {a.versionsCount} versions
                    </Chip>
                  )}
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                      Visibility
                    </Typography>
                    <Select
                      size="sm"
                      value={a.visibility}
                      disabled={busy}
                      onChange={(_e, val) =>
                        val && val !== a.visibility && visibilityMut.mutate({ publicId: a.publicId, visibility: val })
                      }
                      data-testid={`published-artifact-visibility-${a.publicId}`}
                      sx={{ minWidth: 110 }}
                    >
                      <Option value="public">Public</Option>
                      <Option value="private">Private</Option>
                    </Select>
                  </Box>

                  {isBundle && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                        Comments
                      </Typography>
                      <Switch
                        size="sm"
                        checked={commentsOn}
                        disabled={busy}
                        onChange={e => commentsMut.mutate({ publicId: a.publicId, on: e.target.checked })}
                        data-testid={`published-artifact-comments-${a.publicId}`}
                      />
                    </Box>
                  )}

                  <Box sx={{ flex: 1 }} />

                  <Tooltip title="Share, gate & embed">
                    <IconButton
                      size="sm"
                      variant={manageOpen === a.publicId ? 'soft' : 'plain'}
                      color={manageOpen === a.publicId ? 'primary' : 'neutral'}
                      onClick={() => setManageOpen(cur => (cur === a.publicId ? null : a.publicId))}
                      data-testid={`published-artifact-manage-${a.publicId}`}
                      aria-expanded={manageOpen === a.publicId}
                    >
                      <CodeIcon />
                    </IconButton>
                  </Tooltip>

                  <Tooltip title="Copy link">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(url);
                          toast.success('Link copied');
                        } catch {
                          toast.error('Could not copy link');
                        }
                      }}
                      data-testid={`published-artifact-copy-${a.publicId}`}
                    >
                      <LinkIcon />
                    </IconButton>
                  </Tooltip>

                  {/* Markdown is offered only for kinds it converts to faithfully (replies,
                      whose stored body IS markdown) - see exportFormatsFor. Hidden, not
                      disabled: a greyed button implies the export exists and is unavailable,
                      when in fact there is no honest Markdown form of an HTML bundle. */}
                  {supportsExport(a.source.kind, 'md') && (
                    <Tooltip title="Copy as Markdown">
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        loading={exporting === `${a.publicId}:md`}
                        onClick={() => void runExport(a, 'md', 'copy')}
                        data-testid={`published-artifact-copy-md-${a.publicId}`}
                      >
                        <NotesIcon />
                      </IconButton>
                    </Tooltip>
                  )}

                  <Tooltip title="Save as HTML">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      loading={exporting === `${a.publicId}:html`}
                      onClick={() => void runExport(a, 'html', 'download')}
                      data-testid={`published-artifact-save-html-${a.publicId}`}
                    >
                      <DownloadIcon />
                    </IconButton>
                  </Tooltip>

                  {/* Refresh re-publishes from the source artifact's CURRENT content onto
                      the same link. Hidden where there is no source to read back (a reply
                      snapshot, or a bundle published from outside the app). */}
                  {canRefresh && (
                    <Tooltip title="Refresh from source (publishes a new version)">
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        disabled={busy}
                        loading={refreshMut.isPending && refreshMut.variables?.publicId === a.publicId}
                        onClick={() => {
                          // Outward-facing: it replaces what viewers of a live link see.
                          if (
                            window.confirm(
                              `Refresh "${a.title}" from its source artifact? This publishes a new version to the same link.`
                            )
                          ) {
                            refreshMut.mutate(a);
                          }
                        }}
                        data-testid={`published-artifact-refresh-${a.publicId}`}
                      >
                        <PublishedWithChangesIcon />
                      </IconButton>
                    </Tooltip>
                  )}

                  {isBundle && (
                    <Tooltip title={hasPrevious ? 'Restore the previous version' : 'No previous version to restore'}>
                      <span>
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          disabled={busy || !hasPrevious}
                          onClick={() => restoreMut.mutate(a.publicId)}
                          data-testid={`published-artifact-restore-${a.publicId}`}
                        >
                          <RestoreIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}

                  <Tooltip title="Delete">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete "${a.title}"? The share link will stop working.`)) {
                          deleteMut.mutate(a.publicId);
                        }
                      }}
                      data-testid={`published-artifact-delete-${a.publicId}`}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </Tooltip>
                </Box>

                {/* Lazily mounted so the manage-state fetch (gate + embed list) only
                    fires for the row the owner actually opens. */}
                {manageOpen === a.publicId && (
                  <Box sx={{ mt: 0.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
                    <ManageSharingPanel
                      publicId={a.publicId}
                      title={a.title}
                      shareUrl={url}
                      visibility={a.visibility}
                    />
                  </Box>
                )}

                {/* Single-version artifacts have no version switcher yet - explain why
                    and how to create history instead of leaving a silent absence. */}
                {isBundle && (a.versionsCount ?? 0) < 2 && (
                  <Typography
                    level="body-xs"
                    sx={{ opacity: 0.7 }}
                    data-testid={`published-artifact-single-version-${a.publicId}`}
                  >
                    Only one version published -{' '}
                    {canRefresh ? 'refresh it from source (or use AI Revise)' : 're-publish this artifact'} to create
                    version history. A version switcher appears on the page once there are 2 or more versions.
                  </Typography>
                )}
              </Sheet>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
