import React, { useEffect, useMemo, useState } from 'react';
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
  Input,
  Button,
  Autocomplete,
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
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import LockIcon from '@mui/icons-material/Lock';
import DomainIcon from '@mui/icons-material/Domain';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
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
  type ManagedListFacets,
  type ManagedListPage,
  updatePublishedTags,
  fetchMyTagVocabulary,
} from '@client/app/utils/publishApi';
import { ArtifactCover } from '@client/app/components/common/ArtifactCover';
import { normalizePublishTag, normalizePublishTags, PUBLISH_TAGS_MAX, PUBLISH_TAG_MAX_LENGTH } from '@bike4mind/common';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { EXPORT_CONTENT_TYPE, exportFilename, supportsExport } from '@client/app/utils/publishExport';
import { downloadData } from '@client/app/utils/download';
import { printHtmlForPdf } from '@client/app/utils/printToPdf';
import { ManageSharingPanel } from '@client/app/components/common/ManageSharingPanel';

/** Page size. Small enough that the tab opens instantly on a large library, large enough that most
 *  people never page at all. Exported so the paging tests assert against one number rather than a
 *  copy, and named the same as the server's own bound so the two are greppable together. */
export const PAGE_SIZE = 25;

/** Sort options, mirroring the keys the list endpoint accepts. */
const SORTS: Array<{ value: string; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'views', label: 'Most viewed' },
  { value: 'versions', label: 'Most versions' },
  { value: 'title', label: 'Title A-Z' },
];

/** The filter state the toolbar owns. `null` means "not filtering on this axis". */
interface Filters {
  tag: string | null;
  kind: string | null;
  visibility: string | null;
  gate: string | null;
  comments: 'on' | 'off' | null;
  sort: string;
}

const NO_FILTERS: Filters = { tag: null, kind: null, visibility: null, gate: null, comments: null, sort: 'newest' };

/** True when anything is narrowing the list - drives the "no matches" copy and Clear button. */
function isFiltering(f: Filters, q: string): boolean {
  return Boolean(q.trim() || f.tag || f.kind || f.visibility || f.gate || f.comments);
}

/** Compact date for the row meta line: same-year dates drop the year. */
function shortDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

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
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [skip, setSkip] = useState(0);
  // The hook owns the search text: `q` is what the input shows (never laggy) and `debouncedQ` is
  // what the request uses, so typing does not fire one call per keystroke.
  const { value: q, debouncedValue: debouncedQ, setValue: setQ } = useDebounceValue('', 300);

  const query = useMemo(
    () => ({
      q: debouncedQ,
      tag: filters.tag ?? undefined,
      kind: filters.kind ?? undefined,
      visibility: filters.visibility ?? undefined,
      gate: filters.gate ?? undefined,
      comments: filters.comments ?? undefined,
      sort: filters.sort,
      limit: PAGE_SIZE,
      skip,
    }),
    [debouncedQ, filters.tag, filters.kind, filters.visibility, filters.gate, filters.comments, filters.sort, skip]
  );

  const { data, isLoading, isError } = useQuery({
    // Prefix stays ['published-artifacts','mine'] so every existing invalidation - including the
    // profile screen's own has-any query - still matches.
    queryKey: ['published-artifacts', 'mine', query] as const,
    queryFn: () => listMyPublishedArtifacts(query),
    // Keep the previous page on screen while the next one loads instead of flashing a spinner.
    placeholderData: prev => prev,
  });

  // Facets are their own query: they are group-bys over the caller's WHOLE library and by design
  // ignore the current selection, so they do not change when you turn a page. Folding them into the
  // list query re-ran five group-bys on every paging click. staleTime keeps them out of the way of
  // ordinary navigation; the tab's invalidation still refreshes them when the library changes.
  const { data: facetData } = useQuery({
    queryKey: ['published-artifacts', 'mine', 'facets'] as const,
    queryFn: () => listMyPublishedArtifacts({ facets: true, limit: 1 }),
    staleTime: 60_000,
  });

  const artifacts = data?.artifacts ?? [];
  const total = data?.total ?? 0;

  // Backstop alongside `wasLastOnPage` below: that flag is computed at click time from the
  // render-time array, which retains its stale value while an invalidation is in flight, so
  // a second delete fired in that window can still land on an empty page it didn't think it
  // caused. This reacts to the settled response itself instead, so it self-heals regardless of
  // which mutation (or how many in a race) emptied the page.
  useEffect(() => {
    if (!isLoading && !isError && artifacts.length === 0 && skip > 0) {
      setSkip(Math.max(0, Math.floor(Math.max(0, total - 1) / PAGE_SIZE) * PAGE_SIZE));
    }
  }, [artifacts.length, isLoading, isError, skip, total]);

  const facets: ManagedListFacets = facetData?.facets ?? {
    kind: {},
    visibility: {},
    gate: {},
    comments: 0,
    tag: {},
  };
  const filtering = isFiltering(filters, q);

  /** Change a filter. Always resets to the first page - staying on page 4 of a narrower result
   *  set is how you end up staring at an empty list you did not ask for. */
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters(f => ({ ...f, [key]: value }));
    setSkip(0);
  };
  /** Click a chip that is already on to turn it off. */
  const toggleFilter = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilter(key, (filters[key] === value ? null : value) as Filters[K]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });

  // The caller's own tag vocabulary, for autocomplete. Deliberately OUTSIDE the
  // ['published-artifacts','mine'] prefix: under it, every visibility toggle and comment switch
  // refetched it too, and it is the one query backed by a scan of another collection. The two
  // mutations that CAN change it - a tag edit, and a delete, which takes that artifact's tags out
  // of the counts with it - invalidate it explicitly; a staleTime keeps reopening the tab from
  // re-running it.
  const { data: tagVocabulary = [] } = useQuery({
    queryKey: ['publish-tag-vocabulary'] as const,
    queryFn: fetchMyTagVocabulary,
    staleTime: 5 * 60_000,
  });

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
    // Patch the cached rows immediately. The PATCH is a full replace computed off `a.tags`, and
    // `busy` tracks the mutation but not the list refetch, so the input re-enables while the cache
    // is still pre-write: typing a second tag inside that one round trip sent the first one's
    // absence as the new list and silently dropped it, under a "Tags updated" toast. Because the
    // cache is corrected here rather than by the refetch, `busy` settling on the mutation is now
    // harmless - do not "fix" it back into a dependency on refetch timing.
    onMutate: v => {
      qc.setQueriesData<ManagedListPage>({ queryKey: ['published-artifacts', 'mine'] }, prev =>
        prev
          ? { ...prev, artifacts: prev.artifacts.map(a => (a.publicId === v.publicId ? { ...a, tags: v.tags } : a)) }
          : prev
      );
    },
    onSuccess: () => {
      toast.success('Tags updated');
      invalidate();
      void qc.invalidateQueries({ queryKey: ['publish-tag-vocabulary'] });
    },
    // Resync rather than restoring a snapshot: the server is the truth about what is stored, and
    // the toast already says the write did not land.
    onError: (e: unknown) => {
      toast.error(apiError(e, 'Failed to update tags'));
      invalidate();
    },
  });
  const deleteMut = useMutation({
    // `wasLastOnPage` is passed in by the caller, which knows the rendered row count, rather than
    // read from a ref: it decides whether this delete empties the current page.
    mutationFn: (v: { publicId: string; wasLastOnPage: boolean }) => deletePublishedArtifact(v.publicId),
    onSuccess: (_d, v) => {
      toast.success('Artifact deleted');
      // Step back a page when that was the last row on this one. Otherwise `skip` points past the
      // end of a now-shorter list: the page renders empty and - because `total` has dropped to a
      // single page - the pager disappears too, leaving no control to get back. Same reasoning as
      // resetting skip on a filter change, applied to the mutation that can shrink the set.
      if (v.wasLastOnPage) setSkip(cur => Math.max(0, cur - PAGE_SIZE));
      invalidate();
      // A delete takes that artifact's tags out of the vocabulary counts, so the suggestions have
      // to be refreshed too - otherwise deleting the last artifact carrying a label keeps offering
      // it for up to the staleTime.
      void qc.invalidateQueries({ queryKey: ['publish-tag-vocabulary'] });
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Failed to delete')),
  });

  const busy =
    tagsMut.isPending ||
    visibilityMut.isPending ||
    commentsMut.isPending ||
    restoreMut.isPending ||
    refreshMut.isPending ||
    deleteMut.isPending;
  // One row's sharing panel open at a time.
  const [manageOpen, setManageOpen] = useState<string | null>(null);
  /** Rows whose controls are expanded. A set rather than a single id: the collapsed row is the
   *  default now, and comparing two artifacts' settings is a normal thing to want. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (publicId: string) =>
    setExpanded(cur => {
      const next = new Set(cur);
      if (next.has(publicId)) {
        next.delete(publicId);
        // Collapsing must also close this row's sharing panel: the </> button that toggles it
        // lives inside the disclosure, so leaving the panel open would strand it on screen under
        // a one-line row with no visible control to dismiss it.
        setManageOpen(open => (open === publicId ? null : open));
      } else next.add(publicId);
      return next;
    });
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

      {/* Toolbar. Rendered whenever the library is non-empty OR a filter is active, so the way
          out of a no-matches state is always on screen. */}
      {(total > 0 || filtering) && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.5 }}>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              size="sm"
              value={q}
              onChange={e => {
                setQ(e.target.value);
                setSkip(0); // a narrower search must not leave you stranded on a later page
              }}
              placeholder="Search titles and descriptions"
              startDecorator={<SearchIcon sx={{ fontSize: 16 }} />}
              slotProps={{ input: { 'data-testid': 'published-artifacts-search' } }}
              sx={{ flex: '1 1 16rem', minWidth: '12rem' }}
            />
            <Select
              size="sm"
              value={filters.sort}
              onChange={(_e, val) => val && setFilter('sort', val)}
              data-testid="published-artifacts-sort"
              sx={{ minWidth: 160 }}
            >
              {SORTS.map(o => (
                <Option key={o.value} value={o.value}>
                  {o.label}
                </Option>
              ))}
            </Select>
            {filtering && (
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => {
                  setFilters(NO_FILTERS);
                  setQ('');
                  setSkip(0);
                }}
                data-testid="published-artifacts-clear-filters"
              >
                Clear
              </Button>
            )}
          </Box>

          {/* Facet chips. Counts come from the whole library, not the filtered page, so a chip
              still tells you how many there are after you have clicked it. */}
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* The active tag is merged in when the facet response does not carry it: the counts are
                capped at the top 24, but a row chip can select ANY tag the artifact has - and
                without this there is no per-facet control to turn that selection back off, only the
                global Clear. */}
            {/* hasOwn, not `=== undefined`: facets.tag is a plain object built by reduce, so a tag
                named `constructor` is never undefined there and the merge would be skipped - and
                Object.entries would not list it either, leaving that selection with no chip. */}
            {Object.entries(
              filters.tag && !Object.hasOwn(facets.tag, filters.tag) ? { [filters.tag]: 0, ...facets.tag } : facets.tag
            ).map(([tag, n]) => (
              <Chip
                key={`tag-${tag}`}
                size="sm"
                variant={filters.tag === tag ? 'solid' : 'outlined'}
                color={filters.tag === tag ? 'primary' : 'neutral'}
                startDecorator={<LocalOfferIcon sx={{ fontSize: 12 }} />}
                onClick={() => toggleFilter('tag', tag)}
                slotProps={{ action: { 'data-testid': `published-artifacts-facet-tag-${tag}` } }}
              >
                {tag}
                {n > 0 ? ` ${n}` : ''}
              </Chip>
            ))}
            {Object.entries(facets.kind).map(([kind, n]) => (
              <Chip
                key={kind}
                size="sm"
                variant={filters.kind === kind ? 'solid' : 'outlined'}
                color={filters.kind === kind ? 'primary' : 'neutral'}
                onClick={() => toggleFilter('kind', kind)}
                slotProps={{ action: { 'data-testid': `published-artifacts-facet-kind-${kind}` } }}
              >
                {kind} {n}
              </Chip>
            ))}
            {Object.entries(facets.visibility).map(([vis, n]) => (
              <Chip
                key={vis}
                size="sm"
                variant={filters.visibility === vis ? 'solid' : 'outlined'}
                color={filters.visibility === vis ? 'primary' : 'neutral'}
                onClick={() => toggleFilter('visibility', vis)}
                slotProps={{ action: { 'data-testid': `published-artifacts-facet-visibility-${vis}` } }}
              >
                {vis} {n}
              </Chip>
            ))}
            {(['passphrase', 'domain'] as const).map(gate =>
              facets.gate[gate] ? (
                <Chip
                  key={gate}
                  size="sm"
                  variant={filters.gate === gate ? 'solid' : 'outlined'}
                  color={filters.gate === gate ? 'primary' : 'neutral'}
                  onClick={() => toggleFilter('gate', gate)}
                  slotProps={{ action: { 'data-testid': `published-artifacts-facet-gate-${gate}` } }}
                >
                  {gate} {facets.gate[gate]}
                </Chip>
              ) : null
            )}
            {facets.comments > 0 && (
              <Chip
                size="sm"
                variant={filters.comments === 'on' ? 'solid' : 'outlined'}
                color={filters.comments === 'on' ? 'primary' : 'neutral'}
                onClick={() => toggleFilter('comments', 'on')}
                slotProps={{ action: { 'data-testid': 'published-artifacts-facet-comments' } }}
              >
                comments {facets.comments}
              </Chip>
            )}
          </Box>
        </Box>
      )}

      {artifacts.length === 0 ? (
        filtering || total > 0 ? (
          <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="published-artifacts-no-matches">
            {filtering
              ? 'Nothing matches those filters. Clear them to see your whole library.'
              : 'This page is empty - returning you to the first page.'}
          </Typography>
        ) : (
          <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="published-artifacts-empty">
            You haven&apos;t published anything yet. Share an artifact or run the publish-to-bike4mind skill to get
            started.
          </Typography>
        )
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {artifacts.map(a => {
            const path = sharePath(a);
            const url = `${window.location.origin}${path}`;
            const isBundle = a.source.kind === 'bundle';
            const canRefresh = canRefreshFromSource(a);
            const hasPrevious = Boolean(a.previousVersionMeta?.sha256Index);
            const commentsOn = a.commentPolicy === 'open' || a.commentPolicy === 'restricted';
            const isOpen = expanded.has(a.publicId);

            return (
              <Sheet
                key={a.publicId}
                variant="outlined"
                data-testid={`published-artifact-${a.publicId}`}
                sx={{ p: 1, borderRadius: 'md', display: 'flex', flexDirection: 'column', gap: 0.75 }}
              >
                {/* Collapsed row: everything you scan by on ONE line. The controls below used to
                    be always-on, which made each row ~110px tall and turned a library into a
                    scroll. Copy-link stays out here because it is the verb people actually reach
                    for; the rest is one click away. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                  {/* Generated cover: costs nothing, always exists, and is stable per artifact so
                      the eye can find a row it has seen before. Real screenshots replace it later. */}
                  <ArtifactCover
                    publicId={a.publicId}
                    title={a.title}
                    size={26}
                    data-testid={`published-artifact-cover-${a.publicId}`}
                  />
                  <Tooltip title="Opens in a new tab">
                    <Link
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      level="title-sm"
                      endDecorator={<OpenInNewIcon sx={{ fontSize: 13 }} />}
                      sx={{
                        minWidth: 0,
                        flex: '0 1 auto',
                        // Long titles truncate rather than wrapping the row onto a second line,
                        // which is what keeps the row height uniform down the list.
                        '& > span:first-of-type': {
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      }}
                    >
                      <span>{a.title}</span>
                    </Link>
                  </Tooltip>

                  {/* Tags are clickable: seeing a label and wanting everything sharing it is the
                      same impulse, so the chip filters rather than being decoration. */}
                  {(a.tags ?? []).length > 0 && (
                    <Box
                      sx={{ display: 'flex', gap: 0.25, flexWrap: 'nowrap', overflow: 'hidden', flex: '0 1 auto' }}
                      data-testid={`published-artifact-tags-${a.publicId}`}
                    >
                      {(a.tags ?? []).slice(0, 3).map(tag => (
                        <Chip
                          key={tag}
                          size="sm"
                          variant="outlined"
                          color="neutral"
                          onClick={() => setFilter('tag', tag)}
                          slotProps={{ action: { 'data-testid': `published-artifact-tag-${a.publicId}-${tag}` } }}
                        >
                          {tag}
                        </Chip>
                      ))}
                      {(a.tags ?? []).length > 3 && (
                        <Chip size="sm" variant="plain" color="neutral">
                          +{(a.tags ?? []).length - 3}
                        </Chip>
                      )}
                    </Box>
                  )}

                  <Box
                    sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'nowrap', ml: 'auto' }}
                    data-testid={`published-artifact-meta-${a.publicId}`}
                  >
                    {a.gateKind === 'passphrase' && (
                      <Tooltip title="Passphrase required">
                        <LockIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                      </Tooltip>
                    )}
                    {a.gateKind === 'domain' && (
                      <Tooltip title="Restricted to an email domain">
                        <DomainIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                      </Tooltip>
                    )}
                    {commentsOn && (
                      <Tooltip title="Comments are on">
                        <ChatBubbleOutlineIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                      </Tooltip>
                    )}
                    <Typography level="body-xs" sx={{ opacity: 0.6, whiteSpace: 'nowrap' }}>
                      {shortDate(a.publishedAt)}
                    </Typography>
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
                    <Chip size="sm" variant="soft" color="neutral">
                      {a.visibility}
                    </Chip>
                    <Chip size="sm" variant="soft" startDecorator={<VisibilityIcon sx={{ fontSize: 13 }} />}>
                      {a.viewCount ?? 0}
                    </Chip>

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
                    <Tooltip title={isOpen ? 'Hide settings' : 'Settings, export & versions'}>
                      <IconButton
                        size="sm"
                        variant={isOpen ? 'soft' : 'plain'}
                        color="neutral"
                        onClick={() => toggleExpanded(a.publicId)}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? 'Hide settings' : 'Show settings'}
                        data-testid={`published-artifact-expand-${a.publicId}`}
                      >
                        {isOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>

                {isOpen && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <LocalOfferIcon sx={{ fontSize: 15, opacity: 0.6 }} />
                    {/* freeSolo because tags are freeform: the vocabulary SUGGESTS, it does not
                        restrict. Suggestions merge published-artifact and AppFile tags so one
                        label means one thing across the app. */}
                    <Autocomplete
                      size="sm"
                      multiple
                      freeSolo
                      disableClearable
                      placeholder={(a.tags ?? []).length ? '' : 'Add tags'}
                      options={tagVocabulary.map(t => t.tag)}
                      value={a.tags ?? []}
                      disabled={busy}
                      onChange={(_e, next) => {
                        // Normalize with the SAME helper the server uses, so the chips the owner
                        // sees are what gets stored - no surprise re-spelling on reload.
                        const entered = next as string[];
                        const tags = normalizePublishTags(entered);
                        // A REJECTED tag (over-long, or past the cap) is dropped rather than
                        // rewritten, which made the equality check below see no change: no write, no
                        // toast, and the chip just disappeared on the next render. Rewrites are
                        // self-explanatory; drops have to be said out loud or the field reads broken.
                        //
                        // The REASON comes from the entries, not from `tags.length < entered.length`
                        // - that is true of any shortening, dedupe and blank-drop included. MUI
                        // compares options with ===, so typing `IonQ` beside an existing `ionq` chip
                        // appends the variant and the normalizer then dedupes it: the old check
                        // reported a length problem about a four-character tag. Blanks and duplicates
                        // stay SILENT, for the same reason a rewrite does - they explain themselves.
                        const normalizedEach = entered.map(normalizePublishTag);
                        const tooLong = normalizedEach.some(t => t.length > PUBLISH_TAG_MAX_LENGTH);
                        const overCap =
                          new Set(normalizedEach.filter(t => t && t.length <= PUBLISH_TAG_MAX_LENGTH)).size >
                          PUBLISH_TAGS_MAX;
                        // Over-long wins when both hold: it points at a specific bad token, where
                        // the cap message can only restate the limit.
                        if (tooLong) {
                          toast.error(`Tags can be at most ${PUBLISH_TAG_MAX_LENGTH} characters`);
                        } else if (overCap) {
                          toast.error(`Up to ${PUBLISH_TAGS_MAX} tags per artifact`);
                        }
                        const current = a.tags ?? [];
                        if (tags.length === current.length && tags.every((t, i) => t === current[i])) return;
                        tagsMut.mutate({ publicId: a.publicId, tags });
                      }}
                      slotProps={{ input: { 'data-testid': `published-artifact-tag-input-${a.publicId}` } }}
                      sx={{ flex: 1, minWidth: 200 }}
                    />
                    <Typography level="body-xs" sx={{ opacity: 0.6, whiteSpace: 'nowrap' }}>
                      {(a.tags ?? []).length}/{PUBLISH_TAGS_MAX}
                    </Typography>
                  </Box>
                )}

                {isOpen && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                    <Chip size="sm" variant="soft" color="neutral">
                      {a.source.kind}
                    </Chip>
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
                            deleteMut.mutate({ publicId: a.publicId, wasLastOnPage: artifacts.length <= 1 });
                          }
                        }}
                        data-testid={`published-artifact-delete-${a.publicId}`}
                      >
                        <DeleteOutlineIcon />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}

                {/* Lazily mounted so the manage-state fetch (gate + embed list) only
                    fires for the row the owner actually opens. */}
                {isOpen && manageOpen === a.publicId && (
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
                    and how to create history instead of leaving a silent absence. Shown only in
                    the expanded row: it was identical on most rows and, repeated down a long
                    list, was the single largest consumer of vertical space on the page. */}
                {isOpen && isBundle && (a.versionsCount ?? 0) < 2 && (
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

      {/* Pager. Rendered whenever there is more than one page - and `total` is what makes it
          honest: before this the endpoint capped at 200 rows with no count, so a larger library
          silently lost its oldest artifacts with nothing on screen saying so. */}
      {total > PAGE_SIZE && (
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mt: 1.5 }}
          data-testid="published-artifacts-pager"
        >
          <Typography level="body-xs" sx={{ opacity: 0.7 }}>
            {skip + 1}-{Math.min(skip + PAGE_SIZE, total)} of {total}
            {filtering ? ' matching' : ''}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={skip === 0}
              onClick={() => setSkip(cur => Math.max(0, cur - PAGE_SIZE))}
              data-testid="published-artifacts-prev"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={skip + PAGE_SIZE >= total}
              onClick={() => setSkip(cur => cur + PAGE_SIZE)}
              data-testid="published-artifacts-next"
            >
              Next
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}
