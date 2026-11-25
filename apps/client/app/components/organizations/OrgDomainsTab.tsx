import React, { useState } from 'react';
import { SPACE_DOMAIN_JOIN_POLICIES, type IOrgDomainClaimView, type OrgDomainJoinPolicy } from '@bike4mind/common';
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
import {
  addSpaceDomainClaim,
  deleteSpaceDomainClaim,
  fetchSpaceDomainClaims,
  updateSpaceDomainClaimPolicy,
  verifySpaceDomainClaim,
} from '@client/app/utils/spaceDomainAPICalls';
import { getErrorMessage } from '@client/app/utils/error';

const POLICY_LABELS: Record<OrgDomainJoinPolicy, string> = {
  off: 'Off',
  suggest: 'Suggest joining',
  'auto-join': 'Join automatically',
};

export type DomainOwner = { kind: 'organization' | 'space'; id: string };

interface DomainCalls {
  fetch: (ownerId: string) => Promise<IOrgDomainClaimView[]>;
  add: (ownerId: string, domain: string) => Promise<IOrgDomainClaimView>;
  verify: typeof verifyOrgDomainClaim;
  update: (ownerId: string, claimId: string, update: { policy: OrgDomainJoinPolicy }) => Promise<IOrgDomainClaimView>;
  remove: (ownerId: string, claimId: string) => Promise<void>;
}

interface OwnerConfig {
  calls: DomainCalls;
  policies: readonly OrgDomainJoinPolicy[];
  noun: string;
  /** Test id prefix and query key root; the organization's are the original ones. */
  prefix: string;
  queryRoot: string;
  intro: string;
}

const OWNER_CONFIG: Record<DomainOwner['kind'], OwnerConfig> = {
  organization: {
    calls: {
      fetch: id => fetchOrgDomainClaims(id),
      add: (id, domain) => addOrgDomainClaim(id, domain),
      verify: (id, claimId) => verifyOrgDomainClaim(id, claimId),
      update: (id, claimId, update) => updateOrgDomainClaimPolicy(id, claimId, update),
      remove: (id, claimId) => deleteOrgDomainClaim(id, claimId),
    },
    policies: ['off', 'suggest', 'auto-join'],
    noun: 'organization',
    prefix: 'org',
    queryRoot: 'orgDomainClaims',
    intro:
      'Verify a domain your organization owns so people with an email address on it can find and join this organization.',
  },
  space: {
    calls: {
      fetch: id => fetchSpaceDomainClaims(id),
      add: (id, domain) => addSpaceDomainClaim(id, domain),
      verify: (id, claimId) => verifySpaceDomainClaim(id, claimId),
      update: (id, claimId, update) =>
        updateSpaceDomainClaimPolicy(id, claimId, {
          policy: update.policy as (typeof SPACE_DOMAIN_JOIN_POLICIES)[number],
        }),
      remove: (id, claimId) => deleteSpaceDomainClaim(id, claimId),
    },
    policies: SPACE_DOMAIN_JOIN_POLICIES,
    noun: 'space',
    prefix: 'space',
    queryRoot: 'spaceDomainClaims',
    intro:
      'Verify a domain you control so people with an email address on it can find and join this space. They always join as members and are never added automatically.',
  },
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
  ownerId: string;
  config: OwnerConfig;
  claim: IOrgDomainClaimView;
  onChanged: () => Promise<void>;
  onDelete: (claim: IOrgDomainClaimView) => void;
}> = ({ ownerId, config, claim, onChanged, onDelete }) => {
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const verified = claim.status === 'verified';

  const verify = useMutation({
    mutationFn: () => config.calls.verify(ownerId, claim.id),
    onSuccess: async result => {
      setVerifyMessage(result.verified ? null : result.reason);
      if (result.verified) await onChanged();
    },
    onError: error => setVerifyMessage(getErrorMessage(error)),
  });

  const update = useMutation({
    mutationFn: (policy: OrgDomainJoinPolicy) => config.calls.update(ownerId, claim.id, { policy }),
    onSuccess: onChanged,
  });

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }} data-testid={`${config.prefix}-domains-row`}>
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Typography level="title-md" sx={{ flex: 1 }}>
          {claim.domain}
        </Typography>
        <Chip
          size="sm"
          variant="soft"
          color={verified ? 'success' : 'warning'}
          data-testid={`${config.prefix}-domains-status`}
        >
          {verified ? 'Verified' : 'Pending verification'}
        </Chip>
        <Button
          size="sm"
          variant="plain"
          color="danger"
          onClick={() => onDelete(claim)}
          data-testid={`${config.prefix}-domains-delete-btn`}
        >
          Remove
        </Button>
      </Stack>

      {!verified && claim.recordName && claim.recordValue && (
        <Stack gap={1.5} sx={{ mt: 2 }}>
          <Typography level="body-sm">
            Add this TXT record at your DNS provider, then select Verify. DNS changes can take a while to appear.
          </Typography>
          <RecordField label="Record name" value={claim.recordName} testId={`${config.prefix}-domains-txt-name`} />
          <RecordField label="Record value" value={claim.recordValue} testId={`${config.prefix}-domains-txt-value`} />
          <Box>
            <Button
              size="sm"
              loading={verify.isPending}
              onClick={() => verify.mutate()}
              data-testid={`${config.prefix}-domains-verify-btn`}
            >
              Verify
            </Button>
          </Box>
          {verifyMessage && (
            <Alert size="sm" color="warning" data-testid={`${config.prefix}-domains-verify-reason`}>
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
            data-testid={`${config.prefix}-domains-policy-select`}
          >
            {config.policies.map(policy => (
              <Option key={policy} value={policy}>
                {POLICY_LABELS[policy]}
              </Option>
            ))}
          </Select>
        </FormControl>
      </Box>
      {update.isError && (
        <Typography level="body-xs" color="danger" sx={{ mt: 1 }} data-testid={`${config.prefix}-domains-update-error`}>
          {getErrorMessage(update.error)}
        </Typography>
      )}
    </Sheet>
  );
};

type OrgDomainsTabProps = { organizationId: string; owner?: never } | { owner: DomainOwner; organizationId?: never };

/**
 * Domain claims for an organization or a Space: add a domain, prove it with a DNS TXT record, then
 * choose who may join. A Space's policies exclude auto-join.
 */
const OrgDomainsTab: React.FC<OrgDomainsTabProps> = ({ organizationId, owner }) => {
  const resolved: DomainOwner = owner ?? { kind: 'organization', id: organizationId };
  const config = OWNER_CONFIG[resolved.kind];
  const ownerId = resolved.id;
  const queryClient = useQueryClient();
  const queryKey = [config.queryRoot, ownerId];
  const [domain, setDomain] = useState('');
  const [pendingDelete, setPendingDelete] = useState<IOrgDomainClaimView | null>(null);

  const {
    data: claims,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey,
    queryFn: () => config.calls.fetch(ownerId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const add = useMutation({
    mutationFn: (value: string) => config.calls.add(ownerId, value),
    onSuccess: async () => {
      setDomain('');
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (claimId: string) => config.calls.remove(ownerId, claimId),
    onSuccess: async () => {
      setPendingDelete(null);
      await refresh();
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (add.isPending) return;
    const value = domain.trim();
    if (value) add.mutate(value);
  };

  return (
    <Stack gap={2} data-testid={`${config.prefix}-domains-tab`}>
      <Typography level="body-sm" textColor="text.secondary">
        {config.intro}
      </Typography>

      <form onSubmit={submit}>
        <Stack direction="row" gap={1} alignItems="flex-start">
          <Input
            size="sm"
            placeholder="example.com"
            value={domain}
            disabled={add.isPending}
            onChange={e => setDomain(e.target.value)}
            slotProps={{ input: { 'data-testid': `${config.prefix}-domains-add-input` } }}
            sx={{ flex: 1, maxWidth: 360 }}
          />
          <Button
            size="sm"
            type="submit"
            loading={add.isPending}
            disabled={!domain.trim()}
            data-testid={`${config.prefix}-domains-add-btn`}
          >
            Add domain
          </Button>
        </Stack>
      </form>
      {add.isError && (
        <Alert size="sm" color="danger" data-testid={`${config.prefix}-domains-add-error`}>
          {getErrorMessage(add.error)}
        </Alert>
      )}

      {loadError && (
        <Alert size="sm" color="danger" data-testid={`${config.prefix}-domains-load-error`}>
          {getErrorMessage(loadError)}
        </Alert>
      )}
      {!isLoading && !loadError && claims?.length === 0 && (
        <Typography level="body-sm" data-testid={`${config.prefix}-domains-empty`}>
          No domains yet.
        </Typography>
      )}
      {claims?.map(claim => (
        <DomainClaimRow
          key={claim.id}
          ownerId={ownerId}
          config={config}
          claim={claim}
          onChanged={refresh}
          onDelete={setPendingDelete}
        />
      ))}

      <Modal open={!!pendingDelete} onClose={() => !remove.isPending && setPendingDelete(null)}>
        <ModalDialog role="alertdialog" data-testid={`${config.prefix}-domains-delete-modal`}>
          <DialogTitle>Remove {pendingDelete?.domain}?</DialogTitle>
          <DialogContent>
            People with this email domain will no longer be offered or added to this {config.noun}. Existing members
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
              data-testid={`${config.prefix}-domains-delete-confirm-btn`}
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
