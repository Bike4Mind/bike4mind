import React from 'react';
import { Box, Chip, Tooltip, Typography } from '@mui/joy';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useAdminTools } from '@client/app/hooks/useAdminTools';

// Re-export command suggestions from common location
export { SlashCommandSuggestions, AdminCommandSuggestions } from '@client/app/components/common/CommandSuggestions';

interface AdminToolIndicatorProps {
  compact?: boolean;
  showHelp?: boolean;
}

export const AdminToolIndicator: React.FC<AdminToolIndicatorProps> = ({ compact = false, showHelp = false }) => {
  const { canUseAdminTools } = useAdminTools();

  if (!canUseAdminTools) {
    return null;
  }

  if (compact) {
    return (
      <Tooltip
        title={
          <Box>
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Admin Tools Available
            </Typography>
            <Typography level="body-xs">Type /admin or use natural language to manage modals and more</Typography>
          </Box>
        }
        placement="top"
      >
        <AdminPanelSettingsIcon
          sx={{
            fontSize: 20,
            color: 'warning.500',
            cursor: 'help',
          }}
        />
      </Tooltip>
    );
  }

  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
      <Chip size="sm" variant="soft" color="warning" startDecorator={<AdminPanelSettingsIcon />}>
        Admin Mode
      </Chip>

      {showHelp && (
        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
          Try: &quot;Create a modal for...&quot; or &quot;/admin help&quot;
        </Typography>
      )}
    </Box>
  );
};

interface AdminToolStatusProps {
  isExecuting?: boolean;
  lastResult?: any;
}

export const AdminToolStatus: React.FC<AdminToolStatusProps> = ({ isExecuting, lastResult }) => {
  if (isExecuting) {
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <AutoAwesomeIcon
          sx={{
            fontSize: 16,
            color: 'primary.500',
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
        <Typography level="body-xs" sx={{ color: 'primary.500' }}>
          Executing admin command...
        </Typography>
      </Box>
    );
  }

  if (lastResult?.success) {
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <AutoAwesomeIcon sx={{ fontSize: 16, color: 'success.500' }} />
        <Typography level="body-xs" sx={{ color: 'success.500' }}>
          Admin command completed
        </Typography>
      </Box>
    );
  }

  if (lastResult?.error) {
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Typography level="body-xs" sx={{ color: 'danger.500' }}>
          {lastResult.error}
        </Typography>
      </Box>
    );
  }

  return null;
};
