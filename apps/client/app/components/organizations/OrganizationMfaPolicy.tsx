import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Input, Stack, Typography } from '@mui/joy';
import { canAdministerOrganization, type IOrganizationDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { toast } from 'sonner';
import { Link } from '@tanstack/react-router';

export function useOrganizationMfaPolicy(id: string) {
  return useQuery({
    queryKey: ['organizations', id, 'mfa-policy'],
    queryFn: async () =>
      (
        await api.get<{
          policy: NonNullable<IOrganizationDocument['mfaPolicy']>;
          members: { userId: string; enrolled: boolean }[];
        }>(`/api/organizations/${id}/mfa-policy`)
      ).data,
  });
}

export default function OrganizationMfaPolicy({ organization }: { organization: IOrganizationDocument }) {
  const { currentUser } = useUser();
  const query = useOrganizationMfaPolicy(organization.id);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ required: boolean; graceDays: string } | null>(null);
  const required = draft?.required ?? query.data?.policy.required ?? false;
  const graceDays = draft?.graceDays ?? String(query.data?.policy.graceDays ?? 7);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/organizations/${organization.id}/mfa-policy`, { required, graceDays: Number(graceDays) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organizations', organization.id] });
      toast.success('MFA policy saved');
    },
    onError: () => toast.error('Could not save MFA policy'),
  });
  const canManage = !!currentUser && canAdministerOrganization(currentUser, organization);
  const validGrace = /^\d+$/.test(graceDays) && Number(graceDays) <= 30;
  return (
    <Card variant="outlined" data-testid="organization-mfa-policy-card">
      <Typography level="title-md">Multi-factor authentication</Typography>
      {query.isError && <Alert color="danger">Could not load MFA policy.</Alert>}
      <Stack spacing={2}>
        {query.data?.policy.required &&
          !query.data.members.find(member => member.userId === currentUser?.id)?.enrolled && (
            <Alert color="warning" data-testid="organization-mfa-enrollment-alert">
              Enroll in MFA before the organization deadline.{' '}
              <Link to="/profile" search={{ tab: 'security' }}>
                Open account security
              </Link>
            </Alert>
          )}
        <Checkbox
          label="Require MFA for organization access"
          checked={required}
          disabled={!canManage || !query.data}
          onChange={event => setDraft({ required: event.target.checked, graceDays })}
          data-testid="organization-mfa-required-checkbox"
        />
        <Input
          type="number"
          value={graceDays}
          disabled={!canManage || !query.data}
          onChange={event => setDraft({ required, graceDays: event.target.value })}
          slotProps={{
            input: {
              min: 0,
              max: 30,
              'aria-label': 'MFA grace period in days',
              'data-testid': 'organization-mfa-grace-input',
            },
          }}
        />
        <Typography level="body-sm">
          Grace period: 0-30 days. After the deadline, members must enroll before accessing this organization. Personal
          resources remain available.
        </Typography>
        {query.data?.policy.required && (
          <Typography level="body-sm">
            MFA required from{' '}
            {query.data.policy.enforceAfter ? new Date(query.data.policy.enforceAfter).toLocaleString() : 'now'}.
          </Typography>
        )}
        {canManage && (
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!query.data || !validGrace}
            data-testid="organization-mfa-save-btn"
          >
            Save MFA policy
          </Button>
        )}
      </Stack>
    </Card>
  );
}
