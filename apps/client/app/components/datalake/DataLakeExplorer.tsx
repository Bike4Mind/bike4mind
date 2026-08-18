import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalDialog,
  Typography,
  useTheme,
} from '@mui/joy';
import { alpha } from '@mui/system';
import AddIcon from '@mui/icons-material/Add';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { SurfaceBreadcrumb } from '@client/app/components/datalake/SurfaceBreadcrumb';
import DataLakeTree from './DataLakeTree';
import DataLakeChatTree from './DataLakeChatTree';
import DataLakeArticle from './DataLakeArticle';
import { resolveEmptyVariant } from './resolveEmptyVariant';
import DataLakeRail from './DataLakeRail';
import SelectedLakeHeader from './SelectedLakeHeader';
import DataLakeRailViewer from './DataLakeRailViewer';
import { resolveManageableLake } from './resolveManageableLake';
import { DataLakeNavProvider } from './dataLakeNavContext';
import { StatTicker, inkFor, surfaceBackground } from '@client/app/components/datalake/surfaceChrome';
import { humanizeSegment, useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { ManageKnowledgeButton } from '@client/app/components/datalake/manageKnowledge';
import { useSessions, useWorkBenchActions, useWorkBenchFiles } from '@client/app/contexts/SessionsContext';
import useSetDataLakeMode from '@client/app/hooks/useSetDataLakeMode';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import type { DefaultLayoutType } from '@client/app/hooks/useSessionLayout';
import { useNotebookLayout } from '@client/app/components/layouts/Notebook';
import {
  useGetDataLakeArticles,
  useGetDataLakes,
  useGetDataLakeTagCounts,
  useRemoveFileFromDataLake,
} from '@client/app/hooks/data/dataLakes';
import type { DataLakeBrowseSource } from '@client/app/hooks/data/dataLakes';
import {
  buildTagTree,
  getNodeAtPath,
  getNodesAtPath,
} from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeIngestPickerModal from '@client/app/components/DataLakeWizard/DataLakeIngestPickerModal';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { readDroppedItems } from '@client/app/utils/dropReader';
import { DATA_LAKES } from '@client/app/components/datalake/dataLakeBranding';
import { toast } from 'sonner';
import FieldTooltip from '@client/app/components/help/FieldTooltip';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';
import type { IFabFileDocument, ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * Data Lake browser with two host arrangements, chosen by whether a `chatSlot` is supplied:
 *
 * - PAGE mode (no chatSlot): the standalone /data-lakes surface - a header row (breadcrumb,
 *   create/manage/discover, stat ticker) over the brand-agnostic DataLakeTree and an inline
 *   DataLakeArticle reader. Themed via the DataLakeSurface tokens.
 * - CHAT mode (chatSlot set): the in-chat Data Lake surface (main app + premium /opti) - the
 *   DataLakeChatTree rail beside the chat; file rows carry explicit actions (attach to chat,
 *   view in the rail reader, remove from lake) - browsing never mutates the chat. Exposes the
 *   tree's richest branches + navigate to the chatSlot via DataLakeNavProvider so a host idle
 *   pane (e.g. the sonar) can drive the tree.
 */
interface DataLakeExplorerProps {
  /** Root breadcrumb crumb handler (page mode). */
  onBack?: () => void;
  /** "Ask about this file" handler for the inline article reader (page mode). */
  onAskAbout?: (prompt: string) => void;
  /** When set (from URL param), auto-select and display this article on mount. */
  articleId?: string | null;
  /** Which browse backend to read. Only the react-query cache key differs; a branded
   *  surface passes its own value to keep its cache separate from the standalone home. */
  source?: DataLakeBrowseSource;
  /** Overrides the root breadcrumb crumb / tree header title; defaults to the surface token. */
  rootLabel?: string;
  /** Opens the lake management panel (page header button + chat tree footer "Manage"). */
  onManage?: () => void;
  /** Page mode: renders a "Discover" button that opens the public-lake browse catalog. */
  onDiscover?: () => void;
  /** Page mode: renders a "Create" affordance (header button + zero-state CTA). */
  onCreate?: () => void;
  /** Chat mode: opens the Create Lake wizard from the tree footer "Create". */
  onCreateLake?: () => void;
  /**
   * Fills the pane right of the tree and switches this component into CHAT mode. Two host
   * arrangements exist:
   * - Main app (DataLakeChatSurface): the chat's SessionContainer, declared via `chatEmbedded`.
   * - Premium overlay: the page's own (non-chat) content, with the chat DOCKED as a sibling
   *   outside this component.
   */
  chatSlot?: React.ReactNode;
  /**
   * True when `chatSlot` holds the chat's SessionContainer (main app): the View action opens the
   * file in the KnowledgeViewer split (layout `vertical`), and tree navigation closes that split.
   * When omitted (overlay), the chat lives OUTSIDE this component (docked), so the global layout
   * must never be touched - switching it would collapse the docked chat into a 0x0 branch - and
   * View falls back to the in-rail reader.
   */
  chatEmbedded?: boolean;
  /**
   * Called when a file is ATTACHED with no active session (/new, where creation is deferred to
   * the first message): must create + adopt the session and resolve its id so the file can land
   * in a real workbench. Omitted (overlay) -> a guidance toast instead. View never needs this -
   * previewing a file must not mint a session.
   *
   * Receives the file so the session can be created ALREADY HOLDING it (knowledgeIds): adoption
   * rehydrates the workbench from the session's knowledgeIds, so a file merely written into the
   * store after creation is wiped by that reset on hosts with a longer adoption path.
   */
  createSessionForFile?: (file: IFabFileDocument) => Promise<string>;
  /**
   * Whether the chat tree header shows the close (X) that turns Data Lake mode off. Default true.
   * Hosts entered/left by navigation rather than a per-session toggle pass false.
   */
  showModeClose?: boolean;
}

/** True only for drags carrying real files (not text/image-from-page drags). */
const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes('Files');

/** Stable identity so a Set-typed prop doesn't churn every render when nothing is selected. */
const EMPTY_FILE_IDS: ReadonlySet<string> = new Set();

export default function DataLakeExplorer({
  onBack,
  onAskAbout,
  articleId,
  source = 'datalakes',
  rootLabel,
  onManage,
  onDiscover,
  onCreate,
  onCreateLake,
  chatSlot,
  chatEmbedded = false,
  createSessionForFile,
  showModeClose = true,
}: DataLakeExplorerProps) {
  // The presence of a chatSlot is the mode discriminator: with it, the surface is a tree rail
  // beside a chat; without it, the standalone browse-and-read page.
  const chatMode = chatSlot != null;
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const { theme, copy, taxonomy } = useDataLakeSurface();
  const acceptedHint = copy.dropAcceptedHint;
  const accentInk = inkFor(theme.accent, isDark);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  /** Page-mode lake scope; null is the explicit all-lakes view. Chat mode never sets it. */
  const [selectedLakeId, setSelectedLakeId] = useState<string | null>(null);
  // Page mode: file shown in the inline article reader.
  const [userSelectedFile, setUserSelectedFile] = useState<IFabFileDocument | null>(null);
  // External-chat hosts only: our own KnowledgeViewer is open beside the tree (View action).
  const [railViewerOpen, setRailViewerOpen] = useState(false);
  // Ref twin of railViewerOpen for the layout subscription below (a store listener would
  // otherwise close over a stale render's value).
  const railViewerOpenRef = useRef(false);
  // The layout the external host was running when the rail viewer opened, restored when the
  // viewer's Close writes `hide` (leaving `hide` in place would collapse the docked chat).
  const hostLayoutRef = useRef<DefaultLayoutType | null>(null);
  // Chat mode: pending remove-from-lake confirmation.
  const [deleteTarget, setDeleteTarget] = useState<{ file: IFabFileDocument; lake: ManageableDataLakeConfig } | null>(
    null
  );

  // Chat-mode wiring: attach files to the current session's workbench (#836). The hooks are
  // always called (React rules); page mode simply never invokes attachFileToChat.
  const { currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();
  // Files currently attached to the chat's prompt - drives the tree's persistent highlight in
  // chat mode, so a file stays marked "already added" regardless of which action attached it
  // (View or the menu's Attach) or how far the user has since navigated the tree (#1693).
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const attachedFileIds = useMemo(() => new Set(workBenchFiles.map(f => f.id)), [workBenchFiles]);
  const setDataLakeMode = useSetDataLakeMode();
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  // When the sidenav is collapsed its floating expand control overlaps the top-left, so the
  // chat tree needs extra left clearance past it (same 48px the deck top bar uses).
  const sidenavOpen = useNotebookLayout(s => s.openSideNav);
  // Guards double-clicks while createSessionForFile's POST is in flight - a second click
  // would otherwise mint a second session.
  const creatingSessionRef = useRef(false);
  // The session the attach action needs. On /new creation is deferred to the first message, so
  // hosts that can mint the grounded session do it here; the rest get guidance. Returns null
  // when there is no session to be had (already explained to the user), so callers just bail.
  const ensureSessionId = useCallback(
    async (file: IFabFileDocument): Promise<string | null> => {
      if (currentSessionId) return currentSessionId;
      if (!createSessionForFile || creatingSessionRef.current) {
        if (!createSessionForFile) {
          toast.info('Start the chat with a first message - then lake files can be added to it.');
        }
        return null;
      }
      creatingSessionRef.current = true;
      try {
        return await createSessionForFile(file);
      } catch (error) {
        console.error('Data Lake session create failed:', error);
        toast.error("Couldn't start the chat - please try again.");
        return null;
      } finally {
        creatingSessionRef.current = false;
      }
    },
    [currentSessionId, createSessionForFile]
  );

  // Returns whether the file was newly added (false = already in the workbench), so callers
  // can toast only on an actual attachment. The zustand updater runs synchronously.
  const addToWorkBench = useCallback(
    (sessionId: string, file: IFabFileDocument) => {
      let added = false;
      setWorkBenchFiles(sessionId, prev => {
        if (prev.some(f => f.id === file.id)) return prev;
        added = true;
        return [...prev, file];
      });
      return added;
    },
    [setWorkBenchFiles]
  );

  // Explicit [+] action. Comment at the hooks above (#836) still applies: hooks always run,
  // page mode never calls this.
  const attachFileToChat = useCallback(
    async (file: IFabFileDocument) => {
      const sessionId = await ensureSessionId(file);
      if (!sessionId) return;
      addToWorkBench(sessionId, file);
      toast.success(`Added "${file.fileName.replace(/\.[^/.]+$/, '')}" to the chat's files`);
    },
    [ensureSessionId, addToWorkBench]
  );

  // View opens the file in the KnowledgeViewer on both hosts - and ONLY that. It must not
  // mutate the chat: no workbench attach (the explicit [+] action does that) and no session
  // mint. The viewer shows the file through the transient `previewFile` slot (see
  // useSessionLayout), which also serves ?article= deep links, where there is no click.
  //
  // How the viewer gets on screen differs, and only by necessity: with the chat embedded, the
  // chat's own SessionContainer renders it once the layout is `vertical`. External-chat hosts
  // dock the chat, a mode in which SessionContainer renders NO viewer and whose layout must not
  // be touched - the host renders its chat 0x0 in any non-docked layout, and nothing on that
  // surface restores it. So we set the selected artifact WITHOUT touching `layout` and mount
  // the viewer in our own rail (with its layout-switching controls hidden, for the same reason).
  const handleViewFile = useCallback(
    (file: IFabFileDocument) => {
      if (chatEmbedded) {
        setSessionLayout({ layout: 'vertical', previewFile: file, selectedArtifactId: file.id });
      } else {
        hostLayoutRef.current = useSessionLayout.getState().layout;
        setSessionLayout({ previewFile: file, selectedArtifactId: file.id });
        railViewerOpenRef.current = true;
        setRailViewerOpen(true);
      }
    },
    [chatEmbedded, setRailViewerOpen]
  );

  // Enabled on BOTH surfaces now. Chat mode needs it to gate row deletes; page mode needs it to
  // answer "do I have any lakes?" - a question the page could not previously ask, which is why its
  // empty state answered it from the file scope instead and got it wrong (#1645).
  const { data: lakes, isLoading: lakesLoading, isError: lakesError, refetch: refetchLakes } = useGetDataLakes();
  const removeFile = useRemoveFileFromDataLake(deleteTarget?.lake.id ?? null);
  const canDeleteFile = useCallback((file: IFabFileDocument) => resolveManageableLake(file, lakes) != null, [lakes]);
  const handleDeleteFile = useCallback(
    (file: IFabFileDocument) => {
      const lake = resolveManageableLake(file, lakes);
      if (lake) setDeleteTarget({ file, lake });
    },
    [lakes, setDeleteTarget]
  );

  // Drag-to-ingest: an overlay invites dropping files/folders, which then open a lake
  // picker that hands off to the append wizard. A counter ref avoids flicker as drag
  // events bubble across child nodes.
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isFileDrag(e)) e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      // Prefer the items API (traverses folders); fall back to the flat files list for any
      // browser without it - mirrors the wizard's SourceSelectionStep handler.
      const files = e.dataTransfer.items?.length
        ? await readDroppedItems(e.dataTransfer.items)
        : Array.from(e.dataTransfer.files);
      if (files.length === 0) {
        toast.error('No files found in that drop.');
        return;
      }
      toast.success(`${files.length} ${files.length === 1 ? 'file' : 'files'} ${acceptedHint}`);
      setDroppedFiles(files);
    },
    [acceptedHint, setDroppedFiles]
  );

  // Phase 1: Lightweight counts for the tree (server-side aggregation, ~50 entries)
  const { data: tagCountsData, isLoading: tagCountsLoading, isError: tagCountsError } = useGetDataLakeTagCounts(source);

  const selectedLake = useMemo(
    () => (selectedLakeId ? (lakes?.find(l => l.id === selectedLakeId) ?? null) : null),
    [lakes, selectedLakeId]
  );

  // Lake scoping is a client-side filter on the SAME tag-counts payload the unscoped tree uses -
  // every taxonomy tag in a lake is namespaced under its fileTagPrefix, so no extra request is
  // needed and switching lakes costs nothing.
  const scopedTagCounts = useMemo(() => {
    const all = tagCountsData?.tagCounts ?? [];
    if (!selectedLake) return all;
    return all.filter(tc => tc.tag.startsWith(selectedLake.fileTagPrefix));
  }, [tagCountsData, selectedLake]);
  const tree = useMemo(() => buildTagTree(scopedTagCounts), [scopedTagCounts]);

  // Derive the current leaf tag from breadcrumb + tree state. A branch node (has children) can
  // ALSO carry files tagged with its own exact path, which DataLakeTreeView renders mixed into
  // the folder list - so this must fetch whenever there's anything to show at this breadcrumb,
  // not only at a true leaf, or those own-tagged files never even reach the tree.
  const currentNodes = useMemo(() => getNodesAtPath(tree, breadcrumb), [tree, breadcrumb]);
  const currentNode = useMemo(() => getNodeAtPath(tree, breadcrumb), [tree, breadcrumb]);
  const leafTag =
    breadcrumb.length > 0 && (currentNodes.length === 0 || (currentNode?.ownFileCount ?? 0) > 0)
      ? breadcrumb.join(':')
      : null;

  // Phase 2: Fetch articles only when there's a tag at this breadcrumb to filter by (paginated)
  const { data: leafArticlesResult, isLoading: leafLoading } = useGetDataLakeArticles(
    leafTag ? { tags: [leafTag], limit: 50 } : null,
    source
  );
  const leafArticles = leafTag ? (leafArticlesResult?.data ?? []) : [];
  // isLoading passed to the tree below only waits on leafLoading at a true leaf
  // (currentNodes.length === 0): a branch node's subfolder list needs no fetch at all, so
  // blocking it on the own-tagged-files fetch would blank an already-renderable folder list
  // behind a skeleton every time a mixed node is opened.

  // Deep-link: fetch the specific article by ID when the URL param is present. Page mode shows
  // it in the inline reader; chat mode shows it in the rail reader (effect below).
  const { data: deepLinkResult } = useGetDataLakeArticles(
    articleId && !userSelectedFile ? { id: articleId, limit: 1 } : null,
    source
  );
  const deepLinkTarget = deepLinkResult?.data?.[0] ?? null;

  // Page mode: user's explicit click takes priority, then the deep-link result. Pure derivation.
  const selectedFile = userSelectedFile ?? (articleId ? deepLinkTarget : null);
  const pageSelectedFileIds = useMemo(
    () => (selectedFile ? new Set([selectedFile.id]) : EMPTY_FILE_IDS),
    [selectedFile]
  );

  // Chat mode: track global layout changes so the rail viewer follows the viewer actually on
  // screen. Only relevant to external-chat hosts - railViewerOpenRef is set only from the
  // non-embedded branch of handleViewFile below, so an embedded host's layout changes always
  // take the early return here and this effect is a no-op for that host.
  //
  // The host's layout must never change while our rail viewer is up, so ANY departure closes it.
  // The viewer's own Close writes `hide` - the one write that means "close me" rather than a
  // host-driven layout change - and `hide` would collapse the docked chat, so it is answered by
  // restoring the layout captured when the viewer opened. Any other write is the host
  // rearranging itself: close the viewer and let the new value stand.
  useEffect(() => {
    if (!chatMode) return;
    return useSessionLayout.subscribe((state, prev) => {
      if (state.layout === prev.layout) return;
      if (!railViewerOpenRef.current) return;
      railViewerOpenRef.current = false;
      setRailViewerOpen(false);
      const hostLayout = hostLayoutRef.current;
      if (state.layout === 'hide' && hostLayout && hostLayout !== 'hide') {
        setSessionLayout({ layout: hostLayout });
      }
    });
  }, [chatMode]);

  const openedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (chatMode && deepLinkTarget && openedDeepLinkRef.current !== deepLinkTarget.id) {
      openedDeepLinkRef.current = deepLinkTarget.id;
      handleViewFile(deepLinkTarget);
    }
  }, [chatMode, deepLinkTarget, handleViewFile]);

  // Chat mode deliberately leaves the open file alone: the tree and the viewer are separate panels,
  // so browsing categories - including back out of one - must not dismiss what you are reading. The
  // viewer closes on its own Close button (see the layout subscription above). The highlight also
  // stays, so returning to the file's category still shows which one is open.
  const handleNavigate = useCallback(
    (newBreadcrumb: string[]) => {
      setBreadcrumb(newBreadcrumb);
      if (!chatMode) setUserSelectedFile(null);
    },
    [chatMode, setBreadcrumb, setUserSelectedFile]
  );

  // Page mode only: the chat tree's rows carry explicit actions instead of a click handler.
  const handleSelectFile = useCallback((file: IFabFileDocument) => setUserSelectedFile(file), []);

  // Truthful distinct-file count (the tree's fileCounts are tag-occurrence sums, which
  // overcount multi-tagged articles ~2x); branch count stays tree-derived. Follows the lake scope
  // so the ticker describes what is actually on screen.
  const totalArticles = selectedLake
    ? (tagCountsData?.uniqueArticleCounts?.byPrefix?.[selectedLake.fileTagPrefix] ?? 0)
    : (tagCountsData?.uniqueArticleCounts?.total ?? 0);
  const branchCount = useMemo(() => tree.reduce((sum, node) => sum + Math.max(node.children.length, 1), 0), [tree]);

  /** Nothing to browse in the CURRENT scope. Says nothing about how many lakes exist. */
  const isScopeEmpty = !tagCountsLoading && !tagCountsError && totalArticles === 0 && tree.length === 0;

  // Precedence lives in resolveEmptyVariant (pure + unit-tested) rather than inline here, because
  // the ORDER of its checks is the whole fix - see that module's contract.
  const emptyVariant = resolveEmptyVariant({
    chatMode,
    lakesError,
    lakesLoading,
    lakeCount: lakes?.length ?? 0,
    manageableLakeCount: lakes?.filter(l => l.canManage).length ?? 0,
    hasSelectedLake: !!selectedLake,
    isScopeEmpty,
  });

  const addFilesToSelectedLake = useCallback(() => {
    if (!selectedLake) return;
    openWizardForLake({
      id: selectedLake.id,
      slug: selectedLake.slug,
      name: selectedLake.name,
      fileTagPrefix: selectedLake.fileTagPrefix,
      requiredUserTag: selectedLake.requiredUserTag,
      requiredEntitlement: selectedLake.requiredEntitlement,
    });
  }, [selectedLake, openWizardForLake]);

  // Switching lake scope invalidates the breadcrumb: it names a path in the OUTGOING lake's tree,
  // so keeping it would leave the new lake showing an empty node (and the stale leafTag would
  // fetch the old lake's files).
  const handleSelectLake = useCallback((lakeId: string | null) => {
    setSelectedLakeId(lakeId);
    setBreadcrumb([]);
    setUserSelectedFile(null);
  }, []);

  // Richest second-level branches (top 6): the page empty-state's quick dives AND, in chat mode,
  // exposed to a host idle pane via context so its quick-dive chips can drive the tree.
  const quickDives = useMemo(
    () =>
      tree
        .flatMap(prefix =>
          prefix.children.map(child => ({
            path: [prefix.segment, child.segment],
            segment: child.segment,
            count: child.fileCount,
          }))
        )
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
    [tree]
  );

  const nav = useMemo(() => ({ navigate: handleNavigate, quickDives }), [handleNavigate, quickDives]);

  return (
    <Box
      data-testid={chatMode ? 'opti-datalake-explorer' : 'datalake-explorer'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        ...(chatMode ? {} : { background: surfaceBackground(isDark, theme.accent, theme.secondary) }),
      }}
    >
      {isDragging && (
        <Box
          data-testid={chatMode ? 'opti-datalake-dropzone' : 'datalake-dropzone'}
          sx={{
            position: 'absolute',
            inset: 12,
            zIndex: 10,
            borderRadius: 'lg',
            border: '2px dashed',
            borderColor: 'primary.400',
            backgroundColor: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            pointerEvents: 'none',
          }}
        >
          <CloudUploadIcon sx={{ fontSize: 56, color: 'primary.300' }} />
          <Typography level="h4" sx={{ color: 'common.white' }}>
            {chatMode ? 'Drop to add to a data lake' : copy.dropTitle}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'rgba(255,255,255,0.7)' }}>
            {chatMode ? "Files or folders — you'll pick the destination next" : copy.dropHint}
          </Typography>
        </Box>
      )}

      {/* Page-mode header row: breadcrumb, actions, stat ticker. Chat mode carries these on the
          tree's own header/footer instead. */}
      {!chatMode && (
        <Box sx={{ px: 3, pt: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <SurfaceBreadcrumb
            segments={[{ label: rootLabel ?? copy.rootLabel, onClick: onBack }, { label: copy.explorerTitle }]}
          />
          {/* mb:2 matches the breadcrumb's own mb so this icon's center lines up with the
              breadcrumb text in the center-aligned header row (breadcrumb carries mb:2). */}
          <FieldTooltip
            content={FIELD_TOOLTIPS.dataLake}
            placement="bottom"
            ariaLabel={`Help: ${DATA_LAKES}`}
            data-testid="field-tooltip-data-lake-explorer"
            sx={{ mb: 2 }}
          />
          {/* Create is the surface's primary action (solid) and leads the header row; Manage /
              Discover stay outlined-neutral so creating a lake is never buried inside Manage. */}
          {onCreate && (
            <Button
              data-testid="datalake-create-btn"
              size="sm"
              variant="solid"
              color="primary"
              startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
              onClick={onCreate}
              sx={{ mb: 2 }}
            >
              {copy.createLabel}
            </Button>
          )}
          {/* Shared manage-knowledge affordance (#841) - the handler is passed through
              because the caller's gate decided this surface offers it at all (a
              browse-only surface omits `onManage` entirely). */}
          {onManage && <ManageKnowledgeButton onManage={onManage} sx={{ mb: 2, ml: 1 }} />}
          {onDiscover && (
            <Button
              data-testid="datalake-discover-btn"
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<TravelExploreIcon sx={{ fontSize: 16 }} />}
              onClick={onDiscover}
              sx={{ mb: 2, ml: 1 }}
            >
              Discover
            </Button>
          )}
          {/* Resting drop affordance: the drag overlay only appears once a drag is already
              underway, so without this the ingest capability is invisible at rest. */}
          {!isDragging && (
            <Box
              data-testid="datalake-drop-hint"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                mb: 2,
                ml: 1,
                px: 1,
                py: 0.25,
                borderRadius: 'sm',
                border: '1px dashed',
                borderColor: alpha(accentInk, 0.45),
                color: 'text.tertiary',
              }}
            >
              <CloudUploadIcon sx={{ fontSize: 15 }} />
              <Typography level="body-xs" sx={{ color: 'inherit', whiteSpace: 'nowrap' }}>
                {copy.dropRestingHint}
              </Typography>
            </Box>
          )}
          <Box sx={{ ml: 'auto', mb: 2 }}>
            <StatTicker
              stats={[
                { label: copy.statArticlesLabel, value: String(totalArticles || '-') },
                { label: copy.statBranchesLabel, value: String(branchCount || '-') },
                {
                  label: copy.statDepthLabel,
                  value: String(breadcrumb.length),
                  // Humanized like the tree beside it - a raw segment here would disagree with
                  // the branch label whenever a taxonomy is injected. Index = depth.
                  sub:
                    breadcrumb.length === 0
                      ? copy.depthRootLabel
                      : breadcrumb.map((segment, depth) => humanizeSegment(segment, depth, taxonomy)).join(' : '),
                },
              ]}
              isDark={isDark}
            />
          </Box>
        </Box>
      )}

      {/* Zero-state gets a full-width version of the same invitation - a first-time user
          has no tree to scan, so the small header hint alone reads as chrome. Page mode
          only; chat mode's tree carries its own header affordances. */}
      {!chatMode && isScopeEmpty && emptyVariant !== 'lakes-error' && !isDragging && (
        <Box
          data-testid="datalake-drop-prompt"
          sx={{
            mx: 3,
            mt: 1,
            px: 2,
            py: 1.5,
            borderRadius: 'md',
            border: '1.5px dashed',
            borderColor: alpha(accentInk, 0.5),
            backgroundColor: alpha(accentInk, isDark ? 0.06 : 0.04),
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
          }}
        >
          <CloudUploadIcon sx={{ fontSize: 28, color: accentInk }} />
          <Box>
            <Typography level="title-sm">{copy.dropTitle}</Typography>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {copy.dropHint}
            </Typography>
          </Box>
        </Box>
      )}

      {chatMode ? (
        <Box
          className="datalake-explorer-body"
          sx={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            p: '12px',
            pl: sidenavOpen ? '12px' : '48px',
            // With the viewer in the centre pane, the host's splitter is immediately to our right.
            // Keeping the padding would leave a gap between the two, so the splitter reads as part
            // of the chat dock rather than the boundary between the viewer and the chat - which is
            // how the embedded host's splitter reads, sitting flush against both panes.
            pr: railViewerOpen ? 0 : '12px',
            gap: '8px',
            transition: 'padding-left 0.2s ease',
          }}
        >
          <DataLakeChatTree
            tree={tree}
            articles={leafArticles}
            breadcrumb={breadcrumb}
            onNavigate={handleNavigate}
            source={source}
            selectedFileIds={attachedFileIds}
            onAttachFile={attachFileToChat}
            onViewFile={handleViewFile}
            canDeleteFile={canDeleteFile}
            onDeleteFile={handleDeleteFile}
            isLoading={tagCountsLoading || (!!leafTag && leafLoading && currentNodes.length === 0)}
            isError={tagCountsError}
            title={rootLabel ?? copy.rootLabel}
            onManage={onManage}
            onCreateLake={onCreateLake}
            onClose={showModeClose ? () => setDataLakeMode(false) : undefined}
          />
          {/* The tree stays put; the viewer takes the centre pane, which on an external-chat host
              is the page's own content rather than the chat (that is docked outside). The pane is
              hidden, not unmounted, so in-progress state in that subtree survives a look at a
              file and closing the viewer brings it back as it was. */}
          {railViewerOpen && <DataLakeRailViewer />}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              height: '100%',
              display: railViewerOpen ? 'none' : 'flex',
              flexDirection: 'column',
            }}
          >
            <DataLakeNavProvider value={nav}>{chatSlot}</DataLakeNavProvider>
          </Box>
        </Box>
      ) : (
        /* Master/detail: the lake rail owns the choice of lake, and everything to its right is
           that lake's content. The rail is page-mode only - chat mode's host already spends its
           width on the chat, and adding a third column there would squeeze both. */
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <DataLakeRail
            lakes={lakes}
            isLoading={lakesLoading}
            isError={lakesError}
            onRetry={() => void refetchLakes()}
            selectedLakeId={selectedLakeId}
            onSelect={handleSelectLake}
            lakeFileCounts={tagCountsData?.lakeFileCounts}
            totalFileCount={tagCountsData?.uniqueArticleCounts?.total ?? 0}
            onCreate={onCreate}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
            {selectedLake && (
              <SelectedLakeHeader
                lake={selectedLake}
                fileCount={tagCountsData?.lakeFileCounts?.[selectedLake.datalakeTag]}
              />
            )}
            <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <DataLakeTree
                tree={tree}
                articles={leafArticles}
                breadcrumb={breadcrumb}
                onNavigate={handleNavigate}
                source={source}
                selectedFileIds={pageSelectedFileIds}
                onSelectFile={handleSelectFile}
                isLoading={tagCountsLoading || (!!leafTag && leafLoading && currentNodes.length === 0)}
                isError={tagCountsError}
              />
              <DataLakeArticle
                file={selectedFile}
                onAskAbout={onAskAbout ?? (() => {})}
                quickDives={quickDives}
                onDive={handleNavigate}
                emptyVariant={emptyVariant}
                onCreate={onCreate}
                onRetryLakes={() => void refetchLakes()}
                onAddFiles={selectedLake?.canManage ? addFilesToSelectedLake : undefined}
              />
            </Box>
          </Box>
        </Box>
      )}

      {/* Remove-from-lake confirmation for the tree's [x] action. Same contract as the
          Discover viewer's remove: membership + prefix tags go, the file itself stays. */}
      <Modal open={deleteTarget != null} onClose={() => setDeleteTarget(null)}>
        <ModalDialog data-testid="datalake-tree-removefile-confirm" role="alertdialog">
          <DialogTitle>Remove file from data lake?</DialogTitle>
          <DialogContent>
            &ldquo;{deleteTarget ? deleteTarget.file.fileName.replace(/\.[^/.]+$/, '') : ''}&rdquo; will be removed from
            &ldquo;{deleteTarget?.lake.name}&rdquo; and stops appearing here right away. The file stays in your Files
            list and in any chats that use it.
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="danger"
              data-testid="datalake-tree-removefile-confirm-btn"
              loading={removeFile.isPending}
              onClick={() =>
                deleteTarget && removeFile.mutate(deleteTarget.file.id, { onSuccess: () => setDeleteTarget(null) })
              }
            >
              Remove
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Drag-to-ingest: pick a destination lake, then the append wizard takes over.
          The wizard modal is a store-driven singleton already mounted by FileBrowser
          via ProviderBundle (live on the /opti route too), so we drive it through the
          store and must NOT mount a second instance here - that would stack a
          duplicate wizard. */}
      <DataLakeIngestPickerModal
        open={droppedFiles !== null}
        files={droppedFiles ?? []}
        onClose={() => setDroppedFiles(null)}
      />
    </Box>
  );
}
