import { ORG_ALERT_KINDS, type OrgAlertKind } from '@bike4mind/common';
import { useMyOrgNotificationPrefs, useUpdateMyOrgNotificationPrefs } from '@client/app/hooks/data/organizations';
import { Card, Stack, Switch, Typography } from '@mui/joy';
import { FC } from 'react';

const KIND_LABELS: Record<OrgAlertKind, string> = {
  budget_threshold: 'Budget threshold reached',
  low_balance: 'Low credit balance',
  member_cap: 'A member reached their monthly credit limit',
  payment_failed: 'Payment failed',
  seat_limit: 'All seats are in use',
  member_joined: 'A new member joined',
};

/** The viewer's own org alert opt-ins. Render only for the owner or a current manager. */
const MyOrgNotificationPrefsCard: FC<{ organizationId: string }> = ({ organizationId }) => {
  const { data: prefs } = useMyOrgNotificationPrefs(organizationId);
  const updatePrefs = useUpdateMyOrgNotificationPrefs();

  if (!prefs) return null;

  return (
    <Card variant="outlined" sx={{ mx: { xs: 0, sm: '20px' } }} data-testid="org-alert-prefs-card">
      <Stack spacing={1.5} p={2}>
        <Stack spacing={0.5}>
          <Typography level="title-sm">My alert notifications</Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            {prefs.role === 'owner'
              ? 'As the owner you get every alert by email and in your Inbox unless you turn it off.'
              : 'Managers get no alerts until they turn them on. Alerts arrive by email and in your Inbox.'}
          </Typography>
        </Stack>
        {ORG_ALERT_KINDS.map(kind => (
          <Stack key={kind} direction="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Typography level="body-sm">{KIND_LABELS[kind]}</Typography>
            <Switch
              checked={prefs.kinds[kind]}
              disabled={updatePrefs.isPending}
              onChange={e => updatePrefs.mutate({ organizationId, kinds: { [kind]: e.target.checked } })}
              slotProps={{ input: { 'aria-label': KIND_LABELS[kind], 'data-testid': `org-alert-pref-${kind}-switch` } }}
            />
          </Stack>
        ))}
      </Stack>
    </Card>
  );
};

export default MyOrgNotificationPrefsCard;
