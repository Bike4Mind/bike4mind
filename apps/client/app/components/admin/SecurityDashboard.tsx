import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Sheet,
  Stack,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography,
  useTheme,
} from '@mui/joy';
import {
  CheckCircle as CheckCircleIcon,
  CloudOutlined as CloudOutlinedIcon,
  CodeOutlined as CodeOutlinedIcon,
  Error as ErrorIcon,
  HomeRounded as HomeRoundedIcon,
  Inventory2Outlined as Inventory2OutlinedIcon,
  LockOutlined as LockOutlinedIcon,
  MemoryOutlined as MemoryOutlinedIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  ShieldOutlined as ShieldOutlinedIcon,
  VpnKeyOutlined as VpnKeyOutlinedIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { useMemo, useState } from 'react';
import { useSecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { APP_NAME } from '@client/config/general'; // brand externalized
import {
  SecurityCheckStatus,
  SecurityDashboardCodeSnapshot,
  SecurityDashboardOverview,
  SecurityDashboardPackagesSnapshot,
  SecurityDashboardSecretsSnapshot,
  SecurityDashboardCloudSnapshot,
  SecurityDashboardWafSnapshot,
  useSecurityDashboardAiAssessment,
  useSecurityDashboardCode,
  useSecurityDashboardOverview,
  useSecurityDashboardWeb,
  useSecurityDashboardPackages,
  useSecurityDashboardSecrets,
  useRunCodeSecurityScan,
  useRunWebSecurityScan,
  useRunPackagesSecurityScan,
  useRunSecretsSecurityScan,
  useSecurityDashboardCloud,
  useSecurityDashboardProwler,
  useRunProwlerScan,
  useRunCloudSecurityScan,
  useSecurityScanSchedule,
  useSecurityScanSchedules,
  useUpdateSecurityScanSchedule,
  useSecurityDashboardWaf,
  useRunWafSecurityScan,
} from '@client/app/hooks/data/admin';
import { WafTrafficOverview } from './SecurityDashboard/WafTrafficOverview';
import ActiveDefenseTab from './SecurityDashboard/ActiveDefenseTab';

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

/**
 * Get severity counts, preferring structured API data (severityCounts) and
 * falling back to regex parsing for older backends during rollout.
 *
 * @param check - Security check data from API
 * @returns Severity counts object
 */
const getSeverityCounts = (
  check: SecurityDashboardOverview['checks'][number]
): { critical: number; high: number; medium: number; low: number } => {
  // Prefer structured data from API (new backend)
  if (check.severityCounts) {
    return check.severityCounts;
  }

  // Fallback to regex parsing (old backend or missing data)
  // TODO: Remove this fallback after backend deployment is verified
  return parseSeverityCountsFromSummary(check.summary);
};

/**
 * DEPRECATED: Parse severity counts from summary text (fallback only)
 * This is a fragile regex-based parser kept for backwards compatibility.
 * Will be removed after backend deployment is verified.
 *
 * @deprecated Use check.severityCounts from API instead
 */
const parseSeverityCountsFromSummary = (
  summary: string
): { critical: number; high: number; medium: number; low: number } => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };

  if (!summary) {
    return counts;
  }

  const criticalMatch = summary.match(/(\d+)\s+critical/i);
  const highMatch = summary.match(/(\d+)\s+high/i);
  const mediumMatch = summary.match(/(\d+)\s+medium/i);
  const lowMatch = summary.match(/(\d+)\s+low/i);

  if (criticalMatch) counts.critical = parseInt(criticalMatch[1], 10);
  if (highMatch) counts.high = parseInt(highMatch[1], 10);
  if (mediumMatch) counts.medium = parseInt(mediumMatch[1], 10);
  if (lowMatch) counts.low = parseInt(lowMatch[1], 10);

  return counts;
};

/**
 * Determine badge colors and styling based on severity and score.
 * Priority: Critical > High > Score-based. Uses theme colors for dark mode.
 */
const getBadgeColors = (
  score: number,
  criticalCount: number,
  highCount: number,
  theme: ReturnType<typeof useTheme>
) => {
  const { palette } = theme;

  // Priority 1: Critical issues = RED (most severe)
  if (criticalCount > 0) {
    return {
      gradient: `linear-gradient(135deg, ${palette.security.critical.gradientStart}, ${palette.security.critical.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.critical.shadow}`,
      textShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
    };
  }

  // Priority 2: High issues = ORANGE
  if (highCount > 0) {
    return {
      gradient: `linear-gradient(135deg, ${palette.security.high.gradientStart}, ${palette.security.high.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.high.shadow}`,
      textShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
    };
  }

  // Priority 3: Score-based colors
  if (score < 50) {
    // At Risk = Use medium/amber
    return {
      gradient: `linear-gradient(135deg, ${palette.security.medium.gradientStart}, ${palette.security.medium.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.medium.shadow}`,
      textShadow: '0 2px 4px rgba(0, 0, 0, 0.15)',
    };
  }

  if (score < 70) {
    // Moderate
    return {
      gradient: `linear-gradient(135deg, ${palette.security.moderate.gradientStart}, ${palette.security.moderate.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.moderate.shadow}`,
      textShadow: '0 2px 4px rgba(0, 0, 0, 0.15)',
    };
  }

  if (score < 85) {
    // Good
    return {
      gradient: `linear-gradient(135deg, ${palette.security.good.gradientStart}, ${palette.security.good.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.good.shadow}`,
      textShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
    };
  }

  // Excellent
  return {
    gradient: `linear-gradient(135deg, ${palette.security.excellent.gradientStart}, ${palette.security.excellent.gradientEnd})`,
    shadow: `0 8px 24px ${palette.security.excellent.shadow}`,
    textShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
  };
};

/**
 * Get descriptive label based on severity and score
 */
const getSecurityStatusLabel = (score: number, criticalCount: number, highCount: number): string => {
  // Severity always overrides score-based labels
  if (criticalCount > 0) {
    return 'Critical Risk';
  }

  if (highCount > 0) {
    return 'High Risk';
  }

  // Score-based labels
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score < 50) return 'At Risk';
  return 'Moderate';
};

/**
 * Icon component map for status indicators
 */
const STATUS_ICON_MAP = {
  check: CheckCircleIcon,
  warning: WarningIcon,
  error: ErrorIcon,
} as const;

/**
 * StatusIcon - Renders a status icon with consistent styling
 */
const StatusIcon = ({ icon, color }: { icon: keyof typeof STATUS_ICON_MAP; color: string }) => {
  const IconComponent = STATUS_ICON_MAP[icon];
  return <IconComponent sx={{ fontSize: '20px', color }} />;
};

/**
 * Check-specific label mappings for passing/failing states, keyed by check ID.
 */
const CHECK_SPECIFIC_LABELS: Record<string, { passing: string; failing: string }> = {
  waf: { passing: 'Active', failing: 'Inactive' },
  cloud: { passing: 'Compliant', failing: 'Non-Compliant' },
  secrets: { passing: 'Clean', failing: 'Exposed' },
};

/**
 * Get security check card label and color based on score and findings.
 * Uses theme colors for dark mode.
 */
const getCheckStatusLabel = (
  check: SecurityDashboardOverview['checks'][number],
  theme: ReturnType<typeof useTheme>
): { label: string; color: string; bgcolor: string; icon?: 'check' | 'warning' | 'error' } => {
  const { id: checkId, score, status } = check;
  const { palette } = theme;

  // Handle disabled/not scanned state
  if (status === 'disabled' || score === null) {
    return {
      label: status === 'disabled' ? 'Disabled' : 'Not Scanned',
      color: palette.security.neutral.plainColor,
      bgcolor: palette.security.neutral.softBg,
    };
  }

  // Get severity counts from structured data (with fallback for backwards compatibility)
  const counts = getSeverityCounts(check);
  const totalIssues = counts.critical + counts.high + counts.medium + counts.low;

  // Check for special label mapping
  const specialLabel = CHECK_SPECIFIC_LABELS[checkId];

  // Severity configurations (priority order: critical, high, medium, low)
  const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
  const SEVERITY_CONFIG = {
    critical: { icon: 'error' as const, labelSuffix: 'Critical Issue' },
    high: { icon: 'warning' as const, labelSuffix: 'High Issue' },
    medium: { icon: 'warning' as const, labelSuffix: 'Moderate Issue' },
    low: { icon: 'warning' as const, labelSuffix: 'Low Issue' },
  };

  // Check severities in priority order
  for (const severity of SEVERITY_ORDER) {
    const count = counts[severity];
    if (count > 0) {
      const config = SEVERITY_CONFIG[severity];

      // Use special label for critical/high with custom labels, otherwise show count
      if (specialLabel && (severity === 'critical' || severity === 'high')) {
        return {
          label: specialLabel.failing,
          color: palette.security[severity].plainColor,
          bgcolor: palette.security[severity].softBg,
          icon: config.icon,
        };
      }

      // Default: show issue count
      return {
        label: count === 1 ? `1 ${config.labelSuffix}` : `${count} ${config.labelSuffix}s`,
        color: palette.security[severity].plainColor,
        bgcolor: palette.security[severity].softBg,
        icon: config.icon,
      };
    }
  }

  // No issues detected - use check-specific labels
  if (totalIssues === 0 && score >= 70) {
    const label = specialLabel ? specialLabel.passing : 'Passed';
    return {
      label,
      color: palette.security.good.plainColor,
      bgcolor: palette.security.good.softBg,
      icon: 'check',
    };
  }

  // Low score but no specific issues
  return {
    label: 'Review Needed',
    color: palette.security.low.plainColor,
    bgcolor: palette.security.low.softBg,
    icon: 'warning',
  };
};

interface SecurityOverviewCardProps {
  check: SecurityDashboardOverview['checks'][number];
}

const SecurityOverviewCard = ({ check }: SecurityOverviewCardProps) => {
  const theme = useTheme();
  const color = statusColorMap[check.status];
  const checkStatus = getCheckStatusLabel(check, theme);

  return (
    <Sheet
      variant="outlined"
      sx={{
        borderRadius: 'md',
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
      }}
      data-testid={`security-overview-${check.id}-card`}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Typography level="title-sm">{check.label}</Typography>
        <Chip
          variant="soft"
          color={color}
          size="sm"
          sx={{ textTransform: 'none', fontWeight: 500 }}
          data-testid={`security-overview-${check.id}-status-chip`}
        >
          {statusLabelMap[check.status]}
        </Chip>
      </Stack>
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderRadius: 'sm',
          bgcolor: checkStatus.bgcolor,
          width: 'fit-content',
        }}
      >
        {checkStatus.icon && <StatusIcon icon={checkStatus.icon} color={checkStatus.color} />}
        <Typography
          level="title-sm"
          sx={{
            fontWeight: 700,
            color: checkStatus.color,
          }}
          data-testid={`security-overview-${check.id}-score`}
        >
          {checkStatus.label}
        </Typography>
      </Box>
      <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid={`security-overview-${check.id}-summary`}>
        {check.summary}
      </Typography>
      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
        Last checked:{' '}
        <span data-testid={`security-overview-${check.id}-last-checked`}>
          {check.lastCheckedAt
            ? `${new Date(check.lastCheckedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`
            : '—'}
        </span>
      </Typography>
    </Sheet>
  );
};

const SecurityOverviewGrid = () => {
  const theme = useTheme();
  const { data, isLoading } = useSecurityDashboardOverview();
  const aiAssessment = useSecurityDashboardAiAssessment();

  // Fetch all schedules in a single request (N+1 fix)
  const schedules = useSecurityScanSchedules();

  // Next automated scan time from server-provided schedules.
  // Declared before any early returns to satisfy React hooks rules.
  const nextScanLabel = useMemo(() => {
    if (!schedules.data) {
      return 'Loading...';
    }

    const enabledSchedules = Object.values(schedules.data).filter(s => s?.enabled && s?.nextRunAt);

    if (enabledSchedules.length === 0) {
      return 'None scheduled';
    }

    // Find the earliest nextRunAt
    const nextRuns = enabledSchedules.map(s => new Date(s!.nextRunAt!));
    const earliestRun = new Date(Math.min(...nextRuns.map(d => d.getTime())));

    const now = new Date();
    const diffMs = earliestRun.getTime() - now.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMs < 0) {
      return 'Pending'; // Overdue
    } else if (diffDays > 0) {
      return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours === 1 ? '' : 's'}`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} min`;
    } else {
      return 'Now';
    }
  }, [schedules.data]);

  if (isLoading && !data) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={160}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (!data) {
    return null;
  }

  const lastUpdated = new Date(data.lastUpdated);
  const checksSummary = `${data.passedChecks}/${data.totalChecks} Passed`;

  // Check if any scans have been performed yet
  const enabledChecks = data.checks.filter(c => c.enabled);
  const hasAnyScanRun = enabledChecks.some(c => c.lastCheckedAt !== null);

  // Calculate total critical and high counts across all checks (single pass)
  const totalSeverity = data.checks.reduce(
    (acc, check) => {
      const counts = getSeverityCounts(check);
      return {
        critical: acc.critical + counts.critical,
        high: acc.high + counts.high,
      };
    },
    { critical: 0, high: 0 }
  );

  // Get badge styling based on severity (or neutral if no scans yet)
  const badgeColors = hasAnyScanRun
    ? getBadgeColors(data.overallScore, totalSeverity.critical, totalSeverity.high, theme)
    : {
        gradient: `linear-gradient(135deg, ${theme.palette.security.neutral.gradientStart}, ${theme.palette.security.neutral.gradientEnd})`,
        shadow: `0 8px 24px ${theme.palette.security.neutral.shadow}`,
        textShadow: '0 2px 4px rgba(0, 0, 0, 0.15)',
      };

  const scoreLabel = hasAnyScanRun
    ? getSecurityStatusLabel(data.overallScore, totalSeverity.critical, totalSeverity.high)
    : 'Not Assessed';

  const topRecs = (aiAssessment.data?.recommendations ?? []).slice(0, 3);

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={3}>
        <Sheet
          variant="outlined"
          sx={{
            borderRadius: 'lg',
            p: 3,
            flex: { xs: '1 1 auto', lg: '0 0 320px' },
            display: 'flex',
            flexDirection: 'column',
            alignItems: { xs: 'center', lg: 'flex-start' },
            gap: 2,
          }}
          data-testid="security-overview-status-card"
        >
          <Stack direction="column" spacing={2} alignItems="center" sx={{ width: '100%' }}>
            <Box
              sx={{
                width: 148,
                height: 148,
                borderRadius: '50%',
                background: badgeColors.gradient,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: theme.palette.neutral[50],
                boxShadow: badgeColors.shadow,
              }}
            >
              {/* Show "Not Assessed" if no scans have been run yet */}
              {!hasAnyScanRun ? (
                <>
                  <Typography
                    level="h2"
                    sx={{
                      lineHeight: 1,
                      fontSize: '36px',
                      fontWeight: 800,
                      textShadow: badgeColors.textShadow,
                      mb: 0.5,
                    }}
                  >
                    🔍
                  </Typography>
                  <Typography
                    level="title-md"
                    sx={{
                      fontSize: '14px',
                      fontWeight: 700,
                      textShadow: badgeColors.textShadow,
                      lineHeight: 1.2,
                      textAlign: 'center',
                    }}
                  >
                    PENDING
                  </Typography>
                  <Typography
                    level="body-xs"
                    sx={{
                      opacity: 0.95,
                      fontWeight: 600,
                      textShadow: badgeColors.textShadow,
                      mt: 0.25,
                      fontSize: '11px',
                    }}
                  >
                    Run scans
                  </Typography>
                </>
              ) : (
                /* Show status label in circle (with dynamic colors) */
                <Typography
                  level="title-md"
                  sx={{
                    fontSize: '18px',
                    fontWeight: 700,
                    textShadow: badgeColors.textShadow,
                    lineHeight: 1.2,
                    textAlign: 'center',
                    px: 2,
                  }}
                >
                  {scoreLabel}
                </Typography>
              )}
            </Box>
            <Typography level="body-sm" sx={{ color: 'neutral.600', textAlign: 'center' }}>
              {!hasAnyScanRun ? 'Run initial security scans' : 'Security Status'}
            </Typography>
          </Stack>

          <Box
            sx={{
              mt: 2.5,
              pt: 2.5,
              borderTop: '1px solid',
              borderColor: 'divider',
              width: '100%',
            }}
          >
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 1.5 }}>
              <Typography level="body-xs" sx={{ color: 'text.secondary', fontWeight: 500, letterSpacing: '0.01em' }}>
                Last Updated
              </Typography>
              <Typography level="body-xs" sx={{ fontWeight: 600, color: 'text.primary' }}>
                {lastUpdated.toLocaleString('en-US', { timeZone: 'UTC' })} UTC
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 1.5 }}>
              <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                Security Checks
              </Typography>
              <Typography level="body-xs" sx={{ fontWeight: 600, color: 'success.600' }}>
                {checksSummary}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography level="body-xs" sx={{ color: 'text.secondary', fontWeight: 500, letterSpacing: '0.01em' }}>
                Next Scan
              </Typography>
              <Typography level="body-xs" sx={{ fontWeight: 600, color: 'text.primary' }}>
                {nextScanLabel}
              </Typography>
            </Stack>
          </Box>
        </Sheet>

        <Sheet
          variant="soft"
          sx={{
            borderRadius: 'lg',
            p: 3,
            flex: '1 1 auto',
            background:
              theme.palette.mode === 'light'
                ? `linear-gradient(135deg, ${theme.palette.primary.softBg} 0%, ${theme.palette.primary.softHoverBg} 50%, ${theme.palette.primary.softBg} 100%)`
                : `linear-gradient(135deg, ${theme.palette.primary[600]} 0%, ${theme.palette.primary[500]} 50%, ${theme.palette.primary[400]} 100%)`,
            color: theme.palette.mode === 'light' ? theme.palette.text.primary : theme.palette.neutral[50],
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            boxShadow: theme.palette.mode === 'light' ? theme.shadow.sm : `0 8px 24px ${theme.palette.primary[600]}33`,
            border: theme.palette.mode === 'light' ? `1px solid ${theme.palette.primary.outlinedBorder}` : 'none',
          }}
          data-testid="security-overview-ai-card"
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <Sheet
              variant="soft"
              sx={{
                borderRadius: 'lg',
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor:
                  theme.palette.mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[500]}26`,
                color: theme.palette.mode === 'light' ? theme.palette.primary.solidBg : theme.palette.primary[300],
              }}
            >
              <MemoryOutlinedIcon fontSize="small" />
            </Sheet>
            <Box sx={{ flex: 1 }}>
              <Typography level="title-md" sx={{ fontWeight: 700 }}>
                AI Security Assessment
              </Typography>
              <Typography
                level="body-xs"
                sx={{
                  opacity: theme.palette.mode === 'light' ? 0.75 : 0.9,
                  color: theme.palette.mode === 'light' ? theme.palette.text.secondary : 'inherit',
                }}
              >
                {aiAssessment.isLoading || aiAssessment.isFetching
                  ? 'Analyzing your security posture with AI…'
                  : aiAssessment.data?.overallSummary ||
                    'AI assessment is unavailable right now. Review the category cards for the latest scan results.'}
              </Typography>
            </Box>
            <Chip
              variant="soft"
              color="neutral"
              size="sm"
              startDecorator={
                <Box
                  sx={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor:
                      theme.palette.mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[400]}1A`,
                    border:
                      theme.palette.mode === 'light'
                        ? `1px solid ${theme.palette.primary.outlinedBorder}`
                        : `1px solid ${theme.palette.primary[400]}26`,
                  }}
                >
                  <Bike4MindIcon
                    fill={theme.palette.mode === 'light' ? theme.palette.primary.solidBg : theme.palette.primary[300]}
                    size="14"
                  />
                </Box>
              }
              sx={{
                textTransform: 'none',
                fontWeight: 600,
                bgcolor:
                  theme.palette.mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[700]}40`,
                color: theme.palette.mode === 'light' ? theme.palette.text.primary : theme.palette.primary[200],
                border: theme.palette.mode === 'light' ? 'none' : `1px solid ${theme.palette.primary[600]}33`,
              }}
              data-testid="security-overview-powered-by-b4m-chip"
            >
              Powered by{APP_NAME ? ` ${APP_NAME}` : ''}
            </Chip>
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 1 }}>
            {(topRecs.length ? topRecs : [null, null, null]).map((rec, idx) => (
              <Sheet
                key={rec?.id || `placeholder-${idx}`}
                variant="soft"
                sx={{
                  borderRadius: 'md',
                  p: 1.5,
                  flex: 1,
                  bgcolor:
                    theme.palette.mode === 'light'
                      ? theme.palette.primary.plainHoverBg
                      : `${theme.palette.primary[800]}33`,
                  border:
                    theme.palette.mode === 'light'
                      ? `1px solid ${theme.palette.primary.outlinedBorder}`
                      : `1px solid ${theme.palette.primary[700]}26`,
                }}
                data-testid={`security-overview-ai-recommendation-${idx}-card`}
              >
                <Typography level="body-sm" sx={{ fontWeight: 600 }}>
                  {rec?.title ?? '—'}
                </Typography>
                <Typography
                  level="body-xs"
                  sx={{
                    opacity: theme.palette.mode === 'light' ? 0.75 : 0.9,
                    color: theme.palette.mode === 'light' ? theme.palette.text.secondary : 'inherit',
                    mb: 1,
                  }}
                >
                  Priority: {rec?.priority ? rec.priority[0].toUpperCase() + rec.priority.slice(1) : '—'}
                </Typography>
                <Typography
                  level="body-xs"
                  sx={{
                    opacity: theme.palette.mode === 'light' ? 0.75 : 0.9,
                    color: theme.palette.mode === 'light' ? theme.palette.text.secondary : 'inherit',
                    mb: 1,
                  }}
                >
                  {rec?.rationale ??
                    (aiAssessment.isLoading || aiAssessment.isFetching ? 'Generating recommendations…' : '—')}
                </Typography>
                <Button
                  size="sm"
                  variant="soft"
                  color="neutral"
                  data-testid={`security-overview-ai-recommendation-${idx}-cta-btn`}
                  sx={{
                    textTransform: 'none',
                    bgcolor:
                      theme.palette.mode === 'light' ? theme.palette.primary.softBg : `${theme.palette.primary[600]}30`,
                    color: theme.palette.mode === 'light' ? theme.palette.text.primary : theme.palette.primary[100],
                    border:
                      theme.palette.mode === 'light'
                        ? `1px solid ${theme.palette.primary.outlinedBorder}`
                        : `1px solid ${theme.palette.primary[500]}33`,
                    boxShadow: 'none',
                    '&:hover': {
                      bgcolor:
                        theme.palette.mode === 'light'
                          ? theme.palette.primary.softHoverBg
                          : `${theme.palette.primary[600]}45`,
                      boxShadow: 'none',
                    },
                    '&:active': {
                      bgcolor:
                        theme.palette.mode === 'light'
                          ? theme.palette.primary.softActiveBg
                          : `${theme.palette.primary[600]}55`,
                      boxShadow: 'none',
                    },
                    '&.Mui-disabled': {
                      bgcolor:
                        theme.palette.mode === 'light'
                          ? theme.palette.neutral.plainDisabledColor
                          : `${theme.palette.primary[800]}20`,
                      color: theme.palette.mode === 'light' ? theme.palette.neutral[400] : theme.palette.primary[700],
                      borderColor:
                        theme.palette.mode === 'light' ? theme.palette.neutral[200] : `${theme.palette.primary[700]}20`,
                    },
                  }}
                  disabled={!rec}
                >
                  {rec?.suggestedAction ?? '—'}
                </Button>
              </Sheet>
            ))}
          </Stack>

          <Typography
            level="body-xs"
            sx={{
              opacity: theme.palette.mode === 'light' ? 0.7 : 0.85,
              color: theme.palette.mode === 'light' ? theme.palette.text.secondary : 'inherit',
              mt: 1,
            }}
          >
            {aiAssessment.data?.generatedAt && aiAssessment.data?.nextAssessmentAt
              ? `AI assessment last updated: ${new Date(aiAssessment.data.generatedAt).toLocaleString('en-US', {
                  timeZone: 'UTC',
                })} UTC • Next analysis: ${new Date(aiAssessment.data.nextAssessmentAt).toLocaleString('en-US', {
                  timeZone: 'UTC',
                })} UTC`
              : 'AI assessment timing unavailable.'}
          </Typography>
        </Sheet>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            md: 'repeat(3, minmax(0, 1fr))',
          },
          gap: 2,
          mb: 1,
        }}
        data-testid="security-overview-grid"
      >
        {data.checks.map(check => (
          <Box key={check.id}>
            <SecurityOverviewCard check={check} />
          </Box>
        ))}
      </Box>
    </Stack>
  );
};

const SecurityWebTab = () => {
  const { data: snapshot, isLoading } = useSecurityDashboardWeb();
  const runWebScan = useRunWebSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('web');
  const updateSchedule = useUpdateSecurityScanSchedule('web');

  if (isLoading && !snapshot) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
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

      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'md',
        }}
      >
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 1 }}>
          Scan Details
        </Typography>
        <Stack spacing={1.5}>
          {findings.map(finding => (
            <Sheet
              key={finding.id}
              variant="soft"
              sx={theme => ({
                p: 1.5,
                borderRadius: 'sm',
                borderLeft: '3px solid',
                borderLeftColor:
                  finding.severity === 'critical'
                    ? theme.palette.danger[500]
                    : finding.severity === 'high'
                      ? theme.palette.warning[700]
                      : finding.severity === 'medium'
                        ? theme.palette.warning[500]
                        : theme.palette.success[600],
                backgroundColor: theme.palette.background.level1,
              })}
              data-testid={`web-security-finding-${finding.id}`}
            >
              <Typography level="body-sm" sx={{ fontWeight: 600 }}>
                {finding.title}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
                {finding.description}
              </Typography>
            </Sheet>
          ))}
          {findings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No findings were reported in the latest scan.
            </Typography>
          )}
        </Stack>
      </Sheet>

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

const SecurityCodeTab = ({ snapshot: initialSnapshot }: { snapshot?: SecurityDashboardCodeSnapshot }) => {
  const { data: liveSnapshot, isLoading } = useSecurityDashboardCode();
  const snapshot = liveSnapshot ?? initialSnapshot;
  const runCodeScan = useRunCodeSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('code');
  const updateSchedule = useUpdateSecurityScanSchedule('code');

  if (isLoading && !snapshot) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Stack spacing={3} data-testid="security-dashboard-code-tab">
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography level="title-lg">Code Security Analysis</Typography>
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No code analysis scan has been recorded yet for this stage.
            </Typography>
          </Box>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => runCodeScan.mutate()}
            loading={runCodeScan.isPending}
            data-testid="code-security-run-scan-btn"
          >
            Run Code Scan
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
              data-testid="code-security-schedule-toggle"
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

  const handleRunScan = () => {
    if (cooldownActive || runCodeScan.isPending) return;
    runCodeScan.mutate();
  };

  const hasAnyFindings = findings.length > 0;

  return (
    <Stack spacing={3} data-testid="security-dashboard-code-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="title-lg">Code Security Analysis</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
            Semgrep static analysis of your source code for security issues and risky patterns.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={handleRunScan}
            loading={runCodeScan.isPending}
            disabled={cooldownActive || runCodeScan.isPending}
            data-testid="code-security-run-scan-btn"
          >
            Run Code Scan
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
            data-testid="code-security-schedule-toggle"
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
          Code Security Issues
        </Typography>
        <Typography
          level="h3"
          sx={{
            fontWeight: 700,
            color: hasAnyFindings ? 'danger.600' : 'success.600',
          }}
          data-testid="code-security-issues-metric"
        >
          {hasAnyFindings ? (
            <>
              <Typography component="span" level="h4" sx={{ color: 'danger.600', mr: 0.75 }}>
                {criticalCount} Critical
              </Typography>
              <Typography component="span" level="h4" sx={{ color: 'warning.700', mr: 0.75 }}>
                {highCount} High
              </Typography>
              <Typography component="span" level="h4" sx={{ color: 'warning.600', mr: 0.75 }}>
                {mediumCount} Medium
              </Typography>
              <Typography component="span" level="h4" sx={{ color: 'success.600' }}>
                {lowCount} Low
              </Typography>{' '}
              <Typography component="span" level="h4" sx={{ color: 'neutral.700', ml: 0.5 }}>
                code issues
              </Typography>
            </>
          ) : (
            '0 Code issues detected'
          )}
        </Typography>
      </Sheet>

      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'md',
        }}
      >
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 1 }}>
          Findings
        </Typography>
        <Stack spacing={1.5}>
          {findings.map(finding => (
            <Sheet
              key={finding.id}
              variant="soft"
              sx={theme => ({
                p: 1.5,
                borderRadius: 'sm',
                borderLeft: '3px solid',
                borderLeftColor:
                  finding.severity === 'critical'
                    ? theme.palette.danger[500]
                    : finding.severity === 'high'
                      ? theme.palette.warning[700]
                      : finding.severity === 'medium'
                        ? theme.palette.warning[500]
                        : theme.palette.success[600],
                backgroundColor: theme.palette.background.level1,
              })}
              data-testid={`code-security-finding-${finding.id}`}
            >
              <Typography level="body-sm" sx={{ fontWeight: 600 }}>
                {finding.title}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
                {finding.description}
              </Typography>
            </Sheet>
          ))}
          {findings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No issues were reported in the latest code analysis scan.
            </Typography>
          )}
        </Stack>
      </Sheet>

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

const SecurityPackagesTab = ({ snapshot: initialSnapshot }: { snapshot?: SecurityDashboardPackagesSnapshot }) => {
  const { data: liveSnapshot, isLoading } = useSecurityDashboardPackages();
  const snapshot = liveSnapshot ?? initialSnapshot;
  const runPackagesScan = useRunPackagesSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('packages');
  const updateSchedule = useUpdateSecurityScanSchedule('packages');

  if (isLoading && !snapshot) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Stack spacing={3} data-testid="security-dashboard-packages-tab">
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography level="title-lg">Packages Security (Dependencies Audit)</Typography>
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No packages security scan has been recorded yet for this stage.
            </Typography>
          </Box>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => runPackagesScan.mutate()}
            loading={runPackagesScan.isPending}
            data-testid="packages-security-run-scan-btn"
          >
            Run Packages Scan
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
              data-testid="packages-security-schedule-toggle"
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
  const vulnerableCount = findings.length;

  const handleRunScan = () => {
    if (cooldownActive || runPackagesScan.isPending) return;
    runPackagesScan.mutate();
  };

  const hasAnyFindings = findings.length > 0;

  return (
    <Stack spacing={3} data-testid="security-dashboard-packages-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="title-lg">Packages Security (Dependencies Audit)</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
            Audit of third-party dependencies for known vulnerabilities and required updates.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={handleRunScan}
            loading={runPackagesScan.isPending}
            disabled={cooldownActive || runPackagesScan.isPending}
            data-testid="packages-security-run-scan-btn"
          >
            Run Packages Scan
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
            data-testid="packages-security-schedule-toggle"
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
          Known Vulnerabilities
        </Typography>
        <Typography
          level="h3"
          sx={{
            fontWeight: 700,
            color: hasAnyFindings ? 'danger.600' : 'success.600',
          }}
          data-testid="packages-security-issues-metric"
        >
          {hasAnyFindings
            ? `${vulnerableCount} packages with known vulnerabilities`
            : '0 packages with known vulnerabilities'}
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

      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'md',
        }}
      >
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 1 }}>
          Findings
        </Typography>
        <Stack spacing={1.5}>
          {findings.map(finding => {
            const pkgLabel =
              finding.metadata?.packageName && finding.metadata?.currentVersion
                ? `${finding.metadata.packageName}@${finding.metadata.currentVersion}`
                : finding.description;
            const vulnerableRange = finding.metadata?.vulnerableRange;
            const recommendationText =
              finding.recommendation ||
              (finding.metadata?.recommendedVersion && finding.metadata.packageName
                ? `Upgrade ${finding.metadata.packageName} to ${finding.metadata.recommendedVersion}.`
                : 'Review the advisory and upgrade to a safe version.');

            return (
              <Sheet
                key={finding.id}
                variant="soft"
                sx={theme => ({
                  p: 1.5,
                  borderRadius: 'sm',
                  borderLeft: '3px solid',
                  borderLeftColor:
                    finding.severity === 'critical'
                      ? theme.palette.danger[500]
                      : finding.severity === 'high'
                        ? theme.palette.warning[700]
                        : finding.severity === 'medium'
                          ? theme.palette.warning[500]
                          : theme.palette.success[600],
                  backgroundColor: theme.palette.background.level1,
                })}
                data-testid={`packages-security-finding-${finding.id}`}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography level="body-sm" sx={{ fontWeight: 600, mr: 1 }}>
                    {finding.title}
                  </Typography>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={severityColorMap[finding.severity]}
                    sx={{ textTransform: 'none', fontWeight: 500 }}
                  >
                    {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)} severity
                  </Chip>
                </Stack>
                <Typography level="body-xs" sx={{ color: 'neutral.700', mt: 0.5 }}>
                  {pkgLabel}
                  {vulnerableRange ? ` – vulnerable range: ${vulnerableRange}` : ''}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
                  {recommendationText}
                </Typography>
                {finding.documentationUrl?.startsWith('https://') && (
                  <Typography level="body-xs" sx={{ color: 'primary.600', mt: 0.5 }}>
                    <a
                      href={finding.documentationUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`packages-security-finding-${finding.id}-advisory-link`}
                    >
                      View advisory
                    </a>
                  </Typography>
                )}
              </Sheet>
            );
          })}
          {findings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No vulnerable packages were reported in the latest scan.
            </Typography>
          )}
        </Stack>
      </Sheet>

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

const SecuritySecretsTab = ({ snapshot: initialSnapshot }: { snapshot?: SecurityDashboardSecretsSnapshot }) => {
  const { data: liveSnapshot, isLoading } = useSecurityDashboardSecrets();
  const snapshot = liveSnapshot ?? initialSnapshot;
  const runSecretsScan = useRunSecretsSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('secrets');
  const updateSchedule = useUpdateSecurityScanSchedule('secrets');

  if (isLoading && !snapshot) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Stack spacing={3} data-testid="security-dashboard-secrets-tab">
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography level="title-lg">Secrets Scan (Password &amp; Key Protection)</Typography>
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No secrets security scan has been recorded yet for this stage.
            </Typography>
          </Box>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => runSecretsScan.mutate()}
            loading={runSecretsScan.isPending}
            data-testid="secrets-security-run-scan-btn"
          >
            Run Secrets Scan
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
              data-testid="secrets-security-schedule-toggle"
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
  const totalSecrets = findings.length;

  const handleRunScan = () => {
    if (cooldownActive || runSecretsScan.isPending) return;
    runSecretsScan.mutate();
  };

  const hasAnyFindings = findings.length > 0;

  return (
    <Stack spacing={3} data-testid="security-dashboard-secrets-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="title-lg">Secrets Scan (Password &amp; Key Protection)</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
            Detection of exposed API keys, tokens, passwords, and other secrets in your repositories.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={handleRunScan}
            loading={runSecretsScan.isPending}
            disabled={cooldownActive || runSecretsScan.isPending}
            data-testid="secrets-security-run-scan-btn"
          >
            Run Secrets Scan
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
            data-testid="secrets-security-schedule-toggle"
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
          Exposed Secrets
        </Typography>
        <Typography
          level="h3"
          sx={{
            fontWeight: 700,
            color: hasAnyFindings ? 'danger.600' : 'success.600',
          }}
          data-testid="secrets-security-issues-metric"
        >
          {hasAnyFindings ? `${totalSecrets} exposed secrets detected` : '0 exposed secrets detected'}
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

      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'md',
        }}
      >
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 1 }}>
          Findings
        </Typography>
        <Stack spacing={1.5}>
          {findings.map(finding => {
            const secretTypeLabel =
              finding.metadata?.secretType?.toString() || finding.title.replace(/ exposure$/i, '').replace(/_/g, ' ');

            const locationLabel =
              finding.metadata?.filePath && typeof finding.metadata.line === 'number'
                ? `${finding.metadata.filePath}:${finding.metadata.line}`
                : finding.metadata?.filePath;

            const recommendationText =
              finding.recommendation ||
              'Rotate the affected credentials, scrub them from git history if possible, and redeploy with new secrets.';

            return (
              <Sheet
                key={finding.id}
                variant="soft"
                sx={theme => ({
                  p: 1.5,
                  borderRadius: 'sm',
                  borderLeft: '3px solid',
                  borderLeftColor:
                    finding.severity === 'critical'
                      ? theme.palette.danger[500]
                      : finding.severity === 'high'
                        ? theme.palette.warning[700]
                        : finding.severity === 'medium'
                          ? theme.palette.warning[500]
                          : theme.palette.success[600],
                  backgroundColor: theme.palette.background.level1,
                })}
                data-testid={`secrets-security-finding-${finding.id}`}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography level="body-sm" sx={{ fontWeight: 600, mr: 1 }}>
                    {secretTypeLabel}
                  </Typography>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={severityColorMap[finding.severity]}
                    sx={{ textTransform: 'none', fontWeight: 500 }}
                  >
                    {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)} severity
                  </Chip>
                </Stack>
                {locationLabel && (
                  <Typography level="body-xs" sx={{ color: 'neutral.700', mt: 0.5 }}>
                    Location: {locationLabel}
                  </Typography>
                )}
                <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
                  Potential {secretTypeLabel.toLowerCase()} exposure detected. Secret value is never shown in this view.
                </Typography>
                <Typography level="body-xs" sx={{ color: 'neutral.600', mt: 0.5 }}>
                  {recommendationText}
                </Typography>
              </Sheet>
            );
          })}
          {findings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No exposed secrets were reported in the latest scan.
            </Typography>
          )}
        </Stack>
      </Sheet>

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
                ? `…${finding.metadata.resourceArn.slice(-44)}`
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
  const { data: liveSnapshot, isLoading } = useSecurityDashboardCloud();
  const snapshot = liveSnapshot ?? initialSnapshot;
  const runCloudScan = useRunCloudSecurityScan();
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);
  const { data: schedule } = useSecurityScanSchedule('cloud');
  const updateSchedule = useUpdateSecurityScanSchedule('cloud');

  if (isLoading && !snapshot) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
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

      <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }}>
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 1 }}>
          Findings
        </Typography>
        <Stack spacing={1.5}>
          {findings.map(finding => (
            <CloudFindingCard key={finding.id} finding={finding} testIdPrefix="cloud-security" />
          ))}
          {findings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No misconfigurations found in the latest baseline scan.
            </Typography>
          )}
        </Stack>
      </Sheet>

      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
        Last scan: {new Date(snapshot.checkedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
        {cooldownActive ? ` • Next scan available in ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'}.` : ''}
      </Typography>
    </Stack>
  );
};

const ProwlerAuditSubTab = () => {
  const { data: snapshot, isLoading } = useSecurityDashboardProwler();
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
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Stack spacing={2}>
        <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
          No Prowler audit data found for this stage.
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
          Prowler runs automatically every Sunday via the weekly security scan workflow.
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
        <Stack spacing={1.5}>
          {visibleFindings.map(finding => (
            <CloudFindingCard key={finding.id} finding={finding} testIdPrefix="prowler" />
          ))}
          {visibleFindings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No Prowler findings in the latest audit.
            </Typography>
          )}
        </Stack>
      </Sheet>

      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
        Last Prowler audit: {new Date(snapshot.checkedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
        {' · '}Runs automatically every Sunday via GitHub Actions.
      </Typography>
    </Stack>
  );
};

const SecurityCloudTab = ({ snapshot: initialSnapshot }: { snapshot?: SecurityDashboardCloudSnapshot }) => {
  const [cloudSubTab, setCloudSubTab] = useState<'baseline' | 'prowler'>('baseline');

  return (
    <Stack spacing={2} data-testid="security-dashboard-cloud-tab">
      <Box>
        <Typography level="title-lg">Cloud Security</Typography>
        <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
          AWS infrastructure checks and deep Prowler audit results.
        </Typography>
      </Box>
      <Tabs
        value={cloudSubTab}
        onChange={(_, v) => setCloudSubTab(v as 'baseline' | 'prowler')}
        size="sm"
        sx={{ bgcolor: 'transparent' }}
      >
        <TabList sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
          <Tab value="baseline" data-testid="cloud-security-baseline-tab-btn">
            Infrastructure Baseline
          </Tab>
          <Tab value="prowler" data-testid="cloud-security-prowler-tab-btn">
            Prowler Audit
          </Tab>
        </TabList>
        <TabPanel value="baseline" sx={{ px: 0, pt: 2 }}>
          <InfrastructureBaselineSubTab initialSnapshot={initialSnapshot} />
        </TabPanel>
        <TabPanel value="prowler" sx={{ px: 0, pt: 2 }}>
          <ProwlerAuditSubTab />
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

const SecurityWafTab = ({
  snapshot: initialSnapshot,
  isActive = true,
}: {
  snapshot?: SecurityDashboardWafSnapshot;
  isActive?: boolean;
}) => {
  const { data: liveSnapshot, isLoading } = useSecurityDashboardWaf();
  const snapshot = liveSnapshot ?? initialSnapshot;
  const runWafScan = useRunWafSecurityScan();
  const { data: schedule } = useSecurityScanSchedule('waf');
  const updateSchedule = useUpdateSecurityScanSchedule('waf');
  const { cooldownActive, hoursRemaining } = useSecurityScanCooldown(snapshot?.checkedAt);

  // Traffic overview rendered via WafTrafficOverview component

  if (isLoading && !snapshot) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Stack spacing={3} data-testid="security-dashboard-waf-tab">
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography level="title-lg">Firewall / WAF</Typography>
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No Firewall / WAF scan has been recorded yet for this stage.
            </Typography>
          </Box>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={() => runWafScan.mutate()}
            loading={runWafScan.isPending}
            data-testid="waf-security-run-scan-btn"
          >
            Run Firewall / WAF Scan
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
              data-testid="waf-security-schedule-toggle"
            />
          </Stack>
        </Sheet>
        <WafTrafficOverview isActive={isActive} />
      </Stack>
    );
  }

  const findings = snapshot.findings ?? [];
  const issueFindings = findings.filter(finding => !finding.metadata?.informational);
  const configSummaryFinding = findings.find(finding => finding.metadata?.informational);

  const {
    critical: criticalCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount,
  } = countBySeverity(issueFindings as Array<{ severity: SeverityLevel }>);
  const hasAnyFindings = issueFindings.length > 0;

  const handleRunScan = () => {
    if (cooldownActive || runWafScan.isPending) return;
    runWafScan.mutate();
  };

  return (
    <Stack spacing={3} data-testid="security-dashboard-waf-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="title-lg">Firewall / WAF</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
            Evaluates your edge protections (WAF / firewall) for critical gaps and misconfigurations.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="soft"
            color="primary"
            size="sm"
            onClick={handleRunScan}
            loading={runWafScan.isPending}
            disabled={cooldownActive || runWafScan.isPending}
            data-testid="waf-security-run-scan-btn"
          >
            Run Firewall / WAF Scan
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
            data-testid="waf-security-schedule-toggle"
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
          Firewall / WAF Posture
        </Typography>
        <Typography
          level="h3"
          sx={{
            fontWeight: 700,
            color: hasAnyFindings ? 'danger.600' : 'success.600',
          }}
          data-testid="waf-security-issues-metric"
        >
          {hasAnyFindings ? `${snapshot.score} / 100 score` : 'No firewall / WAF issues detected'}
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

      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'md',
        }}
      >
        <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 1 }}>
          Findings
        </Typography>
        <Stack spacing={1.5}>
          {configSummaryFinding && (
            <Sheet
              variant="soft"
              sx={theme => ({
                p: 1.5,
                borderRadius: 'sm',
                borderLeft: '3px solid',
                borderLeftColor: theme.palette.success[600],
                backgroundColor: theme.palette.background.level1,
              })}
              data-testid="waf-security-config-summary"
            >
              <Typography level="body-sm" sx={{ fontWeight: 600, mb: 0.5 }}>
                {configSummaryFinding.title}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.600', mb: 0.5 }}>
                {configSummaryFinding.description}
              </Typography>
              {(configSummaryFinding.metadata?.webAcls?.length ||
                configSummaryFinding.metadata?.distributions?.length) && (
                <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                  {configSummaryFinding.metadata?.webAcls?.length ? (
                    <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                      <strong>WebACLs:</strong> {configSummaryFinding.metadata.webAcls.join(', ')}
                    </Typography>
                  ) : null}
                  {configSummaryFinding.metadata?.distributions?.length ? (
                    <Typography level="body-xs" sx={{ color: 'neutral.600' }}>
                      <strong>CloudFront distributions:</strong>{' '}
                      {configSummaryFinding.metadata.distributions.join(', ')}
                    </Typography>
                  ) : null}
                </Stack>
              )}
            </Sheet>
          )}
          {issueFindings.map(finding => (
            <Sheet
              key={finding.id}
              variant="soft"
              sx={theme => ({
                p: 1.5,
                borderRadius: 'sm',
                borderLeft: '3px solid',
                borderLeftColor:
                  finding.severity === 'critical'
                    ? theme.palette.danger[500]
                    : finding.severity === 'high'
                      ? theme.palette.warning[700]
                      : finding.severity === 'medium'
                        ? theme.palette.warning[500]
                        : theme.palette.success[600],
                backgroundColor: theme.palette.background.level1,
              })}
              data-testid={`waf-security-finding-${finding.id}`}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Typography level="body-sm" sx={{ fontWeight: 600, mr: 1 }}>
                  {finding.title}
                </Typography>
                <Chip
                  size="sm"
                  variant="soft"
                  color={severityColorMap[finding.severity]}
                  sx={{ textTransform: 'none', fontWeight: 500 }}
                >
                  {finding.severity[0].toUpperCase() + finding.severity.slice(1)} severity
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
              {finding.documentationUrl?.startsWith('https://') && (
                <Typography level="body-xs" sx={{ color: 'primary.600', mt: 0.5 }}>
                  <a href={finding.documentationUrl} target="_blank" rel="noreferrer">
                    View guidance
                  </a>
                </Typography>
              )}
            </Sheet>
          ))}
          {findings.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
              No firewall / WAF issues were reported in the latest scan.
            </Typography>
          )}
        </Stack>
      </Sheet>

      <WafTrafficOverview isActive={isActive} />

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

type SecurityDashboardSectionId =
  | 'overview'
  | 'web'
  | 'code'
  | 'packages'
  | 'secrets'
  | 'cloud'
  | 'waf'
  | 'active-defense';

// Tabs temporarily hidden - functionality preserved but not exposed in UI
const HIDDEN_TABS: SecurityDashboardSectionId[] = ['code', 'packages', 'secrets'];

const SecurityDashboard: React.FC = () => {
  const [activeSection, setActiveSection] = useState<SecurityDashboardSectionId>('overview');

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        minHeight: '600px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        p: 2,
      }}
      data-testid="security-dashboard-react-root"
    >
      <Box>
        <Typography level="h3" sx={{ mb: 0.5 }}>
          Security Dashboard
        </Typography>
        <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
          Central view of your security posture across website, code, infrastructure, and more.
        </Typography>
      </Box>

      <Tabs
        value={activeSection}
        onChange={(_, value) => setActiveSection(value as SecurityDashboardSectionId)}
        sx={{ mt: 3 }}
        data-testid="security-dashboard-react-tabs"
      >
        <TabList
          sx={{
            borderBottom: '1px solid',
            borderColor: 'divider',
            mb: 1,
          }}
        >
          <Tab
            value="overview"
            data-testid="security-dashboard-react-overview-tab-btn"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <HomeRoundedIcon fontSize="small" />
              <span>Overview</span>
            </Stack>
          </Tab>
          <Tab
            value="web"
            data-testid="security-dashboard-react-web-tab-btn"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <LockOutlinedIcon fontSize="small" />
              <span>Website Security</span>
            </Stack>
          </Tab>
          {/* Code Analysis, Packages, Secrets tabs hidden - re-enable by removing from HIDDEN_TABS */}
          {!HIDDEN_TABS.includes('code') && (
            <Tab
              value="code"
              data-testid="security-dashboard-react-code-tab-btn"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <CodeOutlinedIcon fontSize="small" />
                <span>Code Analysis</span>
              </Stack>
            </Tab>
          )}
          {!HIDDEN_TABS.includes('packages') && (
            <Tab
              value="packages"
              data-testid="security-dashboard-react-packages-tab-btn"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Inventory2OutlinedIcon fontSize="small" />
                <span>Packages</span>
              </Stack>
            </Tab>
          )}
          {!HIDDEN_TABS.includes('secrets') && (
            <Tab
              value="secrets"
              data-testid="security-dashboard-react-secrets-tab-btn"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <VpnKeyOutlinedIcon fontSize="small" />
                <span>Secrets</span>
              </Stack>
            </Tab>
          )}
          <Tab
            value="cloud"
            data-testid="security-dashboard-react-cloud-tab-btn"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <CloudOutlinedIcon fontSize="small" />
              <span>Cloud</span>
            </Stack>
          </Tab>
          <Tab
            value="waf"
            data-testid="security-dashboard-react-waf-tab-btn"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <ShieldOutlinedIcon fontSize="small" />
              <span>Firewall / WAF</span>
            </Stack>
          </Tab>
          <Tab
            value="active-defense"
            data-testid="security-dashboard-react-active-defense-tab-btn"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <PlayCircleOutlinedIcon fontSize="small" />
              <span>Active Defense</span>
            </Stack>
          </Tab>
        </TabList>

        <TabPanel value="overview" sx={{ px: 0, pt: 2 }}>
          <SecurityOverviewGrid />
        </TabPanel>
        <TabPanel value="web" sx={{ px: 0, pt: 2 }}>
          <SecurityWebTab />
        </TabPanel>
        {/* TabPanels for hidden tabs - preserved for re-enablement via HIDDEN_TABS */}
        {!HIDDEN_TABS.includes('code') && (
          <TabPanel value="code" sx={{ px: 0, pt: 2 }}>
            <SecurityCodeTab />
          </TabPanel>
        )}
        {!HIDDEN_TABS.includes('packages') && (
          <TabPanel value="packages" sx={{ px: 0, pt: 2 }}>
            <SecurityPackagesTab />
          </TabPanel>
        )}
        {!HIDDEN_TABS.includes('secrets') && (
          <TabPanel value="secrets" sx={{ px: 0, pt: 2 }}>
            <SecuritySecretsTab />
          </TabPanel>
        )}
        <TabPanel value="cloud" sx={{ px: 0, pt: 2 }}>
          <SecurityCloudTab />
        </TabPanel>
        <TabPanel value="waf" sx={{ px: 0, pt: 2 }}>
          <SecurityWafTab isActive={activeSection === 'waf'} />
        </TabPanel>
        <TabPanel value="active-defense" sx={{ px: 0, pt: 2 }}>
          <ActiveDefenseTab />
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default SecurityDashboard;
