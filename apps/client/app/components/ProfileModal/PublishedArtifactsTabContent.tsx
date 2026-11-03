import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Typography,
  Sheet,
  Chip,
  IconButton,
  Tooltip,
  Select,
  Option,
  LinearProgress,
  Link,
  Input,
  Button,
  ToggleButtonGroup,
  Modal,
  ModalDialog,
  ModalClose,
} from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LinkIcon from '@mui/icons-material/Link';
import VisibilityIcon from '@mui/icons-material/Visibility';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import ViewListIcon from '@mui/icons-material/ViewList';
import GridViewIcon from '@mui/icons-material/GridView';
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
  refreshPublishedFromSource,
  type ManagedArtifact,
  type ManagedListFacets,
  type ManagedListPage,
  type PublishAccessGateRead,
  updatePublishedTags,
  fetchMyTagVocabulary,
} from '@client/app/utils/publishApi';
import { ArtifactThumbnail } from '@client/app/components/common/ArtifactThumbnail';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { EXPORT_CONTENT_TYPE, exportFilename } from '@client/app/utils/publishExport';
import { downloadData } from '@client/app/utils/download';
import { printHtmlForPdf } from '@client/app/utils/printToPdf';
import {
  PublishAccessBadge,
  PUBLISH_ACCESS_META,
  isPublishAccess,
} from '@client/app/components/common/PublishAccessBadge';
import { PublishedArtifactCard } from './PublishedArtifactCard';
import { PublishedArtifactSettings } from './PublishedArtifactSettings';
import { formatViews, shortDate, sourceKindLabel } from './publishedArtifactFormat';
import { usePublishedArtifactsView } from './usePublishedArtifactsView';

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

function apiError(err: unknown, fallback: string): string {
  if (isAxiosError(err)) return (err.response?.data as { error?: string })?.error || err.message || fallback;
  return err instanceof Error ? err.message : fallback;
}

/** Where keyboard focus goes once a delete lands. */
type DeleteFocusTarget = { kind: 'item'; publicId: string } | { kind: 'search' } | { kind: 'heading' };

/**
 * The next row or card after the deleted one, else the one before it. With neither left the page is
 * empty: the search box is the nearest control that survives, except when the whole library is
 * emptied, which removes the toolbar - then the tab heading is all that is left to land on.
 */
function focusTargetAfterDelete(
  artifacts: ManagedArtifact[],
  deletedId: string,
  libraryEmpties: boolean
): DeleteFocusTarget {
  const i = artifacts.findIndex(a => a.publicId === deletedId);
  const neighbour = i < 0 ? undefined : (artifacts[i + 1] ?? artifacts[i - 1]);
  if (neighbour) return { kind: 'item', publicId: neighbour.publicId };
  return { kind: libraryEmpties ? 'heading' : 'search' };
}

/** Column template shared by the header and every row, so each piece of metadata lines up down the
 *  list: cover, title (takes the slack), access, versions, views, published date, actions. Fixed widths
 *  are sized for the widest content in each column (a "Passphrase" chip, "12 versions"). */
const ROW_COLUMNS = '26px minmax(0, 1fr) 128px 92px 64px 80px 68px';

/** Rows pick their layout from the width of the list, not the viewport: with the app sidebar open a
 *  wide screen can still leave the tab narrow, and a viewport breakpoint would squeeze the title
 *  column to nothing there. Seven columns need about 720px (the fixed columns above are ~430px, the
 *  rest is gaps and the title). Every use sits under the list wrapper, which is the size container. */
const WIDE = '@container (min-width: 720px)';

/** Narrow lists have no room for seven columns: the cover, title and actions keep one line and the
 *  metadata wraps onto a second line under the title. */
const ROW_GRID_SX = {
  display: 'grid',
  gridTemplateColumns: '26px minmax(0, 1fr) auto',
  gridTemplateAreas: '"cover title actions" ". meta meta"',
  [WIDE]: {
    gridTemplateColumns: ROW_COLUMNS,
    gridTemplateAreas: '"cover title access versions views date actions"',
  },
  columnGap: 1,
  rowGap: 0.5,
  alignItems: 'center',
  minWidth: 0,
} as const;

/** A numeric cell on its grid column: right-aligned, tabular figures so digits stack in a column. */
const numericCell = (area: string) =>
  ({
    display: 'flex',
    alignItems: 'center',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    minWidth: 0,
    [WIDE]: { gridArea: area, justifyContent: 'flex-end' },
  }) as const;

/** A labelled cluster of facet chips; the muted label lets one run of chips read as separate questions. */
function FacetGroup({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <Box
      role="group"
      aria-label={label}
      data-testid={`published-artifacts-facet-group-${id}`}
      sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}
    >
      <Typography
        level="body-xs"
        sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, fontWeight: 600, mr: 0.25 }}
        textColor="text.tertiary"
      >
        {label}
      </Typography>
      {children}
    </Box>
  );
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
  const view = usePublishedArtifactsView(s => s.view);
  const setView = usePublishedArtifactsView(s => s.setView);
  /** Grid view only: the artifact whose settings dialog is open. */
  const [settingsId, setSettingsId] = useState<string | null>(null);
  // Focus after a delete. The row or card the user acted on is about to disappear, which would drop
  // keyboard focus to the page body, so focus moves to a neighbour's title link (found by id through
  // `titleLinks`) instead. The move is queued in a ref and applied from an effect so it runs after
  // the settings dialog has closed - see that effect below. `focusTick` only wakes the effect.
  const titleLinks = useRef(new Map<string, HTMLAnchorElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<DeleteFocusTarget | null>(null);
  const settingsSession = useRef(0);
  const [focusTick, setFocusTick] = useState(0);
  /** Ref callback for one artifact's title link, in either view. */
  const titleRef = (publicId: string) => (el: HTMLAnchorElement | null) => {
    if (el) titleLinks.current.set(publicId, el);
    else titleLinks.current.delete(publicId);
  };
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
  // render-time array, which retains its stale value while an invalidation is in flight, so a
  // second delete fired in that window can still land on an empty page it didn't think it caused.
  // `data?.skip === skip` is an exact freshness check (the server echoes back the page it
  // answered, apps/client/pages/api/publish/artifacts/index.ts) that closes both the error case
  // (no `data`) and the stale-key case (an older page's leftover response) in one condition, so
  // this only reacts to the CURRENT page's real, settled result - never a placeholder or a failure.
  useEffect(() => {
    if (data?.skip === skip && artifacts.length === 0 && skip > 0) {
      // Clamp-on-settle is the intent (adjusting state in response to a server response the
      // component doesn't otherwise re-render for), so the setState here is deliberate.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSkip(Math.max(0, Math.floor(Math.max(0, total - 1) / PAGE_SIZE) * PAGE_SIZE));
    }
  }, [data, artifacts.length, skip, total]);

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

  const patchRow = (publicId: string, patch: Partial<ManagedArtifact>) =>
    qc.setQueriesData<ManagedListPage>({ queryKey: ['published-artifacts', 'mine'] }, prev =>
      prev ? { ...prev, artifacts: prev.artifacts.map(a => (a.publicId === publicId ? { ...a, ...patch } : a)) } : prev
    );

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });

  /** A gate edit in the sharing panel: patch the row in place so its access badge is right at once,
   *  and refresh only the facet counts. A full list refetch could drop the row from a filtered or
   *  re-sorted page, unmounting the panel and the show-once passphrase it is still displaying. */
  const onGateChange = async (publicId: string, gate: PublishAccessGateRead) => {
    // A list response started before the gate save must not overwrite its new badge.
    await qc.cancelQueries({
      queryKey: ['published-artifacts', 'mine'],
      predicate: query => query.queryKey[2] !== 'facets',
    });
    patchRow(publicId, { gateKind: gate?.kind });
    void qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine', 'facets'] });
  };

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
      patchRow(v.publicId, { tags: v.tags });
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
    // read from a ref: it decides whether this delete empties the current page. `focusTarget` is
    // worked out at click time for the same reason - the list it is derived from is about to change.
    mutationFn: (v: {
      publicId: string;
      wasLastOnPage: boolean;
      focusTarget: DeleteFocusTarget;
      settingsSession: number;
      focusOwner: Element | null;
      focusCard: Element | null;
    }) => deletePublishedArtifact(v.publicId),
    onSuccess: (_d, v) => {
      toast.success('Artifact deleted');
      // Step back a page when that was the last row on this one. Otherwise `skip` points past the
      // end of a now-shorter list: the page renders empty and - because `total` has dropped to a
      // single page - the pager disappears too, leaving no control to get back. Same reasoning as
      // resetting skip on a filter change, applied to the mutation that can shrink the set.
      // Deliberately kept alongside the settle-driven clamp effect above (which corrects this same
      // case a beat later from the real response): this fast path just avoids a visible flash of
      // the empty-page copy on the common single-delete click.
      if (v.wasLastOnPage) setSkip(cur => Math.max(0, cur - PAGE_SIZE));
      // Grid view deletes from inside the settings dialog: close it now rather than leaving it
      // up, disabled, over an artifact that is gone until the refetch lands.
      setSettingsId(cur => (cur === v.publicId ? null : cur));
      invalidate();
      // A delete takes that artifact's tags out of the vocabulary counts, so the suggestions have
      // to be refreshed too - otherwise deleting the last artifact carrying a label keeps offering
      // it for up to the staleTime.
      void qc.invalidateQueries({ queryKey: ['publish-tag-vocabulary'] });
      const stillOwnsFocus =
        settingsId === v.publicId ||
        v.focusOwner === document.activeElement ||
        v.focusCard?.contains(document.activeElement);
      if (v.settingsSession === settingsSession.current && stillOwnsFocus) {
        pendingFocus.current = v.focusTarget;
        setFocusTick(t => t + 1);
      }
    },
    // A failed delete moves nothing: the dialog stays open and focus stays on the control used.
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

  const urlFor = (a: ManagedArtifact) => `${window.location.origin}${sharePath(a)}`;
  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy link');
    }
  };

  /** Open a card's dialog with its sharing panel shut, like a freshly expanded row - even when that
   *  artifact's panel was left open in the list view before switching to the grid. */
  const openSettings = (publicId: string) => {
    settingsSession.current += 1;
    pendingFocus.current = null;
    setManageOpen(open => (open === publicId ? null : open));
    setSettingsId(publicId);
  };
  const settingsArtifact = settingsId ? artifacts.find(a => a.publicId === settingsId) : undefined;
  // The artifact can leave the list while its dialog is open (a visibility change under an active
  // visibility filter). Forget the id then, or clearing the filter later would reopen the dialog.
  // The sharing panel goes with it, as on any other close.
  if (settingsId && !settingsArtifact) {
    setManageOpen(open => (open === settingsId ? null : open));
    setSettingsId(null);
  }
  const closeSettings = () => {
    pendingFocus.current = null;
    // Same rule as collapsing a row: a sharing panel never outlives the surface that hosts it.
    setManageOpen(open => (open === settingsId ? null : open));
    setSettingsId(null);
  };

  const dialogOpen = Boolean(settingsArtifact);
  useEffect(() => {
    const target = pendingFocus.current;
    // The settings dialog's focus trap hands focus back to its opener when it unmounts, and that
    // opener is the card being deleted. The dialog closes in the same commit as this request, and
    // unmount effects run before mount effects, so moving focus from here lands after that restore
    // instead of losing to it (focusing straight from onSuccess does lose). The dialogOpen check
    // holds the move back should the two ever land in separate commits.
    if (!target || dialogOpen) return;
    pendingFocus.current = null;
    const item = target.kind === 'item' ? titleLinks.current.get(target.publicId) : undefined;
    // The search box still exists at this moment even when emptying the library is about to remove
    // it, so the heading target skips it rather than focus something that is about to unmount.
    const search = target.kind === 'heading' ? null : searchRef.current;
    (item ?? search ?? headingRef.current)?.focus();
  }, [focusTick, dialogOpen]);

  /** The one settings panel, shared by the list row (inline, when expanded) and the grid card
   *  (in a dialog), wired to this tab's mutations. */
  const settingsFor = (a: ManagedArtifact, url: string) => (
    <PublishedArtifactSettings
      artifact={a}
      url={url}
      tagVocabulary={tagVocabulary.map(t => t.tag)}
      busy={busy}
      exporting={exporting}
      refreshing={refreshMut.isPending && refreshMut.variables?.publicId === a.publicId}
      sharingOpen={manageOpen === a.publicId}
      onToggleSharing={() => setManageOpen(cur => (cur === a.publicId ? null : a.publicId))}
      onGateChange={gate => void onGateChange(a.publicId, gate)}
      onTagsChange={tags => tagsMut.mutate({ publicId: a.publicId, tags })}
      onVisibilityChange={visibility => visibilityMut.mutate({ publicId: a.publicId, visibility })}
      onCommentsChange={on => commentsMut.mutate({ publicId: a.publicId, on })}
      onExport={(format, action) => void runExport(a, format, action)}
      onPrint={() => void runPrint(a)}
      onRefresh={() => refreshMut.mutate(a)}
      onRestore={() => restoreMut.mutate(a.publicId)}
      onDelete={() =>
        deleteMut.mutate({
          publicId: a.publicId,
          wasLastOnPage: artifacts.length <= 1,
          settingsSession: settingsSession.current,
          focusOwner: document.activeElement,
          focusCard: titleLinks.current.get(a.publicId)?.closest('li') ?? null,
          // The whole library goes with this one only when nothing is filtering it, which is also
          // when the toolbar (and its search box) stops rendering.
          focusTarget: focusTargetAfterDelete(artifacts, a.publicId, total <= 1 && !filtering),
        })
      }
    />
  );

  if (isLoading) return <LinearProgress data-testid="published-artifacts-loading" />;
  if (isError) {
    return (
      <Typography color="danger" data-testid="published-artifacts-error">
        Failed to load your Live Artifacts.
      </Typography>
    );
  }

  // The active tag is merged in when the facet response does not carry it: the counts are capped at
  // the top 24, but a row chip can select ANY tag the artifact has - and without this there is no
  // per-facet control to turn that selection back off, only the global Clear.
  // hasOwn, not `=== undefined`: facets.tag is a plain object built by reduce, so a tag named
  // `constructor` is never undefined there and the merge would be skipped - and Object.entries would
  // not list it either, leaving that selection with no chip.
  const tagFacets = Object.entries(
    filters.tag && !Object.hasOwn(facets.tag, filters.tag) ? { [filters.tag]: 0, ...facets.tag } : facets.tag
  );
  const kindFacets = Object.entries(facets.kind);
  const visibilityFacets = Object.entries(facets.visibility);
  const gateFacets = (['passphrase', 'domain'] as const).filter(gate => facets.gate[gate]);

  return (
    <Box data-testid="published-artifacts-tab">
      {/* Focusable only from code (tabIndex -1): the landing spot after the last artifact is deleted. */}
      <Typography
        ref={headingRef}
        level="title-md"
        tabIndex={-1}
        data-testid="published-artifacts-heading"
        sx={{ mb: 0.5, '&:focus': { outline: 'none' } }}
      >
        Live Artifacts
      </Typography>
      <Typography level="body-sm" textColor="text.secondary" sx={{ mb: 2 }}>
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
              slotProps={{ input: { ref: searchRef, 'data-testid': 'published-artifacts-search' } }}
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
            <ToggleButtonGroup
              size="sm"
              value={view}
              // Clicking the pressed button reports null: ignore it, one view is always on.
              onChange={(_e, next) => next && setView(next)}
              aria-label="Layout"
              data-testid="published-artifacts-view"
            >
              <Button
                value="list"
                startDecorator={<ViewListIcon sx={{ fontSize: 16 }} />}
                data-testid="published-artifacts-view-list"
              >
                List
              </Button>
              <Button
                value="grid"
                startDecorator={<GridViewIcon sx={{ fontSize: 16 }} />}
                data-testid="published-artifacts-view-grid"
              >
                Grid
              </Button>
            </ToggleButtonGroup>
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

          {/* Facet chips, grouped under small labels. Counts come from the whole library, not the
              filtered page, so a chip still tells you how many there are after you have clicked it. */}
          <Box sx={{ display: 'flex', columnGap: 2, rowGap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
            {tagFacets.length > 0 && (
              <FacetGroup id="tags" label="Tags">
                {tagFacets.map(([tag, n]) => (
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
              </FacetGroup>
            )}
            {kindFacets.length > 0 && (
              <FacetGroup id="type" label="Type">
                {kindFacets.map(([kind, n]) => (
                  <Chip
                    key={kind}
                    size="sm"
                    variant={filters.kind === kind ? 'solid' : 'outlined'}
                    color={filters.kind === kind ? 'primary' : 'neutral'}
                    onClick={() => toggleFilter('kind', kind)}
                    slotProps={{ action: { 'data-testid': `published-artifacts-facet-kind-${kind}` } }}
                  >
                    {sourceKindLabel(kind)} {n}
                  </Chip>
                ))}
              </FacetGroup>
            )}
            {/* Visibility and gate are separate filters on the server but one question to the
                reader - who can open it - so they share a group and the badge's icons. */}
            {(visibilityFacets.length > 0 || gateFacets.length > 0) && (
              <FacetGroup id="access" label="Access">
                {visibilityFacets.map(([vis, n]) => {
                  const meta = isPublishAccess(vis) ? PUBLISH_ACCESS_META[vis] : undefined;
                  return (
                    <Chip
                      key={vis}
                      size="sm"
                      variant={filters.visibility === vis ? 'solid' : 'outlined'}
                      color={filters.visibility === vis ? 'primary' : 'neutral'}
                      startDecorator={meta && <meta.Icon sx={{ fontSize: 12 }} />}
                      onClick={() => toggleFilter('visibility', vis)}
                      slotProps={{
                        action: {
                          'data-testid': `published-artifacts-facet-visibility-${vis}`,
                          // The badge calls only ungated links "Public"; this filter counts every
                          // public page, gated or not.
                          title:
                            vis === 'public' ? 'Every public link, including passphrase and domain gated' : undefined,
                        },
                      }}
                    >
                      {meta?.label ?? vis} {n}
                    </Chip>
                  );
                })}
                {gateFacets.map(gate => {
                  const { label, Icon } = PUBLISH_ACCESS_META[gate];
                  return (
                    <Chip
                      key={gate}
                      size="sm"
                      variant={filters.gate === gate ? 'solid' : 'outlined'}
                      color={filters.gate === gate ? 'primary' : 'neutral'}
                      startDecorator={<Icon sx={{ fontSize: 12 }} />}
                      onClick={() => toggleFilter('gate', gate)}
                      slotProps={{ action: { 'data-testid': `published-artifacts-facet-gate-${gate}` } }}
                    >
                      {label} {facets.gate[gate]}
                    </Chip>
                  );
                })}
              </FacetGroup>
            )}
            {facets.comments > 0 && (
              <FacetGroup id="comments" label="Comments">
                <Chip
                  size="sm"
                  variant={filters.comments === 'on' ? 'solid' : 'outlined'}
                  color={filters.comments === 'on' ? 'primary' : 'neutral'}
                  onClick={() => toggleFilter('comments', 'on')}
                  slotProps={{ action: { 'data-testid': 'published-artifacts-facet-comments' } }}
                >
                  On {facets.comments}
                </Chip>
              </FacetGroup>
            )}
          </Box>
        </Box>
      )}

      {artifacts.length === 0 ? (
        filtering || total > 0 ? (
          <Typography level="body-sm" textColor="text.secondary" data-testid="published-artifacts-no-matches">
            {filtering
              ? 'Nothing matches those filters. Clear them to see your whole library.'
              : 'This page is empty - returning you to the last page that has results.'}
          </Typography>
        ) : (
          <Typography level="body-sm" textColor="text.secondary" data-testid="published-artifacts-empty">
            You haven&apos;t published anything yet. Share an artifact or run the publish-to-bike4mind skill to get
            started.
          </Typography>
        )
      ) : view === 'grid' ? (
        <Box
          component="ul"
          // Explicit: Safari drops the implicit list role from a list with `list-style: none`.
          role="list"
          data-testid="published-artifacts-grid"
          sx={{
            display: 'grid',
            // min() lets one column shrink below 260px when the tab itself is narrower (a phone, after
            // the page padding), instead of overflowing sideways.
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))',
            gap: 2,
            listStyle: 'none',
            m: 0,
            p: 0,
          }}
        >
          {artifacts.map(a => {
            const url = urlFor(a);
            return (
              <PublishedArtifactCard
                key={a.publicId}
                artifact={a}
                url={url}
                onCopyLink={() => void copyLink(url)}
                onOpenSettings={() => openSettings(a.publicId)}
                titleRef={titleRef(a.publicId)}
              />
            );
          })}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, containerType: 'inline-size' }}>
          {/* Column headers, wide lists only: below that the metadata wraps under each title and a
              header row would label columns that are not there. Borders mirror the row Sheet's so
              the two share the same inner edges. */}
          <Box
            aria-hidden
            data-testid="published-artifacts-columns"
            sx={{
              display: 'none',
              [WIDE]: { display: 'grid' },
              gridTemplateColumns: ROW_COLUMNS,
              columnGap: 1,
              px: 1,
              border: '1px solid transparent',
              fontFamily: 'body',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontSize: 10,
              fontWeight: 600,
              color: 'text.tertiary',
            }}
          >
            <Box sx={{ gridColumn: '2' }}>Title</Box>
            <Box sx={{ gridColumn: '3' }}>Access</Box>
            <Box sx={{ gridColumn: '4', textAlign: 'right' }}>Versions</Box>
            <Box sx={{ gridColumn: '5', textAlign: 'right' }}>Views</Box>
            {/* The cell is publishedAt (the last publish), not updatedAt: "Updated" would claim the
                order of the Recently updated sort, which also moves on a rename or tag edit. */}
            <Box sx={{ gridColumn: '6', textAlign: 'right' }}>Published</Box>
          </Box>
          {artifacts.map(a => {
            const url = urlFor(a);
            const isBundle = a.source.kind === 'bundle';
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
                <Box sx={ROW_GRID_SX}>
                  {/* The rendered thumbnail when the artifact has one, else a generated cover: both are
                      stable per artifact, so the eye can find a row it has seen before. */}
                  <Box sx={{ gridArea: 'cover', display: 'flex' }}>
                    <ArtifactThumbnail
                      publicId={a.publicId}
                      title={a.title}
                      thumbnailUrl={a.thumbnailUrl}
                      size={26}
                      data-testid={`published-artifact-cover-${a.publicId}`}
                    />
                  </Box>

                  <Box sx={{ gridArea: 'title', display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <Tooltip title="Opens in a new tab" describeChild>
                      <Link
                        ref={titleRef(a.publicId)}
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

                    {commentsOn && (
                      <Tooltip title="Comments are on">
                        <ChatBubbleOutlineIcon sx={{ fontSize: 14, opacity: 0.7, flex: 'none' }} />
                      </Tooltip>
                    )}
                  </Box>

                  {/* Metadata cells. On a wide list this wrapper disappears (display: contents) and the
                      cells sit on the row grid, one fixed column each; on a narrow one it is a
                      wrapping line under the title. */}
                  <Box
                    sx={{
                      gridArea: 'meta',
                      display: 'flex',
                      [WIDE]: { display: 'contents' },
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      columnGap: 1.5,
                      rowGap: 0.25,
                      minWidth: 0,
                    }}
                    data-testid={`published-artifact-meta-${a.publicId}`}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, [WIDE]: { gridArea: 'access' } }}>
                      <PublishAccessBadge
                        visibility={a.visibility}
                        gateKind={a.gateKind}
                        data-testid={`published-artifact-access-${a.publicId}`}
                      />
                    </Box>

                    <Box sx={numericCell('versions')}>
                      {isBundle &&
                        ((a.versionsCount ?? 0) >= 2 ? (
                          <Chip
                            size="sm"
                            variant="soft"
                            color="primary"
                            data-testid={`published-artifact-versions-${a.publicId}`}
                          >
                            {a.versionsCount} versions
                          </Chip>
                        ) : (
                          <Typography
                            level="body-xs"
                            textColor="text.tertiary"
                            data-testid={`published-artifact-versions-${a.publicId}`}
                          >
                            1 version
                          </Typography>
                        ))}
                    </Box>

                    <Box sx={numericCell('views')}>
                      <Typography
                        level="body-xs"
                        textColor="text.secondary"
                        startDecorator={<VisibilityIcon sx={{ fontSize: 13 }} />}
                        title={`${a.viewCount ?? 0} views`}
                        data-testid={`published-artifact-views-${a.publicId}`}
                      >
                        {formatViews(a.viewCount ?? 0)}
                      </Typography>
                    </Box>

                    <Box sx={numericCell('date')}>
                      <Typography
                        level="body-xs"
                        textColor="text.tertiary"
                        data-testid={`published-artifact-date-${a.publicId}`}
                      >
                        {shortDate(a.publishedAt)}
                      </Typography>
                    </Box>
                  </Box>

                  <Box
                    sx={{
                      gridArea: 'actions',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      gap: 0.5,
                    }}
                  >
                    <Tooltip title="Copy link">
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => void copyLink(url)}
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

                {isOpen && settingsFor(a, url)}
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
          <Typography level="body-xs" textColor="text.tertiary">
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

      {/* Grid cards have no room for the controls, so More opens the same panel the list row
          expands inline - in a dialog. */}
      {settingsArtifact && (
        <Modal open onClose={closeSettings}>
          <ModalDialog
            layout="center"
            aria-labelledby={`published-artifact-settings-title-${settingsArtifact.publicId}`}
            data-testid="published-artifact-settings-modal"
            sx={{ width: 'min(720px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 64px)', overflow: 'auto' }}
          >
            <ModalClose data-testid="published-artifact-settings-close" />
            <Typography
              id={`published-artifact-settings-title-${settingsArtifact.publicId}`}
              level="title-md"
              // A title with no spaces (a pasted URL) wraps instead of pushing the dialog sideways.
              sx={{ pr: 4, overflowWrap: 'anywhere' }}
            >
              {settingsArtifact.title}
            </Typography>
            {settingsFor(settingsArtifact, urlFor(settingsArtifact))}
          </ModalDialog>
        </Modal>
      )}
    </Box>
  );
}
