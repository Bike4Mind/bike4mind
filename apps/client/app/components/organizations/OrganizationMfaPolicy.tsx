import { useState } from 'react';
import { isOrgOwnerOrCurrentAdmin, type IOrganizationDocument } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Checkbox, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';

export default function OrganizationMfaPolicy({ organization }: { organization: IOrganizationDocument }) {
  const { currentUser } = useUser();
  const canManage = !!currentUser && !organization.personal && isOrgOwnerOrCurrentAdmin(currentUser, organization);
  const queryClient = useQueryClient();
  const [required, setRequired] = useState(organization.mfaPolicy?.required ?? false);
  const [graceDays, setGraceDays] = useState('7');
  const url = `/api/organizations/${organization.id}/mfa-policy`;
  const status = useQuery({
    queryKey: ['organizations', organization.id, 'mfa-policy'],
    enabled: canManage,
    queryFn: async () => (await api.get<{ members: { id: string; name: string; mfaEnabled: boolean }[] }>(url)).data,
  });
  const save = useMutation({
    mutationFn: () => api.put(url, { required, graceDays: Number(graceDays) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('MFA policy saved');
    },
    onError: () => toast.error('Could not save MFA policy'),
  });
  if (!canManage) return null;
  const validGrace = /^\d+$/.test(graceDays) && Number(graceDays) <= 30;

  return (
    <Card variant="outlined" data-testid="organization-mfa-policy">
      <Stack spacing={2}>
        <Typography level="title-sm">Member MFA</Typography>
        <Typography level="body-sm">
          After the grace deadline, members without MFA must set it up at their next login. Existing sessions are not
          interrupted. This is not a per-resource access restriction.
        </Typography>
        <Checkbox
          label="Require MFA"
          checked={required}
          onChange={event => setRequired(event.target.checked)}
          slotProps={{ input: { 'data-testid': 'organization-mfa-required' } }}
        />
        <FormControl>
          <FormLabel>Grace period from saving (0-30 days)</FormLabel>
          <Input
            type="number"
            value={graceDays}
            onChange={event => setGraceDays(event.target.value)}
            disabled={!required}
            slotProps={{ input: { min: 0, max: 30, 'data-testid': 'organization-mfa-grace-days' } }}
          />
        </FormControl>
        {organization.mfaPolicy?.required && organization.mfaPolicy.graceEndsAt && (
          <Typography level="body-sm" data-testid="organization-mfa-deadline">
            Current grace deadline: {new Date(organization.mfaPolicy.graceEndsAt).toLocaleString()}
          </Typography>
        )}
        <Button
          data-testid="organization-mfa-save"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={required && !validGrace}
        >
          Save MFA policy
        </Button>
        {status.isError && <Typography color="danger">Could not load member MFA status.</Typography>}
        {status.data?.members.map(member => (
          <Typography key={member.id} level="body-sm" data-testid={`organization-mfa-member-${member.id}`}>
            {member.name}: {member.mfaEnabled ? 'MFA enabled' : 'MFA not enabled'}
          </Typography>
        ))}
      </Stack>
    </Card>
  );
}
