import React from 'react';
import { Box, Sheet, Typography, useTheme } from '@mui/joy';

export interface SecurityStatusCardProps {
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  passedChecks: number;
  totalChecks: number;
  lastDetection: Date | null;
  isLoading: boolean;
}

interface BadgeColors {
  gradient: string;
  shadow: string;
  textShadow: string;
}

export const getUserBadgeColors = (
  riskScore: number,
  riskLevel: 'low' | 'medium' | 'high',
  palette: ReturnType<typeof useTheme>['palette']
): BadgeColors => {
  if (riskLevel === 'high') {
    return {
      gradient: `linear-gradient(135deg, ${palette.security.critical.gradientStart}, ${palette.security.critical.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.critical.shadow}`,
      textShadow: 'none',
    };
  }
  if (riskLevel === 'medium' || riskScore < 50) {
    return {
      gradient: `linear-gradient(135deg, ${palette.security.high.gradientStart}, ${palette.security.high.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.high.shadow}`,
      textShadow: 'none',
    };
  }
  if (riskScore < 70) {
    return {
      gradient: `linear-gradient(135deg, ${palette.security.moderate.gradientStart}, ${palette.security.moderate.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.moderate.shadow}`,
      textShadow: 'none',
    };
  }
  if (riskScore < 85) {
    return {
      gradient: `linear-gradient(135deg, ${palette.security.good.gradientStart}, ${palette.security.good.gradientEnd})`,
      shadow: `0 8px 24px ${palette.security.good.shadow}`,
      textShadow: 'none',
    };
  }
  return {
    gradient: `linear-gradient(135deg, ${palette.security.excellent.gradientStart}, ${palette.security.excellent.gradientEnd})`,
    shadow: `0 8px 24px ${palette.security.excellent.shadow}`,
    textShadow: 'none',
  };
};

export const getUserStatusLabel = (riskScore: number, riskLevel: 'low' | 'medium' | 'high'): string => {
  if (riskLevel === 'high') return 'High Risk';
  if (riskLevel === 'medium') return 'Moderate Risk';
  if (riskScore >= 85) return 'Excellent';
  if (riskScore >= 70) return 'Good';
  return 'At Risk';
};

const SecurityStatusCard: React.FC<SecurityStatusCardProps> = ({
  riskScore,
  riskLevel,
  passedChecks,
  totalChecks,
  lastDetection,
  isLoading,
}) => {
  const theme = useTheme();
  const badgeColors = isLoading
    ? {
        gradient: `linear-gradient(135deg, ${theme.palette.security.neutral.gradientStart}, ${theme.palette.security.neutral.gradientEnd})`,
        shadow: `0 8px 24px ${theme.palette.security.neutral.shadow}`,
        textShadow: 'none',
      }
    : getUserBadgeColors(riskScore, riskLevel, theme.palette);

  const statusLabel = isLoading ? 'Loading…' : getUserStatusLabel(riskScore, riskLevel);
  const allPassed = passedChecks === totalChecks;

  const lastDetectionText = lastDetection
    ? lastDetection.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'medium' }) + ' UTC'
    : 'No events';

  return (
    <Sheet
      variant="outlined"
      data-testid="security-status-card"
      sx={{
        borderRadius: 'lg',
        p: 3,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        minWidth: 220,
      }}
    >
      {/* Score circle */}
      <Box
        data-testid="security-status-card-score"
        sx={{
          width: 148,
          height: 148,
          borderRadius: '50%',
          background: badgeColors.gradient,
          boxShadow: badgeColors.shadow,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
        }}
      >
        <Typography
          level="h3"
          sx={{ color: 'white', textShadow: badgeColors.textShadow, lineHeight: 1.2, textAlign: 'center', px: 1 }}
        >
          {isLoading ? '…' : statusLabel}
        </Typography>
      </Box>

      <Typography level="body-sm" sx={{ color: theme.palette.text.secondary }}>
        Security Status
      </Typography>

      {/* Stats below circle */}
      <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
          <Typography level="body-xs" sx={{ color: theme.palette.text.secondary }}>
            Last detection
          </Typography>
          <Typography
            level="body-xs"
            data-testid="security-status-card-last-detection"
            sx={{ color: theme.palette.text.primary, fontWeight: 'md', flexShrink: 0 }}
          >
            {isLoading ? '…' : lastDetectionText}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
          <Typography level="body-xs" sx={{ color: theme.palette.text.secondary }}>
            Security Checks
          </Typography>
          <Typography
            level="body-xs"
            data-testid="security-status-card-checks"
            sx={{
              color: allPassed ? theme.palette.security.good.plainColor : theme.palette.security.high.plainColor,
              fontWeight: 'md',
              flexShrink: 0,
            }}
          >
            {isLoading ? '…' : `${passedChecks}/${totalChecks} Passed`}
          </Typography>
        </Box>
      </Box>
    </Sheet>
  );
};

export default SecurityStatusCard;
