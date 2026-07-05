import WarningIcon from '@mui/icons-material/Warning';
import { Box, CircularProgress, Typography } from '@mui/joy';
import { FC } from 'react';

export type ImageModerationPlaceholderStatus = 'scanning' | 'blocked';

interface ImageModerationPlaceholderProps {
  status: ImageModerationPlaceholderStatus;
  /**
   * Side length (px) of the square placeholder. Defaults to the ~140x140
   * thumbnail box used for image previews (see ImageContainer).
   */
  size?: number;
}

const COPY: Record<ImageModerationPlaceholderStatus, string> = {
  scanning: 'Scanning for safety…',
  blocked: "This image couldn't be added — it may violate our content policy.",
};

// Below this size the full caption doesn't fit - small file-icon slots (e.g. the 20/32px
// icons in Files/Browser/Item.tsx) clip it into an illegible sliver inside a
// `overflow: hidden` ListItem. The compact variant below renders icon-only instead.
const COMPACT_SIZE_THRESHOLD = 48;

/**
 * Shared placeholder rendered in place of an `<img>` for an uploaded image
 * FabFile that isn't serveable yet (content moderation).
 *
 * - `scanning`: the image is still pending a moderation scan.
 * - `blocked`: the moderation scan flagged the image; it will never be served.
 *
 * Below `COMPACT_SIZE_THRESHOLD` px, renders icon-only (no caption) sized to fit
 * small file-icon slots; the full caption + spinner/icon layout is kept for larger
 * thumbnail-sized usages. The dropped caption is still exposed via the `title`
 * attribute so it's available on hover.
 */
export const ImageModerationPlaceholder: FC<ImageModerationPlaceholderProps> = ({ status, size = 140 }) => {
  const testId = status === 'scanning' ? 'image-moderation-scanning' : 'image-moderation-blocked';

  if (size < COMPACT_SIZE_THRESHOLD) {
    const iconSize = Math.max(12, Math.round(size * 0.6));
    return (
      <Box
        data-testid={testId}
        title={COPY[status]}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          borderRadius: '4px',
          backgroundColor: theme => theme.palette.background.level1,
        }}
      >
        {status === 'scanning' ? (
          <CircularProgress
            data-testid="image-moderation-scanning-spinner"
            sx={{ '--CircularProgress-size': `${iconSize}px` }}
          />
        ) : (
          <WarningIcon sx={{ fontSize: iconSize, color: 'danger.solidBg' }} />
        )}
      </Box>
    );
  }

  return (
    <Box
      data-testid={testId}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        width: size,
        height: size,
        padding: 1,
        textAlign: 'center',
        borderRadius: '8px',
        backgroundColor: theme => theme.palette.background.level1,
        border: theme => `1px solid ${theme.palette.neutral.outlinedBorder}`,
      }}
    >
      {status === 'scanning' ? (
        <CircularProgress size="sm" data-testid="image-moderation-scanning-spinner" />
      ) : (
        <WarningIcon sx={{ fontSize: 28, color: 'danger.solidBg' }} />
      )}
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        {COPY[status]}
      </Typography>
    </Box>
  );
};

export default ImageModerationPlaceholder;
