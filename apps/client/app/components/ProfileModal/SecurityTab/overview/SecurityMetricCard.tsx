import React from 'react';
import { Box, Sheet, Typography, useTheme } from '@mui/joy';

export interface SecurityMetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  status: 'good' | 'high' | 'critical';
  description?: string;
  isLoading?: boolean;
  onTabSelect?: () => void;
  'data-testid'?: string;
}

const SecurityMetricCard: React.FC<SecurityMetricCardProps> = ({
  icon,
  label,
  value,
  status,
  description,
  isLoading = false,
  onTabSelect,
  'data-testid': testId,
}) => {
  const theme = useTheme();

  return (
    <Sheet
      variant="outlined"
      data-testid={testId}
      onClick={onTabSelect}
      role={onTabSelect ? 'button' : undefined}
      tabIndex={onTabSelect ? 0 : undefined}
      onKeyDown={
        onTabSelect
          ? (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onTabSelect();
              }
            }
          : undefined
      }
      sx={{
        borderRadius: 'md',
        p: 2,
        cursor: onTabSelect ? 'pointer' : 'default',
        transition: 'opacity 0.15s',
        '&:hover': onTabSelect ? { opacity: 0.85 } : {},
        '&:focus-visible': onTabSelect
          ? { outline: `2px solid ${theme.palette.primary.solidBg}`, outlineOffset: 2 }
          : {},
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Box sx={{ color: theme.palette.text.secondary, display: 'flex' }}>{icon}</Box>
        <Typography level="title-sm" sx={{ color: theme.palette.text.secondary }}>
          {label}
        </Typography>
      </Box>
      <Typography
        level="h3"
        data-testid={testId ? `${testId}-value` : undefined}
        sx={{ mb: 0.5, color: theme.palette.security[status].plainColor }}
      >
        {isLoading ? '—' : value}
      </Typography>
      {description && (
        <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
          {description}
        </Typography>
      )}
    </Sheet>
  );
};

export default SecurityMetricCard;
