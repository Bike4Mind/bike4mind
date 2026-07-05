import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Sheet,
  Stack,
  Typography,
} from '@mui/joy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import EmailIcon from '@mui/icons-material/Email';
import StorageIcon from '@mui/icons-material/Storage';
import SendIcon from '@mui/icons-material/Send';
import NetworkPingIcon from '@mui/icons-material/NetworkPing';
import SecurityIcon from '@mui/icons-material/Security';
import CloudIcon from '@mui/icons-material/Cloud';
import BlockIcon from '@mui/icons-material/Block';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import type { SystemHealthResponse, OAuthProviderStatus } from '@client/pages/api/admin/system-health';
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
  allConfigMissing?: boolean;
}

interface IntegrationHealthSummary {
  integration: IntegrationName;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  lastCheckedAt: string;
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
): { color: 'success' | 'danger' | 'warning'; label: string } => {
  switch (state) {
    case 'OPEN': {
      const ratePart = snapshot.failureRate !== null ? ` / ${Math.round(snapshot.failureRate * 100)}% rate` : '';
      return { color: 'danger', label: `OPEN (${snapshot.failureCount} failures${ratePart})` };
    }
    case 'HALF_OPEN':
      return { color: 'warning', label: `HALF_OPEN (${snapshot.successCount} successes)` };
    case 'CLOSED':
    default:
      return { color: 'success', label: 'CLOSED' };
  }
};

const getStatusColor = (status: string): 'success' | 'warning' | 'danger' => {
  if (status === 'healthy') return 'success';
  if (status === 'degraded') return 'warning';
  return 'danger';
};

const getStatusIcon = (status: string) => {
  if (status === 'healthy') return <CheckCircleIcon sx={{ fontSize: 16 }} />;
  if (status === 'degraded') return <WarningIcon sx={{ fontSize: 16 }} />;
  return <ErrorIcon sx={{ fontSize: 16 }} />;
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
  <Chip
    size="sm"
    color={configured ? 'success' : 'danger'}
    variant="outlined"
    startDecorator={configured ? <CheckCircleIcon /> : <ErrorIcon />}
    data-testid={testId}
  >
    {configured ? 'Configured' : 'Missing'}
  </Chip>
);

const OAUTH_PROVIDERS: { key: OAuthProvider; label: string }[] = [
  { key: 'google', label: 'Google' },
  { key: 'github', label: 'GitHub' },
  { key: 'okta', label: 'Okta' },
];

/** Detailed Okta diagnostics: JWKS, token/userinfo endpoints, issuer validation. */
const OktaDiagnosticsPanel = ({ diagnostics }: { diagnostics: OktaDiagnostics }) => {
  const items: { label: string; status: 'success' | 'warning' | 'error'; detail: string }[] = [];

  // JWKS status
  if (diagnostics.jwks) {
    if (diagnostics.jwks.reachable && diagnostics.jwks.keyCount > 0) {
      items.push({
        label: 'JWKS',
        status: 'success',
        detail: `${diagnostics.jwks.keyCount} signing key(s) found`,
      });
    } else if (diagnostics.jwks.reachable && diagnostics.jwks.keyCount === 0) {
      items.push({
        label: 'JWKS',
        status: 'warning',
        detail: diagnostics.jwks.error || 'No signing keys found',
      });
    } else {
      items.push({
        label: 'JWKS',
        status: 'error',
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
          status: 'success',
          detail: `Responds (${diagnostics.tokenEndpoint.status})`,
        });
      } else {
        items.push({
          label: 'Token Endpoint',
          status: 'warning',
          detail: 'Reachable but may reject client credentials',
        });
      }
    } else {
      items.push({
        label: 'Token Endpoint',
        status: 'error',
        detail: diagnostics.tokenEndpoint.error || 'Unreachable',
      });
    }
  }

  // Userinfo endpoint status
  if (diagnostics.userinfoEndpoint) {
    if (diagnostics.userinfoEndpoint.reachable) {
      items.push({
        label: 'Userinfo Endpoint',
        status: 'success',
        detail: `Responds (${diagnostics.userinfoEndpoint.status})`,
      });
    } else {
      items.push({
        label: 'Userinfo Endpoint',
        status: 'error',
        detail: diagnostics.userinfoEndpoint.error || 'Unreachable',
      });
    }
  }

  // Issuer match status
  if (diagnostics.issuerMatch !== undefined) {
    if (diagnostics.issuerMatch) {
      items.push({
        label: 'Issuer',
        status: 'success',
        detail: 'Matches expected URL',
      });
    } else {
      items.push({
        label: 'Issuer',
        status: 'error',
        detail: `Mismatch: expected ${diagnostics.expectedIssuer}, got ${diagnostics.actualIssuer}`,
      });
    }
  }

  // RS256 signing support
  if (diagnostics.supportsRS256 !== undefined) {
    if (diagnostics.supportsRS256) {
      items.push({
        label: 'Signing',
        status: 'success',
        detail: 'RS256 supported',
      });
    } else {
      items.push({
        label: 'Signing',
        status: 'warning',
        detail: `RS256 not supported (available: ${diagnostics.signingAlgorithms?.join(', ') || 'none'})`,
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <Box sx={{ mt: 1, pl: 1, borderLeft: '2px solid', borderColor: 'neutral.300' }}>
      <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
        Detailed Diagnostics:
      </Typography>
      <Stack spacing={0.25}>
        {items.map(item => (
          <Stack key={item.label} direction="row" spacing={0.5} alignItems="center">
            {item.status === 'success' ? (
              <CheckCircleIcon sx={{ fontSize: 14, color: 'success.500' }} />
            ) : item.status === 'warning' ? (
              <ErrorIcon sx={{ fontSize: 14, color: 'warning.500' }} />
            ) : (
              <ErrorIcon sx={{ fontSize: 14, color: 'danger.500' }} />
            )}
            <Typography level="body-xs">
              <strong>{item.label}:</strong> {item.detail}
            </Typography>
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

  if (systemHealth.isPending) {
    return (
      <Sheet sx={{ p: 4, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <CircularProgress />
      </Sheet>
    );
  }

  if (systemHealth.isError) {
    return (
      <Sheet sx={{ p: 2 }}>
        <Alert color="danger" variant="outlined">
          <Typography sx={{ color: 'text.primary' }}>Failed to load system health status. Please try again.</Typography>
        </Alert>
      </Sheet>
    );
  }

  const { email, database, oauth } = systemHealth.data || {};

  return (
    <Sheet sx={{ px: 2, py: 1 }}>
      <Stack spacing={3}>
        {/* Header */}
        <Card>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography level="h4">System Health</Typography>
                <ContextHelpButton helpId="admin/system-health" tooltipText="System Health Help" />
              </Stack>
              <Typography level="body-sm" color="neutral">
                Monitor configuration status for critical services. Useful for fork deployments to diagnose issues
                without CloudWatch access.
              </Typography>
            </Box>
            <Button
              size="sm"
              startDecorator={systemHealth.isFetching ? undefined : <RefreshIcon />}
              onClick={handleRefresh}
              loading={systemHealth.isFetching}
              data-testid="system-health-refresh-btn"
            >
              Refresh
            </Button>
          </Stack>
        </Card>

        {/* Email Configuration */}
        <Card>
          <Stack spacing={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <EmailIcon color="primary" />
              <Typography level="title-lg">Email Configuration</Typography>
              <ConfigStatusChip configured={email?.configured ?? false} testId="system-health-email-status" />
            </Stack>

            <Divider />

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

            <Typography level="body-sm" fontWeight="bold">
              Required Secrets Status:
            </Typography>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 1 }}>
              {email?.secrets &&
                Object.entries(email.secrets).map(([key, configured]) => (
                  <Stack key={key} direction="row" alignItems="center" spacing={1}>
                    {configured ? (
                      <CheckCircleIcon color="success" fontSize="small" />
                    ) : (
                      <ErrorIcon color="error" fontSize="small" />
                    )}
                    <Typography level="body-sm" color={configured ? 'neutral' : 'danger'}>
                      {key}
                    </Typography>
                  </Stack>
                ))}
            </Box>

            {email?.missingSecrets && email.missingSecrets.length > 0 && (
              <Alert color="danger" variant="outlined">
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

            <Divider />

            <Stack direction="row" alignItems="center" spacing={2}>
              <Button
                startDecorator={<SendIcon />}
                onClick={handleSendTestEmail}
                loading={sendTestEmail.isPending}
                disabled={!email?.configured || sendTestEmail.isPending}
                color="primary"
                data-testid="system-health-send-test-email-btn"
              >
                Send Test Email
              </Button>
              <Typography level="body-xs" color="neutral">
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
                  <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                    {new Date(lastTestResult.timestamp).toLocaleString()}
                  </Typography>
                </Stack>
              </Alert>
            )}
          </Stack>
        </Card>

        {/* Database Configuration */}
        <Card>
          <Stack spacing={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <StorageIcon color="primary" />
              <Typography level="title-lg">Database Configuration</Typography>
              <ConfigStatusChip configured={database?.connected ?? false} testId="system-health-database-status" />
            </Stack>

            <Divider />

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 2 }}>
              <Stack spacing={0.5}>
                <Typography level="body-xs" color="neutral">
                  Database Type
                </Typography>
                <Chip size="sm" variant="outlined">
                  {database?.type || 'Unknown'}
                </Chip>
              </Stack>

              <Stack spacing={0.5}>
                <Typography level="body-xs" color="neutral">
                  Connection Status
                </Typography>
                <Chip size="sm" color={database?.connected ? 'success' : 'danger'} variant="outlined">
                  {database?.connected ? 'Connected' : 'Disconnected'}
                </Chip>
              </Stack>

              <Stack spacing={0.5}>
                <Typography level="body-xs" color="neutral">
                  Ready State
                </Typography>
                <Chip size="sm" variant="outlined">
                  {database?.readyState === 0
                    ? 'Disconnected'
                    : database?.readyState === 1
                      ? 'Connected'
                      : database?.readyState === 2
                        ? 'Connecting'
                        : database?.readyState === 3
                          ? 'Disconnecting'
                          : 'Unknown'}
                </Chip>
              </Stack>
            </Box>

            {database?.type === 'DocumentDB' && (
              <Alert color="primary" variant="outlined">
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

            <Divider />

            <Stack direction="row" alignItems="center" spacing={2}>
              <Button
                startDecorator={<NetworkPingIcon />}
                onClick={handleTestDatabase}
                loading={testDatabase.isPending}
                disabled={!database?.connected || testDatabase.isPending}
                color="primary"
                data-testid="system-health-test-database-btn"
              >
                Test Connection
              </Button>
              <Typography level="body-xs" color="neutral">
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
                  <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                    {new Date(lastDbTestResult.timestamp).toLocaleString()}
                  </Typography>
                </Stack>
              </Alert>
            )}
          </Stack>
        </Card>

        {/* OAuth Providers */}
        <Card>
          <Stack spacing={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <SecurityIcon color="primary" />
              <Typography level="title-lg">OAuth Providers</Typography>
            </Stack>

            <Divider />

            <Typography level="body-sm" fontWeight="bold">
              Provider Configuration Status:
            </Typography>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 2 }}>
              {OAUTH_PROVIDERS.map(({ key, label }) => {
                const providerStatus = oauth?.[key] as OAuthProviderStatus | undefined;
                const testResult = oauthTestResults[key];
                const isConfigured = providerStatus?.configured ?? false;

                return (
                  <Card key={key} variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={1.5}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography level="title-sm">{label}</Typography>
                        <ConfigStatusChip configured={isConfigured} testId={`system-health-oauth-${key}-status`} />
                      </Stack>

                      {!isConfigured && providerStatus?.missingSecrets && providerStatus.missingSecrets.length > 0 && (
                        <Alert color="danger" variant="outlined" size="sm">
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
                          {/* Config source indicator */}
                          {providerStatus.effectiveSource && (
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <Typography level="body-xs" color="neutral">
                                Config source:
                              </Typography>
                              <Chip
                                size="sm"
                                color={providerStatus.effectiveSource === 'database' ? 'success' : 'primary'}
                                variant="outlined"
                              >
                                {providerStatus.effectiveSource === 'database'
                                  ? 'Database IDP'
                                  : providerStatus.effectiveSource === 'sst'
                                    ? 'SST Secrets'
                                    : 'Not configured'}
                              </Chip>
                            </Stack>
                          )}

                          {/* Database config overrides SST info */}
                          {providerStatus.databaseConfigured && providerStatus.sstConfigured && (
                            <Alert color="neutral" variant="outlined" size="sm">
                              <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                                Database IDP config is active and overriding SST secrets.
                              </Typography>
                            </Alert>
                          )}

                          {/* JWT_SECRET missing warning */}
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
                                    ./for-env {'<stage>'} npx sst secret set JWT_SECRET &quot;$(openssl rand -base64
                                    48)&quot;
                                  </code>
                                </Typography>
                              </Stack>
                            </Alert>
                          )}

                          {/* URL format warnings */}
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

                      <Button
                        size="sm"
                        variant="outlined"
                        startDecorator={<NetworkPingIcon />}
                        onClick={() => handleTestOAuth(key)}
                        loading={testingProvider === key}
                        disabled={!isConfigured || testingProvider !== null}
                        data-testid={`system-health-test-oauth-${key}-btn`}
                      >
                        Test {label}
                      </Button>

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
                            {/* Okta-specific: Show config source */}
                            {key === 'okta' && testResult.details?.configSource && (
                              <Typography level="body-xs">
                                Config source:{' '}
                                {testResult.details.configSource === 'database' ? 'Database IDP' : 'SST Secrets'}
                              </Typography>
                            )}
                            {/* Okta-specific: Show detailed diagnostics */}
                            {key === 'okta' && testResult.success && testResult.details?.diagnostics && (
                              <OktaDiagnosticsPanel diagnostics={testResult.details.diagnostics} />
                            )}
                            {/* Okta-specific: Show warning message even on success */}
                            {key === 'okta' && testResult.success && testResult.error && (
                              <Alert color="warning" variant="outlined" size="sm" sx={{ mt: 1 }}>
                                <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                                  {testResult.error}
                                </Typography>
                              </Alert>
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
                            <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                              {new Date(testResult.timestamp).toLocaleString()}
                            </Typography>
                          </Stack>
                        </Alert>
                      )}
                    </Stack>
                  </Card>
                );
              })}
            </Box>

            <Alert color="neutral" variant="outlined" size="sm">
              <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                OAuth tests verify connectivity to provider endpoints. Configure secrets using:{' '}
                <code>./for-env {'<stage>'} npx sst secret set OKTA_AUDIENCE https://your-domain.okta.com</code>
              </Typography>
            </Alert>
          </Stack>
        </Card>

        {/* Integration Health */}
        <Card>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" alignItems="center" spacing={1}>
                <CloudIcon color="primary" />
                <Typography level="title-lg">Slack + (Github & Atlassian) Integration Health</Typography>
              </Stack>
              <Button
                size="sm"
                variant="outlined"
                startDecorator={probingIntegration === 'all' ? undefined : <NetworkPingIcon />}
                onClick={handleProbeAll}
                loading={probingIntegration === 'all'}
                disabled={probingIntegration !== null}
                data-testid="integration-health-probe-all-btn"
              >
                Probe All
              </Button>
            </Stack>

            <Typography level="body-sm" color="neutral">
              Proactive health monitoring for external API integrations. Probes run automatically every 5 minutes.
            </Typography>

            <Divider />

            {integrationHealth.isPending ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size="sm" />
              </Box>
            ) : integrationHealth.isError ? (
              <Alert color="warning" variant="outlined" size="sm">
                <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                  Unable to load integration health data. Health probes may not have run yet.
                </Typography>
              </Alert>
            ) : (
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 2 }}>
                {(integrationHealth.data?.integrations ?? []).map(integration => (
                  <Card key={integration.integration} variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={1.5}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography level="title-sm">{INTEGRATION_LABELS[integration.integration]}</Typography>
                        <Chip
                          size="sm"
                          color={getStatusColor(integration.status)}
                          variant="outlined"
                          startDecorator={getStatusIcon(integration.status)}
                          data-testid={`integration-health-${integration.integration}-status`}
                        >
                          {integration.status.charAt(0).toUpperCase() + integration.status.slice(1)}
                        </Chip>
                      </Stack>

                      {/* Metrics */}
                      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                        <Stack spacing={0.25}>
                          <Typography level="body-xs" color="neutral">
                            Latency
                          </Typography>
                          <Typography level="body-sm" fontWeight="bold">
                            {integration.latencyMs > 0 ? `${integration.latencyMs}ms` : '--'}
                          </Typography>
                        </Stack>
                        <Stack spacing={0.25}>
                          <Typography level="body-xs" color="neutral">
                            Success Rate (24h)
                          </Typography>
                          <Typography level="body-sm" fontWeight="bold">
                            {integration.successRate > 0 ? `${(integration.successRate * 100).toFixed(1)}%` : '--'}
                          </Typography>
                        </Stack>
                      </Box>

                      {/* Success rate bar */}
                      {integration.successRate > 0 && (
                        <LinearProgress
                          determinate
                          value={integration.successRate * 100}
                          color={
                            integration.successRate >= 0.95
                              ? 'success'
                              : integration.successRate >= 0.8
                                ? 'warning'
                                : 'danger'
                          }
                          size="sm"
                          sx={{ borderRadius: 4 }}
                        />
                      )}

                      {/* Failure streak warning */}
                      {integration.consecutiveFailures >= 3 && (
                        <Alert color="danger" variant="outlined" size="sm">
                          <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                            {integration.consecutiveFailures} consecutive failures
                          </Typography>
                        </Alert>
                      )}

                      {/* Error display */}
                      {integration.error && (
                        <Typography level="body-xs" color="danger" sx={{ wordBreak: 'break-word' }}>
                          {integration.error}
                        </Typography>
                      )}

                      {/* Circuit Breaker Status & Controls */}
                      {integration.circuitBreaker && (
                        <Box sx={{ pt: 0.5 }}>
                          <Stack spacing={1}>
                            <Stack direction="row" alignItems="center" spacing={1}>
                              <Typography level="body-xs" color="neutral">
                                Circuit Breaker:
                              </Typography>
                              {integration.circuitBreaker.mode === 'force_block' && (
                                <Chip size="sm" color="danger" variant="solid">
                                  Blocked (manual)
                                </Chip>
                              )}
                              {integration.circuitBreaker.mode === 'force_open' && (
                                <Chip size="sm" color="warning" variant="solid">
                                  Forced Open (manual)
                                </Chip>
                              )}
                              {integration.circuitBreaker.mode === 'auto' && integration.circuitBreaker.autoTripped && (
                                <Chip size="sm" color="danger" variant="outlined">
                                  Tripped (auto)
                                </Chip>
                              )}
                              {integration.circuitBreaker.mode === 'auto' &&
                                !integration.circuitBreaker.autoTripped &&
                                integration.circuitBreaker.noData &&
                                integration.circuitBreaker.allConfigMissing && (
                                  <Chip size="sm" color="neutral" variant="outlined">
                                    N/A (not connected)
                                  </Chip>
                                )}
                              {integration.circuitBreaker.mode === 'auto' &&
                                !integration.circuitBreaker.autoTripped &&
                                integration.circuitBreaker.noData &&
                                !integration.circuitBreaker.allConfigMissing && (
                                  <Chip size="sm" color="neutral" variant="outlined">
                                    OK (no data)
                                  </Chip>
                                )}
                              {integration.circuitBreaker.mode === 'auto' &&
                                !integration.circuitBreaker.autoTripped &&
                                !integration.circuitBreaker.noData && (
                                  <Chip size="sm" color="success" variant="outlined">
                                    OK (auto)
                                  </Chip>
                                )}
                            </Stack>

                            <Stack direction="row" spacing={0.5}>
                              {/* Show "Block" when not already blocked */}
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
                                >
                                  Block
                                </Button>
                              )}
                              {/* Show "Force Open" when auto-tripped or blocked */}
                              {(integration.circuitBreaker.autoTripped ||
                                integration.circuitBreaker.mode === 'force_block') && (
                                <Button
                                  size="sm"
                                  variant="outlined"
                                  color="warning"
                                  startDecorator={<LockOpenIcon />}
                                  onClick={() => handleCircuitBreakerOverride(integration.integration, 'force_open')}
                                  loading={overridingIntegration === integration.integration}
                                  disabled={overridingIntegration !== null}
                                  data-testid={`circuit-breaker-force-open-${integration.integration}-btn`}
                                >
                                  Force Open
                                </Button>
                              )}
                              {/* Show "Reset to Auto" when in manual override */}
                              {integration.circuitBreaker.mode !== 'auto' && (
                                <Button
                                  size="sm"
                                  variant="outlined"
                                  color="neutral"
                                  startDecorator={<RestartAltIcon />}
                                  onClick={() => handleCircuitBreakerOverride(integration.integration, 'auto')}
                                  loading={overridingIntegration === integration.integration}
                                  disabled={overridingIntegration !== null}
                                  data-testid={`circuit-breaker-reset-${integration.integration}-btn`}
                                >
                                  Reset to Auto
                                </Button>
                              )}
                            </Stack>
                          </Stack>
                        </Box>
                      )}

                      {/* Real-time Circuit Breaker (in-memory) - read/write */}
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
                            spacing={1}
                            sx={{ flexWrap: 'wrap' }}
                            data-testid={`realtime-breaker-${integration.integration}`}
                          >
                            <Typography level="body-xs" color="neutral">
                              Real-time:
                            </Typography>
                            {readSnapshot &&
                              (() => {
                                const { color, label } = getRealtimeBreakerChipProps(readSnapshot.state, readSnapshot);
                                return (
                                  <Chip
                                    size="sm"
                                    color={color}
                                    variant="soft"
                                    data-testid={`realtime-breaker-${integration.integration}-read`}
                                  >
                                    Read: {label}
                                  </Chip>
                                );
                              })()}
                            {writeSnapshot &&
                              (() => {
                                const { color, label } = getRealtimeBreakerChipProps(
                                  writeSnapshot.state,
                                  writeSnapshot
                                );
                                return (
                                  <Chip
                                    size="sm"
                                    color={color}
                                    variant="soft"
                                    data-testid={`realtime-breaker-${integration.integration}-write`}
                                  >
                                    Write: {label}
                                  </Chip>
                                );
                              })()}
                          </Stack>
                        );
                      })()}

                      {/* Last checked */}
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography level="body-xs" sx={{ opacity: 0.6 }}>
                          {integration.lastCheckedAt && new Date(integration.lastCheckedAt).getTime() > 0
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
                        >
                          Probe
                        </Button>
                      </Stack>
                    </Stack>
                  </Card>
                ))}
              </Box>
            )}

            {(integrationHealth.data?.integrations ?? []).length === 0 &&
              !integrationHealth.isPending &&
              !integrationHealth.isError && (
                <Alert color="neutral" variant="outlined" size="sm">
                  <Typography level="body-xs" sx={{ color: 'text.primary' }}>
                    No integration health data available yet. Health probes will populate this section automatically.
                  </Typography>
                </Alert>
              )}
          </Stack>
        </Card>

        {/* Help Section */}
        <Card variant="soft" color="neutral">
          <Typography level="title-md">Need Help?</Typography>
          <Typography level="body-sm" sx={{ mt: 1 }}>
            If you&apos;re running a fork of this application and experiencing configuration issues:
          </Typography>
          <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
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
          </ul>
        </Card>
      </Stack>
    </Sheet>
  );
};

export default AdminSystemHealthTab;
