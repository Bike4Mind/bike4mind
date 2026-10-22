import { useState } from 'react';
import { Box, Button, Chip, DialogContent, DialogTitle, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { useDataLakeSkippedFiles } from '@client/app/hooks/data/dataLakes';
import { formatBytes } from '@client/app/utils/folderTreeParser';
import { SKIPPED_FILE_REASON_LABELS, skippedFilesChipLabel } from './skippedFileReasons';

export function LakeSkippedFilesDialog({
  open,
  onClose,
  lakeId,
  lakeName,
}: {
  open: boolean;
  onClose: () => void;
  lakeId: string;
  lakeName: string;
}) {
  const { data, files, total, hasMore, loadMore, isLoadingMore, isLoading, isFetchNextPageError } =
    useDataLakeSkippedFiles(lakeId, open);
  // A failed load-more or background refetch keeps the rows already fetched; only a first load with
  // nothing to show reads as an error.
  const hasRows = data !== undefined;

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog data-testid="lake-skipped-files-dialog" sx={{ width: 'min(640px, 95vw)', maxHeight: '85vh' }}>
        <ModalClose aria-label="Close skipped files dialog" data-testid="lake-skipped-files-close-btn" />
        <DialogTitle>{`Files not ingested - ${lakeName}`}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Typography level="body-sm" sx={{ mb: 0.5 }}>
            These files are in the connected source but were not added to the lake.
          </Typography>
          {hasRows && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }}>
              {total === 1 ? '1 file' : `${total} files`}
            </Typography>
          )}
          {isLoading && (
            <Typography level="body-sm" data-testid="lake-skipped-files-loading">
              Loading...
            </Typography>
          )}
          {!isLoading && !hasRows && (
            <Typography level="body-sm" color="danger" data-testid="lake-skipped-files-error">
              Could not load the skipped files. Try again shortly.
            </Typography>
          )}
          {hasRows && (
            <Box
              component="ul"
              data-testid="lake-skipped-files-list"
              sx={{
                listStyle: 'none',
                m: 0,
                p: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              {files.map(file => (
                <Box
                  component="li"
                  key={file.id}
                  data-testid={`lake-skipped-files-row-${file.id}`}
                  sx={{ minWidth: 0 }}
                >
                  <Typography level="title-sm" noWrap>
                    {file.name}
                  </Typography>
                  {file.relativePath && file.relativePath !== file.name && (
                    <Typography level="body-xs" textColor="text.tertiary" noWrap>
                      {file.relativePath}
                    </Typography>
                  )}
                  <Typography level="body-xs">
                    {SKIPPED_FILE_REASON_LABELS[file.reason]}
                    {file.size !== undefined && ` (${formatBytes(file.size)})`}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
          {isFetchNextPageError && (
            <Typography level="body-xs" color="danger" sx={{ mt: 1 }} data-testid="lake-skipped-files-load-more-error">
              Could not load more files. Try again.
            </Typography>
          )}
          {hasMore && (
            <Button
              size="sm"
              variant="outlined"
              loading={isLoadingMore}
              onClick={() => loadMore()}
              sx={{ mt: 1.5, alignSelf: 'flex-start' }}
              data-testid="lake-skipped-files-load-more"
            >
              Load more
            </Button>
          )}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}

export default function LakeSkippedFilesChip({
  lakeId,
  lakeName,
  canManage,
}: {
  lakeId: string;
  lakeName: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data, total } = useDataLakeSkippedFiles(lakeId, canManage);

  // Keyed on data, not isError: a failed load-more or refetch keeps the data and must not unmount
  // the open dialog with it.
  if (!canManage || data === undefined || total === 0) return null;

  return (
    <>
      <Chip
        size="sm"
        variant="soft"
        color="warning"
        onClick={() => setOpen(true)}
        sx={{ fontSize: '11px', cursor: 'pointer' }}
        data-testid={`datalake-skipped-files-chip-${lakeId}`}
      >
        {skippedFilesChipLabel(total)}
      </Chip>
      <LakeSkippedFilesDialog open={open} onClose={() => setOpen(false)} lakeId={lakeId} lakeName={lakeName} />
    </>
  );
}
