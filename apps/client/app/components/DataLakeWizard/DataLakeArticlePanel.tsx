import { useState } from 'react';
import { Box, Button, Chip, Skeleton, Tooltip, Typography } from '@mui/joy';
import ChatIcon from '@mui/icons-material/Chat';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import StorageIcon from '@mui/icons-material/Storage';
import { useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import { useReprocessFabFile } from '@client/app/hooks/data/dataLakes';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import PurgeLakeDocumentAction from '@client/app/components/DataLakeWizard/PurgeLakeDocumentAction';
import RemoveFileFromLakeDialog from './RemoveFileFromLakeDialog';
import type { IFabFileDocument } from '@bike4mind/common';
import { describePipelineStall } from '@bike4mind/common';

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
  lakeName: string;
  /**
   * Whether the caller may manage this lake (admin or creator). Gates the per-file
   * management actions (Re-process, Remove) - lake lists surface other users'
   * read-only public lakes. Absent -> read-only (fail-safe).
   */
  canManage?: boolean;
  /**
   * Whether the caller may DESTROY this document - one rung narrower than `canManage`: a curator or
   * org admin manages membership, but permanent deletion needs lake ownership AND ownership of the
   * file itself (or platform admin), which is exactly what `purgeDataLakeDocument` enforces. Separate
   * prop rather than reusing `canManage`, so nobody meets a red button that 400s after the
   * confirmation. Absent -> no purge door (fail-safe).
   */
  canPurge?: boolean;
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
  lakeName,
  canManage,
  canPurge,
  onAskAbout,
  onRemoved,
}: DataLakeArticlePanelProps) {
  // A purged file is unreadable the instant the receipt comes back, but the selection only clears
  // when the owner dismisses it. Without this the pane re-fetches the signed URL of an object that
  // no longer exists and logs a 404 behind the dialog.
  const [purgedFileId, setPurgedFileId] = useState<string | null>(null);
  const readableFile = file && file.id === purgedFileId ? null : file;
  const { data: content, isLoading } = useGetFabFileContent(readableFile);
  const reprocess = useReprocessFabFile(dataLakeId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const stallNotice = file ? describePipelineStall(file) : null;

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
      {/* pr clears the host modal's absolutely-positioned ModalClose (top-right). */}
      <Box sx={{ px: 3, pr: 6, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>
            {title}
          </Typography>
          {/* These mutate lake content, so they are owner-or-admin only (the backend enforces the
              same). Hidden when viewing a read-only lake. Remove unpicks lake membership and is
              reversible; Delete permanently destroys the document everywhere and is not. */}
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
                  onClick={() => setConfirmRemove(true)}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Remove
                </Button>
              </Tooltip>
              {canPurge && (
                <PurgeLakeDocumentAction
                  file={file}
                  title={title}
                  dataLakeId={dataLakeId}
                  onPurgeComplete={() => setPurgedFileId(file.id)}
                  onPurged={onRemoved}
                />
              )}
            </>
          )}
        </Box>
        {/* Pipeline state (no extractable text, a halted rebuild) is derived from its own fields;
            `notes` is the owner's own text and is shown alongside, not in place of it. */}
        {stallNotice && (
          <Typography level="body-xs" sx={{ color: 'warning.500', mb: 1 }}>
            {'\u26a0\ufe0f'} {stallNotice}
          </Typography>
        )}
        {file.notes && (
          <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
            {file.notes}
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
        {readableFile === null ? (
          <Typography level="body-sm" data-testid="datalake-article-purged" sx={{ color: 'text.tertiary' }}>
            This document has been permanently deleted.
          </Typography>
        ) : isLoading ? (
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

      <RemoveFileFromLakeDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        file={file}
        lakeName={lakeName}
        dataLakeId={dataLakeId}
        onRemoved={onRemoved}
      />
    </Box>
  );
}
