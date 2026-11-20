import React from 'react';
import { Button, Stack } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { AdminPageHeader } from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';
import { SystemPromptsManager } from './SystemPromptsManager';
import SystemPromptEditor from './SystemPromptEditor';

const SystemPromptsTab: React.FC = () => {
  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-system-prompts-tab">
      <SystemPromptEditor
        renderHeader={({ count, refreshing, onRefresh, onCreate }) => (
          <AdminPageHeader
            title="System prompts"
            count={count}
            description="The prompts AI features run on. Override one to change it live, with version history."
            actions={
              <>
                <ContextHelpButton helpId="admin/system-prompts" tooltipText="System prompts help" />
                <Button
                  variant="outlined"
                  size="sm"
                  startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
                  loading={refreshing}
                  onClick={onRefresh}
                  data-testid="system-prompts-refresh-btn"
                  sx={adminFocus}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
                  onClick={onCreate}
                  data-testid="system-prompts-new-btn"
                  sx={adminFocus}
                >
                  New prompt
                </Button>
              </>
            }
          />
        )}
      />
      <SystemPromptsManager />
    </Stack>
  );
};

export default SystemPromptsTab;
