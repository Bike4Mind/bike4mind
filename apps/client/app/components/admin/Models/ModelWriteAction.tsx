import type { ReactElement } from 'react';
import { Tooltip } from '@mui/joy';
import { isFullAdmin } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useMissingAdminPermission } from '../shared';

export const FULL_ADMIN_ONLY_MESSAGE = 'Only full administrators can manage models';

/**
 * Why the signed-in admin cannot make model writes, or null. Every write in this area needs `settings:manage` and a
 * full admin, because adminApi admits a delegate holding the permission.
 */
export function useModelWriteBlock(): string | null {
  const { currentUser } = useUser();
  const missing = useMissingAdminPermission('settings:manage');
  if (missing) return missing;
  return isFullAdmin(currentUser) ? null : FULL_ADMIN_ONLY_MESSAGE;
}

/** Wraps a model write control: disabled, with the reason on hover and focus, for an admin who cannot make it. */
export function ModelWriteAction({ children }: { children: (disabled: boolean) => ReactElement }) {
  const blocked = useModelWriteBlock();
  if (!blocked) return children(false);
  return (
    <Tooltip title={blocked}>
      {/* A disabled button fires no pointer events, so the tooltip needs a focusable wrapper; in a table row its
          click must not open the row. */}
      <span tabIndex={0} onClick={event => event.stopPropagation()} data-testid="models-write-blocked-action">
        {children(true)}
      </span>
    </Tooltip>
  );
}
