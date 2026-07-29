import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalDialog,
  Skeleton,
  Tooltip,
  Typography,
} from '@mui/joy';
import ChatIcon from '@mui/icons-material/Chat';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import StorageIcon from '@mui/icons-material/Storage';
import { useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import { useReprocessFabFile, useRemoveFileFromDataLake } from '@client/app/hooks/data/dataLakeWizard';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import type { IFabFileDocument } from '@bike4mind/common';

function cleanFileName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '').replace(/^\[.*?\]\s*/, '');
}

function getMeaningfulTags(file: IFabFileDocument): string[] {
  if (!file.tags) return [];
  return file.tags.map(t => t.name).filter(name => !name.startsWith('datalake:'));
}

interface DataLakeArticlePanelProps {
  file: IFabFileDocument | null;
  dataLakeId: string;
  /**
   * Whether the caller may manage this lake (admin or creator). Gates the per-file
   * management actions (Re-process, Remove) - lake lists surface other users'
   * read-only public lakes. Absent -> read-only (fail-safe).
   */
  canManage?: boolean;
  onAskAbout?: (prompt: string) => void;
  onRemoved?: () => void;
}

/**
 * Read pane for one data-lake file: title + tags header, markdown content, and the
 * owner-or-admin file actions. Shared by the manager modal's right pane (and any
 * future lake read surface).
 */
export default function DataLakeArticlePanel({
  file,
  dataLakeId,
  canManage,
  onAskAbout,
  onRemoved,
}: DataLakeArticlePanelProps) {
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
        <StorageIcon sx={{ fontSize: 48, opacity: 0.4 }} />
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
            “{title}” will be removed from this data lake. The file stays in your Files list and any chats that use it —
            only its membership in this lake is removed. It stops appearing here right away; some search backends finish
            clearing it on the lake&apos;s next sync.
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
