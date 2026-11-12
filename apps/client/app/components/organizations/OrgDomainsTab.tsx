import React, { useState } from 'react';
import type { IOrgDomainClaimView, OrgDomainJoinPolicy } from '@bike4mind/common';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addOrgDomainClaim,
  deleteOrgDomainClaim,
  fetchOrgDomainClaims,
  updateOrgDomainClaimPolicy,
  verifyOrgDomainClaim,
} from '@client/app/utils/orgDomainAPICalls';
import { getErrorMessage } from '@client/app/utils/error';

const POLICY_LABELS: Record<OrgDomainJoinPolicy, string> = {
  off: 'Off',
  suggest: 'Suggest joining',
  'auto-join': 'Join automatically',
};

const copy = (text: string) => {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
};

const RecordField: React.FC<{ label: string; value: string; testId: string }> = ({ label, value, testId }) => (
  <FormControl size="sm">
    <FormLabel>{label}</FormLabel>
    <Input
      readOnly
      value={value}
      slotProps={{ input: { 'data-testid': testId } }}
      endDecorator={
        <IconButton size="sm" variant="plain" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copy(value)}>
          <ContentCopyOutlinedIcon fontSize="small" />
        </IconButton>
      }
      sx={{ fontFamily: 'code' }}
    />
  </FormControl>
);

const DomainClaimRow: React.FC<{
  organizationId: string;
  claim: IOrgDomainClaimView;
  onChanged: () => Promise<void>;
  onDelete: (claim: IOrgDomainClaimView) => void;
}> = ({ organizationId, claim, onChanged, onDelete }) => {
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const verified = claim.status === 'verified';

  const verify = useMutation({
    mutationFn: () => verifyOrgDomainClaim(organizationId, claim.id),
    onSuccess: async result => {
      setVerifyMessage(result.verified ? null : result.reason);
      if (result.verified) await onChanged();
    },
    onError: error => setVerifyMessage(getErrorMessage(error)),
  });

  const update = useMutation({
    mutationFn: (policy: OrgDomainJoinPolicy) => updateOrgDomainClaimPolicy(organizationId, claim.id, { policy }),
    onSuccess: onChanged,
  });

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }} data-testid="org-domains-row">
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Typography level="title-md" sx={{ flex: 1 }}>
          {claim.domain}
        </Typography>
        <Chip size="sm" variant="soft" color={verified ? 'success' : 'warning'} data-testid="org-domains-status">
          {verified ? 'Verified' : 'Pending verification'}
        </Chip>
        <Button
          size="sm"
          variant="plain"
          color="danger"
          onClick={() => onDelete(claim)}
          data-testid="org-domains-delete-btn"
        >
          Remove
        </Button>
      </Stack>

      {!verified && claim.recordName && claim.recordValue && (
        <Stack gap={1.5} sx={{ mt: 2 }}>
          <Typography level="body-sm">
            Add this TXT record at your DNS provider, then select Verify. DNS changes can take a while to appear.
          </Typography>
          <RecordField label="Record name" value={claim.recordName} testId="org-domains-txt-name" />
          <RecordField label="Record value" value={claim.recordValue} testId="org-domains-txt-value" />
          <Box>
            <Button
              size="sm"
              loading={verify.isPending}
              onClick={() => verify.mutate()}
              data-testid="org-domains-verify-btn"
            >
              Verify
            </Button>
          </Box>
          {verifyMessage && (
            <Alert size="sm" color="warning" data-testid="org-domains-verify-reason">
              {verifyMessage}
            </Alert>
          )}
        </Stack>
      )}

      <Box sx={{ mt: 2 }}>
        <FormControl size="sm" sx={{ minWidth: 200, maxWidth: 320 }}>
          <FormLabel>Who can join</FormLabel>
          <Select
            value={claim.policy}
            disabled={!verified || update.isPending}
            onChange={(_e, value) => value && value !== claim.policy && update.mutate(value)}
            data-testid="org-domains-policy-select"
          >
            {(Object.keys(POLICY_LABELS) as OrgDomainJoinPolicy[]).map(policy => (
              <Option key={policy} value={policy}>
                {POLICY_LABELS[policy]}
              </Option>
            ))}
          </Select>
        </FormControl>
      </Box>
      {update.isError && (
        <Typography level="body-xs" color="danger" sx={{ mt: 1 }} data-testid="org-domains-update-error">
          {getErrorMessage(update.error)}
        </Typography>
      )}
    </Sheet>
  );
};

/** Org domain claims: add a domain, prove it with a DNS TXT record, then choose who may join. */
const OrgDomainsTab: React.FC<{ organizationId: string }> = ({ organizationId }) => {
  const queryClient = useQueryClient();
  const queryKey = ['orgDomainClaims', organizationId];
  const [domain, setDomain] = useState('');
  const [pendingDelete, setPendingDelete] = useState<IOrgDomainClaimView | null>(null);

  const {
    data: claims,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey,
    queryFn: () => fetchOrgDomainClaims(organizationId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const add = useMutation({
    mutationFn: (value: string) => addOrgDomainClaim(organizationId, value),
    onSuccess: async () => {
      setDomain('');
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (claimId: string) => deleteOrgDomainClaim(organizationId, claimId),
    onSuccess: async () => {
      setPendingDelete(null);
      await refresh();
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = domain.trim();
    if (value) add.mutate(value);
  };

  return (
    <Stack gap={2} data-testid="org-domains-tab">
      <Typography level="body-sm" textColor="text.secondary">
        Verify a domain your organization owns so people with an email address on it can find and join this
        organization.
      </Typography>

      <form onSubmit={submit}>
        <Stack direction="row" gap={1} alignItems="flex-start">
          <Input
            size="sm"
            placeholder="example.com"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            slotProps={{ input: { 'data-testid': 'org-domains-add-input' } }}
            sx={{ flex: 1, maxWidth: 360 }}
          />
          <Button
            size="sm"
            type="submit"
            loading={add.isPending}
            disabled={!domain.trim()}
            data-testid="org-domains-add-btn"
          >
            Add domain
          </Button>
        </Stack>
      </form>
      {add.isError && (
        <Alert size="sm" color="danger" data-testid="org-domains-add-error">
          {getErrorMessage(add.error)}
        </Alert>
      )}

      {loadError && (
        <Alert size="sm" color="danger" data-testid="org-domains-load-error">
          {getErrorMessage(loadError)}
        </Alert>
      )}
      {!isLoading && !loadError && claims?.length === 0 && (
        <Typography level="body-sm" data-testid="org-domains-empty">
          No domains yet.
        </Typography>
      )}
      {claims?.map(claim => (
        <DomainClaimRow
          key={claim.id}
          organizationId={organizationId}
          claim={claim}
          onChanged={refresh}
          onDelete={setPendingDelete}
        />
      ))}

      <Modal open={!!pendingDelete} onClose={() => !remove.isPending && setPendingDelete(null)}>
        <ModalDialog role="alertdialog" data-testid="org-domains-delete-modal">
          <DialogTitle>Remove {pendingDelete?.domain}?</DialogTitle>
          <DialogContent>
            People with this email domain will no longer be offered or added to this organization. Existing members
            stay.
            {remove.isError && (
              <Typography level="body-xs" color="danger" sx={{ mt: 1 }}>
                {getErrorMessage(remove.error)}
              </Typography>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              loading={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
              data-testid="org-domains-delete-confirm-btn"
            >
              Remove
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setPendingDelete(null)} disabled={remove.isPending}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  );
};

export default OrgDomainsTab;
