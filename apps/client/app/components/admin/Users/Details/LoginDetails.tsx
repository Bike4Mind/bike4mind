import { IUserDocument, WithOrgRef } from '@bike4mind/common';
import { Card, Stack, Typography } from '@mui/joy';
import React from 'react';
import LoginsView from '../LoginsView';
import MigrateAgain from '../MigrateAgain';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface LoginDetailsProps {
  user: WithOrgRef<IUserDocument>;
}

const LoginDetails: React.FC<LoginDetailsProps> = React.memo(({ user }) => {
  const lastLoginRecord = user.loginRecords?.reduce(
    (prev, current) => (prev.loginTime > current.loginTime ? prev : current),
    user.loginRecords[0]
  );

  return (
    <Card variant="outlined" sx={{ p: 1 }}>
      <Stack direction="column" spacing={0.5}>
        <Stack direction="row" spacing={2} display={'flex'} justifyContent={'space-between'}>
          Logins: <LoginsView user={user} />
        </Stack>
        {lastLoginRecord ? (
          <Stack direction="row" spacing={2} display={'flex'} justifyContent={'space-between'}>
            <Typography level="body-xs">Last Login:</Typography>
            <Typography level="body-xs">{new Date(lastLoginRecord.loginTime).toDateString()}</Typography>
          </Stack>
        ) : (
          <MigrateAgain user={user} />
        )}
        {user.lastActiveAt && (
          <Stack direction="row" spacing={2} display={'flex'} justifyContent={'space-between'}>
            <Typography level="body-xs">Last Active:</Typography>
            <Typography level="body-xs">{dayjs(user.lastActiveAt).fromNow()}</Typography>
          </Stack>
        )}
        <Stack direction="row" spacing={2} display={'flex'} justifyContent={'space-between'}>
          <Typography level="body-xs">Updated:</Typography>
          {/* Red when updatedAt equals createdAt (never updated since registration) */}
          <Typography level="body-xs" color={user.createdAt !== user.updatedAt ? 'success' : 'danger'}>
            {user.updatedAt ? new Date(user.updatedAt).toDateString() : 'Unknown'}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={2} display={'flex'} justifyContent={'space-between'}>
          <Typography level="body-xs">Created:</Typography>
          <Typography level="body-xs">
            {user.createdAt ? new Date(user.createdAt).toDateString() : 'Unknown'}
          </Typography>
        </Stack>
      </Stack>
    </Card>
  );
});

LoginDetails.displayName = 'LoginDetails';

export default LoginDetails;
