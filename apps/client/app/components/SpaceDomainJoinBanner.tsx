import React, { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
import Close from '@mui/icons-material/Close';
import { useShallow } from 'zustand/react/shallow';
import { useUser } from '@client/app/contexts/UserContext';
import { useJoinSpaceViaDomain, useSpaceDomainSuggestions } from '@client/app/hooks/data/spaces';
import { useSpacesEnabled } from '@client/app/hooks/useSpacesEnabled';
import { getErrorMessage } from '@client/app/utils/error';

const DISMISS_KEY_PREFIX = 'spaceDomainJoinDismissed:';

// Keyed per user: a shared browser must not carry one account's dismissal over to another.
const dismissKey = (userId: string, spaceId: string) => `${DISMISS_KEY_PREFIX}${userId}:${spaceId}`;

function isDismissed(userId: string, spaceId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(userId, spaceId)) === '1';
  } catch {
    return false;
  }
}

/** Offers an existing user the Space that claimed their verified email domain. */
const SpaceDomainJoinBanner: React.FC = () => {
  const { userId, emailVerified } = useUser(
    useShallow(s => ({ userId: s.currentUser?.id, emailVerified: s.currentUser?.emailVerified }))
  );
  const { enabled } = useSpacesEnabled();
  const [dismissed, setDismissed] = useState<string[]>([]);

  const { data: suggestions } = useSpaceDomainSuggestions(enabled && !!userId && emailVerified === true);
  const join = useJoinSpaceViaDomain();

  const suggestion = userId
    ? suggestions?.find(s => !dismissed.includes(dismissKey(userId, s.spaceId)) && !isDismissed(userId, s.spaceId))
    : undefined;
  if (!enabled || !userId || !suggestion) return null;

  const handleDismiss = () => {
    const key = dismissKey(userId, suggestion.spaceId);
    try {
      localStorage.setItem(key, '1');
    } catch {
      // Storage unavailable: hidden for this page load only.
    }
    setDismissed(prev => [...prev, key]);
  };

  return (
    <Box
      data-testid="space-domain-join-banner"
      sx={{
        position: 'fixed',
        // Clears the organization banner, which sits at the corner.
        bottom: 88,
        right: 16,
        maxWidth: 'calc(100vw - 32px)',
        zIndex: 'var(--joy-zIndex-snackbar, 1400)',
        px: 2,
        py: 1.5,
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'md',
        boxShadow: 'md',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
      }}
    >
      <Box sx={{ flex: 1, minWidth: 200 }}>
        <Typography level="body-sm">
          Your email domain lets you join the space <strong style={{ fontWeight: 600 }}>{suggestion.spaceName}</strong>.
        </Typography>
        {join.isError && (
          <Typography level="body-xs" color="danger" data-testid="space-domain-join-error">
            {getErrorMessage(join.error)}
          </Typography>
        )}
      </Box>
      <Button
        size="sm"
        variant="solid"
        color="primary"
        loading={join.isPending}
        onClick={() => join.mutate(suggestion.spaceId)}
        data-testid="space-domain-join-btn"
      >
        Join
      </Button>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Dismiss"
        onClick={handleDismiss}
        data-testid="space-domain-join-dismiss-btn"
      >
        <Close fontSize="small" />
      </IconButton>
    </Box>
  );
};

export default SpaceDomainJoinBanner;
