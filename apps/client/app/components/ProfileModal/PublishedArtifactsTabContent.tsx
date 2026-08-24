import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Autocomplete,
  Box,
  Button,
  Typography,
  Sheet,
  Chip,
  Switch,
  IconButton,
  Input,
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
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import PublishedWithChangesIcon from '@mui/icons-material/PublishedWithChanges';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import SearchIcon from '@mui/icons-material/Search';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { PublishVisibility } from '@bike4mind/common';
import { normalizePublishedTags, PUBLISHED_TAGS_MAX } from '@bike4mind/common';
import {
  listMyPublishedArtifacts,
  deletePublishedArtifact,
  updatePublishedVisibility,
  updatePublishedCommentPolicy,
  updatePublishedTags,
  restorePreviousVersion,
  toArtifactSharePath,
  fetchPublishedExport,
  canRefreshFromSource,
  refreshPublishedFromSource,
  type ManagedArtifact,
} from '@client/app/utils/publishApi';
import { EXPORT_CONTENT_TYPE, exportFilename, supportsExport } from '@client/app/utils/publishExport';
import { downloadData } from '@client/app/utils/download';
import { printHtmlForPdf } from '@client/app/utils/printToPdf';
import { ManageSharingPanel } from '@client/app/components/common/ManageSharingPanel';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

/** Prefix shared with the profile page's own listing, so one invalidate refreshes both. */
const QUERY_KEY_BASE = ['published-artifacts', 'mine'] as const;

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
  // Debounced so typing does not fire a request per keystroke; `search` drives the
  // input, `debouncedSearch` the query key.
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const filtersActive = debouncedSearch.trim().length > 0 || tagFilter.length > 0;

  const { data, isLoading, isError } = useQuery({
    // Filters are part of the key: narrowing happens server-side (ahead of the result
    // cap), so each filter combination is its own cached result rather than a client
    // slice of one truncated page.
    queryKey: [...QUERY_KEY_BASE, { q: debouncedSearch.trim(), tags: tagFilter }],
    queryFn: () => listMyPublishedArtifacts({ q: debouncedSearch, tags: tagFilter }),
    // Keep the previous rows on screen while a new filter resolves, so the list does
    // not flash empty on every keystroke.
    placeholderData: previous => previous,
  });
  const artifacts = data?.artifacts ?? [];
  // The owner's full vocabulary, which the server returns unfiltered. A tag the owner
  // just removed from their last artifact would otherwise vanish from the control
  // mid-edit; keeping the selected values in the option list avoids that.
  const tagOptions = useMemo(() => [...new Set([...(data?.tags ?? []), ...tagFilter])].sort(), [data?.tags, tagFilter]);
  // A filter can empty the list, so "has rows" alone is not the test - keep the
  // controls on screen whenever they are the reason the list looks the way it does.
  const showControls = artifacts.length > 0 || filtersActive;

  // Prefix invalidate: refreshes every filter combination plus the profile page's
  // own unfiltered listing.
  const invalidate = () => void qc.invalidateQueries({ queryKey: QUERY_KEY_BASE });

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
  const tagsMut = useMutation({
    mutationFn: (v: { publicId: string; tags: string[] }) => updatePublishedTags(v.publicId, v.tags),
    onSuccess: () => {
      toast.success('Tags updated');
      setTagEditor(null);
      invalidate();
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Failed to update tags')),
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
    tagsMut.isPending ||
    deleteMut.isPending;
  // One row's sharing panel open at a time.
  const [manageOpen, setManageOpen] = useState<string | null>(null);
  // One row's tag editor open at a time; `draft` is the uncommitted selection.
  const [tagEditor, setTagEditor] = useState<{ publicId: string; draft: string[] } | null>(null);
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

  /**
   * Save as PDF via the browser's print dialog (issue #1142 item 2). Reuses the HTML
   * export as the source of truth and hands it to an isolated print frame rather than
   * opening author HTML in the app origin - see printToPdf.ts. Owner-only (the public
   * footers are CSP-locked); offered for every kind since the browser renders it.
   */
  const runPrint = async (a: ManagedArtifact) => {
    const key = `${a.publicId}:pdf`;
    setExporting(key);
    try {
      const content = await fetchPublishedExport(sharePath(a), 'html');
      printHtmlForPdf(content);
    } catch (e) {
      toast.error(apiError(e, 'Could not open the print view'));
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

      {/* Management-list controls: they narrow the list the row actions operate on,
          and deliberately sit above the rows rather than replacing any per-row action.
          Hidden entirely for an owner with nothing published, where they would be
          controls over an empty set. */}
      {showControls && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
          <Input
            size="sm"
            placeholder="Search by title..."
            startDecorator={<SearchIcon sx={{ fontSize: 16 }} />}
            value={search}
            onChange={e => setSearch(e.target.value)}
            data-testid="published-artifacts-search"
            sx={{ flex: 1, minWidth: 200 }}
          />
          <Autocomplete
            multiple
            size="sm"
            placeholder={tagFilter.length ? '' : 'Filter by tag'}
            options={tagOptions}
            value={tagFilter}
            onChange={(_e, value) => setTagFilter(value)}
            data-testid="published-artifacts-tag-filter"
            sx={{ flex: 1, minWidth: 200 }}
          />
          {filtersActive && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => {
                setSearch('');
                setTagFilter([]);
              }}
              data-testid="published-artifacts-clear-filters"
            >
              Clear
            </Button>
          )}
        </Box>
      )}

      {artifacts.length === 0 ? (
        filtersActive ? (
          <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="published-artifacts-no-matches">
            No published artifacts match this search. Clear the filters to see all of them.
          </Typography>
        ) : (
          <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="published-artifacts-empty">
            You haven&apos;t published anything yet. Share an artifact or run the publish-to-bike4mind skill to get
            started.
          </Typography>
        )
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

                {/* Clicking a tag filters to it - the fastest path from "I see this
                    grouping" to "show me only that grouping". */}
                {(a.tags?.length ?? 0) > 0 && (
                  <Box
                    sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}
                    data-testid={`published-artifact-tags-${a.publicId}`}
                  >
                    {a.tags?.map(tag => (
                      <Chip
                        key={tag}
                        size="sm"
                        variant={tagFilter.includes(tag) ? 'solid' : 'soft'}
                        color="primary"
                        onClick={() => setTagFilter(cur => (cur.includes(tag) ? cur : [...cur, tag]))}
                        slotProps={{ action: { 'data-testid': `published-artifact-tag-${a.publicId}-${tag}` } }}
                      >
                        {tag}
                      </Chip>
                    ))}
                  </Box>
                )}

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

                  <Tooltip title="Edit tags">
                    <IconButton
                      size="sm"
                      variant={tagEditor?.publicId === a.publicId ? 'soft' : 'plain'}
                      color={tagEditor?.publicId === a.publicId ? 'primary' : 'neutral'}
                      disabled={busy}
                      onClick={() =>
                        setTagEditor(cur =>
                          cur?.publicId === a.publicId ? null : { publicId: a.publicId, draft: a.tags ?? [] }
                        )
                      }
                      data-testid={`published-artifact-edit-tags-${a.publicId}`}
                      aria-expanded={tagEditor?.publicId === a.publicId}
                    >
                      <LocalOfferIcon />
                    </IconButton>
                  </Tooltip>

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

                  {/* PDF is produced client-side by printing the HTML export from an
                      isolated frame (printToPdf), not a server export format. Offered
                      for every kind - the browser renders it visually. */}
                  <Tooltip title="Save as PDF (opens print dialog)">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      loading={exporting === `${a.publicId}:pdf`}
                      onClick={() => void runPrint(a)}
                      data-testid={`published-artifact-save-pdf-${a.publicId}`}
                    >
                      <PictureAsPdfIcon />
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

                {tagEditor?.publicId === a.publicId && (
                  <Box
                    sx={{ mt: 0.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}
                    data-testid={`published-artifact-tag-editor-${a.publicId}`}
                  >
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Autocomplete
                        multiple
                        freeSolo
                        size="sm"
                        placeholder="Add a tag and press Enter"
                        options={tagOptions}
                        value={tagEditor.draft}
                        onChange={(_e, value) =>
                          setTagEditor(cur =>
                            cur ? { ...cur, draft: normalizePublishedTags(value as string[]) } : cur
                          )
                        }
                        sx={{ flex: 1 }}
                        data-testid={`published-artifact-tag-input-${a.publicId}`}
                      />
                      <Button
                        size="sm"
                        loading={tagsMut.isPending && tagsMut.variables?.publicId === a.publicId}
                        onClick={() => tagsMut.mutate({ publicId: a.publicId, tags: tagEditor.draft })}
                        data-testid={`published-artifact-tag-save-${a.publicId}`}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => setTagEditor(null)}
                        data-testid={`published-artifact-tag-cancel-${a.publicId}`}
                      >
                        Cancel
                      </Button>
                    </Box>
                    {/* The write path silently drops anything past the cap, so say so
                        here rather than letting a typed tag vanish on save. */}
                    {tagEditor.draft.length >= PUBLISHED_TAGS_MAX && (
                      <Typography level="body-xs" sx={{ mt: 0.5, opacity: 0.7 }}>
                        Maximum of {PUBLISHED_TAGS_MAX} tags reached - remove one to add another.
                      </Typography>
                    )}
                  </Box>
                )}

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
