import { FC, useState } from 'react';
import { FormControl, FormHelperText, FormLabel, Option, Select, Stack, Typography } from '@mui/joy';
import {
  ACCOUNT_SEGMENTS,
  DEFAULT_ACCOUNT_SEGMENT,
  type AccountSegment,
  type IOrganizationDocument,
  type WithId,
} from '@bike4mind/common';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { setOrganizationAccountSegment } from '@client/app/utils/organizationAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { ActionDialog, ADMIN_REASON_PRESETS, SettingsSection } from './shared';

const SEGMENT_LABELS: Record<AccountSegment, string> = {
  internal: 'Internal',
  partner: 'Partner',
  customer: 'Customer',
};

/**
 * Platform-admin card to tag an org as internal, partner or customer. Spend explorer splits AI cost
 * by it. A change goes through a reason dialog, like every other admin write.
 */
const OrganizationSegmentCard: FC<{ org: WithId<IOrganizationDocument> }> = ({ org }) => {
  const queryClient = useQueryClient();
  // The admin org profile passes a snapshot that does not refresh after a save, so the saved value is
  // held locally (see OrganizationGroupTypesCard for the same reasoning).
  const orgKey = `${org.id}|${org.accountSegment ?? ''}`;
  const [syncedOrgKey, setSyncedOrgKey] = useState(orgKey);
  const [saved, setSaved] = useState<AccountSegment>(org.accountSegment ?? DEFAULT_ACCOUNT_SEGMENT);
  const [pending, setPending] = useState<AccountSegment | null>(null);
  if (orgKey !== syncedOrgKey) {
    setSyncedOrgKey(orgKey);
    setSaved(org.accountSegment ?? DEFAULT_ACCOUNT_SEGMENT);
  }

  const saveMutation = useMutation({
    mutationFn: ({ accountSegment, reason }: { accountSegment: AccountSegment; reason: string }) =>
      setOrganizationAccountSegment(org.id, accountSegment, reason),
    onSuccess: (_result, { accountSegment }) => {
      setSaved(accountSegment);
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success(`Account segment set to ${SEGMENT_LABELS[accountSegment].toLowerCase()}`);
    },
    onError: error => toast.error(getErrorMessage(error)),
  });

  return (
    <SettingsSection data-testid="org-segment-card">
      <Stack spacing={1}>
        <Typography level="title-md">Account segment</Typography>
        <FormControl>
          <FormLabel>Account segment</FormLabel>
          <Select
            size="sm"
            value={saved}
            onChange={(_event, value) => {
              if (value && value !== saved) setPending(value);
            }}
            slotProps={{ button: { 'data-testid': 'org-segment-select' } }}
          >
            {ACCOUNT_SEGMENTS.map(segment => (
              <Option key={segment} value={segment} data-testid={`org-segment-option-${segment}`}>
                {SEGMENT_LABELS[segment]}
              </Option>
            ))}
          </Select>
          <FormHelperText>
            Splits this organization&apos;s AI cost in Spend explorer. Absent reads as customer.
          </FormHelperText>
        </FormControl>
      </Stack>
      <ActionDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={`Set ${org.name} to ${pending ? SEGMENT_LABELS[pending].toLowerCase() : ''}`}
        description="Only the Spend explorer grouping changes. Nothing about the organization's access does."
        reasonPresets={ADMIN_REASON_PRESETS.orgSegment}
        confirmLabel="Set segment"
        pending={saveMutation.isPending}
        onConfirm={async reason => {
          if (!pending) return;
          await saveMutation.mutateAsync({ accountSegment: pending, reason });
        }}
        data-testid="org-segment-action-dialog"
      />
    </SettingsSection>
  );
};

export default OrganizationSegmentCard;
