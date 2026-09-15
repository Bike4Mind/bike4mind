import { useEffect } from 'react';
import { Box, Chip, Divider, Stack, Typography } from '@mui/joy';
import SecurityUpdateIcon from '@mui/icons-material/SecurityUpdate';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import RadioButtonUnchecked from '@mui/icons-material/RadioButtonUnchecked';
import { useUser } from '@client/app/contexts/UserContext';
import { useGitHubConnectionStatus } from '@client/app/hooks/data/useGitHubConnectionStatus';
import SectionContainer from '../SectionContainer';
import TokenRotationButton from './TokenRotationButton';
import { buildRows } from './tokenRotationUtils';

const TokenRotationSection = () => {
  const { currentUser, refreshUser } = useUser();

  // Refresh user data on mount so lastRotationInitiatedAt is current
  // after returning from an OAuth redirect.
  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const {
    data: githubStatus,
    isError: isGitHubStatusError,
    isLoading: isGitHubStatusLoading,
  } = useGitHubConnectionStatus(currentUser?.id ?? '', { enabled: Boolean(currentUser?.id) });

  const isGitHubConnected = isGitHubStatusError ? false : (githubStatus?.connected ?? false);

  const rows = buildRows(currentUser, isGitHubConnected, isGitHubStatusError);

  const connectedCount = rows.filter(r => r.isConnected).length;
  // Treat GitHub status error/loading as "possibly connected" so the section
  // stays visible instead of vanishing due to a transient API failure.
  const possiblyConnectedCount = connectedCount + (isGitHubStatusError || isGitHubStatusLoading ? 1 : 0);

  if (possiblyConnectedCount === 0) return null;

  return (
    <SectionContainer
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <SecurityUpdateIcon sx={{ fontSize: 28, color: 'warning.500' }} />
          <Typography level="title-md">Re-authorize Integrations</Typography>
        </Box>
      }
      subtitle="Refresh OAuth tokens for your connected integrations. Each requires a separate redirect to the provider."
    >
      <Stack spacing={0} divider={<Divider />}>
        {rows.map(row => (
          <Box
            key={row.integration}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              py: 1.5,
              gap: 2,
            }}
            data-testid={`rotation-row-${row.integration}`}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {row.isConnected ? (
                <CheckCircleOutline sx={{ color: 'success.500', fontSize: 20 }} />
              ) : (
                <RadioButtonUnchecked sx={{ color: 'text.tertiary', fontSize: 20 }} />
              )}
              <Typography level="title-sm">{row.label}</Typography>
            </Box>
            {row.isConnected ? (
              <TokenRotationButton
                integration={row.integration}
                isConnected={row.isConnected}
                lastRotationInitiatedAt={row.lastRotationInitiatedAt}
              />
            ) : (
              <Chip
                size="sm"
                variant="outlined"
                color="warning"
                data-testid={`rotation-disconnected-${row.integration}`}
              >
                {row.integration === 'github' && isGitHubStatusError ? 'Status unknown' : 'Not connected'}
              </Chip>
            )}
          </Box>
        ))}
      </Stack>
    </SectionContainer>
  );
};

export default TokenRotationSection;
