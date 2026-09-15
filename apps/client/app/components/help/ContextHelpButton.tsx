import React from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';

interface ContextHelpButtonProps {
  /** The help article slug to open (e.g., "features/knowledge-management") */
  helpId: string;
  /** Optional anchor within the article (e.g., "search-capabilities") */
  anchor?: string;
  /** Tooltip text shown on hover */
  tooltipText?: string;
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Button variant */
  variant?: 'plain' | 'outlined' | 'soft' | 'solid';
  /** Button color */
  color?: 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
  /** Additional className */
  className?: string;
  /** Extra styles merged into the IconButton (e.g. custom color/hover) */
  sx?: SxProps;
  /** Data test ID for testing */
  'data-testid'?: string;
}

/**
 * Context-sensitive help button that opens the help panel to a specific article
 *
 * Usage:
 * ```tsx
 * <ContextHelpButton
 *   helpId="features/knowledge-management"
 *   anchor="search-capabilities"
 *   tooltipText="Learn about search"
 * />
 * ```
 */
const ContextHelpButton: React.FC<ContextHelpButtonProps> = ({
  helpId,
  anchor,
  tooltipText = 'Help',
  size = 'sm',
  variant = 'plain',
  color = 'neutral',
  className,
  sx,
  'data-testid': dataTestId,
}) => {
  const handleClick = () => {
    openHelpPanel(helpId, anchor);
  };

  return (
    <Tooltip title={tooltipText} placement="top">
      <IconButton
        size={size}
        variant={variant}
        color={color}
        onClick={handleClick}
        className={className}
        data-testid={dataTestId || `help-button-${helpId.replace(/\//g, '-')}`}
        sx={{
          '--IconButton-size': size === 'sm' ? '28px' : size === 'md' ? '36px' : '44px',
          ...sx,
        }}
      >
        <HelpOutlineIcon sx={{ fontSize: size === 'sm' ? 16 : size === 'md' ? 20 : 24 }} />
      </IconButton>
    </Tooltip>
  );
};

export default ContextHelpButton;
