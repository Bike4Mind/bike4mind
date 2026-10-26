import { hasAdminPermission, type AdminPermissionId } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { Box, Typography } from '@mui/joy';
import type { PropsWithChildren } from 'react';

export const AdminPermissionBoundary = ({
  permission,
  children,
}: PropsWithChildren<{ permission: AdminPermissionId }>) => {
  const allowed = useUser(state => hasAdminPermission(state.currentUser, permission));
  return (
    <Box component="fieldset" disabled={!allowed} sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
      {!allowed && (
        <Typography level="body-sm" color="warning">
          Missing permission: {permission}
        </Typography>
      )}
      {children}
    </Box>
  );
};
