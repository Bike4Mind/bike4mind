import { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemContent,
  Modal,
  ModalDialog,
  Skeleton,
  Tooltip,
  Typography,
} from '@mui/joy';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ArticleIcon from '@mui/icons-material/Article';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChatIcon from '@mui/icons-material/Chat';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { DataLakeIcon } from '@client/app/components/datalake/dataLakeBranding';
import { buildTagTree } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import { useDataLakeFiles, useReprocessFabFile, useRemoveFileFromDataLake } from '@client/app/hooks/data/dataLakes';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import type { IFabFileDocument } from '@bike4mind/common';
import { satisfiesTagPrefix } from '@bike4mind/common';
import DataLakeTreeView, { type DataLakeTreeChrome } from '@client/app/components/datalake/DataLakeTreeView';

// Utilities

function humanizeSegment(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

function cleanFileName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '').replace(/^\[.*?\]\s*/, '');
}

function getMeaningfulTags(file: IFabFileDocument): string[] {
  if (!file.tags) return [];
  return file.tags.map(t => t.name).filter(name => !name.startsWith('datalake:'));
}

// DataLakeViewer

interface DataLakeViewerProps {
  dataLakeId: string;
  dataLakeName: string;
  tagPrefix: string;
  /**
   * Whether the caller may manage this lake (admin or creator). Gates the per-file
   * management actions (Re-process, Remove) - the lake list surfaces other users'
   * read-only public lakes. Absent -> read-only (fail-safe).
   */
  canManage?: boolean;
  onClose?: () => void;
  onAskAbout?: (prompt: string) => void;
}

export default function DataLakeViewer({
  dataLakeId,
  dataLakeName,
  tagPrefix,
  canManage,
  onClose,
  onAskAbout,
}: DataLakeViewerProps) {
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<IFabFileDocument | null>(null);

  const { data: filesResult, isLoading, isError } = useDataLakeFiles(dataLakeId);
  const articles = filesResult?.data ?? [];

  // Build tag tree from articles, filtering to only data lake-specific tags
  const tree = useMemo(() => {
    const prefix = tagPrefix.endsWith(':') ? tagPrefix : tagPrefix + ':';
    const tagCountMap = new Map<string, number>();
    for (const file of articles) {
      for (const tag of file.tags ?? []) {
        if (tag.name.startsWith(prefix) && !tag.name.startsWith('datalake:')) {
          tagCountMap.set(tag.name, (tagCountMap.get(tag.name) ?? 0) + 1);
        }
      }
    }
    const tagCounts = Array.from(tagCountMap.entries()).map(([tag, count]) => ({ tag, count }));
    return buildTagTree(tagCounts);
  }, [articles, tagPrefix]);

  const handleNavigate = useCallback((newBreadcrumb: string[]) => {
    setBreadcrumb(newBreadcrumb);
    setSelectedFile(null);
  }, []);

  const handleSelectFile = useCallback((file: IFabFileDocument) => {
    setSelectedFile(file);
  }, []);

  return (
    <Box data-testid="datalake-viewer" sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Box
        sx={{
          px: 3,
          py: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <DataLakeIcon sx={{ fontSize: 20, color: 'primary.400' }} />
        <Typography level="title-md" sx={{ flex: 1 }}>
          {dataLakeName}
        </Typography>
        {onClose && (
          <Button size="sm" variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
        )}
      </Box>

      {/* Body: sidebar + article */}
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <TreeSidebar
          tree={tree}
          articles={articles}
          tagPrefix={tagPrefix}
          breadcrumb={breadcrumb}
          onNavigate={handleNavigate}
          selectedFileId={selectedFile?.id ?? null}
          onSelectFile={handleSelectFile}
          isLoading={isLoading}
          isError={isError}
        />
        <ArticlePanel
          file={selectedFile}
          onAskAbout={onAskAbout}
          dataLakeId={dataLakeId}
          canManage={canManage}
          onRemoved={() => setSelectedFile(null)}
        />
      </Box>
    </Box>
  );
}

// Tree Sidebar

interface TreeSidebarProps {
  tree: ReturnType<typeof buildTagTree>;
  articles: IFabFileDocument[];
  tagPrefix: string;
  breadcrumb: string[];
  onNavigate: (breadcrumb: string[]) => void;
  selectedFileId: string | null;
  onSelectFile: (file: IFabFileDocument) => void;
  isLoading: boolean;
  isError?: boolean;
}

function TreeSidebar({
  tree,
  articles,
  tagPrefix,
  breadcrumb,
  onNavigate,
  selectedFileId,
  onSelectFile,
  isLoading,
  isError,
}: TreeSidebarProps) {
  // Files in the lake with no prefix-matching (non-meta) tag - surfaced under "Uncategorized".
  // Shares the server's predicate so this bucket holds exactly the files the write doors and the
  // backfill consider uncategorized; a local copy already drifted on the bare-prefix case.
  const prefixNorm = tagPrefix.endsWith(':') ? tagPrefix : `${tagPrefix}:`;
  const uncategorizedFiles = useMemo(
    () =>
      [...articles]
        .filter(
          f =>
            !satisfiesTagPrefix(
              (f.tags ?? []).map(t => t.name),
              prefixNorm
            )
        )
        .sort((a, b) => a.fileName.localeCompare(b.fileName)),
    [articles, prefixNorm]
  );

  const chrome: DataLakeTreeChrome = {
    containerSx: {
      width: 280,
      minWidth: 280,
      borderRight: '1px solid',
      borderColor: 'divider',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    toolbarSx: { p: 1.5, pb: 1, display: 'flex', gap: 0.5, alignItems: 'center' },
    searchPlaceholder: 'Filter...',
    searchSx: { fontSize: '13px', flex: 1 },
    renderSortButton: (sortBy, toggle) => (
      <Tooltip title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'} size="sm">
        <IconButton
          size="sm"
          variant={sortBy === 'alpha' ? 'soft' : 'plain'}
          color="neutral"
          onClick={toggle}
          data-testid="datalake-sort-toggle"
          data-sort={sortBy}
          sx={{ flexShrink: 0 }}
        >
          <SortByAlphaIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    ),
    renderBackRow: (label, onBack) => (
      <ListItemButton onClick={onBack} sx={{ px: 1.5, py: 0.75, gap: 1, minHeight: 36 }} data-testid="datalake-back">
        <ArrowBackIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          {label}
        </Typography>
      </ListItemButton>
    ),
    backRowPlacement: 'above',
    scrollSx: { flex: 1, overflow: 'auto' },
    nodeListSx: { '--ListItem-paddingX': '12px', '--ListItem-paddingY': '4px' },
    fileListSx: { '--ListItem-paddingX': '12px', '--ListItem-paddingY': '6px' },
    renderNodeRow: (node, _depth, onOpen) => (
      <ListItem>
        <ListItemButton
          onClick={onOpen}
          sx={{ borderRadius: 'sm', gap: 1 }}
          data-testid={`datalake-node-${node.segment}`}
        >
          {node.children.length > 0 ? (
            <FolderIcon sx={{ fontSize: 18, color: 'warning.400' }} />
          ) : (
            <FolderOpenIcon sx={{ fontSize: 18, color: 'warning.300' }} />
          )}
          <ListItemContent>
            <Typography level="body-sm" sx={{ fontWeight: 'md' }}>
              {humanizeSegment(node.segment)}
            </Typography>
          </ListItemContent>
          <Chip size="sm" variant="soft" color="neutral" sx={{ minHeight: 20, fontSize: '11px' }}>
            {node.fileCount}
          </Chip>
        </ListItemButton>
      </ListItem>
    ),
    renderFileRow: (file, selected, onSelect) => (
      <ListItem>
        <ListItemButton
          selected={selected}
          onClick={onSelect}
          sx={{ borderRadius: 'sm', gap: 1 }}
          data-testid={`datalake-file-${file.id}`}
        >
          <ArticleIcon sx={{ fontSize: 16, color: 'text.tertiary', flexShrink: 0 }} />
          <ListItemContent>
            <Typography level="body-xs" noWrap sx={{ fontWeight: selected ? 'lg' : undefined }}>
              {file.fileName.replace(/\.[^/.]+$/, '')}
            </Typography>
          </ListItemContent>
        </ListItemButton>
      </ListItem>
    ),
    humanize: segment => humanizeSegment(segment),
    allCategoriesLabel: 'All Categories',
    emptyFilesLabel: 'No files found',
    errorLabel: 'Failed to load files',
  };

  return (
    <DataLakeTreeView
      tree={tree}
      articles={articles}
      breadcrumb={breadcrumb}
      onNavigate={onNavigate}
      selectedFileId={selectedFileId}
      onSelectFile={onSelectFile}
      isLoading={isLoading}
      isError={isError}
      chrome={chrome}
      uncategorized={{
        files: uncategorizedFiles,
        renderRow: (count, onOpen) => (
          <ListItem>
            <ListItemButton
              onClick={onOpen}
              sx={{ borderRadius: 'sm', gap: 1 }}
              data-testid="datalake-node-uncategorized"
            >
              <FolderOpenIcon sx={{ fontSize: 18, color: 'neutral.400' }} />
              <ListItemContent>
                <Typography level="body-sm" sx={{ fontWeight: 'md', fontStyle: 'italic', color: 'text.secondary' }}>
                  Uncategorized
                </Typography>
              </ListItemContent>
              <Chip size="sm" variant="soft" color="neutral" sx={{ minHeight: 20, fontSize: '11px' }}>
                {count}
              </Chip>
            </ListItemButton>
          </ListItem>
        ),
      }}
    />
  );
}

// Article Panel

function ArticlePanel({
  file,
  onAskAbout,
  dataLakeId,
  canManage,
  onRemoved,
}: {
  file: IFabFileDocument | null;
  onAskAbout?: (prompt: string) => void;
  dataLakeId: string;
  canManage?: boolean;
  onRemoved?: () => void;
}) {
  const { data: content, isLoading } = useGetFabFileContent(file);
  const reprocess = useReprocessFabFile(dataLakeId);
  const removeFile = useRemoveFileFromDataLake(dataLakeId);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!file) {
    return (
      <Box
        data-testid="datalake-article-empty"
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          p: 4,
          color: 'text.tertiary',
        }}
      >
        <DataLakeIcon sx={{ fontSize: 48, opacity: 0.4 }} />
        <Typography level="title-lg" sx={{ color: 'text.secondary' }}>
          Select a file
        </Typography>
        <Typography level="body-sm" sx={{ maxWidth: 360, textAlign: 'center' }}>
          Choose a file from the sidebar to view its content.
        </Typography>
      </Box>
    );
  }

  const title = cleanFileName(file.fileName);
  const tags = getMeaningfulTags(file);

  return (
    <Box
      data-testid="datalake-article"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
    >
      <Box sx={{ px: 3, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>
            {title}
          </Typography>
          {/* Re-process and Remove mutate lake content, so they are owner-or-admin only
              (the backend enforces the same). Hidden when viewing a read-only lake. */}
          {canManage && (
            <>
              <Tooltip title="Re-run chunking + vectorization" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  data-testid={`datalake-reprocess-btn-${file.id}`}
                  startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
                  loading={reprocess.isPending}
                  onClick={() => reprocess.mutate(file.id)}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Re-process
                </Button>
              </Tooltip>
              <Tooltip title="Remove this file from the data lake" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="danger"
                  data-testid={`datalake-removefile-btn-${file.id}`}
                  startDecorator={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
                  loading={removeFile.isPending}
                  onClick={() => setConfirmRemove(true)}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Remove
                </Button>
              </Tooltip>
            </>
          )}
        </Box>
        {/* Surfaced from the chunk-pipeline hardening: files that extracted no text are flagged. */}
        {file.notes && (
          <Typography level="body-xs" sx={{ color: 'warning.500', mb: 1 }}>
            ⚠️ {file.notes}
          </Typography>
        )}
        {tags.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {tags.map(tag => (
              <Chip key={tag} size="sm" variant="soft" color="neutral" sx={{ fontSize: '11px' }}>
                {tag}
              </Chip>
            ))}
          </Box>
        )}
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Skeleton variant="text" level="h4" sx={{ width: '60%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '100%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '90%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '70%' }} />
          </Box>
        ) : content ? (
          <MarkdownViewer content={content} />
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Unable to load file content.
          </Typography>
        )}
      </Box>

      {onAskAbout && (
        <Box sx={{ px: 3, py: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Button
            size="sm"
            variant="soft"
            color="primary"
            startDecorator={<ChatIcon sx={{ fontSize: 16 }} />}
            onClick={() => onAskAbout(`Tell me about: ${title}`)}
            sx={{ fontSize: '13px' }}
          >
            Ask about this file
          </Button>
        </Box>
      )}

      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)}>
        <ModalDialog data-testid="datalake-removefile-confirm" role="alertdialog">
          <DialogTitle>Remove file from data lake?</DialogTitle>
          <DialogContent>
            &ldquo;{title}&rdquo; will be removed from this data lake and stops appearing here right away. The file
            stays in your Files list and in any chats that use it, and you can still find it in your own file search.
            Its tags under this lake&apos;s prefix go with it, so it also leaves this lake&apos;s folder groupings.
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="danger"
              data-testid="datalake-removefile-confirm-btn"
              loading={removeFile.isPending}
              onClick={() =>
                removeFile.mutate(file.id, {
                  onSuccess: () => {
                    setConfirmRemove(false);
                    onRemoved?.();
                  },
                })
              }
            >
              Remove
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Box>
  );
}
