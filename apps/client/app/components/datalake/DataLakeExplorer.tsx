import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog, Typography } from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DataLakeChatTree from './DataLakeChatTree';
import DataLakeLakePicker from './DataLakeLakePicker';
import DataLakeTreeEmptyState from './DataLakeTreeEmptyState';
import { resolveEmptyVariant } from './resolveEmptyVariant';
import { scopeTagCountsToLake } from './scopeTagCountsToLake';
import SelectedLakeHeader from './SelectedLakeHeader';
import DataLakeRailViewer from './DataLakeRailViewer';
import { resolveManageableLake } from './resolveManageableLake';
import { DataLakeNavProvider } from './dataLakeNavContext';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
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
import { toast } from 'sonner';
import type { IFabFileDocument, ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * The Data Lake surface: a browse tree beside a chat (main app + premium /opti). File rows carry
 * explicit actions (attach to chat, view, remove from lake) - browsing never mutates the chat.
 * Exposes the tree's richest branches + navigate to the chatSlot via DataLakeNavProvider so a host
 * idle pane (e.g. the sonar) can drive the tree.
 *
 * This is the ONLY Data Lake browse surface. The standalone /data-lakes page was a second
 * implementation of the same feature, unreachable since #1059 and retired in #1943; its lake rail,
 * scoped-lake header and honest empty states now live inside the tree card here.
 */
interface DataLakeExplorerProps {
  /** When set (from URL param), auto-select and display this article on mount. */
  articleId?: string | null;
  /** Which browse backend to read. Only the react-query cache key differs; a branded
   *  surface passes its own value to keep its cache separate from the main app's. */
  source?: DataLakeBrowseSource;
  /** Overrides the tree header title; defaults to the surface token. */
  rootLabel?: string;
  /** Opens the lake management panel (tree footer "Manage"). */
  onManage?: () => void;
  /** Opens the public-lake browse catalog from the lake picker. */
  onDiscover?: () => void;
  /** Opens the Create Lake wizard (tree footer "Create" + the lake picker's create row). */
  onCreateLake?: () => void;
  /**
   * Fills the pane right of the tree. Two host arrangements exist:
   * - Main app (DataLakeChatSurface): the chat's SessionContainer, declared via `chatEmbedded`.
   * - Premium overlay: the page's own (non-chat) content, with the chat DOCKED as a sibling
   *   outside this component.
   */
  chatSlot: React.ReactNode;
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

export default function DataLakeExplorer({
  articleId,
  source = 'datalakes',
  rootLabel,
  onManage,
  onDiscover,
  onCreateLake,
  chatSlot,
  chatEmbedded = false,
  createSessionForFile,
  showModeClose = true,
}: DataLakeExplorerProps) {
  const { copy } = useDataLakeSurface();
  const acceptedHint = copy.dropAcceptedHint;
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  /** Lake scope; null is the explicit all-lakes view. */
  const [selectedLakeId, setSelectedLakeId] = useState<string | null>(null);
  // External-chat hosts only: our own KnowledgeViewer is open beside the tree (View action).
  const [railViewerOpen, setRailViewerOpen] = useState(false);
  // Ref twin of railViewerOpen for the layout subscription below (a store listener would
  // otherwise close over a stale render's value).
  const railViewerOpenRef = useRef(false);
  // The layout the external host was running when the rail viewer opened, restored when the
  // viewer's Close writes `hide` (leaving `hide` in place would collapse the docked chat).
  const hostLayoutRef = useRef<DefaultLayoutType | null>(null);
  // Pending remove-from-lake confirmation.
  const [deleteTarget, setDeleteTarget] = useState<{ file: IFabFileDocument; lake: ManageableDataLakeConfig } | null>(
    null
  );

  // Attach files to the current session's workbench (#836).
  const { currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();
  // Files currently attached to the chat's prompt - drives the tree's persistent highlight, so a
  // file stays marked "already added" regardless of which action attached it (View or the menu's
  // Attach) or how far the user has since navigated the tree (#1693).
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

  // Drives the lake picker, gates row deletes, and answers "do I have any lakes?" - the question
  // the empty state used to answer from the file scope instead, and got wrong (#1645).
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

  // Scoping lives in scopeTagCountsToLake (pure + unit-tested, including the prefix-containment
  // assumption it rests on) rather than inline here.
  const scopedTagCounts = useMemo(
    () => scopeTagCountsToLake(tagCountsData?.tagCounts ?? [], selectedLake),
    [tagCountsData, selectedLake]
  );
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

  // Deep-link: fetch the specific article by ID when the URL param is present, then open it in
  // the viewer (effect below).
  const { data: deepLinkResult } = useGetDataLakeArticles(articleId ? { id: articleId, limit: 1 } : null, source);
  const deepLinkTarget = deepLinkResult?.data?.[0] ?? null;

  // Track global layout changes so the rail viewer follows the viewer actually on screen. Only
  // relevant to external-chat hosts - railViewerOpenRef is set only from the non-embedded branch
  // of handleViewFile above, so an embedded host's layout changes always take the early return
  // here and this effect is a no-op for that host.
  //
  // The host's layout must never change while our rail viewer is up, so ANY departure closes it.
  // The viewer's own Close writes `hide` - the one write that means "close me" rather than a
  // host-driven layout change - and `hide` would collapse the docked chat, so it is answered by
  // restoring the layout captured when the viewer opened. Any other write is the host
  // rearranging itself: close the viewer and let the new value stand.
  useEffect(() => {
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
  }, []);

  const openedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (deepLinkTarget && openedDeepLinkRef.current !== deepLinkTarget.id) {
      openedDeepLinkRef.current = deepLinkTarget.id;
      handleViewFile(deepLinkTarget);
    }
  }, [deepLinkTarget, handleViewFile]);

  // Browsing deliberately leaves the open file alone: the tree and the viewer are separate panels,
  // so browsing categories - including back out of one - must not dismiss what you are reading. The
  // viewer closes on its own Close button (see the layout subscription above). The highlight also
  // stays, so returning to the file's category still shows which one is open.
  const handleNavigate = useCallback((newBreadcrumb: string[]) => setBreadcrumb(newBreadcrumb), []);

  // Truthful distinct-file count (the tree's fileCounts are tag-occurrence sums, which
  // overcount multi-tagged articles ~2x). Follows the lake scope so it describes what is on screen.
  const totalArticles = selectedLake
    ? (tagCountsData?.uniqueArticleCounts?.byPrefix?.[selectedLake.fileTagPrefix] ?? 0)
    : (tagCountsData?.uniqueArticleCounts?.total ?? 0);

  /** Nothing to browse in the CURRENT scope. Says nothing about how many lakes exist. */
  const isScopeEmpty = !tagCountsLoading && !tagCountsError && totalArticles === 0 && tree.length === 0;

  // Precedence lives in resolveEmptyVariant (pure + unit-tested) rather than inline here, because
  // the ORDER of its checks is the whole fix - see that module's contract.
  const emptyVariant = resolveEmptyVariant({
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
  }, []);

  // Richest second-level branches (top 6), exposed to a host idle pane via context so its
  // quick-dive chips can drive the tree.
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
      data-testid="opti-datalake-explorer"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {isDragging && (
        <Box
          data-testid="opti-datalake-dropzone"
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
            {copy.dropTitle}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'rgba(255,255,255,0.7)' }}>
            {copy.dropHint}
          </Typography>
        </Box>
      )}

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
          dropHint={copy.dropRestingHint}
          subHeader={
            <>
              <DataLakeLakePicker
                lakes={lakes}
                isLoading={lakesLoading}
                isError={lakesError}
                onRetry={() => void refetchLakes()}
                // Derived, not the raw state: deleting or archiving the scoped lake through
                // Configure drops it from the list, and everything else here already falls back
                // to the all-lakes scope when that happens. Feeding the stale id back would leave
                // the picker claiming a scope nothing else is honouring.
                selectedLakeId={selectedLake?.id ?? null}
                onSelect={handleSelectLake}
                lakeFileCounts={tagCountsData?.lakeFileCounts}
                totalFileCount={tagCountsData?.uniqueArticleCounts?.total ?? 0}
                onCreate={onCreateLake}
                onDiscover={onDiscover}
              />
              {selectedLake && <SelectedLakeHeader lake={selectedLake} />}
            </>
          }
          emptySlot={
            emptyVariant === 'no-selection' ? undefined : (
              <DataLakeTreeEmptyState
                variant={emptyVariant}
                onCreate={onCreateLake}
                onRetryLakes={() => void refetchLakes()}
                onAddFiles={selectedLake?.canManage ? addFilesToSelectedLake : undefined}
              />
            )
          }
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
