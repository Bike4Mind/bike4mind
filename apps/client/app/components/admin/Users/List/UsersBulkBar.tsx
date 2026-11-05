import { Box, Button, Divider, Dropdown, ListDivider, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { AdminUsersBulkActionType } from '@client/app/utils/adminUsersBulk';
import { BulkActionBar, type AdminSelection } from '../../shared/BulkActionBar';
import { adminFocus } from '../../shared/adminStyles';
import { AnalyticsTermHelp } from '../../EventMetrics/components/AnalyticsTermHelp';
import { USERS_BULK_ACTIONS, USERS_BULK_ACTION_COPY } from './UsersBulkActionDialog';

const WIDE = { xs: 'none', md: 'inline-flex' } as const;
const NARROW = { xs: 'inline-flex', md: 'none' } as const;

/** What each bulk action does, from the same copy its dialog shows, so the two never drift. */
export function UsersBulkActionsLegend() {
  return (
    <Stack gap={1} sx={{ py: 0.5 }} data-testid="admin-users-bulk-legend">
      <Stack component="dl" gap={0.75} sx={{ m: 0 }}>
        {USERS_BULK_ACTIONS.map(type => (
          <div key={type} data-testid={`admin-users-bulk-legend-${type}`}>
            <Typography component="dt" level="body-xs" fontWeight="lg" textColor="inherit">
              {USERS_BULK_ACTION_COPY[type].label}
            </Typography>
            <Typography component="dd" level="body-xs" textColor="inherit" sx={{ m: 0 }}>
              {USERS_BULK_ACTION_COPY[type].description}
            </Typography>
          </div>
        ))}
      </Stack>
      <Typography level="body-xs" textColor="inherit" sx={{ opacity: 0.8 }}>
        The admin who ran a batch can undo it for 30 seconds from its toast. Undo does not reopen connections or restore
        canceled subscriptions, and unsuspending a user from their profile does not restore revoked keys or removed
        credits.
      </Typography>
    </Stack>
  );
}

/** The selection's count, "select all matching" and the bulk commands, docked under the table. */
export function UsersBulkBar({
  selection,
  totalMatching,
  onSelectAllMatching,
  onClear,
  onAction,
}: {
  selection: AdminSelection;
  totalMatching: number;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onAction: (type: AdminUsersBulkActionType) => void;
}) {
  return (
    // Left-aligned so the global AI Chat pill in the bottom-right corner does not cover it.
    <Box sx={{ position: 'sticky', bottom: 8, zIndex: 2, alignSelf: 'flex-start', maxWidth: '100%' }}>
      <BulkActionBar
        selection={selection}
        totalMatching={totalMatching}
        onSelectAllMatching={onSelectAllMatching}
        onClear={onClear}
      >
        <Divider orientation="vertical" sx={{ mx: 0.5, display: WIDE }} />
        {USERS_BULK_ACTIONS.map(type => {
          const isContain = type === 'contain';
          return (
            <Button
              key={type}
              size="sm"
              variant={isContain ? 'solid' : 'outlined'}
              color={isContain ? 'danger' : 'neutral'}
              data-testid={`admin-users-bulk-${type}-btn`}
              onClick={() => onAction(type)}
              sx={{ ...adminFocus, display: WIDE }}
            >
              {USERS_BULK_ACTION_COPY[type].label}
            </Button>
          );
        })}
        {/* Six buttons wrap under the chat pill on a phone; one menu keeps the bar short. */}
        <Dropdown>
          <MenuButton
            size="sm"
            variant="outlined"
            endDecorator={<ExpandMoreIcon sx={{ fontSize: 16 }} />}
            data-testid="admin-users-bulk-menu-btn"
            sx={{ ...adminFocus, display: NARROW }}
          >
            Actions
          </MenuButton>
          <Menu size="sm" placement="top-start" sx={{ zIndex: 1300 }}>
            {USERS_BULK_ACTIONS.map(type => [
              type === 'contain' && <ListDivider key="divider" />,
              <MenuItem
                key={type}
                color={type === 'contain' ? 'danger' : 'neutral'}
                data-testid={`admin-users-bulk-${type}-menuitem`}
                onClick={() => onAction(type)}
              >
                {USERS_BULK_ACTION_COPY[type].label}
              </MenuItem>,
            ])}
          </Menu>
        </Dropdown>
        <AnalyticsTermHelp
          term="bulk actions"
          testId="admin-users-bulk-help-btn"
          maxWidth={380}
          description={<UsersBulkActionsLegend />}
        />
      </BulkActionBar>
    </Box>
  );
}
