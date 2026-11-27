import { useEffect } from 'react';
import { Autocomplete, Box, FormControl, FormHelperText, FormLabel, Input, Switch } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import {
  fetchOrganizationById,
  searchOrganizations,
  type OrganizationOption,
} from '@client/app/utils/partnerSignupRuleAPICalls';

// Fields shared by the partner signup rule dialog and the grant package form. Validation stays
// server-side in partnerSignupRule.ts schemas so both forms report the same errors.

/** `organizationId` is the value persisted; `organization` carries the name the picker displays. */
export type PartnerRuleOrganizationValue = {
  organizationId: string | null;
  organization: OrganizationOption | null;
};

export function PartnerRuleDomainField({
  value,
  onChange,
  locked,
}: {
  value: string;
  onChange: (domain: string) => void;
  /** The domain is the rule's key, so a saved rule's domain cannot change. */
  locked: boolean;
}) {
  return (
    <FormControl required>
      <FormLabel>Domain</FormLabel>
      <Input
        placeholder="partner.com"
        autoFocus={!locked}
        value={value}
        disabled={locked}
        onChange={e => onChange(e.target.value)}
        data-testid="partner-rule-domain-input"
      />
      <FormHelperText>
        {locked
          ? 'Domain is the key and cannot be changed. Delete and re-add to move it.'
          : 'Bare domain only (no @ or path). Public mail providers are rejected.'}
      </FormHelperText>
    </FormControl>
  );
}

export function PartnerRuleOrganizationField({
  value,
  onChange,
  seedOrganizationId,
}: {
  value: OrganizationOption | null;
  /** Receives a patch builder so a late seed cannot overwrite an org picked meanwhile. */
  onChange: (update: (current: PartnerRuleOrganizationValue) => Partial<PartnerRuleOrganizationValue>) => void;
  /** A saved rule stores only the org id, so its name is fetched to label the picker. */
  seedOrganizationId: string | null;
}) {
  // The Autocomplete input stays uncontrolled so it shows the selected org's label; onInputChange feeds the search.
  const { debouncedValue: orgSearch, setValue: setOrgSearchInput } = useDebounceValue('');
  const { data: orgOptions = [], isFetching: orgOptionsLoading } = useQuery({
    queryKey: ['org-search', orgSearch],
    queryFn: () => searchOrganizations(orgSearch),
  });

  useEffect(() => {
    if (!seedOrganizationId) return;
    let cancelled = false;
    fetchOrganizationById(seedOrganizationId)
      .then(org => {
        // A since-deleted org (null) leaves the picker empty; the id still saves.
        if (org && !cancelled) onChange(current => (current.organizationId === org.id ? { organization: org } : {}));
      })
      .catch(() => {
        /* non-fatal: the id still saves; only the display label is missing */
      });
    return () => {
      cancelled = true;
    };
    // onChange is a fresh closure each render; the seed only depends on the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedOrganizationId]);

  return (
    <FormControl>
      <FormLabel>Organization</FormLabel>
      <Autocomplete
        placeholder="Search organizations by name..."
        options={orgOptions}
        value={value}
        loading={orgOptionsLoading}
        getOptionLabel={option => option.name}
        isOptionEqualToValue={(option, selected) => option.id === selected.id}
        onInputChange={(_event, input) => setOrgSearchInput(input)}
        onChange={(_event, org) => onChange(() => ({ organization: org, organizationId: org?.id ?? null }))}
        data-testid="partner-rule-org-input"
      />
      <FormHelperText>
        Optional. Verified signups on this domain are auto-added to this organization as members. Existing users are not
        touched - use the backfill action for those. Leave empty for no org.
      </FormHelperText>
    </FormControl>
  );
}

export function PartnerRuleEnabledField({ value, onChange }: { value: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Box>
        <FormLabel>Enabled</FormLabel>
        <FormHelperText sx={{ mt: 0 }}>Turn off to stage a rule without granting anything.</FormHelperText>
      </Box>
      <Switch
        color={value ? 'success' : 'neutral'}
        checked={value}
        onChange={e => onChange(e.target.checked)}
        data-testid="partner-rule-enabled-switch"
      />
    </FormControl>
  );
}
