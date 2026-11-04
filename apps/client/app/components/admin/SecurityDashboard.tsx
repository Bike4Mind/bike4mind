import { Box, Button, Chip, Sheet, Stack, Switch, Typography, useTheme } from '@mui/joy';
import { useState } from 'react';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useSecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';
import {
  SecurityCheckStatus,
  SecurityDashboardCloudSnapshot,
  useSecurityDashboardWeb,
  useRunWebSecurityScan,
  useSecurityDashboardCloud,
  useSecurityDashboardProwler,
  useRunProwlerScan,
  useRunCloudSecurityScan,
  useSecurityScanSchedule,
  useUpdateSecurityScanSchedule,
} from '@client/app/hooks/data/admin';
import { WafTrafficOverview } from './SecurityDashboard/WafTrafficOverview';
import ActiveDefenseTab from './SecurityDashboard/ActiveDefenseTab';
import { IncidentView } from './SecurityDashboard/IncidentView';
import { ScanSummaryTable } from './SecurityDashboard/ScanSummaryTable';
import { useSecurityDashboardSearch } from './SecurityDashboard/useSecurityDashboardSearch';
import { SECURITY_VIEWS, type SecurityScan, type SecurityView } from './securityDashboardSearch';
import {
  AdminPageHeader,
  ErrorState,
  LoadingState,
  SegmentedControl,
  UpdatingBar,
  ViewTabs,
  type SegmentedOption,
  type ViewTab,
} from './shared';
import { SecurityFindingsTable } from './SecurityDashboard/SecurityFindingsTable';

const statusColorMap: Record<SecurityCheckStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  pass: 'success',
  warning: 'warning',
  fail: 'danger',
  disabled: 'neutral',
};

const statusLabelMap: Record<SecurityCheckStatus, string> = {
  pass: 'Passed',
  warning: 'Review recommended',
  fail: 'Issues detected',
  disabled: 'Disabled',
};

type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

const severityColorMap: Record<SeverityLevel, 'danger' | 'warning' | 'success'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'warning',
  low: 'success',
};

const SCHEDULE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
};

const countBySeverity = (findings: Array<{ severity: SeverityLevel }>) => {
  return {
    critical: findings.filter(f => f.severity === 'critical').length,
    high: findings.filter(f => f.severity === 'high').length,
    medium: findings.filter(f => f.severity === 'medium').length,
    low: findings.filter(f => f.severity === 'low').length,
  };
};

const SecurityWebTab = () => {
  const { data: snapshot, isLoading, isFetching, isError, refetch } = useSecurityDashboardWeb();
  const runWebScan = useRunWebSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('web');
  const updateSchedule = useUpdateSecurityScanSchedule('web');

  if (isLoading && !snapshot) {
    return <LoadingState label="Loading website scan" testId="security-scans-web-loading" />;
  }

  if (!snapshot && isError) {
    return <ErrorState message="Could not load the website security scan." onRetry={() => void refetch()} />;
  }

  if (!snapshot) {
    return (
      <Stack spacing={3} data-testid="security-dashboard-web-tab">
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography level="title-lg">Website Security Scan</Typography>
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No website security scan has been recorded yet for this stage.
            </Typography>
          </Box>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => runWebScan.mutate()}
            loading={runWebScan.isPending}
            data-testid="web-security-run-scan-btn"
          >
            Run Website Scan
          </Button>
        </Stack>
        <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md', bgcolor: 'background.surface' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
            <Box sx={{ flex: 1 }}>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Weekly Automated Scan
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                Automatically run this scan every Sunday at 2:00 AM UTC
              </Typography>
              {schedule?.enabled && schedule?.nextRunAt && (
                <Typography level="body-xs" sx={{ color: 'success.600', mt: 1 }}>
                  ✓ Next scheduled run: {new Date(schedule.nextRunAt).toLocaleString('en-US', SCHEDULE_DATE_FORMAT)}
                </Typography>
              )}
            </Box>
            <Switch
              checked={schedule?.enabled ?? false}
              onChange={e => {
                if (!updateSchedule.isPending) {
                  updateSchedule.mutate({ enabled: e.target.checked });
                }
              }}
              disabled={updateSchedule.isPending}
              aria-label="Weekly Automated Scan"
              data-testid="web-security-schedule-toggle"
            />
          </Stack>
        </Sheet>
      </Stack>
    );
  }

  const findings = snapshot.findings ?? [];
  const {
    critical: criticalCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount,
  } = countBySeverity(findings as Array<{ severity: SeverityLevel }>);
  const totalFindings = findings.length;
  const maxSeverityCount = Math.max(criticalCount, highCount, mediumCount, lowCount, 1);

  const handleRunScan = () => {
    if (cooldownActive || runWebScan.isPending) return;
    runWebScan.mutate();
  };

  return (
    <Stack spacing={3} data-testid="security-dashboard-web-tab">
      <UpdatingBar active={isFetching} testId="security-scans-web-updating" />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="title-lg">Website Security Scan</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
            Automated OWASP ZAP scan of your live website for critical vulnerabilities.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={handleRunScan}
            loading={runWebScan.isPending}
            disabled={cooldownActive || runWebScan.isPending}
            data-testid="web-security-run-scan-btn"
          >
            Run Website Scan
          </Button>
          <Chip
            variant="soft"
            color={statusColorMap[snapshot.status]}
            size="sm"
            sx={{ textTransform: 'none', fontWeight: 500 }}
          >
            {statusLabelMap[snapshot.status]}
          </Chip>
        </Stack>
      </Stack>

      {/* Weekly Scan Schedule */}
      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'md',
          bgcolor: 'background.surface',
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Weekly Automated Scan
            </Typography>
            <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
              Automatically run this scan every Sunday at 2:00 AM UTC
            </Typography>
            {schedule?.enabled && schedule?.nextRunAt && (
              <Typography level="body-xs" sx={{ color: 'success.600', mt: 1 }}>
                ✓ Next scheduled run: {new Date(schedule.nextRunAt).toLocaleString('en-US', SCHEDULE_DATE_FORMAT)}
              </Typography>
            )}
          </Box>
          <Switch
            checked={schedule?.enabled ?? false}
            onChange={e => {
              if (!updateSchedule.isPending) {
                updateSchedule.mutate({ enabled: e.target.checked });
              }
            }}
            disabled={updateSchedule.isPending}
            aria-label="Weekly Automated Scan"
            data-testid="web-security-schedule-toggle"
          />
        </Stack>
      </Sheet>

      <Sheet
        variant="soft"
        sx={{
          p: 2,
          borderRadius: 'md',
          minWidth: 0,
        }}
      >
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 0.5 }}>
          Vulnerabilities Found
        </Typography>
        <Typography
          level="h3"
          sx={{
            fontWeight: 700,
            color:
              totalFindings === 0 ? 'success.600' : criticalCount > 0 || highCount > 0 ? 'danger.600' : 'warning.600',
          }}
          data-testid="web-security-total-findings"
        >
          {totalFindings} findings
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.75 }}>
          {`${criticalCount} Critical, ${highCount} High, ${mediumCount} Medium, ${lowCount} Low`}
        </Typography>

        <Box
          sx={{
            mt: 2.5,
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, minmax(0, 1fr))',
              md: 'repeat(4, minmax(0, 1fr))',
            },
            gap: 1.5,
          }}
        >
          <Sheet
            variant="outlined"
            sx={{
              borderRadius: 'md',
              p: 1.5,
              textAlign: 'center',
              minHeight: 140,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
              {criticalCount}
            </Typography>
            <Box
              sx={{
                mt: 0.5,
                flex: 1,
                display: 'flex',
                alignItems: 'flex-end',
                width: '100%',
              }}
            >
              <Box
                sx={{
                  width: '100%',
                  height: 72,
                  borderRadius: 'sm',
                  bgcolor: 'neutral.softBg',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                }}
              >
                <Box
                  sx={{
                    width: '100%',
                    height: `${criticalCount === 0 ? 0 : (criticalCount / maxSeverityCount) * 100}%`,
                    borderRadius: 'sm',
                    bgcolor: 'danger.500',
                    transition: 'height 0.3s ease',
                  }}
                />
              </Box>
            </Box>
            <Typography level="body-xs" sx={{ mt: 0.75 }}>
              Critical
            </Typography>
          </Sheet>

          <Sheet
            variant="outlined"
            sx={{
              borderRadius: 'md',
              p: 1.5,
              textAlign: 'center',
              minHeight: 140,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
              {highCount}
            </Typography>
            <Box
              sx={{
                mt: 0.5,
                flex: 1,
                display: 'flex',
                alignItems: 'flex-end',
                width: '100%',
              }}
            >
              <Box
                sx={{
                  width: '100%',
                  height: 72,
                  borderRadius: 'sm',
                  bgcolor: 'neutral.softBg',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                }}
              >
                <Box
                  sx={{
                    width: '100%',
                    height: `${highCount === 0 ? 0 : (highCount / maxSeverityCount) * 100}%`,
                    borderRadius: 'sm',
                    bgcolor: 'warning.600',
                    transition: 'height 0.3s ease',
                  }}
                />
              </Box>
            </Box>
            <Typography level="body-xs" sx={{ mt: 0.75 }}>
              High
            </Typography>
          </Sheet>

          <Sheet
            variant="outlined"
            sx={{
              borderRadius: 'md',
              p: 1.5,
              textAlign: 'center',
              minHeight: 140,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
              {mediumCount}
            </Typography>
            <Box
              sx={{
                mt: 0.5,
                flex: 1,
                display: 'flex',
                alignItems: 'flex-end',
                width: '100%',
              }}
            >
              <Box
                sx={{
                  width: '100%',
                  height: 72,
                  borderRadius: 'sm',
                  bgcolor: 'neutral.softBg',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                }}
              >
                <Box
                  sx={{
                    width: '100%',
                    height: `${mediumCount === 0 ? 0 : (mediumCount / maxSeverityCount) * 100}%`,
                    borderRadius: 'sm',
                    bgcolor: 'warning.400',
                    transition: 'height 0.3s ease',
                  }}
                />
              </Box>
            </Box>
            <Typography level="body-xs" sx={{ mt: 0.75 }}>
              Medium
            </Typography>
          </Sheet>

          <Sheet
            variant="outlined"
            sx={{
              borderRadius: 'md',
              p: 1.5,
              textAlign: 'center',
              minHeight: 140,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
              {lowCount}
            </Typography>
            <Box
              sx={{
                mt: 0.5,
                flex: 1,
                display: 'flex',
                alignItems: 'flex-end',
                width: '100%',
              }}
            >
              <Box
                sx={{
                  width: '100%',
                  height: 72,
                  borderRadius: 'sm',
                  bgcolor: 'neutral.softBg',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                }}
              >
                <Box
                  sx={{
                    width: '100%',
                    height: `${lowCount === 0 ? 0 : (lowCount / maxSeverityCount) * 100}%`,
                    borderRadius: 'sm',
                    bgcolor: 'success.500',
                    transition: 'height 0.3s ease',
                  }}
                />
              </Box>
            </Box>
            <Typography level="body-xs" sx={{ mt: 0.75 }}>
              Low
            </Typography>
          </Sheet>
        </Box>
      </Sheet>

      <SecurityFindingsTable rows={findings} testId="web-security" onRetry={() => void refetch()} />

      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
        Last scan:{' '}
        {new Date(snapshot.checkedAt).toLocaleString('en-US', {
          timeZone: 'UTC',
        })}{' '}
        UTC
        {cooldownActive
          ? ` • You can run another scan in ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'}.`
          : ''}
      </Typography>
    </Stack>
  );
};

const CloudFindingCard = ({
  finding,
  testIdPrefix,
}: {
  finding: {
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
    documentationUrl?: string;
    metadata?: { region?: string; resourceArn?: string };
  };
  testIdPrefix: string;
}) => {
  const theme = useTheme();
  const borderColor =
    finding.severity === 'critical'
      ? theme.palette.danger[500]
      : finding.severity === 'high'
        ? theme.palette.warning[700]
        : finding.severity === 'medium'
          ? theme.palette.warning[500]
          : theme.palette.success[600];

  return (
    <Sheet
      variant="soft"
      sx={{
        p: 1.5,
        borderRadius: 'sm',
        borderLeft: '3px solid',
        borderLeftColor: borderColor,
        backgroundColor: theme.palette.background.level1,
      }}
      data-testid={`${testIdPrefix}-finding-${finding.id}`}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Typography level="body-sm" sx={{ fontWeight: 600, mr: 1 }}>
          {finding.title}
        </Typography>
        <Chip
          size="sm"
          variant="soft"
          color={severityColorMap[finding.severity]}
          sx={{ textTransform: 'none', fontWeight: 500, flexShrink: 0 }}
        >
          {finding.severity[0].toUpperCase() + finding.severity.slice(1)}
        </Chip>
      </Stack>
      <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
        {finding.description}
      </Typography>
      {finding.recommendation && (
        <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
          {finding.recommendation}
        </Typography>
      )}
      {(finding.metadata?.region || finding.metadata?.resourceArn) && (
        <Stack direction="row" spacing={1} sx={{ mt: 0.75, flexWrap: 'wrap' }}>
          {finding.metadata.region && (
            <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '0.65rem' }}>
              {finding.metadata.region}
            </Chip>
          )}
          {finding.metadata.resourceArn && (
            <Chip
              size="sm"
              variant="outlined"
              color="neutral"
              sx={{ fontSize: '0.65rem', fontFamily: 'monospace', maxWidth: 320 }}
              title={finding.metadata.resourceArn}
            >
              {finding.metadata.resourceArn.length > 48
                ? `\u2026${finding.metadata.resourceArn.slice(-44)}`
                : finding.metadata.resourceArn}
            </Chip>
          )}
        </Stack>
      )}
      {finding.documentationUrl?.startsWith('https://') && (
        <Typography level="body-xs" sx={{ color: 'primary.600', mt: 0.5 }}>
          <a href={finding.documentationUrl} target="_blank" rel="noreferrer">
            View guidance
          </a>
        </Typography>
      )}
    </Sheet>
  );
};

const InfrastructureBaselineSubTab = ({ initialSnapshot }: { initialSnapshot?: SecurityDashboardCloudSnapshot }) => {
  const { data: liveSnapshot, isLoading, isFetching, refetch } = useSecurityDashboardCloud();
  const snapshot = liveSnapshot ?? initialSnapshot;
  const runCloudScan = useRunCloudSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('cloud');
  const updateSchedule = useUpdateSecurityScanSchedule('cloud');

  if (isLoading && !snapshot) {
    return <LoadingState label="Loading cloud baseline" testId="security-scans-cloud-loading" />;
  }

  if (!snapshot) {
    return (
      <Stack spacing={3} data-testid="security-dashboard-cloud-tab">
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography level="title-lg">Cloud Security</Typography>
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No cloud security scan has been recorded yet for this stage.
            </Typography>
          </Box>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => runCloudScan.mutate()}
            loading={runCloudScan.isPending}
            data-testid="cloud-security-run-scan-btn"
          >
            Run Cloud Scan
          </Button>
        </Stack>
        <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md', bgcolor: 'background.surface' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
            <Box sx={{ flex: 1 }}>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Weekly Automated Scan
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                Automatically run this scan every Sunday at 2:00 AM UTC
              </Typography>
              {schedule?.enabled && schedule?.nextRunAt && (
                <Typography level="body-xs" sx={{ color: 'success.600', mt: 1 }}>
                  ✓ Next scheduled run: {new Date(schedule.nextRunAt).toLocaleString('en-US', SCHEDULE_DATE_FORMAT)}
                </Typography>
              )}
            </Box>
            <Switch
              checked={schedule?.enabled ?? false}
              onChange={e => {
                if (!updateSchedule.isPending) {
                  updateSchedule.mutate({ enabled: e.target.checked });
                }
              }}
              disabled={updateSchedule.isPending}
              aria-label="Weekly Automated Scan"
              data-testid="cloud-security-schedule-toggle"
            />
          </Stack>
        </Sheet>
      </Stack>
    );
  }

  const findings = snapshot.findings ?? [];
  const {
    critical: criticalCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount,
  } = countBySeverity(findings as Array<{ severity: SeverityLevel }>);
  const hasAnyFindings = findings.length > 0;

  return (
    <Stack spacing={3}>
      <UpdatingBar active={isFetching} testId="security-scans-cloud-updating" />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
          7 baseline checks across IAM, S3, CloudTrail, EC2, and Secrets Manager.
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => {
              if (!cooldownActive && !runCloudScan.isPending) runCloudScan.mutate();
            }}
            loading={runCloudScan.isPending}
            disabled={cooldownActive || runCloudScan.isPending}
            data-testid="cloud-security-run-scan-btn"
          >
            Run Cloud Scan
          </Button>
          <Chip
            variant="soft"
            color={statusColorMap[snapshot.status]}
            size="sm"
            sx={{ textTransform: 'none', fontWeight: 500 }}
          >
            {statusLabelMap[snapshot.status]}
          </Chip>
        </Stack>
      </Stack>

      <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md', bgcolor: 'background.surface' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Weekly Automated Scan
            </Typography>
            <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
              Automatically run this scan every Sunday at 2:00 AM UTC
            </Typography>
            {schedule?.enabled && schedule?.nextRunAt && (
              <Typography level="body-xs" sx={{ color: 'success.600', mt: 1 }}>
                ✓ Next scheduled run: {new Date(schedule.nextRunAt).toLocaleString('en-US', SCHEDULE_DATE_FORMAT)}
              </Typography>
            )}
          </Box>
          <Switch
            checked={schedule?.enabled ?? false}
            onChange={e => {
              if (!updateSchedule.isPending) updateSchedule.mutate({ enabled: e.target.checked });
            }}
            disabled={updateSchedule.isPending}
            aria-label="Weekly Automated Scan"
            data-testid="cloud-security-schedule-toggle"
          />
        </Stack>
      </Sheet>

      <Sheet variant="soft" sx={{ p: 2, borderRadius: 'md', minWidth: 0 }}>
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 0.5 }}>
          Posture Score
        </Typography>
        <Typography
          level="h3"
          sx={{ fontWeight: 700, color: hasAnyFindings ? 'danger.600' : 'success.600' }}
          data-testid="cloud-security-issues-metric"
        >
          {hasAnyFindings ? `${snapshot.score} / 100` : 'No misconfigurations detected'}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.75 }}>
          <Typography component="span" level="body-xs" sx={{ color: 'danger.600', mr: 0.75 }}>
            {criticalCount} Critical
          </Typography>
          <Typography component="span" level="body-xs" sx={{ color: 'warning.700', mr: 0.75 }}>
            {highCount} High
          </Typography>
          <Typography component="span" level="body-xs" sx={{ color: 'warning.600', mr: 0.75 }}>
            {mediumCount} Medium
          </Typography>
          <Typography component="span" level="body-xs" sx={{ color: 'success.600' }}>
            {lowCount} Low
          </Typography>
        </Typography>
      </Sheet>

      <SecurityFindingsTable
        rows={findings}
        testId="cloud-security"
        onRetry={() => void refetch()}
        renderDetail={finding => <CloudFindingCard finding={finding} testIdPrefix="cloud-security" />}
      />

      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
        Last scan: {new Date(snapshot.checkedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
        {cooldownActive ? ` • Next scan available in ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'}.` : ''}
      </Typography>
    </Stack>
  );
};

const ProwlerAuditSubTab = () => {
  const { data: snapshot, isLoading, isFetching, isError, refetch } = useSecurityDashboardProwler();
  const runProwler = useRunProwlerScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const [showAll, setShowAll] = useState(false);
  const [queued, setQueued] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const handleRunProwler = () => {
    if (cooldownActive || runProwler.isPending) return;
    setDispatchError(null);
    runProwler.mutate(undefined, {
      onSuccess: () => setQueued(true),
      onError: () =>
        setDispatchError('Failed to queue Prowler scan. Check that SECOPS_PROWLER_WORKFLOW_TOKEN is configured.'),
    });
  };

  if (isLoading) {
    return <LoadingState label="Loading Prowler audit" testId="security-scans-prowler-loading" />;
  }

  if (!snapshot && isError) {
    return <ErrorState message="Could not load the Prowler audit." onRetry={() => void refetch()} />;
  }

  if (!snapshot) {
    return (
      <Stack spacing={2}>
        <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
          No Prowler audit data found for this stage.
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
          Prowler runs when a scan is started from this page.
        </Typography>
        {queued ? (
          <Typography level="body-xs" sx={{ color: 'success.600' }}>
            ✓ Prowler scan queued — results will appear here in approximately 10 minutes.
          </Typography>
        ) : (
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={handleRunProwler}
            loading={runProwler.isPending}
            disabled={cooldownActive}
            data-testid="prowler-run-scan-btn"
            sx={{ alignSelf: 'flex-start' }}
          >
            {cooldownActive ? `Cooldown active (${hoursRemaining}h remaining)` : 'Run Prowler Scan'}
          </Button>
        )}
        {dispatchError && (
          <Typography level="body-xs" sx={{ color: 'danger.600' }}>
            {dispatchError}
          </Typography>
        )}
      </Stack>
    );
  }

  const allFindings = snapshot.findings ?? [];
  const criticalHighFindings = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high');
  const visibleFindings = showAll ? allFindings : criticalHighFindings;

  const {
    critical: criticalCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount,
  } = countBySeverity(allFindings as Array<{ severity: SeverityLevel }>);
  const hiddenCount = allFindings.length - criticalHighFindings.length;

  return (
    <Stack spacing={3}>
      <UpdatingBar active={isFetching} testId="security-scans-prowler-updating" />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
          Deep AWS audit via Prowler — 300+ checks across IAM, S3, EC2, GuardDuty, and more.
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {queued ? (
            <Typography level="body-xs" sx={{ color: 'success.600' }}>
              ✓ Scan queued (~10 min)
            </Typography>
          ) : (
            <Button
              variant="soft"
              color="primary"
              size="sm"
              onClick={handleRunProwler}
              loading={runProwler.isPending}
              disabled={cooldownActive}
              data-testid="prowler-run-scan-btn"
            >
              {cooldownActive ? `Cooldown active (${hoursRemaining}h remaining)` : 'Run Prowler Scan'}
            </Button>
          )}
          <Chip
            variant="soft"
            color={statusColorMap[snapshot.status]}
            size="sm"
            sx={{ textTransform: 'none', fontWeight: 500 }}
          >
            {statusLabelMap[snapshot.status]}
          </Chip>
        </Stack>
      </Stack>
      {dispatchError && (
        <Typography level="body-xs" sx={{ color: 'danger.600' }}>
          {dispatchError}
        </Typography>
      )}

      <Sheet variant="soft" sx={{ p: 2, borderRadius: 'md', minWidth: 0 }}>
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 0.5 }}>
          Prowler Score
        </Typography>
        <Typography level="h3" sx={{ fontWeight: 700, color: allFindings.length > 0 ? 'danger.600' : 'success.600' }}>
          {allFindings.length > 0 ? `${snapshot.score} / 100` : 'No findings detected'}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.75 }}>
          <Typography component="span" level="body-xs" sx={{ color: 'danger.600', mr: 0.75 }}>
            {criticalCount} Critical
          </Typography>
          <Typography component="span" level="body-xs" sx={{ color: 'warning.700', mr: 0.75 }}>
            {highCount} High
          </Typography>
          <Typography component="span" level="body-xs" sx={{ color: 'warning.600', mr: 0.75 }}>
            {mediumCount} Medium
          </Typography>
          <Typography component="span" level="body-xs" sx={{ color: 'success.600' }}>
            {lowCount} Low
          </Typography>
        </Typography>
      </Sheet>

      <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
            Findings {showAll ? `(${allFindings.length} total)` : `(${criticalHighFindings.length} critical & high)`}
          </Typography>
          {hiddenCount > 0 && (
            <Button
              variant="plain"
              color="neutral"
              size="sm"
              onClick={() => setShowAll(prev => !prev)}
              sx={{ fontSize: '0.75rem', py: 0 }}
              data-testid="prowler-toggle-show-all-btn"
            >
              {showAll ? 'Show critical & high only' : `Show ${hiddenCount} more (medium & low)`}
            </Button>
          )}
        </Stack>
        <SecurityFindingsTable
          rows={visibleFindings}
          testId="prowler"
          onRetry={() => void refetch()}
          renderDetail={finding => <CloudFindingCard finding={finding} testIdPrefix="prowler" />}
        />
      </Sheet>

      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
        Last Prowler audit: {new Date(snapshot.checkedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
        {'. '}Runs when started from this page.
      </Typography>
    </Stack>
  );
};

const SCAN_TABS: readonly SegmentedOption<SecurityScan>[] = [
  { value: 'web', label: 'Website' },
  { value: 'cloud', label: 'Cloud baseline' },
  { value: 'prowler', label: 'Prowler' },
  { value: 'active-defense', label: 'Active defense' },
];

const ScanPanel = ({ scan }: { scan: SecurityScan }) => {
  switch (scan) {
    case 'web':
      return <SecurityWebTab />;
    case 'cloud':
      return <InfrastructureBaselineSubTab />;
    case 'prowler':
      return <ProwlerAuditSubTab />;
    case 'active-defense':
      return <ActiveDefenseTab />;
  }
};

export const ScansView = ({ scan, onSelectScan }: { scan: SecurityScan; onSelectScan(scan: SecurityScan): void }) => (
  <Stack spacing={2.5} data-testid="security-scans-view">
    <ScanSummaryTable activeScan={scan} onSelect={onSelectScan} />
    <SegmentedControl
      options={SCAN_TABS}
      value={scan}
      onChange={onSelectScan}
      aria-label="Scan"
      data-testid="security-scans-panel-tabs"
    />
    <Box data-testid={`security-scans-${scan}-panel`}>
      <ScanPanel scan={scan} />
    </Box>
  </Stack>
);

const VIEW_TABS: readonly ViewTab[] = [
  { id: 'incident', label: 'Incident' },
  { id: 'firewall', label: 'Firewall' },
  { id: 'scans', label: 'Scans' },
];

const isSecurityView = (id: string): id is SecurityView => SECURITY_VIEWS.some(view => view === id);

const SecurityDashboard: React.FC = () => {
  const { view, scan, setView, setScan } = useSecurityDashboardSearch();

  return (
    <Stack spacing={2.5} sx={{ width: '100%', p: 2 }} data-testid="security-dashboard-root">
      <AdminPageHeader
        title="Security"
        description="Live incident signals, firewall traffic and scan results."
        actions={<ContextHelpButton helpId="admin/security-dashboard" tooltipText="Security dashboard help" />}
      />
      <ViewTabs
        views={VIEW_TABS}
        activeId={view}
        onSelect={id => {
          if (isSecurityView(id)) setView(id);
        }}
        aria-label="Security views"
        data-testid="security-dashboard-views"
      />
      {view === 'incident' && <IncidentView />}
      {view === 'firewall' && (
        <Box data-testid="security-firewall-view">
          <WafTrafficOverview isActive />
        </Box>
      )}
      {view === 'scans' && <ScansView scan={scan} onSelectScan={setScan} />}
    </Stack>
  );
};

export default SecurityDashboard;
