import { Box, CircularProgress, IconButton, Modal, ModalClose, ModalDialog, Tooltip, Typography } from '@mui/joy';
import { Download as DownloadIcon, PlayArrow as PlayIcon, Pause as PauseIcon } from '@mui/icons-material';
import { FC, useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { blackAlpha } from '@client/app/utils/themes/colors';

type VideoContainerProps = {
  id?: string;
  src: string;
  index: number;
  totalVideos: number;
  videos: string[];
  onNavigate?: (newIndex: number) => void;
  /**
   * Controls how large the inline video preview renders in the chat.
   * Full-size is still available via the modal on click.
   */
  variant?: 'thumbnail' | 'full';
};

const VideoContainer: FC<VideoContainerProps> = ({ src, index, totalVideos, videos, variant = 'thumbnail' }) => {
  const [openVideo, setOpenVideo] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [currentIndex, setCurrentIndex] = useState<number>(index);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const modalVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setCurrentIndex(index);
  }, [index]);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load video as blob to bypass CORS/Content-Type issues
  useEffect(() => {
    let cancelled = false;

    const loadVideoAsBlob = async () => {
      setIsLoading(true);
      setLoadError(null);
      setBlobUrl(null);

      try {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const blob = await response.blob();
        if (!cancelled) {
          const url = URL.createObjectURL(blob);
          setBlobUrl(url);
          setIsLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch video:', error);
          setLoadError(error instanceof Error ? error.message : 'Failed to load video');
          setIsLoading(false);
        }
      }
    };

    loadVideoAsBlob();

    return () => {
      cancelled = true;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [src, retryCount]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  const handleRetry = () => {
    setLoadError(null);
    setRetryCount(prev => prev + 1);
  };

  const handleVideoError = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = e.currentTarget;
    const errorCode = video.error?.code;
    const errorMessage = video.error?.message || 'Unknown error';

    // Map error codes to human-readable messages
    const errorCodes: Record<number, string> = {
      1: 'MEDIA_ERR_ABORTED - Video loading was aborted',
      2: 'MEDIA_ERR_NETWORK - Network error while loading video',
      3: 'MEDIA_ERR_DECODE - Video decoding failed',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - Video format not supported or CORS issue',
    };

    const friendlyError = errorCode ? errorCodes[errorCode] || `Error code: ${errorCode}` : errorMessage;
    console.error('Failed to load video: ', src, '\nError:', friendlyError, '\nRaw error:', video.error);
    setLoadError(friendlyError);
  };

  const handleDownloadVideo = async () => {
    setDownloading(true);
    try {
      const response = await fetch(src);
      const blob = await response.blob();

      const url = URL.createObjectURL(blob);
      const filename = `video_${Date.now()}.mp4`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();

      URL.revokeObjectURL(url);
      toast.success('Video downloaded successfully');
    } catch (error) {
      console.error('Failed to download video: ', error);
      toast.error(`Failed to download video: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloading(false);
    }
  };

  const togglePlay = () => {
    const video = openVideo ? modalVideoRef.current : videoRef.current;
    if (video) {
      if (video.paused) {
        video.play();
        setIsPlaying(true);
      } else {
        video.pause();
        setIsPlaying(false);
      }
    }
  };

  const videoActions = (
    <>
      <Tooltip title={isPlaying ? 'Pause' : 'Play'}>
        <IconButton
          onClick={togglePlay}
          size="sm"
          variant="outlined"
          color="neutral"
          sx={{ borderRadius: '50%' }}
          data-testid="video-play-btn"
        >
          {isPlaying ? <PauseIcon sx={{ fontSize: 18 }} /> : <PlayIcon sx={{ fontSize: 18 }} />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Download Video">
        <IconButton
          onClick={handleDownloadVideo}
          disabled={downloading}
          size="sm"
          variant="outlined"
          color="neutral"
          sx={{ borderRadius: '50%' }}
          data-testid="video-download-btn"
        >
          {downloading ? <CircularProgress size="sm" /> : <DownloadIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </>
  );

  const isThumbnail = variant === 'thumbnail';
  const previewSize = isThumbnail ? 200 : 400;

  return (
    <Box
      className="video-container"
      sx={{
        display: 'flex',
        position: 'relative',
        '&:hover .video-actions': {
          opacity: 1,
        },
      }}
    >
      <Box
        className="video-actions"
        sx={{
          position: 'absolute',
          top: 6,
          right: 6,
          zIndex: 1,
          display: 'flex',
          gap: '.25rem',
          backgroundColor: (theme: any) => theme.palette.common?.imageActions?.backgroundColor || 'rgba(0, 0, 0, 0.7)',
          borderRadius: '1rem',
          padding: '.25rem',
          opacity: isThumbnail ? 0 : 1,
          transition: 'opacity 0.2s ease',
        }}
      >
        {videoActions}
      </Box>

      <Box
        tabIndex={0}
        onClick={() => setOpenVideo(true)}
        sx={{
          display: 'flex',
          overflow: 'hidden',
          borderRadius: '8px',
          cursor: 'pointer',
          transition: 'all 0.3s ease',
          width: previewSize,
          height: Math.round(previewSize * 0.5625), // 16:9 aspect ratio
          backgroundColor: theme => theme.palette.background.level1,
          position: 'relative',

          '&:hover video': {
            opacity: 0.9,
            transform: 'scale(1.02)',
            transition: 'all 0.3s ease',
          },
        }}
        data-testid="video-thumbnail"
      >
        {isLoading ? (
          <Box
            sx={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CircularProgress size="sm" />
          </Box>
        ) : loadError ? (
          <Box
            sx={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              p: 2,
              textAlign: 'center',
            }}
          >
            <Typography level="body-xs" sx={{ color: 'danger.500', mb: 1 }}>
              {loadError}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Typography
                level="body-xs"
                onClick={handleRetry}
                sx={{ color: '#0066cc', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Retry
              </Typography>
              <Typography level="body-xs">|</Typography>
              <Typography level="body-xs">
                <a href={src} target="_blank" rel="noopener noreferrer" style={{ color: '#0066cc' }}>
                  Open directly →
                </a>
              </Typography>
            </Box>
          </Box>
        ) : blobUrl ? (
          <video
            ref={videoRef}
            src={blobUrl}
            width={previewSize}
            height={Math.round(previewSize * 0.5625)}
            onError={handleVideoError}
            style={{
              objectFit: 'cover',
              maxWidth: '100%',
              transition: 'all 0.3s ease',
            }}
            muted
            playsInline
            preload="metadata"
          />
        ) : null}
        {/* Play icon overlay - only show when no error */}
        {!loadError && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              backgroundColor: blackAlpha[0][50],
              borderRadius: '50%',
              width: 48,
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PlayIcon sx={{ color: 'white', fontSize: 32 }} />
          </Box>
        )}
      </Box>

      <Modal open={openVideo} onClose={() => setOpenVideo(false)}>
        <ModalDialog sx={{ minWidth: '90vw', minHeight: '90vh' }}>
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
              Video {currentIndex + 1} of {totalVideos}
            </Typography>
            <Box sx={{ display: 'flex', gap: '.5rem' }}>{videoActions}</Box>
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
            {blobUrl ? (
              <video
                ref={modalVideoRef}
                src={blobUrl}
                controls
                autoPlay
                style={{
                  maxWidth: '100%',
                  maxHeight: '80vh',
                  objectFit: 'contain',
                }}
                onError={handleVideoError}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <CircularProgress />
                <Typography level="body-sm">Loading video...</Typography>
              </Box>
            )}
          </Box>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default VideoContainer;
