import { IOrganizationDocument } from '@bike4mind/common';
import { useSetMemberCreditDefault } from '@client/app/hooks/data/organizations';
import { Button, Card, Stack, Typography } from '@mui/joy';
import { FC, useState } from 'react';
import CreditLimitModal from './CreditLimitModal';
import { formatMemberCreditReset, formatMemberCredits } from './memberCreditBudget';

interface MemberCreditBudgetCardProps {
  organization: IOrganizationDocument;
  /** Viewer may edit budgets (`canManageMemberCreditBudgets`); others only see the limit in force. */
  canManage: boolean;
}

/** The org's default monthly credit limit per member, on the Members tab. */
const MemberCreditBudgetCard: FC<MemberCreditBudgetCardProps> = ({ organization, canManage }) => {
  const [editing, setEditing] = useState(false);
  const setDefault = useSetMemberCreditDefault();
  const cap = organization.maxCreditsPerMember ?? null;

  // Nothing to tell a member who cannot change it when no limit is set.
  if (cap == null && !canManage) return null;

  return (
    <Card variant="outlined" sx={{ mx: { xs: 0, sm: '20px' } }} data-testid="member-credit-budget-card">
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2} flexWrap="wrap" p={2}>
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography level="title-sm">Monthly credit limit per member</Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }} data-testid="member-credit-budget-summary">
            {cap == null
              ? 'No limit. Members can spend from the organization pool without a monthly cap.'
              : `Each member can spend up to ${formatMemberCredits(cap)} credits per month. Usage resets on ${formatMemberCreditReset()} (UTC).`}
          </Typography>
        </Stack>
        {canManage && (
          <Button
            size="sm"
            variant="outlined"
            onClick={() => setEditing(true)}
            data-testid="member-credit-budget-edit-btn"
          >
            {cap == null ? 'Set limit' : 'Change limit'}
          </Button>
        )}
      </Stack>
      <CreditLimitModal
        open={editing}
        onClose={() => setEditing(false)}
        title="Monthly credit limit per member"
        description="Applies to every member without their own limit. Usage resets on the 1st of each month (UTC)."
        currentValue={cap}
        allowZero={false}
        clearLabel="Remove limit"
        saving={setDefault.isPending}
        onSave={maxCreditsPerMember => setDefault.mutateAsync({ organizationId: organization.id, maxCreditsPerMember })}
      />
    </Card>
  );
};

export default MemberCreditBudgetCard;
