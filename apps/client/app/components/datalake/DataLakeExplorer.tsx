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
import DataLakeRailReader from './DataLakeRailReader';
import { resolveManageableLake } from './resolveManageableLake';
import { DataLakeNavProvider } from './dataLakeNavContext';
import { StatTicker, inkFor, surfaceBackground } from '@client/app/components/datalake/surfaceChrome';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { ManageKnowledgeButton } from '@client/app/components/datalake/manageKnowledge';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import useSetDataLakeMode from '@client/app/hooks/useSetDataLakeMode';
import { useNotebookLayout } from '@client/app/components/layouts/Notebook';
import {
  useGetDataLakeArticles,
  useGetDataLakes,
  useGetDataLakeTagCounts,
  useRemoveFileFromDataLake,
} from '@client/app/hooks/data/dataLakes';
import type { DataLakeBrowseSource } from '@client/app/hooks/data/dataLakes';
import { buildTagTree, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeIngestPickerModal from '@client/app/components/DataLakeWizard/DataLakeIngestPickerModal';
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
   * Fills the pane right of the tree and switches this component into CHAT mode. The chat may
   * be the main app's SessionContainer (DataLakeChatSurface) or live docked OUTSIDE this
   * component (premium overlay); either way the tree never drives the global session layout.
   */
  chatSlot?: React.ReactNode;
  /**
   * Called when a file is ATTACHED with no active session (/new, where creation is deferred to
   * the first message): must create + adopt the session and resolve its id so the attach can
   * land in a real workbench. Omitted (overlay) -> a guidance toast instead.
   */
  createSessionForFile?: () => Promise<string>;
  /**
   * Whether the chat tree header shows the close (X) that turns Data Lake mode off. Default true.
   * Hosts entered/left by navigation rather than a per-session toggle pass false.
   */
  showModeClose?: boolean;
}

/** True only for drags carrying real files (not text/image-from-page drags). */
const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes('Files');

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
  createSessionForFile,
  showModeClose = true,
}: DataLakeExplorerProps) {
  // The presence of a chatSlot is the mode discriminator: with it, the surface is a tree rail
  // beside a chat; without it, the standalone browse-and-read page.
  const chatMode = chatSlot != null;
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const { theme, copy } = useDataLakeSurface();
  const acceptedHint = copy.dropAcceptedHint;
  const accentInk = inkFor(theme.accent, isDark);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  // Page mode: file shown in the inline article reader.
  const [userSelectedFile, setUserSelectedFile] = useState<IFabFileDocument | null>(null);
  // Chat mode: id of the file most recently viewed, kept to highlight it in the tree.
  const [viewerFileId, setViewerFileId] = useState<string | null>(articleId ?? null);
  // Chat mode: file open in the rail reader (View action); it replaces the tree until Back.
  const [readerFile, setReaderFile] = useState<IFabFileDocument | null>(null);
  // Chat mode: pending remove-from-lake confirmation.
  const [deleteTarget, setDeleteTarget] = useState<{ file: IFabFileDocument; lake: ManageableDataLakeConfig } | null>(
    null
  );

  // Chat-mode wiring: attach files to the current session's workbench (#836). The hooks are
  // always called (React rules); page mode simply never invokes attachFileToChat.
  const { currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();
  const setDataLakeMode = useSetDataLakeMode();
  // When the sidenav is collapsed its floating expand control overlaps the top-left, so the
  // chat tree needs extra left clearance past it (same 48px the deck top bar uses).
  const sidenavOpen = useNotebookLayout(s => s.openSideNav);
  // Guards double-clicks while createSessionForFile's POST is in flight - a second click
  // would otherwise mint a second session.
  const creatingSessionRef = useRef(false);
  // Explicit [+] action; the one place lake browsing writes into the chat. Comment at the
  // hooks above (#836) still applies: hooks always run, page mode never calls this.
  const attachFileToChat = useCallback(
    async (file: IFabFileDocument) => {
      let sessionId = currentSessionId;
      if (!sessionId) {
        // /new: session creation is deferred to the first message, so there is no workbench to
        // attach to. Hosts that can mint the grounded session do so here; otherwise guide.
        if (!createSessionForFile || creatingSessionRef.current) {
          if (!createSessionForFile) {
            toast.info('Start the chat with a first message - then lake files can be added to it.');
          }
          return;
        }
        creatingSessionRef.current = true;
        try {
          sessionId = await createSessionForFile();
        } catch (error) {
          console.error('Data Lake session create failed:', error);
          toast.error("Couldn't start the chat - please try again.");
          return;
        } finally {
          creatingSessionRef.current = false;
        }
      }
      setWorkBenchFiles(sessionId, prev => (prev.some(f => f.id === file.id) ? prev : [...prev, file]));
      toast.info(`Added "${file.fileName.replace(/\.[^/.]+$/, '')}" to the chat's files`);
    },
    [currentSessionId, setWorkBenchFiles, createSessionForFile]
  );

  const handleViewFile = useCallback(
    (file: IFabFileDocument) => {
      setReaderFile(file);
      setViewerFileId(file.id);
    },
    [setReaderFile, setViewerFileId]
  );

  // Delete gating: the lake list is only needed in chat mode (page mode has no row actions).
  const { data: lakes } = useGetDataLakes(chatMode);
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
  const tree = useMemo(() => buildTagTree(tagCountsData?.tagCounts ?? []), [tagCountsData]);

  // Derive the current leaf tag from breadcrumb + tree state
  const currentNodes = getNodesAtPath(tree, breadcrumb);
  const leafTag = breadcrumb.length > 0 && currentNodes.length === 0 ? breadcrumb.join(':') : null;

  // Phase 2: Fetch articles only when at a leaf node (filtered by tag, paginated)
  const { data: leafArticlesResult, isLoading: leafLoading } = useGetDataLakeArticles(
    leafTag ? { tags: [leafTag], limit: 50 } : null,
    source
  );
  const leafArticles = leafTag ? (leafArticlesResult?.data ?? []) : [];

  // Deep-link: fetch the specific article by ID when the URL param is present. Page mode shows
  // it in the inline reader; chat mode shows it in the rail reader (effect below).
  const { data: deepLinkResult } = useGetDataLakeArticles(
    articleId && !userSelectedFile ? { id: articleId, limit: 1 } : null,
    source
  );
  const deepLinkTarget = deepLinkResult?.data?.[0] ?? null;

  // Page mode: user's explicit click takes priority, then the deep-link result. Pure derivation.
  const selectedFile = userSelectedFile ?? (articleId ? deepLinkTarget : null);

  // Chat mode: show the URL's article in the rail reader once it resolves, once per id.
  const openedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (chatMode && deepLinkTarget && openedDeepLinkRef.current !== deepLinkTarget.id) {
      openedDeepLinkRef.current = deepLinkTarget.id;
      setReaderFile(deepLinkTarget);
      setViewerFileId(deepLinkTarget.id);
    }
  }, [chatMode, deepLinkTarget]);

  const handleNavigate = useCallback(
    (newBreadcrumb: string[]) => {
      setBreadcrumb(newBreadcrumb);
      if (chatMode) {
        // Browsing away closes the rail reader; navigation can arrive from the host's idle
        // pane (DataLakeNavProvider) while the reader has the rail.
        setReaderFile(null);
        setViewerFileId(null);
      } else {
        setUserSelectedFile(null);
      }
    },
    [chatMode, setBreadcrumb, setReaderFile, setViewerFileId, setUserSelectedFile]
  );

  // Page mode only: the chat tree's rows carry explicit actions instead of a click handler.
  const handleSelectFile = useCallback((file: IFabFileDocument) => setUserSelectedFile(file), []);

  // Truthful distinct-file count (the tree's fileCounts are tag-occurrence sums, which
  // overcount multi-tagged articles ~2x); branch count stays tree-derived.
  const totalArticles = tagCountsData?.uniqueArticleCounts?.total ?? 0;
  const branchCount = useMemo(() => tree.reduce((sum, node) => sum + Math.max(node.children.length, 1), 0), [tree]);

  // Zero-state: nothing to browse yet. Drives the create-first affordance so the first
  // lake can be created in place instead of dead-ending on an empty scope (#837).
  const isEmpty = !tagCountsLoading && !tagCountsError && totalArticles === 0 && tree.length === 0;

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
                  sub: breadcrumb.length === 0 ? copy.depthRootLabel : breadcrumb.join(' : '),
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
      {!chatMode && isEmpty && !isDragging && (
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
            gap: '8px',
            transition: 'padding-left 0.2s ease',
          }}
        >
          {readerFile ? (
            <DataLakeRailReader file={readerFile} onBack={() => setReaderFile(null)} />
          ) : (
            <DataLakeChatTree
              tree={tree}
              articles={leafArticles}
              breadcrumb={breadcrumb}
              onNavigate={handleNavigate}
              selectedFileId={viewerFileId}
              onAttachFile={attachFileToChat}
              onViewFile={handleViewFile}
              canDeleteFile={canDeleteFile}
              onDeleteFile={handleDeleteFile}
              isLoading={tagCountsLoading || (!!leafTag && leafLoading)}
              isError={tagCountsError}
              title={rootLabel ?? copy.rootLabel}
              onManage={onManage}
              onCreateLake={onCreateLake}
              onClose={showModeClose ? () => setDataLakeMode(false) : undefined}
            />
          )}
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <DataLakeNavProvider value={nav}>{chatSlot}</DataLakeNavProvider>
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <DataLakeTree
            tree={tree}
            articles={leafArticles}
            breadcrumb={breadcrumb}
            onNavigate={handleNavigate}
            selectedFileId={selectedFile?.id ?? null}
            onSelectFile={handleSelectFile}
            isLoading={tagCountsLoading || (!!leafTag && leafLoading)}
            isError={tagCountsError}
          />
          <DataLakeArticle
            file={selectedFile}
            onAskAbout={onAskAbout ?? (() => {})}
            quickDives={quickDives}
            onDive={handleNavigate}
            onCreate={isEmpty ? onCreate : undefined}
          />
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
