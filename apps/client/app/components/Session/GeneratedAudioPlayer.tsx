import { Box, Typography } from '@mui/joy';
import { FC, useState } from 'react';

/**
 * Inline player for a tool-generated clip in a reply. Deleting the clip from Files also removes this copy (see
 * deleteStoredObjects), so a load failure reads as gone rather than leaving a dead player behind.
 */
export const GeneratedAudioPlayer: FC<{ src: string }> = ({ src }) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) {
    return (
      <Typography level="body-sm" data-testid="generated-audio-unavailable">
        This audio is no longer available. It may have been deleted from your files.
      </Typography>
    );
  }

  return (
    <Box
      component="audio"
      controls
      preload="metadata"
      src={src}
      onError={() => setFailedSrc(src)}
      data-testid="generated-audio-player"
      sx={{ width: '100%', maxWidth: 480 }}
    />
  );
};
