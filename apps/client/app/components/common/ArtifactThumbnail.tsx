import React, { useState } from 'react';
import { Box } from '@mui/joy';
import { ArtifactCover } from './ArtifactCover';

export interface ArtifactThumbnailProps {
  publicId: string;
  title?: string;
  /** A rendered preview of the page. Absent until one exists; see ManagedArtifact.thumbnailUrl. */
  thumbnailUrl?: string;
  /** Square size in px, or 'fill' to take the parent's whole box (the parent clips the corners). */
  size?: number | 'fill';
  /** Lands on the frame in both states, so one selector finds the slot whatever it is showing. The
   *  image itself is `<testid>-image`. */
  'data-testid'?: string;
}

/**
 * The preview slot for a published artifact: the rendered thumbnail when there is one, the generated
 * ArtifactCover otherwise - including when the image fails to load, so a broken URL never leaves a
 * broken-image glyph in the grid.
 *
 * The image is decorative (`alt=""`): the title next to it names the artifact. It is anchored to the
 * top because a page's identity - its heading - is at the top, and the slot crops the rest.
 */
export function ArtifactThumbnail({
  publicId,
  title,
  thumbnailUrl,
  size = 28,
  'data-testid': testId,
}: ArtifactThumbnailProps) {
  // Remember WHICH url failed rather than a boolean, so a new thumbnailUrl for the same artifact
  // (for example after a re-publish) gets its own attempt without an effect to reset the flag.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!thumbnailUrl || failedUrl === thumbnailUrl) {
    return <ArtifactCover publicId={publicId} title={title} size={size} data-testid={testId} />;
  }

  const fill = size === 'fill';
  return (
    <Box
      data-testid={testId}
      sx={{
        width: fill ? '100%' : size,
        height: fill ? '100%' : size,
        flex: 'none',
        borderRadius: fill ? 0 : 'sm',
        border: fill ? 'none' : '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        overflow: 'hidden',
      }}
    >
      <img
        src={thumbnailUrl}
        alt=""
        loading="lazy"
        decoding="async"
        // The image host learns nothing about the page that embeds it.
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(thumbnailUrl)}
        data-testid={testId ? `${testId}-image` : undefined}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }}
      />
    </Box>
  );
}

export default ArtifactThumbnail;
