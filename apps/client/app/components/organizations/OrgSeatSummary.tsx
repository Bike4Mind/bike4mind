import { useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { Card, Chip, LinearProgress, Stack, Typography } from '@mui/joy';
import { FC } from 'react';

/**
 * The team's one seat summary (used / total / pending). Seats are counted by useOrganizationSeats,
 * which also drives the Add Member gate, so the two never disagree.
 */
const OrgSeatSummary: FC<{ organizationId: string }> = ({ organizationId }) => {
  const { maxSeats, currentSeats, pendingSeats, availableSeats } = useOrganizationSeats(organizationId);
  const usage = maxSeats > 0 ? Math.min(100, (currentSeats / maxSeats) * 100) : 0;
  const color = usage >= 90 ? 'danger' : usage >= 75 ? 'warning' : 'success';
  const activeSeats = currentSeats - pendingSeats;

  return (
    <Card variant="outlined" data-testid="organization-members-seats-card" sx={{ mx: { xs: 0, sm: '20px' }, gap: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography level="title-sm">Seats</Typography>
        {maxSeats === 0 ? (
          <Chip size="sm" color="danger" variant="soft" data-testid="organization-members-no-plan-chip">
            No Active Plan
          </Chip>
        ) : (
          <Chip size="sm" color={color} variant="soft" data-testid="organization-members-seats-available">
            {availableSeats} available
          </Chip>
        )}
      </Stack>
      <Typography level="body-sm" data-testid="organization-members-seats-count">
        {currentSeats} of {maxSeats || '∞'} seats used
      </Typography>
      {maxSeats > 0 && (
        <LinearProgress
          determinate
          value={usage}
          color={color}
          aria-label={`${currentSeats} of ${maxSeats} seats used`}
          sx={{ '--LinearProgress-thickness': '6px' }}
        />
      )}
      <Typography level="body-xs" color="neutral" data-testid="organization-members-seats-breakdown">
        {activeSeats} {activeSeats === 1 ? 'member' : 'members'}, {pendingSeats} pending{' '}
        {pendingSeats === 1 ? 'invitation' : 'invitations'}
      </Typography>
    </Card>
  );
};

export default OrgSeatSummary;
