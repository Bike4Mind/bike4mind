import {
  Alert,
  Button,
  CircularProgress,
  FormControl,
  FormLabel,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import { FC, useEffect, useState } from 'react';
import { isOrgMember, organizationMemberRole } from '@bike4mind/common';
import {
  MemberOffboardingInventory,
  useGetOrganization,
  useMemberOffboardingInventory,
  useRemoveMemberFromOrganization,
} from '@client/app/hooks/data/organizations';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import { getErrorMessage } from '@client/app/utils/error';

interface OffboardMemberDialogProps {
  organizationId: string;
  /** The member being removed; null keeps the dialog closed. */
  member: { id: string; name: string } | null;
  onClose: () => void;
}

const CONTENT_ROWS: { key: Exclude<keyof MemberOffboardingInventory, 'orgBilledApiKeys'>; label: string }[] = [
  { key: 'files', label: 'Files' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'projects', label: 'Projects' },
  { key: 'notebooks', label: 'Notebooks' },
  { key: 'agents', label: 'Agents' },
];

type Disposition = 'keep' | 'transfer';

/** Replaces the plain "remove member?" confirm: shows what the member owns in this org and lets the admin hand it on. */
const OffboardMemberDialog: FC<OffboardMemberDialogProps> = ({ organizationId, member, onClose }) => {
  const [disposition, setDisposition] = useState<Disposition>('keep');
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const organizationQuery = useGetOrganization(member ? organizationId : null);
  const organization = organizationQuery.data;
  const currentMember = !!member && !!organization && organizationMemberRole(organization, member.id) !== null;
  const inventory = useMemberOffboardingInventory(organizationId, member?.id ?? null, { enabled: currentMember });
  const { data: members = [] } = useGetOrganizationUsers(member ? organizationId : null);
  const inventoryError = organizationQuery.error ?? inventory.error;
  const removeMember = useRemoveMemberFromOrganization();

  useEffect(() => {
    setDisposition('keep');
    setReassignTo(null);
  }, [member?.id]);

  if (!member) return null;

  // Same rule the transfer enforces server-side: only roster rows that confer membership qualify.
  const candidates = organization
    ? members.filter(candidate => candidate.id !== member.id && isOrgMember({ id: candidate.id }, organization))
    : [];
  const contentCount = inventory.data ? CONTENT_ROWS.reduce((sum, row) => sum + inventory.data[row.key].count, 0) : 0;
  const keyCount = inventory.data?.orgBilledApiKeys.count ?? 0;
  const transferring = disposition === 'transfer' && contentCount > 0;
  const canConfirm = currentMember && !!inventory.data && !removeMember.isPending && (!transferring || !!reassignTo);

  const handleClose = () => {
    if (!removeMember.isPending) onClose();
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    try {
      await removeMember.mutateAsync({
        organizationId,
        userId: member.id,
        ...(transferring && reassignTo ? { reassignTo } : {}),
      });
      onClose();
    } catch {
      // The mutation's onError already toasts; the dialog stays open so the admin can retry.
    }
  };

  return (
    <Modal open onClose={handleClose}>
      <ModalDialog sx={{ maxWidth: 520, width: '100%' }} data-testid="offboard-dialog">
        <ModalClose disabled={removeMember.isPending} aria-label="Close removal dialog" />
        <Typography level="title-lg">Remove {member.name}</Typography>
        <Typography level="body-sm">
          {member.name} loses access to this team. Their org-billed API keys
          {keyCount > 0 ? ` (${keyCount})` : ''} are revoked.
        </Typography>

        {(organizationQuery.isLoading || inventory.isLoading) && (
          <CircularProgress size="sm" data-testid="offboard-dialog-loading" />
        )}
        {inventoryError && (
          <Alert color="danger" data-testid="offboard-dialog-error">
            Could not load this member&apos;s content: {getErrorMessage(inventoryError)}
            <Button
              size="sm"
              variant="outlined"
              disabled={organizationQuery.isFetching || inventory.isFetching || removeMember.isPending}
              onClick={() => void (organizationQuery.error ? organizationQuery.refetch() : inventory.refetch())}
            >
              Retry
            </Button>
          </Alert>
        )}

        {inventory.data && contentCount === 0 && (
          <Typography level="body-sm" data-testid="offboard-dialog-empty">
            {member.name} owns no content in this team.
          </Typography>
        )}

        {inventory.data && contentCount > 0 && (
          <Stack spacing={1.5}>
            <Stack spacing={0.5} data-testid="offboard-dialog-inventory">
              {CONTENT_ROWS.filter(row => inventory.data[row.key].count > 0).map(row => {
                const entry = inventory.data[row.key];
                const names = entry.sample.map(item => item.name).join(', ');
                return (
                  <Typography key={row.key} level="body-sm" data-testid={`offboard-dialog-count-${row.key}`}>
                    <strong>
                      {row.label}: {entry.count}
                    </strong>
                    {names ? ` - ${names}${entry.count > entry.sample.length ? ', ...' : ''}` : ''}
                  </Typography>
                );
              })}
            </Stack>

            <FormControl>
              <FormLabel>Their team content</FormLabel>
              <RadioGroup
                value={disposition}
                onChange={event => setDisposition(event.target.value as Disposition)}
                data-testid="offboard-dialog-disposition"
              >
                <Radio
                  disabled={removeMember.isPending}
                  value="keep"
                  label={`Keep with ${member.name}`}
                  data-testid="offboard-dialog-keep-radio"
                />
                <Radio
                  disabled={removeMember.isPending}
                  value="transfer"
                  label="Transfer to another member"
                  data-testid="offboard-dialog-transfer-radio"
                />
              </RadioGroup>
            </FormControl>

            {transferring && (
              <Select
                placeholder="Choose a member"
                disabled={removeMember.isPending}
                slotProps={{ button: { 'aria-label': 'Transfer team content to' } }}
                value={reassignTo}
                onChange={(_event, value) => setReassignTo(value)}
                data-testid="offboard-dialog-target-select"
              >
                {candidates.map(candidate => (
                  <Option
                    key={candidate.id}
                    value={candidate.id}
                    data-testid={`offboard-dialog-target-${candidate.id}`}
                  >
                    {candidate.name}
                  </Option>
                ))}
              </Select>
            )}
          </Stack>
        )}

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            variant="outlined"
            color="neutral"
            disabled={removeMember.isPending}
            onClick={handleClose}
            data-testid="offboard-dialog-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            color="danger"
            onClick={handleConfirm}
            disabled={!canConfirm}
            loading={removeMember.isPending}
            data-testid="offboard-dialog-confirm-btn"
          >
            Remove member
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default OffboardMemberDialog;
