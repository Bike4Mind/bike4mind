import React from 'react';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/joy';
import ShareIcon from '@mui/icons-material/Share';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import XIcon from '@mui/icons-material/X';
import LinkedInIcon from '@mui/icons-material/LinkedIn';
import CloudIcon from '@mui/icons-material/Cloud';
import DescriptionIcon from '@mui/icons-material/Description';
import { toast } from 'sonner';
import { openInNewTab } from '@client/app/utils/externalLinks';

export interface ShareActionsProps {
  /** Title used for native share + tweet text. */
  title: string;
  /** Canonical URL being shared. */
  url: string;
  /** Compact mode renders just an icon button (e.g. for a toolbar). */
  variant?: 'full' | 'icon';
  /** If provided, shows a "Copy Markdown" button that copies the full content as markdown. */
  markdown?: string;
}

/**
 * Social share bar - Bluesky / X / LinkedIn / Copy Link / Copy Markdown /
 * native share. Ported from vibeswire (frontend/app/components/news/ShareActions.tsx)
 * and converted from @mui/material to @mui/joy + sonner per B4M conventions.
 */
export function ShareActions({ title, url, variant = 'full', markdown }: ShareActionsProps) {
  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied to clipboard!');
    } catch {
      toast.error("Couldn't copy — select the URL manually");
    }
  };

  const handleCopyMarkdown = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success('Markdown copied — paste into your AI tool of choice');
    } catch {
      toast.error("Couldn't copy — try again or select the text manually");
    }
  };

  const handleNativeShare = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // User cancelled - no-op
      }
    } else {
      void handleCopyUrl();
    }
  };

  const handleShareToBluesky = () => {
    const text = encodeURIComponent(`${title}\n\n${url}`);
    openInNewTab(`https://bsky.app/intent/compose?text=${text}`);
  };

  const handleShareToTwitter = () => {
    const text = encodeURIComponent(title);
    openInNewTab(`https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(url)}`);
  };

  const handleShareToLinkedIn = () => {
    openInNewTab(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`);
  };

  // Compact icon button for a toolbar / top bar
  if (variant === 'icon') {
    return (
      <Tooltip title="Share">
        <IconButton
          onClick={handleNativeShare}
          size="sm"
          variant="plain"
          color="neutral"
          data-testid="share-actions-icon-btn"
        >
          <ShareIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    );
  }

  // Full share bar
  const buttonSx = { textTransform: 'none' as const, fontWeight: 500, fontSize: '13px' };

  return (
    <Box sx={{ mb: 3 }} data-testid="share-actions">
      <Typography level="title-sm" sx={{ fontWeight: 700, mb: 1.5 }}>
        Share
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button
          variant="outlined"
          size="sm"
          startDecorator={<CloudIcon />}
          onClick={handleShareToBluesky}
          sx={{ ...buttonSx, borderColor: '#0085FF44', color: '#0085FF' }}
          data-testid="share-actions-bluesky"
        >
          Bluesky
        </Button>
        <Button
          variant="outlined"
          size="sm"
          color="neutral"
          startDecorator={<XIcon />}
          onClick={handleShareToTwitter}
          sx={buttonSx}
          data-testid="share-actions-twitter"
        >
          Twitter / X
        </Button>
        <Button
          variant="outlined"
          size="sm"
          startDecorator={<LinkedInIcon />}
          onClick={handleShareToLinkedIn}
          sx={{ ...buttonSx, borderColor: '#0A66C244', color: '#0A66C2' }}
          data-testid="share-actions-linkedin"
        >
          LinkedIn
        </Button>
        <Button
          variant="outlined"
          size="sm"
          color="neutral"
          startDecorator={<ContentCopyIcon />}
          onClick={handleCopyUrl}
          sx={buttonSx}
          data-testid="share-actions-copy-link"
        >
          Copy Link
        </Button>
        {markdown && (
          <Tooltip title="Copy the full content as markdown — paste into Claude, ChatGPT, Gemini, etc.">
            <Button
              variant="outlined"
              size="sm"
              startDecorator={<DescriptionIcon />}
              onClick={handleCopyMarkdown}
              sx={{ ...buttonSx, borderColor: '#7C3AED44', color: '#7C3AED' }}
              data-testid="share-actions-copy-markdown"
            >
              Copy Markdown
            </Button>
          </Tooltip>
        )}
        <Button
          variant="outlined"
          size="sm"
          color="neutral"
          startDecorator={<ShareIcon />}
          onClick={handleNativeShare}
          sx={buttonSx}
          data-testid="share-actions-more"
        >
          More...
        </Button>
      </Box>
    </Box>
  );
}

export default ShareActions;
