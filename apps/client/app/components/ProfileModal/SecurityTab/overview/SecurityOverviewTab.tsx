import React from 'react';
import { Box, Chip, Sheet, Stack, Typography, useTheme, CircularProgress, Button } from '@mui/joy';
import {
  Lock,
  Key,
  Mail,
  Warning,
  CheckCircle,
  PersonSearch as PersonSearchIcon,
  MemoryOutlined as MemoryOutlinedIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { APP_NAME } from '@client/config/general';
import {
  useGetFailedLoginCount,
  useGetSuspiciousSummary,
  useGetBlockedIPs,
  useGetApiUsage,
  useGetRecentSecurityEvents,
  useGetSecurityBehavioralSummary,
} from '@client/app/hooks/data/admin';
import SecurityStatusCard from './SecurityStatusCard';
import SecurityMetricCard from './SecurityMetricCard';

interface SecurityOverviewTabProps {
  onTabSelect: (tab: string) => void;
  onRefresh: () => Promise<void>;
}

const SecurityOverviewTab: React.FC<SecurityOverviewTabProps> = ({ onTabSelect, onRefresh }) => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  const failedLogins = useGetFailedLoginCount();
  const suspiciousSummary = useGetSuspiciousSummary();
  const blockedIPs = useGetBlockedIPs();
  const apiUsage = useGetApiUsage();
  const recentEvents = useGetRecentSecurityEvents();
  const behavioralSummary = useGetSecurityBehavioralSummary();

  // Derived values
  const suspiciousCount = suspiciousSummary.data?.total ?? 0;
  const failedCount = failedLogins.data?.total ?? 0;
  const apiKeys = apiUsage.data ?? [];
  const apiKeysWithAlerts = apiKeys.filter(k => k.alerts && k.alerts.length > 0);
  const hasApiKeyIssues = apiKeysWithAlerts.length > 0;
  const hasSuspiciousLogins = suspiciousCount > 0;
  const hasFailedLogins = failedCount > 0;

  // Security Checks pass/fail (4 checks; phishing always passes - no real data)
  const passedChecks = [!hasSuspiciousLogins, !hasFailedLogins, !hasApiKeyIssues, true].filter(Boolean).length;
  const totalChecks = 4;

  // Last detection: most recent event timestamp
  const events = recentEvents.data?.items ?? [];
  const lastDetection = events.length > 0 ? new Date(events[0].timestamp) : null;

  // Behavioral summary
  const securityScore = Math.max(0, Math.min(100, Math.round(behavioralSummary.data?.securityScore ?? 50)));
  const riskLevel = behavioralSummary.data?.riskLevel ?? 'low';
  const isOverviewLoading =
    failedLogins.isLoading || suspiciousSummary.isLoading || apiUsage.isLoading || behavioralSummary.isLoading;

  return (
    <Box data-testid="security-overview-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Row 1: Status Card + AI Assessment */}
      <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems="stretch">
        <Box sx={{ flex: { xs: '1 1 auto', lg: '0 0 260px' } }}>
          <SecurityStatusCard
            securityScore={securityScore}
            riskLevel={riskLevel}
            passedChecks={passedChecks}
            totalChecks={totalChecks}
            lastDetection={lastDetection}
            isLoading={isOverviewLoading}
          />
        </Box>

        {/* AI Assessment card - matches admin theme-based primary gradient */}
        <Sheet
          variant="soft"
          data-testid="security-summary-ai-card"
          sx={{
            flex: 1,
            borderRadius: 'lg',
            p: 3,
            background:
              mode === 'light'
                ? `linear-gradient(135deg, ${theme.palette.primary.softBg} 0%, ${theme.palette.primary.softHoverBg} 50%, ${theme.palette.primary.softBg} 100%)`
                : `linear-gradient(135deg, ${theme.palette.primary[600]} 0%, ${theme.palette.primary[500]} 50%, ${theme.palette.primary[400]} 100%)`,
            color: mode === 'light' ? theme.palette.text.primary : theme.palette.neutral[50],
            boxShadow: mode === 'light' ? theme.shadow.sm : `0 8px 24px ${theme.palette.primary[600]}33`,
            border: mode === 'light' ? `1px solid ${theme.palette.primary.outlinedBorder}` : 'none',
          }}
        >
          {/* AI card header. Summary renders full-width below this row, not beside the badge:
              a paragraph wedged next to the non-shrinking badge collapses to ~1 word per line at
              narrow widths. Header stacks to a column below `sm` so the title and badge don't
              crush together on one narrow row. */}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            justifyContent="space-between"
            gap={1}
            mb={1}
          >
            <Stack
              direction="row"
              alignItems="center"
              gap={1}
              sx={{ minWidth: 0, width: { xs: '100%', sm: 'auto' }, flex: { sm: 1 } }}
            >
              <Sheet
                variant="soft"
                sx={{
                  borderRadius: 'lg',
                  width: 32,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  bgcolor: mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[500]}26`,
                  color: mode === 'light' ? theme.palette.primary.solidBg : theme.palette.primary[300],
                }}
              >
                <MemoryOutlinedIcon fontSize="small" />
              </Sheet>
              <Typography level="title-md" sx={{ fontWeight: 700, minWidth: 0 }}>
                AI Security Assessment
              </Typography>
            </Stack>
            <Chip
              size="sm"
              variant="soft"
              color="neutral"
              startDecorator={
                <Box
                  sx={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[400]}1A`,
                    border:
                      mode === 'light'
                        ? `1px solid ${theme.palette.primary.outlinedBorder}`
                        : `1px solid ${theme.palette.primary[400]}26`,
                  }}
                >
                  <Bike4MindIcon
                    fill={mode === 'light' ? theme.palette.primary.solidBg : theme.palette.primary[300]}
                    size="14"
                  />
                </Box>
              }
              data-testid="ai-assessment-powered-by-b4m-chip"
              sx={{
                flexShrink: 0,
                ml: { xs: 0, sm: 1 },
                fontWeight: 600,
                bgcolor: mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[700]}40`,
                color: mode === 'light' ? theme.palette.text.primary : theme.palette.primary[200],
                border: mode === 'light' ? 'none' : `1px solid ${theme.palette.primary[600]}33`,
              }}
            >
              {APP_NAME ? `Powered by ${APP_NAME}` : 'Powered by AI'}
            </Chip>
          </Stack>

          {/* Full-width AI summary spans the whole card so it reads as a paragraph instead of a
              1-word-per-line column wedged beside the badge at narrow (~430px) widths. */}
          <Typography
            level="body-xs"
            sx={{
              mb: 1.5,
              opacity: mode === 'light' ? 0.75 : 0.9,
              color: mode === 'light' ? theme.palette.text.secondary : 'inherit',
            }}
          >
            {behavioralSummary.isLoading || behavioralSummary.isFetching
              ? 'Analyzing your security posture…'
              : (behavioralSummary.data?.summary ?? 'No summary available.')}
          </Typography>

          {/* Risk score bar */}
          {behavioralSummary.data && (
            <Box data-testid="ai-assessment-risk-score-bar" sx={{ mb: 1.5 }}>
              <Stack direction="row" justifyContent="space-between" mb={0.5}>
                <Typography level="body-xs" sx={{ opacity: mode === 'light' ? 0.75 : 0.9 }}>
                  Security Score
                </Typography>
                <Typography level="body-xs" sx={{ opacity: mode === 'light' ? 0.75 : 0.9 }}>
                  {securityScore}/100
                </Typography>
              </Stack>
              <Box
                sx={{
                  height: 6,
                  borderRadius: 'sm',
                  bgcolor: mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[800]}40`,
                  overflow: 'hidden',
                }}
              >
                <Box
                  sx={{
                    height: '100%',
                    width: `${securityScore}%`,
                    background:
                      riskLevel === 'high'
                        ? theme.palette.security.critical.solidBg
                        : riskLevel === 'medium'
                          ? theme.palette.security.high.solidBg
                          : theme.palette.security.good.solidBg,
                    transition: 'width 0.5s ease',
                  }}
                />
              </Box>
            </Box>
          )}

          {/* Recommendation cards - profile returns string[], admin returns structured objects */}
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1}>
            {(behavioralSummary.data?.recommendations ?? [null, null, null]).map((rec, idx) => (
              <Sheet
                key={idx}
                variant="soft"
                data-testid={`ai-assessment-recommendation-${idx}-card`}
                sx={{
                  flex: 1,
                  borderRadius: 'md',
                  p: 1.5,
                  minHeight: '80px',
                  bgcolor: mode === 'light' ? theme.palette.primary.plainHoverBg : `${theme.palette.primary[800]}33`,
                  border:
                    mode === 'light'
                      ? `1px solid ${theme.palette.primary.outlinedBorder}`
                      : `1px solid ${theme.palette.primary[700]}26`,
                }}
              >
                {rec !== null && (
                  <Typography
                    level="body-xs"
                    sx={{
                      opacity: mode === 'light' ? 0.75 : 0.9,
                      color: mode === 'light' ? theme.palette.text.secondary : 'inherit',
                    }}
                  >
                    {rec}
                  </Typography>
                )}
              </Sheet>
            ))}
          </Stack>
        </Sheet>
      </Stack>

      {/* Row 2: 4 metric cards */}
      <Box
        data-testid="security-summary-metrics-grid"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
          gap: 2,
        }}
      >
        <SecurityMetricCard
          icon={<PersonSearchIcon />}
          label="Suspicious Logins"
          value={suspiciousCount}
          status={hasSuspiciousLogins ? 'high' : 'good'}
          description="Last 24 hours"
          isLoading={suspiciousSummary.isLoading}
          onTabSelect={() => onTabSelect('suspicious-logins')}
          data-testid="suspicious-logins-card"
        />
        <SecurityMetricCard
          icon={<Lock />}
          label="Failed Login Attempts"
          value={failedCount}
          status={hasFailedLogins ? 'high' : 'good'}
          description="Last 24 hours"
          isLoading={failedLogins.isLoading}
          onTabSelect={() => onTabSelect('failed-logins')}
          data-testid="failed-logins-card"
        />
        <SecurityMetricCard
          icon={<Key />}
          label="API Key Status"
          value={
            apiKeysWithAlerts.length > 0
              ? `${apiKeysWithAlerts.length} Alert${apiKeysWithAlerts.length > 1 ? 's' : ''}`
              : 'All Clear'
          }
          status={hasApiKeyIssues ? 'high' : 'good'}
          description={`${apiKeys.length} key${apiKeys.length !== 1 ? 's' : ''} total`}
          isLoading={apiUsage.isLoading}
          onTabSelect={() => onTabSelect('api-keys')}
          data-testid="api-key-status-card"
        />
        <SecurityMetricCard
          icon={<Mail />}
          label="Last Phishing Test"
          value="N/A"
          status="good"
          description="No data available"
          onTabSelect={() => onTabSelect('phishing')}
          data-testid="last-phishing-test-card"
        />
      </Box>

      {/* Row 3: Recent Activity + Blocked IPs */}
      <Stack direction={{ xs: 'column', lg: 'row' }} gap={2}>
        {/* Recent Activity */}
        <Sheet
          variant="outlined"
          data-testid="security-summary-recent-activity-card"
          sx={{ flex: 1, borderRadius: 'lg', p: 2 }}
        >
          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.5}>
            <Typography level="title-sm">Recent Activity</Typography>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              startDecorator={<RefreshIcon fontSize="small" />}
              onClick={onRefresh}
              loading={recentEvents.isFetching}
              data-testid="security-overview-activity-refresh-btn"
            >
              Refresh
            </Button>
          </Stack>
          {recentEvents.isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size="sm" />
            </Box>
          ) : events.length === 0 ? (
            <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary, textAlign: 'center', py: 3 }}>
              No recent security events
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {events.slice(0, 5).map((event, idx) => (
                <Sheet
                  key={idx}
                  variant="soft"
                  data-testid={`overview-activity-${event.type}-${idx}`}
                  sx={{
                    borderRadius: 'sm',
                    p: 1.5,
                    borderLeft: `3px solid ${event.type === 'suspicious_pattern' ? theme.palette.security.high.outlinedBorder : theme.palette.security.critical.outlinedBorder}`,
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                    <Stack direction="row" gap={0.75} alignItems="center">
                      {event.type === 'suspicious_pattern' ? (
                        <Warning fontSize="small" sx={{ color: theme.palette.security.high.plainColor }} />
                      ) : (
                        <Lock fontSize="small" sx={{ color: theme.palette.security.critical.plainColor }} />
                      )}
                      <Typography level="body-xs">
                        {event.type === 'suspicious_pattern'
                          ? `Suspicious: ${(event.data as { ip?: string }).ip ?? 'Unknown IP'}`
                          : `Failed login: ${(event.data as { username?: string }).username ?? 'Unknown user'}`}
                      </Typography>
                    </Stack>
                    <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary, whiteSpace: 'nowrap' }}>
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </Typography>
                  </Stack>
                </Sheet>
              ))}
            </Box>
          )}
        </Sheet>

        {/* Blocked IPs */}
        <Sheet
          variant="outlined"
          data-testid="security-summary-blocked-ips-card"
          sx={{ flex: 1, borderRadius: 'lg', p: 2 }}
        >
          <Typography level="title-sm" mb={1.5}>
            Blocked IP Addresses
          </Typography>
          {blockedIPs.isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size="sm" />
            </Box>
          ) : !blockedIPs.data || blockedIPs.data.length === 0 ? (
            <Stack direction="row" gap={1} alignItems="center" justifyContent="center" sx={{ py: 3 }}>
              <CheckCircle sx={{ color: theme.palette.security.good.plainColor }} />
              <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
                No IPs are currently blocked
              </Typography>
            </Stack>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {blockedIPs.data.slice(0, 5).map((item, idx) => (
                <Sheet
                  key={idx}
                  variant="outlined"
                  data-testid={`overview-blocked-ip-${idx}`}
                  sx={{
                    borderRadius: 'sm',
                    p: 1.5,
                    borderLeft: `3px solid ${theme.palette.security.high.outlinedBorder}`,
                  }}
                >
                  <Typography level="body-xs" fontWeight="md">
                    {item.ip}
                  </Typography>
                  {item.reason && (
                    <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
                      {item.reason}
                    </Typography>
                  )}
                </Sheet>
              ))}
            </Box>
          )}
        </Sheet>
      </Stack>
    </Box>
  );
};

export default SecurityOverviewTab;
