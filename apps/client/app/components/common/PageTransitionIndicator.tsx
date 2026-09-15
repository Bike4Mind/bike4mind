import React from 'react';
import { LinearProgress } from '@mui/joy';
import { useNavigationLoading } from '../../hooks/useNavigationLoading';

export interface PageTransitionIndicatorProps {
  /** Thickness of the progress bar in pixels */
  thickness?: number;
  /** MUI Joy color palette token for the progress bar */
  color?: 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
  /** MUI Joy variant for the progress bar */
  variant?: 'solid' | 'soft' | 'outlined' | 'plain';
  /** MUI Joy size for the progress bar */
  size?: 'sm' | 'md' | 'lg';
  /** Duration of show/hide animation in milliseconds */
  animationDuration?: number;
  /** CSS z-index for positioning */
  zIndex?: number;
  /** Position of the indicator */
  position?: 'top' | 'bottom';
  /** Custom className for styling */
  className?: string;
  /** Optional test ID for testing */
  'data-testid'?: string;
}

export function PageTransitionIndicator({
  thickness = 2,
  color = 'primary',
  variant = 'soft',
  size = 'sm',
  animationDuration = 300,
  zIndex = 9999,
  position = 'top',
  className,
  'data-testid': testId = 'page-transition-indicator',
}: PageTransitionIndicatorProps) {
  const { isLoading } = useNavigationLoading();

  return (
    <LinearProgress
      data-testid={testId}
      determinate={false}
      size={size}
      variant={variant}
      color={color}
      thickness={thickness}
      className={className}
      aria-label="Page loading"
      aria-valuemin={0}
      aria-valuemax={100}
      sx={{
        position: 'fixed',
        [position]: 0,
        left: 0,
        right: 0,
        zIndex,
        opacity: isLoading ? 1 : 0,
        transform: `scaleX(${isLoading ? 1 : 0})`,
        transformOrigin: 'left',
        transition: `all ${animationDuration}ms ease-in-out`,
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
        },
      }}
    />
  );
}

export default PageTransitionIndicator;
