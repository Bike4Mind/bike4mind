import { isVideoMimeType, type IFabFileDocument } from '@bike4mind/common';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { downloadData } from '@client/app/utils/download';
import DownloadIcon from '@mui/icons-material/Download';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

// Signed file URLs last an hour; one this close to expiry is re-signed before it is handed to the element.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type MediaPlayerFile = Pick<
  IFabFileDocument,
  'id' | 'fileName' | 'mimeType' | 'fileUrl' | 'presignedUrl' | 'fileUrlExpireAt'
>;

type MediaPlayerProps = {
  file: MediaPlayerFile;
  /** 'none' keeps a long list from fetching every file up front; video defaults to 'metadata' for its poster frame. */
  preload?: 'none' | 'metadata';
  /** Hides the download button where the surrounding UI already offers one. */
  hideDownload?: boolean;
};

const isExpiring = (expireAt: MediaPlayerFile['fileUrlExpireAt']): boolean =>
  !!expireAt && new Date(expireAt).getTime() - Date.now() < REFRESH_MARGIN_MS;

const PlayerBody: FC<MediaPlayerProps> = ({ file, preload = 'metadata', hideDownload = false }) => {
  const { t } = useTranslation();
  const isVideo = isVideoMimeType(file.mimeType);
  const [src, setSrc] = useState(file.fileUrl || file.presignedUrl);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // One re-sign per failure: a URL that still fails right after re-signing is a missing or unplayable file.
  const refreshedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshedRef.current) {
      setFailed(true);
      return;
    }
    refreshedRef.current = true;
    try {
      const fresh = await getFabFileByIdFromServer(file.id);
      if (!fresh.fileUrl) throw new Error('no signed url');
      setSrc(fresh.fileUrl);
    } catch {
      setFailed(true);
    }
  }, [file.id]);

  useEffect(() => {
    if (!src || isExpiring(file.fileUrlExpireAt)) void refresh();
    // Mount only: the element keeps its own src afterwards, so a parent re-render with a re-signed URL
    // does not restart playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => {
    refreshedRef.current = false;
    setFailed(false);
    void refresh();
  };

  const download = async () => {
    if (!src) return;
    setDownloading(true);
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      downloadData(await response.blob(), file.fileName);
    } catch (error) {
      console.error('Media download failed:', error);
      toast.error(t('media_player.download_failed'));
    } finally {
      setDownloading(false);
    }
  };

  if (failed) {
    return (
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        data-testid="media-player-error"
        onClick={event => event.stopPropagation()}
        sx={{ py: 0.5 }}
      >
        <ErrorOutlineIcon color="error" fontSize="small" />
        <Typography level="body-sm" color="danger">
          {t('media_player.load_failed')}
        </Typography>
        <Button size="sm" variant="plain" onClick={retry} data-testid="media-player-retry-btn">
          {t('media_player.retry')}
        </Button>
      </Stack>
    );
  }

  return (
    // Stops propagation so the transport controls do not toggle the surrounding row's selection.
    <Stack direction="row" spacing={1} alignItems="center" onClick={event => event.stopPropagation()}>
      <Box
        component={isVideo ? 'video' : 'audio'}
        controls
        preload={preload}
        src={src}
        onError={() => void refresh()}
        onLoadedMetadata={() => {
          refreshedRef.current = false;
        }}
        aria-label={file.fileName}
        data-testid={isVideo ? 'media-player-video' : 'media-player-audio'}
        sx={
          isVideo
            ? { width: '100%', maxHeight: '60vh', borderRadius: 'sm', bgcolor: 'black' }
            : { width: '100%', height: 34 }
        }
      />
      {!hideDownload && (
        <Tooltip title={t('file_actions.download')}>
          <IconButton
            size="sm"
            variant="plain"
            onClick={download}
            loading={downloading}
            disabled={!src}
            aria-label={t('file_actions.download')}
            data-testid="media-player-download-btn"
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
};

/**
 * Audio or video player for a stored file. Re-signs the file URL through `/api/files/:id` when it is about to
 * expire or the element fails to load it, so a player left open past the URL's hour still plays.
 */
export const MediaPlayer: FC<MediaPlayerProps> = props => <PlayerBody key={props.file.id} {...props} />;

export default MediaPlayer;
