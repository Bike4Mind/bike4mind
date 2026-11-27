import { CircularProgress, Sheet } from '@mui/joy';
import { useGetFabFile } from '@client/app/hooks/data/fabFileQueries';

// Longest side of the thumbnail, in px.
const PREVIEW_SIZE = 64;

/** A Files image as a small thumbnail; GET /api/files/:id signs it, so it renders straight from its record. */
const ImageFieldPreview = ({ fileId, alt, testId }: { fileId: string; alt: string; testId: string }) => {
  const file = useGetFabFile(fileId);
  const url = file.data?.fileUrl;
  return (
    <Sheet
      variant="outlined"
      sx={{
        width: PREVIEW_SIZE,
        height: PREVIEW_SIZE,
        borderRadius: 'sm',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      data-testid={`${testId}-preview`}
    >
      {url ? (
        <img src={url} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        file.isPending && <CircularProgress size="sm" />
      )}
    </Sheet>
  );
};

export default ImageFieldPreview;
