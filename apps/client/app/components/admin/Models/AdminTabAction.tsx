import type { ReactElement } from 'react';
import { Tooltip } from '@mui/joy';
import { useUser } from '@client/app/contexts/UserContext';
import { AdminTab } from '../adminSidebarConfig';
import { canOpenAdminTab } from '../adminTabPermissions';

export const TAB_NOT_OPEN_MESSAGE = 'Only full administrators can open this page';

/** Wraps a link from Models into another admin tab: disabled, with the reason, when the signed-in admin cannot open it. */
export function AdminTabAction({ tab, children }: { tab: AdminTab; children: (disabled: boolean) => ReactElement }) {
  const { currentUser } = useUser();
  if (canOpenAdminTab(currentUser, tab)) return children(false);
  return (
    <Tooltip title={TAB_NOT_OPEN_MESSAGE}>
      <span tabIndex={0} data-testid="models-tab-blocked-action">
        {children(true)}
      </span>
    </Tooltip>
  );
}
