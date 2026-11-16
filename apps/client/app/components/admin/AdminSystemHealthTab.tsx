import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import NetworkPingIcon from '@mui/icons-material/NetworkPing';
import BlockIcon from '@mui/icons-material/Block';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { AdminPageHeader, EmptyState, ErrorState, InlineBar, LoadingState, SectionCard, StatusChip } from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';
import type { SystemHealthResponse, OAuthProviderStatus } from '@server/admin/systemHealth/getSystemHealthStatus';
import type { TestOAuthResult, OAuthProvider, OktaDiagnostics } from '@client/pages/api/admin/system-health/test-oauth';

interface TestEmailResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  sentTo: string;
  timestamp: string;
}

interface TestDatabaseResponse {
  success: boolean;
  latencyMs?: number;
  error?: string;
  timestamp: string;
}

const useSystemHealth = () => {
  return useQuery<SystemHealthResponse>({
    queryKey: ['admin', 'system-health'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-health');
      return response.data;
    },
    refetchInterval: 30000,
  });
};

const useSendTestEmail = () => {
  return useMutation<TestEmailResponse, Error, { to?: string }>({
    mutationFn: async ({ to }) => {
      const response = await api.post('/api/admin/system-health/test-email', { to });
      return response.data;
    },
  });
};

const useTestDatabase = () => {
  return useMutation<TestDatabaseResponse, Error, void>({
    mutationFn: async () => {
      const response = await api.post('/api/admin/system-health/test-database');
      return response.data;
    },
  });
};

const useTestOAuth = () => {
  return useMutation<TestOAuthResult, Error, { provider: OAuthProvider }>({
    mutationFn: async ({ provider }) => {
      const response = await api.post('/api/admin/system-health/test-oauth', { provider });
      return response.data;
    },
  });
};

// Integration Health Types & Hooks

type IntegrationName = 'slack' | 'github' | 'jira' | 'confluence';

type CircuitBreakerMode = 'auto' | 'force_block' | 'force_open';

interface CircuitBreakerStatus {
  available: boolean;
  reason: string | null;
  mode: CircuitBreakerMode;
  autoTripped: boolean;
  noData?: boolean;
}

interface IntegrationHealthSummary {
  integration: IntegrationName;
  // 'no_data' (with a null lastCheckedAt) means the integration has never been checked.
  status: 'healthy' | 'degraded' | 'unhealthy' | 'no_data';
  latencyMs: number;
  lastCheckedAt: string | null;
  successRate: number;
  consecutiveFailures: number;
  error: string | null;
  circuitBreaker?: CircuitBreakerStatus;
}

type RealtimeCircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface RealtimeCircuitBreakerSnapshot {
  state: RealtimeCircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextRetryTime: number | null;
  halfOpenActiveCount: number;
  totalCalls: number;
  failureRate: number | null;
}

interface IntegrationHealthResponse {
  integrations: IntegrationHealthSummary[];
  circuitBreakers?: Record<string, RealtimeCircuitBreakerSnapshot>;
}

interface IntegrationProbeResult {
  integration: IntegrationName;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  checkedAt: string;
}

const useIntegrationHealth = () => {
  return useQuery<IntegrationHealthResponse>({
    queryKey: ['admin', 'integration-health'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-health/integration-health');
      return response.data;
    },
    refetchInterval: 30000,
  });
};

const useProbeIntegrations = () => {
  const queryClient = useQueryClient();
  return useMutation<{ results: IntegrationProbeResult[] }, Error, { integration?: IntegrationName }>({
    mutationFn: async ({ integration }) => {
      const body = integration ? { integration } : {};
      const response = await api.post('/api/admin/system-health/integration-health', body);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'integration-health'] });
    },
  });
};

const useCircuitBreakerOverride = () => {
  const queryClient = useQueryClient();
  return useMutation<
    { integration: IntegrationName; mode: CircuitBreakerMode },
    Error,
    { integration: IntegrationName; mode: CircuitBreakerMode; reason?: string }
  >({
    mutationFn: async ({ integration, mode, reason }) => {
      const response = await api.put('/api/admin/system-health/integration-health', {
        integration,
        mode,
        reason,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'integration-health'] });
    },
  });
};

const INTEGRATION_LABELS: Record<IntegrationName, string> = {
  slack: 'Slack',
  github: 'GitHub',
  jira: 'Jira',
  confluence: 'Confluence',
};

/** Maps integration names to MCP server names for real-time circuit breaker lookup */
const INTEGRATION_TO_MCP_SERVER: Partial<Record<IntegrationName, string>> = {
  slack: 'slack',
  github: 'github',
  jira: 'atlassian',
  confluence: 'atlassian',
};

const getRealtimeBreakerChipProps = (
  state: RealtimeCircuitBreakerState,
  snapshot: RealtimeCircuitBreakerSnapshot
): { tone: AdminStatusTone; label: string } => {
  switch (state) {
    case 'OPEN': {
      const ratePart = snapshot.failureRate !== null ? ` / ${Math.round(snapshot.failureRate * 100)}% rate` : '';
      return { tone: 'bad', label: `OPEN (${snapshot.failureCount} failures${ratePart})` };
    }
    case 'HALF_OPEN':
      return { tone: 'warn', label: `HALF_OPEN (${snapshot.successCount} successes)` };
    case 'CLOSED':
    default:
      return { tone: 'good', label: 'CLOSED' };
  }
};

const getStatusTone = (status: string): AdminStatusTone => {
  if (status === 'healthy') return 'good';
  if (status === 'degraded') return 'warn';
  if (status === 'no_data') return 'neutral';
  return 'bad';
};

/** A hairline-separated row inside a SectionCard body. */
const ROW_SX = {
  px: 2,
  py: 2,
  borderTop: '1px solid',
  borderColor: 'admin.border',
  '&:first-of-type': { borderTop: 0 },
};

/** Actionable guidance for common email errors. */
const getEmailErrorGuidance = (error: string): string | null => {
  // SES identity not verified
  if (error.includes('Email address is not verified') || error.includes('identities failed the check')) {
    const regionMatch = error.match(/region ([A-Z]{2}-[A-Z]+-\d+)/i);
    const region = regionMatch ? regionMatch[1] : 'your region';
    return `AWS SES requires sender verification. Go to AWS Console → SES → Verified Identities (in ${region}) and verify your sender email address or domain.`;
  }

  // SES sandbox mode (recipient not verified)
  if (error.includes('Address rejected') || error.includes('recipient')) {
    return 'Your AWS SES account may be in sandbox mode. Request production access in AWS Console → SES → Account dashboard, or verify recipient emails for testing.';
  }

  // Connection refused
  if (error.includes('ECONNREFUSED') || error.includes('connection refused')) {
    return 'Cannot connect to SMTP server. Verify MAIL_HOST and MAIL_PORT are correct and the server is accessible.';
  }

  // Auth failed
  if (error.includes('authentication') || error.includes('535') || error.includes('Invalid login')) {
    return 'SMTP authentication failed. Verify MAIL_USERNAME and MAIL_PASSWORD are correct.';
  }

  // Timeout
  if (error.includes('ETIMEDOUT') || error.includes('timeout')) {
    return 'Connection timed out. Check if MAIL_HOST is correct and the SMTP port is open in your security groups/firewall.';
  }

  return null;
};

/** Actionable guidance for common OAuth errors. */
const getOAuthErrorGuidance = (provider: OAuthProvider, error: string): string | null => {
  // Missing configuration
  if (error.includes('Missing configuration')) {
    const secretNames: Record<OAuthProvider, string[]> = {
      okta: ['OKTA_AUDIENCE', 'OKTA_CLIENT_ID', 'OKTA_CLIENT_SECRET'],
      google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    };
    return `Set the required secrets using: ./for-env <stage> npx sst secret set ${secretNames[provider].join(' <value> && ./for-env <stage> npx sst secret set ')} <value>`;
  }

  // Network errors
  if (error.includes('ECONNREFUSED') || error.includes('ENOTFOUND') || error.includes('getaddrinfo')) {
    return 'Cannot reach the OAuth provider. Check your network connectivity and verify the provider URL is correct.';
  }

  // Timeout
  if (error.includes('ETIMEDOUT') || error.includes('timeout') || error.includes('Timeout')) {
    return 'Connection timed out. The OAuth provider may be temporarily unavailable or blocked by a firewall.';
  }

  // Okta-specific: Invalid audience URL
  if (provider === 'okta' && (error.includes('404') || error.includes('Not Found'))) {
    return 'The Okta discovery endpoint returned 404. Verify OKTA_AUDIENCE is your Okta domain (e.g., https://your-domain.okta.com) without a trailing slash.';
  }

  // SSL/TLS errors
  if (error.includes('certificate') || error.includes('SSL') || error.includes('TLS')) {
    return 'SSL/TLS certificate error. The OAuth provider may have an invalid or expired certificate.';
  }

  // Generic HTTP errors
  const httpMatch = error.match(/status(?:\s+code)?:?\s*(\d{3})/i);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === '401' || status === '403') {
      return 'Authentication failed. Verify your client ID and secret are correct for this OAuth provider.';
    }
    if (status === '500' || status === '502' || status === '503') {
      return 'The OAuth provider returned a server error. This is likely a temporary issue on their end.';
    }
  }

  return null;
};

const ConfigStatusChip = ({ configured, testId }: { configured: boolean; testId?: string }) => (
  <StatusChip tone={configured ? 'good' : 'warn'} label={configured ? 'Configured' : 'Missing'} data-testid={testId} />
);

const OAUTH_PROVIDERS: { key: OAuthProvider; label: string }[] = [
  { key: 'google', label: 'Google' },
  { key: 'github', label: 'GitHub' },
  { key: 'okta', label: 'Okta' },
];

/** Detailed Okta diagnostics: JWKS, token/userinfo endpoints, issuer validation. */
const OktaDiagnosticsPanel = ({ diagnostics }: { diagnostics: OktaDiagnostics }) => {
  const items: { label: string; status: AdminStatusTone; detail: string }[] = [];

  // JWKS status
  if (diagnostics.jwks) {
    if (diagnostics.jwks.reachable && diagnostics.jwks.keyCount > 0) {
      items.push({
        label: 'JWKS',
        status: 'good',
        detail: `${diagnostics.jwks.keyCount} signing key(s) found`,
      });
    } else if (diagnostics.jwks.reachable && diagnostics.jwks.keyCount === 0) {
      items.push({
        label: 'JWKS',
        status: 'warn',
        detail: diagnostics.jwks.error || 'No signing keys found',
      });
    } else {
      items.push({
        label: 'JWKS',
        status: 'bad',
        detail: diagnostics.jwks.error || 'Unreachable',
      });
    }
  }

  // Token endpoint status
  if (diagnostics.tokenEndpoint) {
    if (diagnostics.tokenEndpoint.reachable) {
      if (diagnostics.tokenEndpoint.acceptsClientAuth) {
        items.push({
          label: 'Token Endpoint',
          status: 'good',
          detail: `Responds (${diagnostics.tokenEndpoint.status})`,
        });
      } else {
        items.push({
          label: 'Token Endpoint',
          status: 'warn',
          detail: 'Reachable but may reject client credentials',
        });
      }
    } else {
      items.push({
        label: 'Token Endpoint',
        status: 'bad',
        detail: diagnostics.tokenEndpoint.error || 'Unreachable',
      });
    }
  }

  // Userinfo endpoint status
  if (diagnostics.userinfoEndpoint) {
    if (diagnostics.userinfoEndpoint.reachable) {
      items.push({
        label: 'Userinfo Endpoint',
        status: 'good',
        detail: `Responds (${diagnostics.userinfoEndpoint.status})`,
      });
    } else {
      items.push({
        label: 'Userinfo Endpoint',
        status: 'bad',
        detail: diagnostics.userinfoEndpoint.error || 'Unreachable',
      });
    }
  }

  // Issuer match status
  if (diagnostics.issuerMatch !== undefined) {
    if (diagnostics.issuerMatch) {
      items.push({
        label: 'Issuer',
        status: 'good',
        detail: 'Matches expected URL',
      });
    } else {
      items.push({
        label: 'Issuer',
        status: 'bad',
        detail: `Mismatch: expected ${diagnostics.expectedIssuer}, got ${diagnostics.actualIssuer}`,
      });
    }
  }

  // RS256 signing support
  if (diagnostics.supportsRS256 !== undefined) {
    if (diagnostics.supportsRS256) {
      items.push({
        label: 'Signing',
        status: 'good',
        detail: 'RS256 supported',
      });
    } else {
      items.push({
        label: 'Signing',
        status: 'warn',
        detail: `RS256 not supported (available: ${diagnostics.signingAlgorithms?.join(', ') || 'none'})`,
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <Box sx={{ mt: 1, pl: 1, borderLeft: '2px solid', borderColor: 'admin.border' }}>
      <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
        Detailed diagnostics:
      </Typography>
      <Stack spacing={0.5}>
        {items.map(item => (
          <Stack key={item.label} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <StatusChip tone={item.status} label={item.label} />
            <Typography level="body-xs">{item.detail}</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
};

const AdminSystemHealthTab = () => {
  const systemHealth = useSystemHealth();
  const sendTestEmail = useSendTestEmail();
  const testDatabase = useTestDatabase();
  const testOAuth = useTestOAuth();
  const [lastTestResult, setLastTestResult] = useState<TestEmailResponse | null>(null);
  const [lastDbTestResult, setLastDbTestResult] = useState<TestDatabaseResponse | null>(null);
  const [oauthTestResults, setOAuthTestResults] = useState<Record<OAuthProvider, TestOAuthResult | null>>({
    google: null,
    github: null,
    okta: null,
  });
  const [testingProvider, setTestingProvider] = useState<OAuthProvider | null>(null);

  // Integration health
  const integrationHealth = useIntegrationHealth();
  const probeIntegrations = useProbeIntegrations();
  const circuitBreakerOverride = useCircuitBreakerOverride();
  const [probingIntegration, setProbingIntegration] = useState<IntegrationName | 'all' | null>(null);
  const [overridingIntegration, setOverridingIntegration] = useState<IntegrationName | null>(null);

  const handleRefresh = async () => {
    await Promise.all([systemHealth.refetch(), integrationHealth.refetch()]);
    toast.success('System health status refreshed');
  };

  const handleProbeAll = async () => {
    setProbingIntegration('all');
    try {
      const result = await probeIntegrations.mutateAsync({});
      const healthy = result.results.filter(r => r.status === 'healthy').length;
      toast.success(`Probed ${result.results.length} integrations (${healthy} healthy)`);
    } catch (error: unknown) {
      const message =
        isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : error instanceof Error
            ? error.message
            : 'Failed to probe integrations';
      toast.error(message);
    } finally {
      setProbingIntegration(null);
    }
  };

  const handleProbeSingle = async (integration: IntegrationName) => {
    setProbingIntegration(integration);
    try {
      await probeIntegrations.mutateAsync({ integration });
      toast.success(`${INTEGRATION_LABELS[integration]} probe complete`);
    } catch (error: unknown) {
      const message =
        isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : error instanceof Error
            ? error.message
            : `Failed to probe ${INTEGRATION_LABELS[integration]}`;
      toast.error(message);
    } finally {
      setProbingIntegration(null);
    }
  };

  const handleCircuitBreakerOverride = async (integration: IntegrationName, mode: CircuitBreakerMode) => {
    setOverridingIntegration(integration);
    try {
      await circuitBreakerOverride.mutateAsync({ integration, mode });
      const label = INTEGRATION_LABELS[integration];
      const modeLabel = mode === 'force_block' ? 'blocked' : mode === 'force_open' ? 'force-opened' : 'reset to auto';
      toast.success(`${label} circuit breaker ${modeLabel}`);
    } catch (error: unknown) {
      const message =
        isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : error instanceof Error
            ? error.message
            : 'Failed to update circuit breaker';
      toast.error(message);
    } finally {
      setOverridingIntegration(null);
    }
  };

  const handleSendTestEmail = async () => {
    try {
      const result = await sendTestEmail.mutateAsync({});
      setLastTestResult(result);
      if (result.success) {
        toast.success(`Test email sent to ${result.sentTo}`);
      } else {
        toast.error(`Failed to send test email: ${result.error}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send test email';
      toast.error(errorMessage);
      setLastTestResult({
        success: false,
        error: errorMessage,
        sentTo: '',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const handleTestDatabase = async () => {
    try {
      const result = await testDatabase.mutateAsync();
      setLastDbTestResult(result);
      if (result.success) {
        toast.success(`Database ping successful (${result.latencyMs}ms)`);
      } else {
        toast.error(`Database test failed: ${result.error}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to test database';
      toast.error(errorMessage);
      setLastDbTestResult({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const handleTestOAuth = async (provider: OAuthProvider) => {
    setTestingProvider(provider);
    try {
      const result = await testOAuth.mutateAsync({ provider });
      setOAuthTestResults(prev => ({ ...prev, [provider]: result }));
      if (result.success) {
        toast.success(`${provider} OAuth test passed (${result.latencyMs}ms)`);
      } else {
        toast.error(`${provider} OAuth test failed: ${result.error}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to test OAuth';
      toast.error(errorMessage);
      setOAuthTestResults(prev => ({
        ...prev,
        [provider]: {
          success: false,
          provider,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      }));
    } finally {
      setTestingProvider(null);
    }
  };

  const header = (
    <AdminPageHeader
      title="System health"
      description="Configuration and connection status for email, database, sign-in and integrations."
      actions={
        <>
          <ContextHelpButton helpId="admin/system-health" tooltipText="System health help" />
          <Button
            size="sm"
            variant="outlined"
            startDecorator={systemHealth.isFetching ? undefined : <RefreshIcon sx={{ fontSize: 16 }} />}
            onClick={handleRefresh}
            loading={systemHealth.isFetching}
            data-testid="system-health-refresh-btn"
            sx={adminFocus}
          >
            Refresh
          </Button>
        </>
      }
    />
  );

  if (systemHealth.isPending) {
    return (
      <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-system-health-tab">
        {header}
        <LoadingState label="Loading system health" />
      </Stack>
    );
  }

  if (systemHealth.isError) {
    return (
      <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-system-health-tab">
        {header}
        <ErrorState
          message="Failed to load system health status."
          onRetry={() => systemHealth.refetch()}
          retrying={systemHealth.isFetching}
        />
      </Stack>
    );
  }

  const { email, database, oauth } = systemHealth.data || {};
  const integrations = integrationHealth.data?.integrations ?? [];

  const renderBreakerChip = (
    integration: IntegrationHealthSummary['integration'],
    kind: 'read' | 'write',
    snapshot: RealtimeCircuitBreakerSnapshot | undefined
  ) => {
    if (!snapshot) return null;
    const { tone, label } = getRealtimeBreakerChipProps(snapshot.state, snapshot);
    return (
      <StatusChip
        tone={tone}
        label={`${kind === 'read' ? 'Read' : 'Write'}: ${label}`}
        data-testid={`realtime-breaker-${integration}-${kind}`}
      />
    );
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-system-health-tab">
      {header}

      <SectionCard
        title="Email"
        body="custom"
        action={<ConfigStatusChip configured={email?.configured ?? false} testId="system-health-email-status" />}
      >
        <Stack gap={2} sx={{ p: 2 }}>
          {!email?.configured && (
            <Alert color="warning" variant="outlined">
              <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                <Typography level="body-sm" fontWeight="bold">
                  Email not configured
                </Typography>
                <Typography level="body-xs">
                  Users will not receive verification emails, password resets, or other system emails.
                </Typography>
              </Stack>
            </Alert>
          )}

          <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
            Required secrets
          </Typography>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 1 }}>
            {email?.secrets &&
              Object.entries(email.secrets).map(([key, configured]) => (
                <Stack key={key} direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
                  <Typography level="body-sm" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
                    {key}
                  </Typography>
                  {!configured && <StatusChip tone="warn" label="Missing" />}
                </Stack>
              ))}
          </Box>

          {email?.missingSecrets && email.missingSecrets.length > 0 && (
            <Alert color="warning" variant="outlined">
              <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                <Typography level="body-sm" fontWeight="bold">
                  Missing secrets
                </Typography>
                <Typography level="body-xs">{email.missingSecrets.join(', ')}</Typography>
                <Typography level="body-xs">
                  Set these using: <code>./for-env {'<stage>'} npx sst secret set MAIL_HOST smtp.example.com</code>
                </Typography>
              </Stack>
            </Alert>
          )}

          <Stack direction="row" alignItems="center" flexWrap="wrap" gap={2}>
            <Button
              variant="outlined"
              startDecorator={<SendIcon />}
              onClick={handleSendTestEmail}
              loading={sendTestEmail.isPending}
              disabled={!email?.configured || sendTestEmail.isPending}
              data-testid="system-health-send-test-email-btn"
              sx={adminFocus}
            >
              Send test email
            </Button>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              Sends a test email to your admin email address
            </Typography>
          </Stack>

          {lastTestResult && (
            <Alert color={lastTestResult.success ? 'success' : 'danger'} variant="outlined">
              <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                <Typography level="body-sm" fontWeight="bold">
                  {lastTestResult.success ? 'Test email sent successfully!' : 'Test email failed'}
                </Typography>
                {lastTestResult.success ? (
                  <>
                    <Typography level="body-xs">Sent to: {lastTestResult.sentTo}</Typography>
                    {lastTestResult.messageId && (
                      <Typography level="body-xs">Message ID: {lastTestResult.messageId}</Typography>
                    )}
                  </>
                ) : (
                  <>
                    <Typography level="body-xs">Error: {lastTestResult.error}</Typography>
                    {lastTestResult.error && getEmailErrorGuidance(lastTestResult.error) && (
                      <Typography level="body-xs" sx={{ mt: 1, fontStyle: 'italic' }}>
                        How to fix: {getEmailErrorGuidance(lastTestResult.error)}
                      </Typography>
                    )}
                  </>
                )}
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  {new Date(lastTestResult.timestamp).toLocaleString()}
                </Typography>
              </Stack>
            </Alert>
          )}
        </Stack>
      </SectionCard>

      <SectionCard
        title="Database"
        body="custom"
        action={
          <StatusChip
            tone={database?.connected ? 'good' : 'bad'}
            label={database?.connected ? 'Connected' : 'Disconnected'}
            data-testid="system-health-database-status"
          />
        }
      >
        <Stack gap={2} sx={{ p: 2 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 2 }}>
            <Stack spacing={0.5}>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Database type
              </Typography>
              <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                {database?.type || 'Unknown'}
              </Typography>
            </Stack>

            <Stack spacing={0.5}>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Ready state
              </Typography>
              <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                {database?.readyState === 0
                  ? 'Disconnected'
                  : database?.readyState === 1
                    ? 'Connected'
                    : database?.readyState === 2
                      ? 'Connecting'
                      : database?.readyState === 3
                        ? 'Disconnecting'
                        : 'Unknown'}
              </Typography>
            </Stack>
          </Box>

          {database?.type === 'DocumentDB' && (
            <Alert color="neutral" variant="outlined">
              <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                <Typography level="body-sm" fontWeight="bold">
                  DocumentDB detected
                </Typography>
                <Typography level="body-xs">
                  Ensure <code>MAIN_DB_TYPE=DocumentDB</code> is set in your environment to disable retryable writes
                  (not supported by DocumentDB).
                </Typography>
              </Stack>
            </Alert>
          )}

          <Stack direction="row" alignItems="center" flexWrap="wrap" gap={2}>
            <Button
              variant="outlined"
              startDecorator={<NetworkPingIcon />}
              onClick={handleTestDatabase}
              loading={testDatabase.isPending}
              disabled={!database?.connected || testDatabase.isPending}
              data-testid="system-health-test-database-btn"
              sx={adminFocus}
            >
              Test connection
            </Button>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              Runs a ping command to verify database connectivity
            </Typography>
          </Stack>

          {lastDbTestResult && (
            <Alert color={lastDbTestResult.success ? 'success' : 'danger'} variant="outlined">
              <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                <Typography level="body-sm" fontWeight="bold">
                  {lastDbTestResult.success ? 'Database connection successful!' : 'Database connection failed'}
                </Typography>
                {lastDbTestResult.success ? (
                  <Typography level="body-xs">Latency: {lastDbTestResult.latencyMs}ms</Typography>
                ) : (
                  <Typography level="body-xs">Error: {lastDbTestResult.error}</Typography>
                )}
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  {new Date(lastDbTestResult.timestamp).toLocaleString()}
                </Typography>
              </Stack>
            </Alert>
          )}
        </Stack>
      </SectionCard>

      <SectionCard title="OAuth providers" body="custom">
        <Stack>
          {OAUTH_PROVIDERS.map(({ key, label }) => {
            const providerStatus = oauth?.[key] as OAuthProviderStatus | undefined;
            const testResult = oauthTestResults[key];
            const isConfigured = providerStatus?.configured ?? false;

            return (
              <Stack key={key} gap={1.5} sx={ROW_SX} data-testid={`system-health-oauth-${key}-row`}>
                <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
                  <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
                    {label}
                  </Typography>
                  <ConfigStatusChip configured={isConfigured} testId={`system-health-oauth-${key}-status`} />
                  <Button
                    size="sm"
                    variant="outlined"
                    startDecorator={<NetworkPingIcon />}
                    onClick={() => handleTestOAuth(key)}
                    loading={testingProvider === key}
                    disabled={!isConfigured || testingProvider !== null}
                    data-testid={`system-health-test-oauth-${key}-btn`}
                    sx={{ ...adminFocus, ml: 'auto' }}
                  >
                    Test {label}
                  </Button>
                </Stack>

                {!isConfigured && providerStatus?.missingSecrets && providerStatus.missingSecrets.length > 0 && (
                  <Alert color="warning" variant="outlined" size="sm">
                    <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                      <Typography level="body-xs" fontWeight="bold">
                        Missing configuration
                      </Typography>
                      <Typography level="body-xs">{providerStatus.missingSecrets.join(', ')}</Typography>
                    </Stack>
                  </Alert>
                )}

                {/* Okta-specific: Show config source and warnings */}
                {key === 'okta' && providerStatus && (
                  <>
                    {providerStatus.effectiveSource && (
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                          Config source:
                        </Typography>
                        <StatusChip
                          tone={providerStatus.effectiveSource === 'database' ? 'info' : 'neutral'}
                          label={
                            providerStatus.effectiveSource === 'database'
                              ? 'Database IDP'
                              : providerStatus.effectiveSource === 'sst'
                                ? 'SST secrets'
                                : 'Not configured'
                          }
                        />
                      </Stack>
                    )}

                    {providerStatus.databaseConfigured && providerStatus.sstConfigured && (
                      <Alert color="neutral" variant="outlined" size="sm">
                        <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                          Database IDP config is active and overriding SST secrets.
                        </Typography>
                      </Alert>
                    )}

                    {providerStatus.missingSecrets?.includes('JWT_SECRET') && (
                      <Alert color="warning" variant="outlined" size="sm">
                        <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                          <Typography level="body-xs" fontWeight="bold">
                            JWT_SECRET missing
                          </Typography>
                          <Typography level="body-xs">
                            Okta login will fail with <code>error=okta_setup_failed</code>
                          </Typography>
                          <Typography level="body-xs">
                            JWT_SECRET is required for OAuth state token signing (CSRF protection).
                          </Typography>
                          <Typography level="body-xs">
                            Generate and set:{' '}
                            <code>
                              ./for-env {'<stage>'} npx sst secret set JWT_SECRET &quot;$(openssl rand -base64 48)&quot;
                            </code>
                          </Typography>
                        </Stack>
                      </Alert>
                    )}

                    {providerStatus.warnings && providerStatus.warnings.length > 0 && (
                      <Alert color="warning" variant="outlined" size="sm">
                        <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                          <Typography level="body-xs" fontWeight="bold">
                            Configuration warning
                          </Typography>
                          {providerStatus.warnings.map(warning => (
                            <Typography key={warning} level="body-xs">
                              {warning}
                            </Typography>
                          ))}
                        </Stack>
                      </Alert>
                    )}
                  </>
                )}

                {testResult && (
                  <Alert color={testResult.success ? 'success' : 'danger'} variant="outlined" size="sm">
                    <Stack spacing={0.5} sx={{ color: 'text.primary' }}>
                      <Typography level="body-xs" fontWeight="bold">
                        {testResult.success ? 'Test passed!' : 'Test failed'}
                        {testResult.success && testResult.latencyMs && ` (${testResult.latencyMs}ms)`}
                      </Typography>
                      {testResult.success && testResult.details?.endpoint && (
                        <Typography level="body-xs">Endpoint: {testResult.details.endpoint}</Typography>
                      )}
                      {key === 'okta' && testResult.details?.configSource && (
                        <Typography level="body-xs">
                          Config source:{' '}
                          {testResult.details.configSource === 'database' ? 'Database IDP' : 'SST secrets'}
                        </Typography>
                      )}
                      {key === 'okta' && testResult.success && testResult.details?.diagnostics && (
                        <OktaDiagnosticsPanel diagnostics={testResult.details.diagnostics} />
                      )}
                      {key === 'okta' && testResult.success && testResult.error && (
                        <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 0.5 }}>
                          <StatusChip tone="warn" label="Warning" />
                          <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                            {testResult.error}
                          </Typography>
                        </Stack>
                      )}
                      {!testResult.success && testResult.error && (
                        <>
                          <Typography level="body-xs">Error: {testResult.error}</Typography>
                          {getOAuthErrorGuidance(key, testResult.error) && (
                            <Typography level="body-xs" sx={{ mt: 0.5, fontStyle: 'italic' }}>
                              How to fix: {getOAuthErrorGuidance(key, testResult.error)}
                            </Typography>
                          )}
                        </>
                      )}
                      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                        {new Date(testResult.timestamp).toLocaleString()}
                      </Typography>
                    </Stack>
                  </Alert>
                )}
              </Stack>
            );
          })}
          <Box sx={ROW_SX}>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              OAuth tests verify connectivity to provider endpoints. Configure secrets using:{' '}
              <code>./for-env {'<stage>'} npx sst secret set OKTA_AUDIENCE https://your-domain.okta.com</code>
            </Typography>
          </Box>
        </Stack>
      </SectionCard>

      <SectionCard
        title="Integration health"
        body="custom"
        action={
          <Button
            size="sm"
            variant="outlined"
            startDecorator={probingIntegration === 'all' ? undefined : <NetworkPingIcon />}
            onClick={handleProbeAll}
            loading={probingIntegration === 'all'}
            disabled={probingIntegration !== null}
            data-testid="integration-health-probe-all-btn"
            sx={adminFocus}
          >
            Probe all
          </Button>
        }
      >
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted', px: 2, pt: 2 }}>
          Proactive health monitoring for Slack, GitHub and Atlassian. Probes run automatically every 5 minutes.
        </Typography>

        {integrationHealth.isPending ? (
          <LoadingState label="Loading integrations" />
        ) : integrationHealth.isError ? (
          <ErrorState
            message="Unable to load integration health data. Health probes may not have run yet."
            onRetry={() => integrationHealth.refetch()}
            retrying={integrationHealth.isFetching}
          />
        ) : integrations.length === 0 ? (
          <EmptyState
            title="No integration health data yet"
            description="Health probes will populate this section automatically."
            action={
              <Button
                size="sm"
                variant="outlined"
                onClick={handleProbeAll}
                loading={probingIntegration === 'all'}
                disabled={probingIntegration !== null}
                data-testid="integration-health-empty-probe-btn"
                sx={adminFocus}
              >
                Probe all
              </Button>
            }
          />
        ) : (
          <Stack sx={{ mt: 1 }}>
            {integrations.map(integration => (
              <Stack key={integration.integration} gap={1.5} sx={ROW_SX}>
                <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
                  <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
                    {INTEGRATION_LABELS[integration.integration]}
                  </Typography>
                  <StatusChip
                    tone={getStatusTone(integration.status)}
                    label={
                      integration.status === 'no_data'
                        ? 'Not checked'
                        : integration.status.charAt(0).toUpperCase() + integration.status.slice(1)
                    }
                    data-testid={`integration-health-${integration.integration}-status`}
                  />
                </Stack>

                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, maxWidth: 360 }}>
                  <Stack spacing={0.25}>
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      Latency
                    </Typography>
                    <Typography level="body-sm" fontWeight="bold" sx={{ color: 'admin.ink' }}>
                      {integration.latencyMs > 0 ? `${integration.latencyMs}ms` : '--'}
                    </Typography>
                  </Stack>
                  <Stack spacing={0.25}>
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      Success rate (24h)
                    </Typography>
                    <Stack direction="row" alignItems="center" gap={1}>
                      <Typography level="body-sm" fontWeight="bold" sx={{ color: 'admin.ink' }}>
                        {integration.successRate > 0 ? `${(integration.successRate * 100).toFixed(1)}%` : '--'}
                      </Typography>
                      {integration.successRate > 0 && <InlineBar value={integration.successRate * 100} max={100} />}
                    </Stack>
                  </Stack>
                </Box>

                {integration.consecutiveFailures >= 3 && (
                  <Alert color="danger" variant="outlined" size="sm">
                    <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                      {integration.consecutiveFailures} consecutive failures
                    </Typography>
                  </Alert>
                )}

                {integration.error && (
                  <Typography level="body-xs" sx={{ color: 'admin.danger', wordBreak: 'break-word' }}>
                    {integration.error}
                  </Typography>
                )}

                {integration.circuitBreaker && (
                  <Stack spacing={1}>
                    <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
                      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                        Circuit breaker:
                      </Typography>
                      {integration.circuitBreaker.mode === 'force_block' && (
                        <StatusChip
                          tone="bad"
                          label="Blocked (manual)"
                          data-testid={`circuit-breaker-status-${integration.integration}`}
                        />
                      )}
                      {integration.circuitBreaker.mode === 'force_open' && (
                        <StatusChip
                          tone="warn"
                          label="Forced open (manual)"
                          data-testid={`circuit-breaker-status-${integration.integration}`}
                        />
                      )}
                      {integration.circuitBreaker.mode === 'auto' && integration.circuitBreaker.autoTripped && (
                        <StatusChip
                          tone="bad"
                          label="Tripped (auto)"
                          data-testid={`circuit-breaker-status-${integration.integration}`}
                        />
                      )}
                      {integration.circuitBreaker.mode === 'auto' &&
                        !integration.circuitBreaker.autoTripped &&
                        integration.circuitBreaker.noData && (
                          <StatusChip
                            tone="neutral"
                            label="OK (no data)"
                            data-testid={`circuit-breaker-status-${integration.integration}`}
                          />
                        )}
                      {integration.circuitBreaker.mode === 'auto' &&
                        !integration.circuitBreaker.autoTripped &&
                        !integration.circuitBreaker.noData && (
                          <StatusChip
                            tone="good"
                            label="OK (auto)"
                            data-testid={`circuit-breaker-status-${integration.integration}`}
                          />
                        )}
                    </Stack>

                    <Stack direction="row" flexWrap="wrap" gap={0.5}>
                      {integration.circuitBreaker.mode !== 'force_block' && (
                        <Button
                          size="sm"
                          variant="outlined"
                          color="danger"
                          startDecorator={<BlockIcon />}
                          onClick={() => handleCircuitBreakerOverride(integration.integration, 'force_block')}
                          loading={overridingIntegration === integration.integration}
                          disabled={overridingIntegration !== null}
                          data-testid={`circuit-breaker-block-${integration.integration}-btn`}
                          sx={adminFocus}
                        >
                          Block
                        </Button>
                      )}
                      {(integration.circuitBreaker.autoTripped ||
                        integration.circuitBreaker.mode === 'force_block') && (
                        <Button
                          size="sm"
                          variant="outlined"
                          color="neutral"
                          startDecorator={<LockOpenIcon />}
                          onClick={() => handleCircuitBreakerOverride(integration.integration, 'force_open')}
                          loading={overridingIntegration === integration.integration}
                          disabled={overridingIntegration !== null}
                          data-testid={`circuit-breaker-force-open-${integration.integration}-btn`}
                          sx={adminFocus}
                        >
                          Force open
                        </Button>
                      )}
                      {integration.circuitBreaker.mode !== 'auto' && (
                        <Button
                          size="sm"
                          variant="outlined"
                          color="neutral"
                          startDecorator={<RestartAltIcon />}
                          onClick={() => handleCircuitBreakerOverride(integration.integration, 'auto')}
                          loading={overridingIntegration === integration.integration}
                          disabled={overridingIntegration !== null}
                          title="Also resets the in-memory MCP breakers for all users"
                          data-testid={`circuit-breaker-reset-${integration.integration}-btn`}
                          sx={adminFocus}
                        >
                          Reset to auto (all users)
                        </Button>
                      )}
                    </Stack>
                  </Stack>
                )}

                {(() => {
                  const mcpServer = INTEGRATION_TO_MCP_SERVER[integration.integration];
                  if (!mcpServer) return null;
                  const readSnapshot = integrationHealth.data?.circuitBreakers?.[`${mcpServer}:read`];
                  const writeSnapshot = integrationHealth.data?.circuitBreakers?.[`${mcpServer}:write`];
                  if (!readSnapshot && !writeSnapshot) return null;
                  return (
                    <Stack
                      direction="row"
                      alignItems="center"
                      gap={1}
                      sx={{ flexWrap: 'wrap' }}
                      data-testid={`realtime-breaker-${integration.integration}`}
                    >
                      <Typography
                        level="body-xs"
                        sx={{ color: 'admin.inkMuted' }}
                        title="Worst state across users: OPEN means open for at least one user"
                      >
                        Real-time (worst across users):
                      </Typography>
                      {renderBreakerChip(integration.integration, 'read', readSnapshot)}
                      {renderBreakerChip(integration.integration, 'write', writeSnapshot)}
                    </Stack>
                  );
                })()}

                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    {integration.lastCheckedAt
                      ? `Checked ${new Date(integration.lastCheckedAt).toLocaleTimeString()}`
                      : 'No data yet'}
                  </Typography>
                  <Button
                    size="sm"
                    variant="plain"
                    onClick={() => handleProbeSingle(integration.integration)}
                    loading={probingIntegration === integration.integration}
                    disabled={probingIntegration !== null}
                    data-testid={`integration-health-probe-${integration.integration}-btn`}
                    sx={adminFocus}
                  >
                    Probe
                  </Button>
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </SectionCard>

      <SectionCard title="Troubleshooting" body="custom">
        <Box sx={{ p: 2, color: 'admin.ink' }}>
          <Typography level="body-sm">
            If you&apos;re running a fork of this application and experiencing configuration issues:
          </Typography>
          <Box component="ul" sx={{ my: 1, pl: 2.5, display: 'grid', gap: 0.5 }}>
            <li>
              <Typography level="body-sm">
                Check the fork setup documentation for required environment variables
              </Typography>
            </li>
            <li>
              <Typography level="body-sm">
                Use <code>./for-env {'<stage>'} npx sst secret list</code> to see configured secrets
              </Typography>
            </li>
            <li>
              <Typography level="body-sm">
                For email issues, verify your SMTP provider credentials and DNS records (SPF, DKIM, DMARC)
              </Typography>
            </li>
            <li>
              <Typography level="body-sm">
                For database issues, ensure your MongoDB/DocumentDB connection string is correct
              </Typography>
            </li>
          </Box>
        </Box>
      </SectionCard>
    </Stack>
  );
};

export default AdminSystemHealthTab;
