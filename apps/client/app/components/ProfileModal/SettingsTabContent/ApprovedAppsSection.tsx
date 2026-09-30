import React from 'react';
import { Box, Button, Card, Chip, Divider, Stack, Typography } from '@mui/joy';
import AppsIcon from '@mui/icons-material/Apps';
import { toast } from 'sonner';
import { useOAuthGrants, useRevokeOAuthGrant } from '@client/app/hooks/data/oauthGrants';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { toConsentScopes } from '@client/app/routes/oauth/consentScopes';

const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Lists every third-party OAuth client the user has approved and lets them revoke
 * individual grants. Always rendered (not gated on MFA) so the user can reach it
 * regardless of MFA state.
 */
const ApprovedAppsSection: React.FC = () => {
  const { data: grants, isLoading, isError } = useOAuthGrants();
  const revokeGrant = useRevokeOAuthGrant();
  // Track each in-flight revoke by clientId so rows don't share a single isPending flag.
  const [pendingRevokes, setPendingRevokes] = React.useState<Set<string>>(new Set());
  // While impersonating we would be acting on the real customer's grants; mirror ActiveSessionsSection.
  const impersonating = useAccessToken(s => s.impersonating);

  const handleRevoke = (clientId: string, clientName: string) => {
    setPendingRevokes(prev => new Set(prev).add(clientId));
    revokeGrant.mutate(
      { clientId },
      {
        onSuccess: () => toast.success(`Access revoked for ${clientName}`),
        onError: () => toast.error(`Could not revoke access for ${clientName}`),
        onSettled: () =>
          setPendingRevokes(prev => {
            const next = new Set(prev);
            next.delete(clientId);
            return next;
          }),
      }
    );
  };

  return (
    <Card variant="outlined" sx={{ p: 3, mt: 2 }} data-testid="approved-apps-section">
      <Typography level="h4" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <AppsIcon /> Approved Apps
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2 }}>
        Third-party apps you have authorized to access your Bike4Mind account. Revoking an app
        stops it from renewing access; any active session it holds may continue for up to 30
        minutes before it expires.
      </Typography>

      {isLoading && <Typography level="body-sm">Loading...</Typography>}

      {isError && !isLoading && !grants && (
        <Typography level="body-sm" color="danger" data-testid="approved-apps-error">
          Could not load approved apps. Please try again later.
        </Typography>
      )}

      {!isLoading && Array.isArray(grants) && !grants.length && (
        <Typography level="body-sm" data-testid="approved-apps-empty">
          No approved apps. Apps you authorize through the consent screen will appear here.
        </Typography>
      )}

      {grants && grants.length > 0 && (
        <Stack spacing={1} divider={<Divider />}>
          {grants.map(grant => {
            const scopes = toConsentScopes(grant.scopes);
            return (
              <Box
                key={grant.clientId}
                sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, py: 0.5 }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography level="body-md" fontWeight="md">
                    {grant.clientName}
                  </Typography>
                  <Typography level="body-xs" sx={{ mb: 0.5 }}>
                    Approved {formatDate(grant.approvedAt)}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {scopes.map(scope => (
                      <Chip key={scope.id} size="sm" variant="soft" color="neutral" title={scope.id}>
                        {scope.label ?? scope.id}
                      </Chip>
                    ))}
                  </Box>
                </Box>
                {!impersonating && (
                  <Button
                    size="sm"
                    color="danger"
                    variant="outlined"
                    sx={{ flexShrink: 0 }}
                    data-testid={`approved-app-revoke-btn-${grant.clientId}`}
                    loading={pendingRevokes.has(grant.clientId)}
                    aria-busy={pendingRevokes.has(grant.clientId) || undefined}
                    onClick={() => handleRevoke(grant.clientId, grant.clientName)}
                  >
                    Revoke
                  </Button>
                )}
              </Box>
            );
          })}
        </Stack>
      )}
    </Card>
  );
};

export default ApprovedAppsSection;
