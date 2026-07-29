import { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Input,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  Modal,
  ModalDialog,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import StorageIcon from '@mui/icons-material/Storage';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RestoreIcon from '@mui/icons-material/Restore';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { buildTagTree, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import {
  COUNT_CHIP_SX,
  FOOTER_BTN_SX,
  ICON_BTN_SX,
  TREE_LIST_SX,
  hueForBranch,
  humanizeSegment,
  treeRowSx,
} from '@client/app/components/datalake/treeChrome';
import { gray } from '@client/app/utils/themes/colors';
import { useDataLakeFiles, useDataLakes } from '@client/app/hooks/data/dataLakeWizard';
import { useGetDataLakeTagCounts } from '@client/app/hooks/data/fabFiles';
import {
  useArchiveDataLake,
  useCleanupDataLake,
  useGetArchivedDataLakes,
  useGetDeletedDataLakes,
  usePermanentDeleteDataLake,
  useRestoreDeletedDataLake,
  useUnarchiveDataLake,
} from '@client/app/hooks/data/dataLakes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import DataLakeArticlePanel from './DataLakeArticlePanel';
import { DataLakeSettingsModal } from './DataLakeSettingsModal';
import type { EditableLake } from './DataLakeSettingsModal';
import type { IFabFileDocument } from '@bike4mind/common';

type ManagerLake = NonNullable<ReturnType<typeof useDataLakes>['data']>[number];

/** Synthetic category for lake files that carry no prefix-matching tag (e.g. appended or
 *  meta-tag-only files), so every file is always reachable in the manager. */
const UNCATEGORIZED_KEY = '__uncategorized__';

const normalizePrefix = (fileTagPrefix: string) => (fileTagPrefix.endsWith(':') ? fileTagPrefix : `${fileTagPrefix}:`);

/** The prefix's namespace segments, e.g. 'books' -> ['books']. Lake navigation seeds the
 *  path past these so clicking a lake lands directly on its categories. */
const prefixSegments = (fileTagPrefix: string) => fileTagPrefix.replace(/:+$/, '').split(':').filter(Boolean);

/**
 * Data Lakes management surface: one persistent two-pane layout. The left sidebar navigates
 * lakes -> categories -> files with the exact styling of the in-chat tree (treeChrome); the
 * right pane shows the selected lake's details/actions, or the file's content, or (at root)
 * the archived/deleted lifecycle sections. Replaces the old stacked list + viewer modals.
 */
export default function DataLakeManagerPanel() {
  const { data: dataLakes, isLoading } = useDataLakes();
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  const { isFeatureEnabled } = useAdminSettingsCache();

  // The lakes list endpoint doesn't compute per-lake file counts; fall back to the unique
  // per-prefix counts behind the in-chat tree so both surfaces show the same numbers.
  const { data: tagCountsData } = useGetDataLakeTagCounts('datalakes');
  const lakeCount = useCallback(
    (lake: ManagerLake): number | undefined =>
      lake.fileCount ?? tagCountsData?.uniqueArticleCounts?.byPrefix?.[normalizePrefix(lake.fileTagPrefix)],
    [tagCountsData]
  );

  const [lakeId, setLakeId] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<IFabFileDocument | null>(null);
  const [editingLakeId, setEditingLakeId] = useState<string | null>(null);

  // Derived, not effect-synced: when the active lake vanishes from the list (archived or
  // deleted), this goes null and the panel falls back to the root view on its own. The stale
  // path/file are unreachable behind the null and reset on the next lake click.
  const activeLake = useMemo(() => dataLakes?.find(l => l.id === lakeId) ?? null, [dataLakes, lakeId]);

  // Derive the lake being edited from the LIVE list (by id) rather than a snapshot, so a
  // visibility mutation's cache refresh flows into the settings modal instead of leaving the
  // Visibility control showing stale pre-mutation state.
  const editingLake = useMemo<EditableLake | null>(() => {
    const l = dataLakes?.find(d => d.id === editingLakeId);
    return l
      ? {
          id: l.id,
          name: l.name,
          description: l.description ?? '',
          requiredUserTag: l.requiredUserTag ?? '',
          requiredEntitlement: l.requiredEntitlement ?? '',
          organizationId: l.organizationId ?? '',
          isPublic: l.isPublic ?? false,
        }
      : null;
  }, [dataLakes, editingLakeId]);

  const selectLake = (lake: ManagerLake) => {
    setLakeId(lake.id);
    // Seed past the shared prefix root so the first in-lake view shows its categories
    // instead of a single redundant folder named like the lake.
    setPath(prefixSegments(lake.fileTagPrefix));
    setSelectedFile(null);
  };

  // Shared choke point for every manager entry point: with the feature off the lakes
  // queries 403 and the empty panel is a dead end, so never render - even if some (future)
  // ungated caller opens the manager. Mirrors the render guard in SendToDataLakeModal.
  // Placed after all hooks so the hook order is stable.
  if (!isFeatureEnabled('EnableDataLakes')) return null;

  return (
    // No header bar: the nav floats as a full-height card (same chrome as the in-chat tree)
    // and the modal's ModalClose sits in the top-right corner across from it.
    <Box
      data-testid="datalake-manager-panel"
      sx={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', p: '12px', gap: '12px' }}
    >
      <ManagerNav
        lakes={dataLakes}
        lakesLoading={isLoading}
        lakeCount={lakeCount}
        activeLake={activeLake}
        path={path}
        selectedFileId={selectedFile?.id ?? null}
        onSelectLake={selectLake}
        onNavigate={p => {
          setPath(p);
          setSelectedFile(null);
        }}
        onExitLake={() => {
          setLakeId(null);
          setPath([]);
          setSelectedFile(null);
        }}
        onSelectFile={setSelectedFile}
        onCreateLake={openWizard}
      />
      {activeLake ? (
        selectedFile ? (
          <DataLakeArticlePanel
            file={selectedFile}
            dataLakeId={activeLake.id}
            canManage={activeLake.canManage}
            onRemoved={() => setSelectedFile(null)}
          />
        ) : (
          <LakeInfoPanel
            lake={activeLake}
            fileCount={lakeCount(activeLake)}
            onOpenSettings={() => setEditingLakeId(activeLake.id)}
            onArchived={() => {
              setLakeId(null);
              setPath([]);
              setSelectedFile(null);
            }}
          />
        )
      ) : (
        <ManagerOverview />
      )}

      <DataLakeSettingsModal lake={editingLake} onClose={() => setEditingLakeId(null)} />
    </Box>
  );
}

// Left sidebar

interface ManagerNavProps {
  lakes: ManagerLake[] | undefined;
  lakesLoading: boolean;
  /** Resolved per-lake file count (list fileCount, else the tag-counts fallback). */
  lakeCount: (lake: ManagerLake) => number | undefined;
  activeLake: ManagerLake | null;
  /** In-lake tag path, seeded with the lake's prefix segments (see selectLake). */
  path: string[];
  selectedFileId: string | null;
  onSelectLake: (lake: ManagerLake) => void;
  onNavigate: (path: string[]) => void;
  onExitLake: () => void;
  onSelectFile: (file: IFabFileDocument) => void;
  onCreateLake: () => void;
}

function ManagerNav({
  lakes,
  lakesLoading,
  lakeCount,
  activeLake,
  path,
  selectedFileId,
  onSelectLake,
  onNavigate,
  onExitLake,
  onSelectFile,
  onCreateLake,
}: ManagerNavProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const hoverBg = theme.palette.notebooklist.hoverBg;
  const borderColor = isDark ? gray[800] : gray[200];
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'count' | 'alpha'>('count');

  // Root accordions: active lakes open by default; the lifecycle lists stay collapsed (their
  // queries only fire once expanded, same as the old right-pane sections).
  const [showLakes, setShowLakes] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
  const unarchiveLake = useUnarchiveDataLake();
  const restoreDeletedLake = useRestoreDeletedDataLake();
  const deleteLake = usePermanentDeleteDataLake();
  const cleanupLake = useCleanupDataLake();
  const { data: archivedLakes } = useGetArchivedDataLakes(showArchived);
  const { data: deletedLakes } = useGetDeletedDataLakes(showDeleted);

  const { data: filesResult, isLoading: filesLoading, isError: filesError } = useDataLakeFiles(activeLake?.id ?? null);
  const articles = useMemo(() => filesResult?.data ?? [], [filesResult]);

  // Per-lake category tree from the lake's prefix-matching tags (datalake: meta-tags excluded).
  const tree = useMemo(() => {
    if (!activeLake) return [];
    const prefix = normalizePrefix(activeLake.fileTagPrefix);
    const tagCountMap = new Map<string, number>();
    for (const file of articles) {
      for (const tag of file.tags ?? []) {
        if (tag.name.startsWith(prefix) && !tag.name.startsWith('datalake:')) {
          tagCountMap.set(tag.name, (tagCountMap.get(tag.name) ?? 0) + 1);
        }
      }
    }
    return buildTagTree(Array.from(tagCountMap.entries()).map(([tag, count]) => ({ tag, count })));
  }, [articles, activeLake]);

  const currentNodes = useMemo(() => getNodesAtPath(tree, path), [tree, path]);

  const filteredNodes = useMemo(() => {
    let nodes = currentNodes;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      nodes = nodes.filter(node => node.segment.toLowerCase().includes(q));
    }
    return [...nodes].sort((a, b) =>
      sortBy === 'count' ? b.fileCount - a.fileCount : a.segment.localeCompare(b.segment)
    );
  }, [currentNodes, searchQuery, sortBy]);

  // Files in the lake with no prefix-matching (non-meta) tag - surfaced under "Uncategorized".
  const uncategorizedFiles = useMemo(() => {
    if (!activeLake) return [];
    const prefix = normalizePrefix(activeLake.fileTagPrefix);
    return [...articles]
      .filter(f => !(f.tags ?? []).some(t => t.name.startsWith(prefix) && !t.name.startsWith('datalake:')))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [articles, activeLake]);

  const seedDepth = activeLake ? prefixSegments(activeLake.fileTagPrefix).length : 0;
  const atLakeRoot = !!activeLake && path.length <= seedDepth;
  const isUncategorized = path[path.length - 1] === UNCATEGORIZED_KEY;
  // Leaf detection starts BELOW the seeded lake root, so an empty/untagged lake still shows
  // the folder view (with the Uncategorized bucket) instead of flipping to a dead file list.
  const leafTag =
    activeLake && !isUncategorized && path.length > seedDepth && currentNodes.length === 0 ? path.join(':') : null;
  const showFiles = isUncategorized || !!leafTag;
  const files = useMemo(() => {
    if (isUncategorized) return uncategorizedFiles;
    if (!leafTag) return [];
    return [...articles]
      .filter(f => (f.tags ?? []).some(t => t.name === leafTag))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [isUncategorized, uncategorizedFiles, leafTag, articles]);

  const filteredLakes = useMemo(() => {
    let list = lakes ?? [];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(l => l.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) =>
      sortBy === 'count' ? (lakeCount(b) ?? 0) - (lakeCount(a) ?? 0) : a.name.localeCompare(b.name)
    );
  }, [lakes, searchQuery, sortBy, lakeCount]);

  // The sidebar search also narrows the lifecycle lists; undefined stays undefined so the
  // sections keep their loading skeleton.
  const filterByName = <T extends { name: string }>(list: T[] | undefined): T[] | undefined => {
    if (!list || !searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(l => l.name.toLowerCase().includes(q));
  };

  // Search is scoped to the current level: entering/leaving a lake or drilling a category
  // clears it, so a query typed to find a lake at root can't silently filter (and hide) that
  // lake's categories once opened. Wrap every level transition to reset it.
  const selectLake = (lake: ManagerLake) => {
    setSearchQuery('');
    onSelectLake(lake);
  };
  const navigate = (next: string[]) => {
    setSearchQuery('');
    onNavigate(next);
  };
  const handleBack = () => {
    setSearchQuery('');
    if (!activeLake || atLakeRoot) onExitLake();
    else onNavigate(path.slice(0, -1));
  };

  const backLabel = !activeLake
    ? ''
    : atLakeRoot
      ? 'All Lakes'
      : path.length - 1 <= seedDepth
        ? activeLake.name
        : humanizeSegment(path[path.length - 2], path.length - 2);

  const rowTypographySx = { fontSize: '14px', fontWeight: 400, color: gray[200] } as const;

  return (
    <Box
      data-testid="datalake-manager-nav"
      sx={{
        width: 280,
        minWidth: 280,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Floating-card chrome like the in-chat tree (DataLakeTree), slightly tighter radius.
        backgroundColor: 'background.surface2',
        border: '1px solid',
        borderColor,
        borderRadius: '8px',
      }}
    >
      {/* Search bar + sort toggle - same toolbar as the in-chat tree. */}
      <Box sx={{ mt: '12px', mb: '12px', px: '12px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <Input
          size="sm"
          placeholder="Search"
          startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="datalake-manager-search"
          sx={{ flex: 1, '--Input-minHeight': '32px', color: 'text.primary', boxShadow: 'none' }}
        />
        <Tooltip
          title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'}
          size="sm"
        >
          <IconButton
            variant="outlined"
            color="neutral"
            onClick={() => setSortBy(prev => (prev === 'count' ? 'alpha' : 'count'))}
            data-testid="datalake-manager-sort-toggle"
            data-sort={sortBy}
            sx={{ ...ICON_BTN_SX, flexShrink: 0 }}
          >
            <SwapVertIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: '8px' }}>
        {activeLake && (
          <ListItemButton
            onClick={handleBack}
            data-testid="datalake-manager-back"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              px: '8px',
              mb: '4px',
              height: '32px',
              minHeight: '32px',
              borderRadius: '8px',
              transition: 'background 0.15s',
              '--variant-plainHoverBg': hoverBg,
            }}
          >
            <ArrowBackIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
            <Typography noWrap sx={rowTypographySx}>
              {backLabel}
            </Typography>
          </ListItemButton>
        )}

        {!activeLake ? (
          /* Root: accordions - active lakes (tree-folder rows) + the lifecycle lists. */
          <>
            <Box data-testid="datalake-manager-lakes-section">
              <NavSectionHeader
                label="Data Lakes"
                open={showLakes}
                onToggle={() => setShowLakes(v => !v)}
                testid="datalake-manager-lakes-section-toggle"
                hoverBg={hoverBg}
              />
              {showLakes &&
                (lakesLoading ? (
                  <NavSkeletons />
                ) : (
                  <List size="sm" sx={TREE_LIST_SX}>
                    {filteredLakes.length === 0 ? (
                      <EmptyHint text={searchQuery ? 'No matches' : 'No data lakes yet'} />
                    ) : (
                      filteredLakes.map(lake => {
                        const count = lakeCount(lake);
                        return (
                          <ListItem key={lake.id}>
                            <ListItemButton
                              onClick={() => selectLake(lake)}
                              data-testid={`datalake-manager-lake-${lake.id}`}
                              // pr aligns the count chip with the section headers' chevrons.
                              sx={{ ...treeRowSx(hoverBg), pr: '12px' }}
                            >
                              <FolderOutlinedIcon
                                sx={{
                                  fontSize: 16,
                                  color: inkFor(hueForBranch(prefixSegments(lake.fileTagPrefix)[0] ?? '', []), isDark),
                                  flexShrink: 0,
                                }}
                              />
                              <ListItemContent>
                                <Typography noWrap sx={rowTypographySx}>
                                  {lake.name}
                                </Typography>
                              </ListItemContent>
                              {typeof count === 'number' && (
                                <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
                                  {count}
                                </Chip>
                              )}
                            </ListItemButton>
                          </ListItem>
                        );
                      })
                    )}
                  </List>
                ))}
            </Box>

            {/* Archived (reversible) */}
            <NavLifecycleSection
              label="Archived"
              open={showArchived}
              onToggle={() => setShowArchived(v => !v)}
              testid="datalake-archived-section"
              emptyText="No archived data lakes."
              lakes={showArchived ? filterByName(archivedLakes) : undefined}
              hoverBg={hoverBg}
              renderActions={lake => (
                <>
                  <Tooltip title="Restore" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="success"
                      data-testid={`datalake-restore-btn-${lake.id}`}
                      onClick={() => unarchiveLake.mutate(lake.id)}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <UnarchiveOutlinedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete (recoverable)" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      data-testid={`datalake-delete-btn-${lake.id}`}
                      onClick={() => deleteLake.mutate(lake.id)}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            />

            {/* Deleted (recoverable until purged) */}
            <NavLifecycleSection
              label="Deleted (recoverable)"
              open={showDeleted}
              onToggle={() => setShowDeleted(v => !v)}
              testid="datalake-deleted-section"
              emptyText="No deleted data lakes."
              lakes={showDeleted ? filterByName(deletedLakes) : undefined}
              hoverBg={hoverBg}
              renderActions={lake => (
                <>
                  <Tooltip title="Restore" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="success"
                      data-testid={`datalake-restore-deleted-btn-${lake.id}`}
                      onClick={() => restoreDeletedLake.mutate(lake.id)}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <RestoreIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Purge permanently" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      data-testid={`datalake-purge-btn-${lake.id}`}
                      onClick={() => setPurgeTarget({ id: lake.id, name: lake.name })}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <DeleteForeverIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            />

            {/* Irreversible purge confirmation */}
            <Modal open={!!purgeTarget} onClose={() => setPurgeTarget(null)}>
              <ModalDialog data-testid="datalake-purge-confirm" role="alertdialog">
                <DialogTitle>Permanently purge data lake?</DialogTitle>
                <DialogContent>
                  This irreversibly deletes “{purgeTarget?.name}” and all its files, chunks, and batches. This cannot be
                  undone.
                </DialogContent>
                <DialogActions>
                  <Button
                    variant="solid"
                    color="danger"
                    data-testid="datalake-purge-confirm-btn"
                    loading={cleanupLake.isPending}
                    onClick={() => {
                      if (purgeTarget) cleanupLake.mutate(purgeTarget.id, { onSuccess: () => setPurgeTarget(null) });
                    }}
                  >
                    Purge permanently
                  </Button>
                  <Button variant="plain" color="neutral" onClick={() => setPurgeTarget(null)}>
                    Cancel
                  </Button>
                </DialogActions>
              </ModalDialog>
            </Modal>
          </>
        ) : filesError ? (
          <Box sx={{ p: 2, textAlign: 'center' }} data-testid="datalake-manager-error">
            <Typography level="body-xs" sx={{ color: 'danger.400' }}>
              Failed to load files
            </Typography>
          </Box>
        ) : filesLoading ? (
          <NavSkeletons />
        ) : showFiles ? (
          /* File list at leaf */
          <List size="sm" sx={TREE_LIST_SX}>
            {files.length === 0 ? (
              <EmptyHint text="No files found" />
            ) : (
              files.map(file => (
                <ListItem key={file.id}>
                  <ListItemButton
                    selected={selectedFileId === file.id}
                    onClick={() => onSelectFile(file)}
                    data-testid={`datalake-manager-file-${file.id}`}
                    sx={treeRowSx(hoverBg)}
                  >
                    <ArticleOutlinedIcon
                      sx={{
                        fontSize: 16,
                        color: selectedFileId === file.id ? inkFor(HUES.cyan, isDark) : 'text.tertiary',
                        flexShrink: 0,
                      }}
                    />
                    <ListItemContent>
                      <Typography
                        noWrap
                        sx={{ ...rowTypographySx, fontWeight: selectedFileId === file.id ? 'lg' : 400 }}
                      >
                        {file.fileName.replace(/\.[^/.]+$/, '')}
                      </Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              ))
            )}
          </List>
        ) : (
          /* In-lake folder tree */
          <List size="sm" sx={TREE_LIST_SX}>
            {filteredNodes.map(node => (
              <ListItem key={node.segment}>
                <ListItemButton
                  onClick={() => navigate([...path, node.segment])}
                  sx={treeRowSx(hoverBg)}
                  data-testid={`datalake-manager-node-${node.segment}`}
                >
                  <FolderOutlinedIcon
                    sx={{ fontSize: 16, color: inkFor(hueForBranch(node.segment, path), isDark), flexShrink: 0 }}
                  />
                  <ListItemContent>
                    <Typography noWrap sx={rowTypographySx}>
                      {humanizeSegment(node.segment, path.length)}
                    </Typography>
                  </ListItemContent>
                  <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
                    {node.fileCount}
                  </Chip>
                </ListItemButton>
              </ListItem>
            ))}

            {/* Fallback bucket: files with no prefix-matching tag, so nothing is hidden. */}
            {atLakeRoot && !searchQuery && uncategorizedFiles.length > 0 && (
              <ListItem key={UNCATEGORIZED_KEY}>
                <ListItemButton
                  onClick={() => navigate([...path, UNCATEGORIZED_KEY])}
                  data-testid="datalake-manager-uncategorized"
                  sx={treeRowSx(hoverBg)}
                >
                  <FolderOutlinedIcon sx={{ fontSize: 16, color: 'neutral.400', flexShrink: 0 }} />
                  <ListItemContent>
                    <Typography noWrap sx={{ ...rowTypographySx, fontStyle: 'italic', color: 'text.secondary' }}>
                      Uncategorized
                    </Typography>
                  </ListItemContent>
                  <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
                    {uncategorizedFiles.length}
                  </Chip>
                </ListItemButton>
              </ListItem>
            )}

            {filteredNodes.length === 0 && !(atLakeRoot && !searchQuery && uncategorizedFiles.length > 0) && (
              <EmptyHint text={searchQuery ? 'No matches' : 'No categories'} />
            )}
          </List>
        )}
      </Box>

      {/* Sticky bottom bar, same chrome as the in-chat tree footer. */}
      <Box sx={{ display: 'flex', gap: '8px', p: '12px', borderTop: '1px solid', borderColor }}>
        <Button
          variant="solid"
          color="primary"
          onClick={onCreateLake}
          data-testid="datalake-manager-create-btn"
          sx={FOOTER_BTN_SX}
        >
          Create
        </Button>
      </Box>
    </Box>
  );
}

function NavSkeletons() {
  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {[1, 2, 3, 4].map(i => (
        <Skeleton key={i} variant="rectangular" height={32} sx={{ borderRadius: 'sm' }} />
      ))}
    </Box>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <Box sx={{ p: 2, textAlign: 'center' }}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        {text}
      </Typography>
    </Box>
  );
}

/** Accordion header for the sidebar's root sections, styled like the tree rows. */
function NavSectionHeader({
  label,
  open,
  onToggle,
  testid,
  hoverBg,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  hoverBg: string;
}) {
  return (
    <ListItemButton
      onClick={onToggle}
      data-testid={testid}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        px: '8px',
        mb: '4px',
        height: '32px',
        minHeight: '32px',
        borderRadius: '8px',
        transition: 'background 0.15s',
        '--variant-plainHoverBg': hoverBg,
      }}
    >
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 400, color: gray[200] }}>
        {label}
      </Typography>
      {open ? (
        <ExpandLessIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
      ) : (
        <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
      )}
    </ListItemButton>
  );
}

interface LifecycleSectionLake {
  id: string;
  name: string;
  fileTagPrefix: string;
}

/** Sidebar accordion for archived/deleted lakes: tree-style rows with restore/delete actions.
 *  `lakes` undefined -> loading skeleton (the query fires only once the section is expanded). */
function NavLifecycleSection({
  label,
  open,
  onToggle,
  testid,
  emptyText,
  lakes,
  hoverBg,
  renderActions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  emptyText: string;
  lakes: LifecycleSectionLake[] | undefined;
  hoverBg: string;
  renderActions: (lake: LifecycleSectionLake) => React.ReactNode;
}) {
  return (
    <Box data-testid={testid} sx={{ mt: '8px' }}>
      <NavSectionHeader label={label} open={open} onToggle={onToggle} testid={`${testid}-toggle`} hoverBg={hoverBg} />
      {open &&
        (!lakes ? (
          <Box sx={{ px: '8px', pb: 1 }}>
            <Skeleton variant="rectangular" height={28} sx={{ borderRadius: 'sm' }} />
          </Box>
        ) : lakes.length === 0 ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary', px: '8px', pb: 1 }}>
            {emptyText}
          </Typography>
        ) : (
          <List size="sm" sx={TREE_LIST_SX}>
            {lakes.map(lake => (
              <ListItem key={lake.id}>
                <Box
                  data-testid={`${testid}-card-${lake.id}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    px: '8px',
                    minHeight: '28px',
                    width: '100%',
                  }}
                >
                  <FolderOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary', flexShrink: 0 }} />
                  <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 400, color: gray[200] }}>
                    {lake.name}
                  </Typography>
                  {renderActions(lake)}
                </Box>
              </ListItem>
            ))}
          </List>
        ))}
    </Box>
  );
}

// Right pane: selected lake's details + management actions

function LakeInfoPanel({
  lake,
  fileCount,
  onOpenSettings,
  onArchived,
}: {
  lake: ManagerLake;
  fileCount: number | undefined;
  onOpenSettings: () => void;
  /** Called after the active lake is archived, so the panel exits to root instead of the
   *  derived activeLake re-binding to a lake that just left the list (and a later restore
   *  teleporting back in). */
  onArchived: () => void;
}) {
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const archiveLake = useArchiveDataLake();
  const visibility = lake.isPublic ? 'Public' : lake.organizationId ? 'Organization' : 'Private';

  return (
    <Box
      data-testid="datalake-manager-lakeinfo"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
    >
      {/* pr clears the modal's absolutely-positioned ModalClose (top-right). */}
      <Box sx={{ px: 3, pr: 6, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>
            {lake.name}
          </Typography>
          {/* Add files / Settings / Archive are owner-or-admin only (the backend enforces the
              same rule). The nav surfaces other users' read-only public lakes too. */}
          {lake.canManage && (
            <>
              <Button
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-addfiles-btn-${lake.id}`}
                onClick={() =>
                  openWizardForLake({
                    id: lake.id,
                    slug: lake.slug,
                    name: lake.name,
                    fileTagPrefix: lake.fileTagPrefix,
                    requiredUserTag: lake.requiredUserTag,
                    requiredEntitlement: lake.requiredEntitlement,
                  })
                }
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Add files
              </Button>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-settings-btn-${lake.id}`}
                onClick={onOpenSettings}
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Settings
              </Button>
              <Tooltip title="Archive (restorable from the manager home)" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="warning"
                  startDecorator={<ArchiveOutlinedIcon sx={{ fontSize: 16 }} />}
                  data-testid={`datalake-archive-btn-${lake.id}`}
                  loading={archiveLake.isPending}
                  onClick={() => archiveLake.mutate(lake.id, { onSuccess: onArchived })}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Archive
                </Button>
              </Tooltip>
            </>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '11px' }}>
            {lake.fileTagPrefix}
          </Chip>
          {lake.requiredUserTag && (
            <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '11px' }}>
              {lake.requiredUserTag}
            </Chip>
          )}
          <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
            {visibility}
          </Chip>
          {typeof fileCount === 'number' && (
            <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </Chip>
          )}
        </Box>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
        {lake.description ? (
          <Typography level="body-md" sx={{ whiteSpace: 'pre-wrap' }}>
            {lake.description}
          </Typography>
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            No description.
          </Typography>
        )}
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 2 }}>
          Browse the categories and files in the left sidebar - click a file to read it here.
        </Typography>
      </Box>
    </Box>
  );
}

// Right pane at root: pick-a-lake hint (the lifecycle sections live in the sidebar accordions)

function ManagerOverview() {
  return (
    <Box
      data-testid="datalake-manager-overview"
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        px: 4,
        color: 'text.tertiary',
        textAlign: 'center',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56,
          height: 56,
          borderRadius: 'md',
          backgroundColor: 'background.surface2',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <StorageIcon sx={{ fontSize: 24, color: 'text.tertiary' }} />
      </Box>
      <Typography level="title-lg" sx={{ color: 'text.primary' }}>
        Select a data lake
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', maxWidth: 380 }}>
        Pick a lake on the left to see its details
        <br /> and browse its files, or create a new one.
      </Typography>
    </Box>
  );
}
