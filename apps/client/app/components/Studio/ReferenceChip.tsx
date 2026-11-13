import { Chip, CircularProgress, IconButton, Sheet, Stack, Switch, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { useGetFabFile } from '@client/app/hooks/data/fabFileQueries';
import type { ReferenceCutout, ReferenceFile } from './capabilityFields';
import { CHECKERBOARD_SX } from './checkerboard';

// Longest side of the cutout preview, in px.
const PREVIEW_SIZE = 96;

type ReferenceChipProps = {
  file: ReferenceFile;
  disabled?: boolean;
  testId: string;
  onRemove: (fileId: string) => void;
  onToggleCutout?: (fileId: string, on: boolean) => void;
};

// GET /api/files/:id signs the file, so the cutout renders straight from its record.
const CutoutPreview = ({ fileId, alt, testId }: { fileId: string; alt: string; testId: string }) => {
  // Saved moments before the job succeeded, so its signed URL appears only once upload moderation clears.
  const file = useGetFabFile(fileId, { pollUntilViewable: true });
  return (
    <Sheet
      variant="outlined"
      sx={{ ...CHECKERBOARD_SX, width: PREVIEW_SIZE, height: PREVIEW_SIZE, borderRadius: 'sm', overflow: 'hidden' }}
      data-testid={`${testId}-preview`}
    >
      {file.data?.fileUrl ? (
        <img src={file.data.fileUrl} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : file.data?.moderationStatus === 'blocked' ? (
        <Stack alignItems="center" justifyContent="center" height="100%" sx={{ px: 1 }}>
          <Typography level="body-xs" textAlign="center" data-testid={`${testId}-preview-unavailable`}>
            Preview unavailable
          </Typography>
        </Stack>
      ) : (
        <Stack alignItems="center" justifyContent="center" height="100%">
          <CircularProgress size="sm" />
        </Stack>
      )}
    </Sheet>
  );
};

const CutoutStatus = ({ cutout, fileName, testId }: { cutout: ReferenceCutout; fileName: string; testId: string }) => {
  switch (cutout.status) {
    case 'pending':
      return (
        <Stack direction="row" alignItems="center" gap={1} data-testid={`${testId}-pending`}>
          <CircularProgress size="sm" />
          <Typography level="body-xs">Removing background...</Typography>
        </Stack>
      );
    case 'ready':
      return <CutoutPreview fileId={cutout.fileId} alt={`${fileName} without its background`} testId={testId} />;
    case 'failed':
      return (
        <Typography level="body-xs" color="danger" data-testid={`${testId}-failed`}>
          {cutout.message}
        </Typography>
      );
  }
};

/**
 * One reference image. With `onToggleCutout`, it offers "Remove background": the cutout replaces the original as the
 * reference once ready, shown on a checkerboard so its transparency is visible.
 */
const ReferenceChip = ({ file, disabled, testId, onRemove, onToggleCutout }: ReferenceChipProps) => {
  const chipTestId = `${testId}-file-${file.fileId}`;
  const removeButton = (
    <IconButton
      size="sm"
      variant="plain"
      aria-label={`Remove ${file.fileName}`}
      disabled={disabled}
      onClick={() => onRemove(file.fileId)}
      data-testid={`${testId}-remove-${file.fileId}-btn`}
    >
      <CloseIcon fontSize="small" />
    </IconButton>
  );
  if (!onToggleCutout) {
    return (
      <Chip variant="soft" data-testid={chipTestId} endDecorator={removeButton}>
        {file.fileName}
      </Chip>
    );
  }
  const cutoutTestId = `${testId}-cutout-${file.fileId}`;
  return (
    <Sheet
      variant="soft"
      sx={{ borderRadius: 'md', p: 1, display: 'flex', flexDirection: 'column', gap: 0.75, maxWidth: 240 }}
      data-testid={chipTestId}
    >
      <Stack direction="row" alignItems="center" gap={1}>
        <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {file.fileName}
        </Typography>
        {removeButton}
      </Stack>
      <Switch
        size="sm"
        checked={file.cutout !== undefined}
        disabled={disabled}
        onChange={event => onToggleCutout(file.fileId, event.target.checked)}
        endDecorator={<Typography level="body-xs">Remove background</Typography>}
        slotProps={{
          input: { 'data-testid': `${cutoutTestId}-switch`, 'aria-label': `Remove background from ${file.fileName}` },
        }}
      />
      {file.cutout && <CutoutStatus cutout={file.cutout} fileName={file.fileName} testId={cutoutTestId} />}
    </Sheet>
  );
};

export default ReferenceChip;
