import React from 'react';
import { Box, IconButton, Link, Sheet, Tooltip, Typography } from '@mui/joy';
import LinkIcon from '@mui/icons-material/Link';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import VisibilityIcon from '@mui/icons-material/Visibility';
import type { ManagedArtifact } from '@client/app/utils/publishApi';
import { ArtifactThumbnail } from '@client/app/components/common/ArtifactThumbnail';
import { PublishAccessBadge } from '@client/app/components/common/PublishAccessBadge';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { formatViews, shortDate } from './publishedArtifactFormat';

export interface PublishedArtifactCardProps {
  artifact: ManagedArtifact;
  /** Absolute share URL: the title's href. */
  url: string;
  onCopyLink: () => void;
  /** Opens the same settings the list row shows when expanded. */
  onOpenSettings: () => void;
  /** Ref to the title link, so the tab can move focus here after a neighbouring card is deleted. */
  titleRef?: React.Ref<HTMLAnchorElement>;
}

/** Solid, not blurred or translucent: the badge sits on whatever the thumbnail shows, so its
 *  backing has to stay legible over a bright screenshot as much as over a dark cover. */
const BADGE_BACKING_SX = {
  position: 'absolute',
  top: 8,
  left: 8,
  p: '2px',
  borderRadius: 'md',
  bgcolor: '#15181c',
  border: '1px solid rgba(255, 255, 255, 0.16)',
} as const;

/**
 * One published artifact as a grid card: preview on top, then title and a single meta line.
 *
 * Only the title is a link - the card is not one big hit target - so the copy and More buttons
 * keep their own clicks and a keyboard user tabs through title, copy, More. Every test id is
 * `published-artifact-card-<part>-<publicId>`, the list row's scheme with `card-` added.
 */
export function PublishedArtifactCard({
  artifact: a,
  url,
  onCopyLink,
  onOpenSettings,
  titleRef,
}: PublishedArtifactCardProps) {
  const isBundle = a.source.kind === 'bundle';
  const versions = a.versionsCount ?? 0;
  const views = a.viewCount ?? 0;
  const id = (part: string) => `published-artifact-card-${part}-${a.publicId}`;

  return (
    <Sheet
      component="li"
      variant="outlined"
      data-testid={`published-artifact-card-${a.publicId}`}
      sx={{ borderRadius: 'md', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
    >
      <Box sx={{ position: 'relative', aspectRatio: '16 / 10', width: '100%', overflow: 'hidden' }}>
        <ArtifactThumbnail
          publicId={a.publicId}
          title={a.title}
          thumbnailUrl={a.thumbnailUrl}
          size="fill"
          data-testid={id('cover')}
        />
        <Box sx={BADGE_BACKING_SX}>
          <PublishAccessBadge visibility={a.visibility} gateKind={a.gateKind} data-testid={id('access')} />
        </Box>
      </Box>

      <Box sx={{ p: 1.25, flex: 1, display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
        {/* describeChild keeps the title as the link's accessible name; without it the tooltip text
            would replace it. */}
        <Tooltip title="Opens in a new tab" describeChild>
          <Link
            ref={titleRef}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            level="title-sm"
            data-testid={id('title')}
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
              textAlign: 'left',
            }}
          >
            {a.title}
          </Link>
        </Tooltip>

        <Box sx={{ mt: 'auto', display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              columnGap: 1.25,
              rowGap: 0.25,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            <Typography level="body-xs" textColor="text.tertiary" data-testid={id('date')}>
              {shortDate(a.publishedAt)}
            </Typography>
            {isBundle && (
              <Typography level="body-xs" textColor="text.tertiary" data-testid={id('versions')}>
                {versions >= 2 ? `${versions} versions` : '1 version'}
              </Typography>
            )}
            <Typography
              level="body-xs"
              textColor="text.secondary"
              startDecorator={<VisibilityIcon sx={{ fontSize: 13 }} />}
              title={`${views} views`}
              data-testid={id('views')}
            >
              {formatViews(views)}
              <Box component="span" sx={visuallyHidden}>
                {' views'}
              </Box>
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flex: 'none' }}>
            <Tooltip title="Copy link">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={onCopyLink}
                aria-label={`Copy link to ${a.title}`}
                data-testid={id('copy')}
                sx={{ '--IconButton-size': '28px' }}
              >
                <LinkIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Settings, export & versions">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={onOpenSettings}
                aria-haspopup="dialog"
                aria-label={`Settings for ${a.title}`}
                data-testid={id('more')}
                sx={{ '--IconButton-size': '28px' }}
              >
                <MoreHorizIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>
    </Sheet>
  );
}

export default PublishedArtifactCard;
