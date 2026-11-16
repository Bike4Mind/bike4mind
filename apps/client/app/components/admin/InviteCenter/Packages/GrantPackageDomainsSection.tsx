import { useState, type ReactNode } from 'react';
import { Alert, Button, Chip, FormHelperText, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isGrantPackageExpired, type IGrantPackageDocument, type IPartnerSignupRuleDocument } from '@bike4mind/common';
import {
  GRANT_PACKAGES_QUERY_KEY,
  fetchGrantPackageLinks,
  grantPackageLinksQueryKey,
} from '@client/app/utils/grantPackageAPICalls';
import {
  createPartnerSignupRule,
  fetchOrganizationById,
  updatePartnerSignupRule,
} from '@client/app/utils/partnerSignupRuleAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { useUser } from '@client/app/contexts/UserContext';
import {
  PartnerRuleDomainField,
  PartnerRuleEnabledField,
  PartnerRuleOrganizationField,
  type PartnerRuleOrganizationValue,
} from '../../PartnerSignupRuleFields';

export type DomainDraft = PartnerRuleOrganizationValue & { domain: string; enabled: boolean };
export type QueuedDomain = DomainDraft & { key: number };

type Props = {
  /** The saved package; null while the package is still being created. */
  pkg: IGrantPackageDocument | null;
  /** Domains to create right after the package is created. */
  queued: QueuedDomain[];
  onQueuedChange: (next: QueuedDomain[]) => void;
};

const EMPTY_DRAFT: DomainDraft = { domain: '', enabled: true, organizationId: null, organization: null };

/** Create payload for a domain ruled by a package: the package supplies the credits, so the rule grants none itself. */
export const domainRuleInput = (draft: DomainDraft, grantPackageId: string) => ({
  domain: draft.domain.trim(),
  entitlements: [],
  signupCredits: 0,
  enabled: draft.enabled,
  organizationId: draft.organizationId,
  grantPackageId,
});

export function GrantPackageDomainsSection(props: Props) {
  const { currentUser } = useUser();
  // Linked rules come from links.ts, which is full-admin only like the code list.
  if (!currentUser?.isAdmin) {
    return (
      <Stack gap={1} data-testid="grant-package-domains-section">
        <Typography level="title-sm">Partner domains</Typography>
        <Typography level="body-sm" data-testid="grant-package-domains-admin-only">
          Only full admins can view and add partner domains for a package.
        </Typography>
      </Stack>
    );
  }
  return <DomainsManager {...props} />;
}

function DomainEditor({
  draft,
  onChange,
  locked,
  seedOrganizationId,
  onSave,
  onCancel,
  saving,
  saveLabel,
  testId,
  children,
}: {
  draft: DomainDraft;
  onChange: (update: (current: DomainDraft) => DomainDraft) => void;
  locked: boolean;
  seedOrganizationId: string | null;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  saveLabel: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <Stack gap={1} sx={{ p: 1.5, borderRadius: 'sm', bgcolor: 'background.level1' }} data-testid={testId}>
      <PartnerRuleDomainField
        value={draft.domain}
        onChange={domain => onChange(current => ({ ...current, domain }))}
        locked={locked}
      />
      <PartnerRuleOrganizationField
        value={draft.organization}
        onChange={update => onChange(current => ({ ...current, ...update(current) }))}
        seedOrganizationId={seedOrganizationId}
      />
      <PartnerRuleEnabledField
        value={draft.enabled}
        onChange={enabled => onChange(current => ({ ...current, enabled }))}
      />
      <Stack direction="row" gap={1}>
        <Button
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={draft.domain.trim() === ''}
          data-testid={`${testId}-save-btn`}
        >
          {saveLabel}
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onCancel}
          disabled={saving}
          data-testid={`${testId}-cancel-btn`}
        >
          Cancel
        </Button>
        {children}
      </Stack>
    </Stack>
  );
}

function OrganizationName({ id }: { id: string }) {
  const org = useQuery({ queryKey: ['organization', id], queryFn: () => fetchOrganizationById(id) });
  return <>{org.data?.name ?? id}</>;
}

function DomainsManager({ pkg, queued, onQueuedChange }: Props) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<DomainDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: ({ draft, packageId }: { draft: DomainDraft; packageId: string }) =>
      createPartnerSignupRule(domainRuleInput(draft, packageId)),
    onSuccess: () => {
      setError(null);
      setAdding(false);
      void queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] });
    },
    onError: (err: unknown) => setError(getErrorMessage(err)),
  });

  // assertGrantPackageExists refuses new links to an expired or inactive package.
  const closedReason = !pkg
    ? null
    : isGrantPackageExpired(pkg)
      ? 'This package has expired, so it cannot take new partner domains.'
      : !pkg.active
        ? 'This package is inactive, so it cannot take new partner domains.'
        : null;

  const saveAdd = (draft: DomainDraft) => {
    if (pkg) {
      add.mutate({ draft, packageId: pkg.id });
      return;
    }
    onQueuedChange([...queued, { ...draft, key: Date.now() + queued.length }]);
    setAdding(false);
  };

  return (
    <Stack gap={1} data-testid="grant-package-domains-section">
      <Typography level="title-sm">Partner domains</Typography>
      <FormHelperText>Verified signups on these domains get this package&apos;s credits.</FormHelperText>
      {error && (
        <Alert color="danger" data-testid="grant-package-domains-error">
          {error}
        </Alert>
      )}
      {pkg && <LinkedDomains pkg={pkg} onError={setError} />}
      {!pkg && queued.length > 0 && (
        <Stack gap={0.5} data-testid="grant-package-domains-queued">
          {queued.map((domain, index) => (
            <Stack key={domain.key} direction="row" gap={1} alignItems="center">
              <Typography level="body-sm">
                {domain.domain}
                {domain.enabled ? '' : ' (disabled)'}
              </Typography>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => onQueuedChange(queued.filter(item => item.key !== domain.key))}
                data-testid={`grant-package-queued-domain-remove-${index}`}
              >
                Remove
              </Button>
            </Stack>
          ))}
          <FormHelperText>Domains are added after the package is saved.</FormHelperText>
        </Stack>
      )}
      {adding ? (
        <DomainEditor
          draft={addDraft}
          onChange={setAddDraft}
          locked={false}
          seedOrganizationId={null}
          onSave={() => saveAdd(addDraft)}
          onCancel={() => setAdding(false)}
          saving={add.isPending}
          saveLabel="Add domain"
          testId="grant-package-domain-add"
        />
      ) : (
        <Stack direction="row">
          <Button
            size="sm"
            variant="outlined"
            onClick={() => {
              setAddDraft(EMPTY_DRAFT);
              setAdding(true);
            }}
            disabled={closedReason !== null}
            data-testid="grant-package-add-domain-btn"
          >
            Add domain
          </Button>
        </Stack>
      )}
      {closedReason && <FormHelperText data-testid="grant-package-domains-closed">{closedReason}</FormHelperText>}
    </Stack>
  );
}

function LinkedDomains({ pkg, onError }: { pkg: IGrantPackageDocument; onError: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: grantPackageLinksQueryKey(pkg.id),
    queryFn: () => fetchGrantPackageLinks(pkg.id),
  });
  const [editing, setEditing] = useState<IPartnerSignupRuleDocument | null>(null);
  const [editDraft, setEditDraft] = useState<DomainDraft>(EMPTY_DRAFT);

  const save = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: Parameters<typeof updatePartnerSignupRule>[1] }) =>
      updatePartnerSignupRule(id, changes),
    onSuccess: () => {
      onError(null);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] });
    },
    onError: (err: unknown) => onError(getErrorMessage(err)),
  });

  const rules = links.data?.partnerRules;

  return (
    <>
      {links.isError && (
        <Alert color="danger" data-testid="grant-package-domains-load-error">
          {getErrorMessage(links.error)}
        </Alert>
      )}
      {rules && rules.data.length === 0 && (
        <Typography level="body-sm" data-testid="grant-package-domains-empty">
          No partner domains use this package yet.
        </Typography>
      )}
      {rules?.data.map(rule => (
        <Stack
          key={rule.id}
          direction="row"
          gap={1.5}
          alignItems="center"
          flexWrap="wrap"
          data-testid={`grant-package-domain-row-${rule.domain}`}
        >
          <Typography level="body-sm" fontWeight="md">
            {rule.domain}
          </Typography>
          <Chip size="sm" color={rule.enabled ? 'success' : 'neutral'}>
            {rule.enabled ? 'Enabled' : 'Disabled'}
          </Chip>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {rule.organizationId ? <OrganizationName id={rule.organizationId} /> : 'No organization'}
          </Typography>
          <Button
            size="sm"
            variant="plain"
            onClick={() => {
              setEditing(rule);
              setEditDraft({
                domain: rule.domain,
                enabled: rule.enabled,
                organizationId: rule.organizationId ?? null,
                organization: null,
              });
            }}
            disabled={save.isPending}
            data-testid={`grant-package-domain-edit-btn-${rule.domain}`}
          >
            Edit
          </Button>
        </Stack>
      ))}
      {editing && (
        <DomainEditor
          key={editing.id}
          draft={editDraft}
          onChange={setEditDraft}
          locked
          seedOrganizationId={editing.organizationId ?? null}
          onSave={() =>
            save.mutate({
              id: editing.id,
              changes: { enabled: editDraft.enabled, organizationId: editDraft.organizationId },
            })
          }
          onCancel={() => setEditing(null)}
          saving={save.isPending}
          saveLabel="Save domain"
          testId="grant-package-domain-edit"
        >
          <Button
            size="sm"
            variant="plain"
            color="danger"
            onClick={() => save.mutate({ id: editing.id, changes: { grantPackageId: null } })}
            disabled={save.isPending}
            data-testid="grant-package-domain-unlink-btn"
          >
            Unlink from package
          </Button>
        </DomainEditor>
      )}
      {rules?.truncated && (
        <FormHelperText data-testid="grant-package-domains-truncated">
          Showing the newest {rules.data.length} domains.
        </FormHelperText>
      )}
    </>
  );
}
