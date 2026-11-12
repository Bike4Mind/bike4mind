import React, { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
import Close from '@mui/icons-material/Close';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { useUser } from '@client/app/contexts/UserContext';
import { fetchOrgDomainJoinSuggestions, joinOrgViaDomain } from '@client/app/utils/orgDomainAPICalls';

const DISMISS_KEY_PREFIX = 'orgDomainJoinDismissed:';

function isDismissed(organizationId: string): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY_PREFIX + organizationId) === '1';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' && message ? message : 'Could not join the organization. Try again later.';
}

/** Offers an existing user the org that claimed their verified email domain. */
const OrgDomainJoinBanner: React.FC = () => {
  const queryClient = useQueryClient();
  const { userId, emailVerified, refreshUser } = useUser(
    useShallow(s => ({
      userId: s.currentUser?.id,
      emailVerified: s.currentUser?.emailVerified,
      refreshUser: s.refreshUser,
    }))
  );
  const [dismissed, setDismissed] = useState<string[]>([]);

  const { data: suggestions } = useQuery({
    queryKey: ['orgDomainJoinSuggestions', userId],
    queryFn: fetchOrgDomainJoinSuggestions,
    enabled: !!userId && emailVerified === true,
    staleTime: 5 * 60 * 1000,
  });

  const join = useMutation({
    mutationFn: joinOrgViaDomain,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orgDomainJoinSuggestions'] }),
        queryClient.invalidateQueries({ queryKey: ['organizations'] }),
        refreshUser(),
      ]);
    },
  });

  const suggestion = suggestions?.find(s => !dismissed.includes(s.organizationId) && !isDismissed(s.organizationId));
  if (!userId || !suggestion) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY_PREFIX + suggestion.organizationId, '1');
    } catch {
      // Storage unavailable: hidden for this page load only.
    }
    setDismissed(prev => [...prev, suggestion.organizationId]);
  };

  return (
    <Box
      data-testid="org-domain-join-banner"
      sx={{
        position: 'fixed',
        bottom: 16,
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
          Your email domain lets you join <strong style={{ fontWeight: 600 }}>{suggestion.organizationName}</strong>.
        </Typography>
        {join.isError && (
          <Typography level="body-xs" color="danger" data-testid="org-domain-join-error">
            {errorMessage(join.error)}
          </Typography>
        )}
      </Box>
      <Button
        size="sm"
        variant="solid"
        color="primary"
        loading={join.isPending}
        onClick={() => join.mutate(suggestion.organizationId)}
        data-testid="org-domain-join-btn"
      >
        Join
      </Button>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Dismiss"
        onClick={handleDismiss}
        data-testid="org-domain-join-dismiss-btn"
      >
        <Close fontSize="small" />
      </IconButton>
    </Box>
  );
};

export default OrgDomainJoinBanner;
