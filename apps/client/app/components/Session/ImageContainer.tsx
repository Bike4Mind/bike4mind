import { IChatHistoryItemDocument, KnowledgeType, extensionFromMimeType } from '@bike4mind/common';
import { CreateFabFileRequestInputType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload, copyGeneratedImageToFabFile } from '@client/app/utils/filesAPICalls';
import {
  ContentCopy as ContentCopyIcon,
  Download as DownloadIcon,
  Edit as EditIcon,
  Description as DescriptionIcon,
} from '@mui/icons-material';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Modal,
  ModalClose,
  ModalDialog,
  Tooltip,
  Typography,
} from '@mui/joy';
import SaveIcon from '@mui/icons-material/Save';
import { ArrowBack as ArrowBackIcon, ArrowForward as ArrowForwardIcon } from '@mui/icons-material';
import { FC, useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import ImageMaskerFlux from './ImageMaskerFlux';
import { ImageModerationPlaceholder } from './ImageModerationPlaceholder';
import { SendMessageOptions } from '@client/app/utils/llm';
import { blackAlpha, whiteAlpha } from '@client/app/utils/themes/colors';

// Add FabAPI interface
interface FabAPI {
  saveFile: (file: File) => Promise<any>;
}

// Extend Window interface
declare global {
  interface Window {
    FabAPI?: FabAPI;
  }
}

type ImageContainerProps = {
  id?: string;
  src: string;
  index: number;
  totalImages: number;
  images: string[];
  onSendMessage: (message: Partial<IChatHistoryItemDocument>, options: SendMessageOptions) => Promise<void>;
  onNavigate?: (newIndex: number) => void;
  /**
   * Controls how large the inline image preview renders in the chat.
   * Full-size is still available via the modal on click.
   */
  variant?: 'thumbnail' | 'full';
  /**
   * Content-moderation state of the backing FabFile. Only set for
   * user-uploaded images; generated images have no moderation gating.
   * A 'blocked' or not-yet-'clean' image is served with `src` empty by the
   * server, so `moderationStatus` is what lets us tell "still scanning" apart
   * from "blocked" instead of showing a broken image. 'scanning' (atomic-claim
   * interim state) renders identically to 'pending' below - both are "not
   * blocked, not null, no src yet" - so it isn't special-cased separately.
   */
  moderationStatus?: 'pending' | 'scanning' | 'clean' | 'blocked';
};

// Extract the S3 key from an image URL
const extractS3KeyFromUrl = (imageUrl: string): string | null => {
  try {
    const url = new URL(imageUrl);

    // Check if it's an S3 URL (either S3 domain or presigned URL)
    if (url.hostname.includes('generatedimagesbucket') || url.hostname.includes('s3')) {
      // Extract the path, removing leading slash
      const pathname = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      return pathname;
    }

    return null;
  } catch (error) {
    console.error('Error parsing image URL:', error);
    return null;
  }
};

// Whether an image URL points at the generated-images bucket
const isGeneratedImage = (imageUrl: string): boolean => {
  return imageUrl.includes('generatedimagesbucket');
};

// Build a sensible filename for a downloaded/saved generated asset.
// Prefer the real basename from the source URL (preserves names like
// "report-1a2b3c4d.xlsx"); otherwise fall back to a timestamped name with an
// extension derived from the blob's MIME type. Deriving the extension via
// extensionFromMimeType avoids bogus extensions like ".sheet" that result from
// naively splitting structured MIME types such as
// application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
const getAssetFilename = (sourceUrl: string, blob: Blob): string => {
  try {
    const { pathname } = new URL(sourceUrl, window.location.origin);
    const basename = decodeURIComponent(pathname.split('/').pop() || '');
    if (basename.includes('.')) {
      return basename;
    }
  } catch {
    // Fall through to MIME-based naming for relative/invalid URLs
  }
  const ext = extensionFromMimeType(blob.type) || 'jpg';
  return `image_${Date.now()}.${ext}`;
};

const ImageContainer: FC<ImageContainerProps> = ({
  id,
  src,
  index,
  totalImages,
  images,
  onNavigate,
  onSendMessage,
  variant = 'thumbnail',
  moderationStatus,
}) => {
  const [openImage, setOpenImage] = useState<boolean>(false);
  const [copying, setCopying] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [currentIndex, setCurrentIndex] = useState<number>(index);
  const [editing, setEditing] = useState<boolean>(false);

  useEffect(() => {
    setCurrentIndex(index);
  }, [index]);

  const handleNavigate = useCallback(
    (newIndex: number) => {
      setCurrentIndex(newIndex);
      if (onNavigate) {
        onNavigate(newIndex);
      }
    },
    [onNavigate, setCurrentIndex]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!openImage) return;

      switch (e.key) {
        case 'ArrowLeft':
          if (currentIndex > 0) {
            handleNavigate(currentIndex - 1);
          }
          break;
        case 'ArrowRight':
          if (currentIndex < totalImages - 1) {
            handleNavigate(currentIndex + 1);
          }
          break;
        case 'Escape':
          setOpenImage(false);
          break;
        default:
          break;
      }
    },
    [currentIndex, openImage, totalImages, handleNavigate]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  const handleImageError = () => {
    console.error('Failed to load image: ', src);
  };

  const handleImageEdit = async (sourceImageUrl: string, base64Mask: string, prompt: string) => {
    setEditing(true);
    try {
      // Convert base64 to blob
      const byteString = atob(base64Mask);
      const mimeString = 'image/png';
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);

      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }

      const blob = new Blob([ab], { type: mimeString });

      // Prepare the form data for Fab file
      const formData: CreateFabFileRequestInputType = {
        type: KnowledgeType.FILE,
        fileName: `image_mask_${Date.now()}.png`,
        mimeType: 'image/png',
        fileSize: blob.size,
      };

      // Create a File object from the blob
      const file = new File([blob], formData.fileName, { type: blob.type });

      // Save as FabFile
      const maskFabFile = await createFabFileOnServerWithUpload(formData, file);
      await onSendMessage({ fabFileIds: [maskFabFile.id], prompt }, { isImageEdit: true, image: sourceImageUrl });
      setEditing(false);
    } catch (error) {
      console.error('Failed to copy image: ', error);
      toast.error(`Failed to copy image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setEditing(false);
    }
  };

  const handleSaveImage = async () => {
    setSaving(true);
    try {
      // Get the current image URL (which may be the original or the one at currentIndex)
      const currentImageUrl = images[currentIndex];

      // Check if this is a generated image (from generatedImagesBucket)
      if (isGeneratedImage(currentImageUrl)) {
        // Extract the S3 key from the URL
        const s3Key = extractS3KeyFromUrl(currentImageUrl);

        if (!s3Key) {
          throw new Error('Unable to extract S3 key from image URL');
        }

        // Use the server-side copy endpoint to avoid CORS issues
        const fileName = `image_${Date.now()}.png`;
        await copyGeneratedImageToFabFile(s3Key, fileName);

        toast.success('Image saved to your files');
      } else {
        // For images not from generatedImagesBucket, use the original approach
        // Get a fresh signed URL for the current image
        const freshUrl = src;

        // Fetch the image using the fresh signed URL
        const response = await fetch(freshUrl);
        const blob = await response.blob();

        // Prepare the form data
        const formData: CreateFabFileRequestInputType = {
          type: KnowledgeType.FILE,
          fileName: getAssetFilename(freshUrl, blob),
          mimeType: blob.type,
          fileSize: blob.size,
        };

        // Create a File object from the blob
        const file = new File([blob], formData.fileName, { type: blob.type });

        // Save as FabFile - this will use the filesStorage (FabFilesBucket)
        await createFabFileOnServerWithUpload(formData, file);

        toast.success('Image saved to your files');
      }
    } catch (error) {
      console.error('Failed to save image: ', error);
      toast.error(`Failed to save image: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Fallback to desktop app API if available
      if (window.FabAPI?.saveFile) {
        try {
          const freshUrl = await src;
          const response = await fetch(freshUrl);
          const blob = await response.blob();
          const filename = getAssetFilename(freshUrl, blob);
          const file = new File([blob], filename, { type: blob.type });
          await window.FabAPI.saveFile(file);
          toast.success('Image saved using desktop app');
        } catch (fallbackError) {
          console.error('Desktop app fallback also failed:', fallbackError);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCopyImage = async () => {
    setCopying(true);
    try {
      // Get a fresh signed URL for the current image
      const freshUrl = src;

      // Fetch the image
      const response = await fetch(freshUrl);
      const blob = await response.blob();

      try {
        // Try to use the clipboard API
        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type]: blob,
          }),
        ]);
        toast.success('Image copied to clipboard');
      } catch (clipboardError) {
        console.error('Clipboard API failed:', clipboardError);

        // Fallback - open in new tab
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        toast.success('Image opened in a new tab. Right-click and select "Copy Image" to copy it.');
      }
    } catch (error) {
      console.error('Failed to copy image: ', error);
      toast.error(`Failed to copy image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setCopying(false);
    }
  };

  const handleDownloadImage = async () => {
    setDownloading(true);
    try {
      // Get a fresh signed URL for the current image
      const freshUrl = src;

      // Fetch the image
      const response = await fetch(freshUrl);
      const blob = await response.blob();

      // Create a download link
      const url = URL.createObjectURL(blob);
      const filename = getAssetFilename(freshUrl, blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    } catch (error) {
      console.error('Failed to download image: ', error);
      toast.error(`Failed to download image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloading(false);
    }
  };

  // Prepare image action buttons
  const imageActions = (
    <>
      <Tooltip title="Save Image">
        <IconButton
          onClick={handleSaveImage}
          disabled={saving}
          size="sm"
          variant="outlined"
          color="neutral"
          sx={{ borderRadius: '50%' }}
          data-testid="image-save-btn"
        >
          {saving ? <CircularProgress size="sm" /> : <SaveIcon sx={{ fontSize: 18 }} />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Copy Image">
        <IconButton
          onClick={handleCopyImage}
          disabled={copying}
          size="sm"
          variant="outlined"
          color="neutral"
          sx={{ borderRadius: '50%' }}
          data-testid="image-copy-btn"
        >
          {copying ? <CircularProgress size="sm" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Download Image">
        <IconButton
          onClick={handleDownloadImage}
          disabled={downloading}
          size="sm"
          variant="outlined"
          color="neutral"
          sx={{ borderRadius: '50%' }}
          data-testid="image-download-btn"
        >
          {downloading ? <CircularProgress size="sm" /> : <DownloadIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Edit Image">
        <Box component="span" sx={{ display: 'inline-block' }}>
          <IconButton
            onClick={() => setEditing(true)}
            disabled={editing}
            size="sm"
            variant="outlined"
            color="neutral"
            sx={{ borderRadius: '50%' }}
            data-testid="image-edit-btn"
          >
            {editing ? <CircularProgress size="sm" /> : <EditIcon fontSize="small" />}
          </IconButton>
        </Box>
      </Tooltip>
    </>
  );

  const isThumbnail = variant === 'thumbnail';
  const previewSize = isThumbnail ? 140 : 350;

  // Content-moderation gating: same condition the inline preview below uses to
  // decide placeholder-vs-<img>. A blocked image never gets a serveable URL, and
  // an empty `src` means the scan hasn't cleared it yet - in either case there is
  // nothing viewable to open in the lightbox modal.
  const isImageViewable = moderationStatus !== 'blocked' && !!src;

  // Check if this is an Excel file (handle signed URLs with query params)
  const isExcelFile = (() => {
    try {
      const url = new URL(src, window.location.origin);
      return url.pathname.endsWith('.xlsx');
    } catch {
      // Fallback for relative paths or invalid URLs
      return src.split('?')[0].endsWith('.xlsx');
    }
  })();

  // Render Excel file as a download card instead of image preview
  if (isExcelFile) {
    return (
      <Box
        className="excel-container"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          p: 2,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 'sm',
          bgcolor: 'background.level1',
          width: 200,
          height: 160,
        }}
        data-testid="excel-file-container"
      >
        <DescriptionIcon sx={{ fontSize: 48, color: '#217346' }} />
        <Typography level="body-sm" sx={{ mt: 1, fontWeight: 'md' }}>
          Excel Spreadsheet
        </Typography>
        <Button
          size="sm"
          variant="solid"
          color="success"
          sx={{ mt: 1.5 }}
          onClick={handleDownloadImage}
          disabled={downloading}
          startDecorator={downloading ? <CircularProgress size="sm" /> : <DownloadIcon />}
          data-testid="excel-download-btn"
        >
          {downloading ? 'Downloading...' : 'Download'}
        </Button>
      </Box>
    );
  }

  return (
    <Box
      className="image-container"
      sx={{
        display: 'flex',
        position: 'relative',
        '&:hover .image-actions': {
          opacity: 1,
        },
      }}
    >
      <Box
        className="image-actions"
        sx={{
          position: 'absolute',
          top: 6,
          right: 6,
          zIndex: 1,
          display: 'flex',
          gap: '.25rem',
          backgroundColor: (theme: any) => theme.palette.common.imageActions.backgroundColor,
          borderRadius: '1rem',
          padding: '.25rem',
          opacity: isThumbnail ? 0 : 1,
          transition: 'opacity 0.2s ease',
        }}
      >
        {imageActions}
      </Box>

      <Box
        tabIndex={0}
        onClick={isImageViewable ? () => setOpenImage(true) : undefined}
        sx={{
          display: 'flex',
          overflow: 'hidden',
          borderRadius: '8px',
          cursor: isImageViewable ? 'pointer' : 'default',
          transition: 'all 0.3s ease',
          width: previewSize,
          height: previewSize,
          backgroundColor: theme => theme.palette.background.level1,

          '&:hover img': {
            opacity: 0.9,
            transform: 'scale(1.02)',
            transition: 'all 0.3s ease',
          },
        }}
        data-testid="image-thumbnail"
      >
        {moderationStatus === 'blocked' ? (
          <ImageModerationPlaceholder status="blocked" size={previewSize} />
        ) : moderationStatus != null && !src ? (
          // Content-moderation gating: a not-yet-clean image is served by the
          // server with no fileUrl/presignedUrl, so an empty `src` here means
          // the scan hasn't cleared it yet. Never render a broken <img> - show
          // the scanning placeholder instead. Gated on `moderationStatus != null`
          // - only user-uploaded FabFile images get that prop; generated reply
          // images (PromptReplies.tsx) never pass it, so a transiently-empty
          // `src` there falls through to the plain <img> below (prior behavior)
          // instead of the upload-scanning copy.
          <ImageModerationPlaceholder status="scanning" size={previewSize} />
        ) : (
          <img
            src={src}
            height={previewSize}
            width={previewSize}
            alt={`Generated image ${index + 1} of ${totalImages}`}
            onError={handleImageError}
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
            style={{
              objectFit: isThumbnail ? 'cover' : 'scale-down',
              maxWidth: '100%',
              margin: 'auto',
              transition: 'all 0.3s ease',
            }}
            loading="eager"
            data-testid="ai-response-image"
          />
        )}
      </Box>

      <Modal open={openImage} onClose={() => setOpenImage(false)}>
        <ModalDialog sx={{ minWidth: '90vw', minHeight: '90vh' }} data-testid="image-preview-modal">
          <Box
            sx={{
              zIndex: 1,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingRight: '2rem',
              paddingLeft: '2rem',
            }}
          >
            <Typography level="body-sm">
              Image {currentIndex + 1} of {totalImages}
            </Typography>
            <Box sx={{ display: 'flex', gap: '.5rem' }}>{imageActions}</Box>
          </Box>
          <ModalClose />

          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              position: 'relative',
              width: '100%',
              height: '100%',
              backgroundColor: blackAlpha[0][50],
            }}
          >
            {currentIndex > 0 && (
              <IconButton
                onClick={() => handleNavigate(currentIndex - 1)}
                data-testid="image-nav-prev-btn"
                sx={{
                  position: 'absolute',
                  left: '1rem',
                  backgroundColor: whiteAlpha[0][10],
                  '&:hover': {
                    backgroundColor: whiteAlpha[0][20],
                  },
                }}
              >
                <ArrowBackIcon />
              </IconButton>
            )}

            <img
              src={images[currentIndex]}
              height={'700em'}
              alt={`Generated image ${currentIndex + 1} of ${totalImages}`}
              onError={handleImageError}
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              style={{ objectFit: 'scale-down' }}
              data-testid="ai-response-image"
            />

            {currentIndex < totalImages - 1 && (
              <IconButton
                onClick={() => handleNavigate(currentIndex + 1)}
                data-testid="image-nav-next-btn"
                sx={{
                  position: 'absolute',
                  right: '1rem',
                  backgroundColor: whiteAlpha[0][10],
                  '&:hover': {
                    backgroundColor: whiteAlpha[0][20],
                  },
                }}
              >
                <ArrowForwardIcon />
              </IconButton>
            )}
          </Box>
        </ModalDialog>
      </Modal>

      {editing && (
        <ImageMaskerFlux open={editing} onSave={handleImageEdit} imageUrl={src} onClose={() => setEditing(false)} />
      )}
    </Box>
  );
};

export default ImageContainer;
