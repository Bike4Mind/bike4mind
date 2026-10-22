import { isVideoMimeType, type IFabFileDocument } from '@bike4mind/common';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { downloadData } from '@client/app/utils/download';
import DownloadIcon from '@mui/icons-material/Download';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import React, { FC, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export type MediaPlayerFile = Pick<
  IFabFileDocument,
  'id' | 'fileName' | 'mimeType' | 'fileUrl' | 'presignedUrl' | 'fileUrlExpireAt' | 'moderationStatus'
>;

type MediaPlayerProps = {
  file: MediaPlayerFile;
  /** 'none' keeps a long list from fetching every file up front; 'metadata' loads the video poster frame. */
  preload?: 'none' | 'metadata';
  /** Hides the download button where the surrounding UI already offers one. */
  hideDownload?: boolean;
};

type Status = 'ready' | 'refreshing' | 'failed';

/** A load error this soon after a re-sign means the fresh URL failed too; later, it has most likely expired. */
const RESIGN_GIVE_UP_WINDOW_MS = 60 * 1000;

export const hasExpired = (expireAt: MediaPlayerFile['fileUrlExpireAt']): boolean =>
  !!expireAt && new Date(expireAt).getTime() <= Date.now();

/** How often, and for how long (ms), to re-ask for the URL of a file whose moderation scan has not finished. */
export const SCAN_POLL_INTERVAL_MS = 1000;
export const SCAN_WAIT_MS = 30 * 1000;

const isScanInFlight = (status: MediaPlayerFile['moderationStatus']): boolean =>
  status === 'pending' || status === 'scanning';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GET /api/files/:id re-signs the URL only once the stored one has expired (or fails), so asking any earlier
 * returns the same URL. That answer means the URL is still valid: the caller reloads it rather than giving up.
 *
 * Every file read withholds the URL until the S3 upload event's moderation scan clears the file (isImageServeable),
 * which lands about a second after a server-side save. A just-generated file (Studio speech or sound effects) is
 * listed inside that window, so a scan still in flight is waited out here rather than reported as unplayable.
 */
const fetchFreshUrl = async (fileId: string, isCancelled: () => boolean): Promise<string> => {
  const giveUpAt = Date.now() + SCAN_WAIT_MS;
  for (;;) {
    const fresh = await getFabFileByIdFromServer(fileId);
    if (fresh.fileUrl) return fresh.fileUrl;
    if (!isScanInFlight(fresh.moderationStatus)) throw new Error('the file has no signed url');
    if (Date.now() + SCAN_POLL_INTERVAL_MS > giveUpAt) throw new Error('the moderation scan did not finish in time');
    await sleep(SCAN_POLL_INTERVAL_MS);
    if (isCancelled()) throw new Error('the player was closed');
  }
};

const PlayerBody: FC<MediaPlayerProps> = ({ file, preload = 'metadata', hideDownload = false }) => {
  const { t } = useTranslation();
  const isVideo = isVideoMimeType(file.mimeType);
  const initialUrl = file.fileUrl || file.presignedUrl;
  const needsUrl = !initialUrl || hasExpired(file.fileUrlExpireAt);
  const [src, setSrc] = useState(initialUrl);
  // An expired URL is never handed to the element: its instant 403 would race the re-sign below.
  const [status, setStatus] = useState<Status>(needsUrl ? 'refreshing' : 'ready');
  const [downloading, setDownloading] = useState(false);
  // When the URL was last re-signed, cleared by a successful load. Time-based rather than per load because a
  // `preload="none"` row loads nothing until played, so it may first fail on a URL that expired long ago.
  const lastResignAtRef = useRef<number | null>(null);
  // Remounts the element after each re-sign, so a same-URL answer (a transient error) still reloads it.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const unmountedRef = useRef(false);
  const isUnmounted = () => unmountedRef.current;

  const refresh = async () => {
    const lastResignAt = lastResignAtRef.current;
    if (lastResignAt !== null && Date.now() - lastResignAt < RESIGN_GIVE_UP_WINDOW_MS) {
      setStatus('failed');
      return;
    }
    lastResignAtRef.current = Date.now();
    setStatus('refreshing');
    try {
      setSrc(await fetchFreshUrl(file.id, isUnmounted));
      setLoadAttempt(attempt => attempt + 1);
      setStatus('ready');
    } catch (error) {
      if (isUnmounted()) return;
      console.error('Media player could not re-sign the file url:', error);
      setStatus('failed');
    }
  };

  useEffect(() => {
    unmountedRef.current = false;
    if (needsUrl) void refresh();
    return () => {
      unmountedRef.current = true;
    };
    // Mount only (the component is keyed by file id); later failures arrive through onError.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => {
    lastResignAtRef.current = null;
    void refresh();
  };

  const download = async () => {
    if (!src) return;
    setDownloading(true);
    try {
      // no-store: the element fetched this same URL without an Origin header, so S3's cached reply carries no CORS
      // headers, and reusing it fails the first fetch with a CORS error.
      let response = await fetch(src, { cache: 'no-store' });
      if (!response.ok) {
        // Most likely expired while the player sat open; re-sign once and try again. The element keeps its own
        // src so playback is not interrupted; it re-signs through onError if it needs to.
        response = await fetch(await fetchFreshUrl(file.id, isUnmounted), { cache: 'no-store' });
      }
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      downloadData(await response.blob(), file.fileName);
    } catch (error) {
      console.error('Media download failed:', error);
      toast.error(t('media_player.download_failed'));
    } finally {
      setDownloading(false);
    }
  };

  if (status === 'failed') {
    return (
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        role="alert"
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
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      onClick={event => event.stopPropagation()}
      sx={{ width: '100%' }}
    >
      <Box
        key={loadAttempt}
        component={isVideo ? 'video' : 'audio'}
        controls
        preload={preload}
        src={status === 'ready' ? src : undefined}
        onError={() => {
          if (status === 'ready') void refresh();
        }}
        onLoadedMetadata={() => {
          lastResignAtRef.current = null;
        }}
        aria-label={file.fileName}
        data-testid={isVideo ? 'media-player-video' : 'media-player-audio'}
        sx={
          isVideo
            ? { flex: 1, minWidth: 0, maxHeight: '60vh', borderRadius: 'sm', bgcolor: 'black' }
            : { flex: 1, minWidth: 0, height: 34 }
        }
      />
      {!hideDownload && (
        <Tooltip title={t('file_actions.download')}>
          <IconButton
            size="sm"
            variant="plain"
            onClick={download}
            loading={downloading}
            disabled={!src || status !== 'ready'}
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
 * Audio or video player for a stored file. Re-signs the file URL through `/api/files/:id` when it has expired or
 * the element fails to load it, so a player left open past the URL's lifetime still plays.
 */
export const MediaPlayer: FC<MediaPlayerProps> = props => <PlayerBody key={props.file.id} {...props} />;

export default MediaPlayer;
