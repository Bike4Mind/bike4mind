import { useEffect, useRef } from 'react';
import { Box } from '@mui/joy';
import { useMediaQuery } from '@mui/system';

interface WhatsNewSlideVideoProps {
  src: string;
  poster?: string;
  title: string;
  /** Plays only while true: the slide is showing and the slider is open. */
  active: boolean;
  onSourceError: () => void;
}

const WhatsNewSlideVideo: React.FC<WhatsNewSlideVideoProps> = ({ src, poster, title, active, onSourceError }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Playback position survives a src swap (a re-signed URL) instead of restarting the video
  const resumeAt = useRef(0);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active && !prefersReducedMotion) {
      // play() rejects when the browser blocks autoplay; the controls still let the user start it
      video.play()?.catch(() => {});
    } else {
      video.pause();
    }
  }, [active, prefersReducedMotion, src]);

  useEffect(() => {
    const video = videoRef.current;
    return () => video?.pause();
  }, []);

  return (
    <Box
      component="video"
      ref={videoRef}
      src={src}
      poster={poster}
      aria-label={title}
      muted
      loop
      playsInline
      controls
      preload="metadata"
      onTimeUpdate={() => {
        if (videoRef.current) resumeAt.current = videoRef.current.currentTime;
      }}
      onLoadedMetadata={() => {
        if (videoRef.current && resumeAt.current > 0) videoRef.current.currentTime = resumeAt.current;
      }}
      onError={onSourceError}
      data-testid="whats-new-slide-video"
      sx={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: '12px', backgroundColor: 'black' }}
    />
  );
};

export default WhatsNewSlideVideo;
