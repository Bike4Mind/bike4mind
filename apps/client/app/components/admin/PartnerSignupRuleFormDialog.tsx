import { useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import type { IPartnerSignupRuleDocument } from '@bike4mind/common';
import { KNOWN_ENTITLEMENT_KEYS } from '@bike4mind/server-utils/lib/entitlements/registry';
import { SUBSCRIPTION_PLANS } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import type { SubscriptionPlanDetail } from '@bike4mind/server-utils/lib/userSubscriptions/types';
import {
  createPartnerSignupRule,
  updatePartnerSignupRule,
  searchOrganizations,
  fetchOrganizationById,
  type OrganizationOption,
} from '@client/app/utils/partnerSignupRuleAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import GrantPackageSelect, { useSelectedGrantPackage } from './InviteCenter/shared/GrantPackageSelect';
import { AdminDialog } from './shared';

// Options for the entitlements picker; spread to a mutable array for Joy Autocomplete.
const ENTITLEMENT_OPTIONS = [...KNOWN_ENTITLEMENT_KEYS];

export const planLabel = (plan: SubscriptionPlanDetail): string => `${plan.name} (${plan.interval})`;

// A saved rule can outlive its plan, so fall back to the raw price id rather than hide it.
export const planLabelForPriceId = (priceId: string): string => {
  const plan = SUBSCRIPTION_PLANS.find(candidate => candidate.priceId === priceId);
  return plan ? planLabel(plan) : priceId;
};

type FormState = {
  domain: string;
  label: string;
  entitlements: string[];
  tags: string[];
  subscriptionPriceId: string | null;
  subscriptionMonths: string;
  signupCredits: string;
  grantPackageId: string | null;
  notes: string;
  enabled: boolean;
  // `organizationId` is the value persisted; `organization` carries the name so the picker can
  // render the current selection (seeded async when editing a rule that already has an org).
  organizationId: string | null;
  organization: OrganizationOption | null;
};

const emptyForm: FormState = {
  domain: '',
  label: '',
  entitlements: [],
  tags: [],
  subscriptionPriceId: null,
  subscriptionMonths: '1',
  signupCredits: '0',
  grantPackageId: null,
  notes: '',
  enabled: true,
  organizationId: null,
  organization: null,
};

const ruleToForm = (rule: IPartnerSignupRuleDocument): FormState => ({
  domain: rule.domain,
  label: rule.label ?? '',
  entitlements: rule.entitlements ?? [],
  tags: rule.tags ?? [],
  subscriptionPriceId: rule.subscription?.priceId ?? null,
  subscriptionMonths: String(rule.subscription?.durationMonths ?? 1),
  signupCredits: String(rule.signupCredits ?? 0),
  grantPackageId: rule.grantPackageId ?? null,
  notes: rule.notes ?? '',
  enabled: rule.enabled,
  organizationId: rule.organizationId ?? null,
  organization: null,
});

type Props = {
  /** The rule being edited; null creates a new one. */
  editing: IPartnerSignupRuleDocument | null;
  onClose: () => void;
  onSaved: () => void;
};

/** Create/edit form for one partner signup rule. Mount it only while open so its state resets. */
export default function PartnerSignupRuleFormDialog({ editing, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(editing ? ruleToForm(editing) : emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  // A plan removed from the catalog after the rule was saved would otherwise match no Option and render blank.
  const planOptions = SUBSCRIPTION_PLANS.map(plan => ({ priceId: plan.priceId, label: planLabel(plan) }));
  if (form.subscriptionPriceId && !planOptions.some(option => option.priceId === form.subscriptionPriceId)) {
    planOptions.push({ priceId: form.subscriptionPriceId, label: `${form.subscriptionPriceId} (unavailable)` });
  }
  const selectedPackage = useSelectedGrantPackage(form.grantPackageId);

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Send label/notes as trimmed strings (not `|| undefined`): JSON drops undefined keys
      // and the API only $sets keys it receives, so coalescing to undefined would make a
      // cleared field un-clearable (the old value would persist on update).
      const payload = {
        entitlements: form.entitlements,
        tags: form.tags,
        // null (not undefined) so clearing the subscription is a real update; see organizationId below.
        subscription: form.subscriptionPriceId
          ? { priceId: form.subscriptionPriceId, durationMonths: Number(form.subscriptionMonths) }
          : null,
        signupCredits: Number(form.signupCredits),
        grantPackageId: form.grantPackageId,
        label: form.label.trim(),
        notes: form.notes.trim(),
        enabled: form.enabled,
        // Send null (not undefined) so clearing the org association is a real update - the API
        // $sets keys it receives, and JSON drops undefined, so undefined would be un-clearable.
        organizationId: form.organizationId,
      };
      if (editing) {
        return updatePartnerSignupRule(editing.id, payload);
      }
      return createPartnerSignupRule({ domain: form.domain, ...payload });
    },
    onSuccess: rule => {
      onSaved();
      toast.success(editing ? `Updated rule for ${rule.domain}` : `Created signup rule for ${rule.domain}`);
    },
    onError: (error: unknown) => {
      setFormError(getErrorMessage(error));
    },
  });

  // Org picker: debounced name search. The Autocomplete input stays uncontrolled so it shows the
  // selected org's label; onInputChange feeds the search.
  const { debouncedValue: orgSearch, setValue: setOrgSearchInput } = useDebounceValue('');
  const { data: orgOptions = [], isFetching: orgOptionsLoading } = useQuery({
    queryKey: ['org-search', orgSearch],
    queryFn: () => searchOrganizations(orgSearch),
  });

  // Seed the picker's selected label. The rule stores only the id, so fetch the org name;
  // a since-deleted org (fetch returns null) leaves the picker empty.
  useEffect(() => {
    if (!editing?.organizationId) return;
    let cancelled = false;
    fetchOrganizationById(editing.organizationId)
      .then(org => {
        if (org && !cancelled) setForm(f => (f.organizationId === org.id ? { ...f, organization: org } : f));
      })
      .catch(() => {
        /* non-fatal: the id still saves; only the display label is missing */
      });
    return () => {
      cancelled = true;
    };
  }, [editing]);

  return (
    <AdminDialog
      onClose={onClose}
      title={editing ? 'Edit signup rule' : 'Add signup rule'}
      width={540}
      data-testid="partner-rule-modal"
    >
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mt: -1, mb: 1 }}>
        {editing ? editing.domain : 'Grant entitlements and bonus credits to a partner domain.'}
      </Typography>
      <Stack spacing={1.5}>
        <FormControl required>
          <FormLabel>Domain</FormLabel>
          <Input
            placeholder="partner.com"
            autoFocus={!editing}
            value={form.domain}
            disabled={!!editing}
            onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
            data-testid="partner-rule-domain-input"
          />
          <FormHelperText>
            {editing
              ? 'Domain is the key and cannot be changed. Delete and re-add to move it.'
              : 'Bare domain only (no @ or path). Public mail providers are rejected.'}
          </FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Label</FormLabel>
          <Input
            placeholder="Partner name (admin-facing)"
            value={form.label}
            onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            data-testid="partner-rule-label-input"
          />
        </FormControl>

        <FormControl>
          <FormLabel>Entitlements</FormLabel>
          <Autocomplete
            multiple
            freeSolo
            options={ENTITLEMENT_OPTIONS}
            value={form.entitlements}
            onChange={(_event, value) => setForm(f => ({ ...f, entitlements: value }))}
            placeholder={form.entitlements.length ? '' : 'Select entitlements to grant'}
            data-testid="partner-rule-entitlements-input"
          />
          <FormHelperText>
            {/* FormHelperText's root is flex, so mixed text/element children become separate
                    flex items laid out side by side instead of flowing as one paragraph - a single
                    wrapping child keeps the sentence inline. */}
            <span>
              Pick from the products the registry recognizes, or type a lake grant as <code>datalake:&lt;slug&gt;</code>{' '}
              and press Enter. A new product key must be added to the entitlement registry before it appears in the
              list.
            </span>
          </FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>User tags</FormLabel>
          <Autocomplete
            multiple
            freeSolo
            autoSelect
            options={[]}
            value={form.tags}
            onChange={(_event, value) => setForm(f => ({ ...f, tags: value }))}
            placeholder={form.tags.length ? '' : 'Type a tag and press Enter'}
            data-testid="partner-rule-tags-input"
          />
          <FormHelperText>
            Added to the user&apos;s tags at email verification. Tags stay on the user if the rule is later disabled or
            deleted.
          </FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Subscription</FormLabel>
          <Select
            placeholder="None"
            value={form.subscriptionPriceId}
            onChange={(_event, value) => setForm(f => ({ ...f, subscriptionPriceId: value }))}
            slotProps={{ button: { 'data-testid': 'partner-rule-subscription-select' } }}
          >
            <Option value={null}>None</Option>
            {planOptions.map(({ priceId, label }) => (
              <Option key={priceId} value={priceId}>
                {label}
              </Option>
            ))}
          </Select>
          <FormHelperText>
            Granted free at email verification through the admin-grant path (no Stripe). It stays on the user if the
            rule is later disabled or deleted.
          </FormHelperText>
        </FormControl>

        {form.subscriptionPriceId && (
          <FormControl>
            <FormLabel>Subscription duration</FormLabel>
            <Input
              type="number"
              slotProps={{ input: { min: 1, max: 12, step: 1 } }}
              endDecorator={<Typography level="body-xs">months</Typography>}
              value={form.subscriptionMonths}
              onChange={e => setForm(f => ({ ...f, subscriptionMonths: e.target.value }))}
              data-testid="partner-rule-subscription-months-input"
            />
          </FormControl>
        )}

        <FormControl>
          <FormLabel>Signup credits</FormLabel>
          <Input
            type="number"
            slotProps={{ input: { min: 0 } }}
            endDecorator={<Typography level="body-xs">credits</Typography>}
            value={selectedPackage ? String(selectedPackage.credits) : form.signupCredits}
            onChange={e => setForm(f => ({ ...f, signupCredits: e.target.value }))}
            disabled={form.grantPackageId !== null}
            data-testid="partner-rule-credits-input"
          />
          <FormHelperText>One-time bonus granted at email verification. 0 = access only, no bonus.</FormHelperText>
        </FormControl>

        <GrantPackageSelect
          value={form.grantPackageId}
          onChange={id => setForm(f => ({ ...f, grantPackageId: id }))}
          testId="partner-rule-grant-package-select"
          helperText="A package replaces the credits above and caps them; at the cap, signups still join the org and plan without credits."
        />

        <FormControl>
          <FormLabel>Organization</FormLabel>
          <Autocomplete
            placeholder="Search organizations by name..."
            options={orgOptions}
            value={form.organization}
            loading={orgOptionsLoading}
            getOptionLabel={option => option.name}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onInputChange={(_event, value) => setOrgSearchInput(value)}
            onChange={(_event, value) =>
              setForm(f => ({ ...f, organization: value, organizationId: value?.id ?? null }))
            }
            data-testid="partner-rule-org-input"
          />
          <FormHelperText>
            Optional. Verified signups on this domain are auto-added to this organization as members. Existing users are
            not touched - use the backfill action for those. Leave empty for no org.
          </FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Notes</FormLabel>
          <Textarea
            minRows={2}
            placeholder="Deal reference, contact, etc."
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            data-testid="partner-rule-notes-input"
          />
        </FormControl>

        <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Box>
            <FormLabel>Enabled</FormLabel>
            <FormHelperText sx={{ mt: 0 }}>Turn off to stage a rule without granting anything.</FormHelperText>
          </Box>
          <Switch
            color={form.enabled ? 'success' : 'neutral'}
            checked={form.enabled}
            onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
            data-testid="partner-rule-enabled-switch"
          />
        </FormControl>

        {formError && (
          <Alert
            color="danger"
            variant="soft"
            startDecorator={<WarningRoundedIcon />}
            data-testid="partner-rule-form-error"
          >
            {formError}
          </Alert>
        )}
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 0.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="partner-rule-cancel-btn">
            Cancel
          </Button>
          <Button
            onClick={() => {
              setFormError(null);
              saveMutation.mutate();
            }}
            loading={saveMutation.isPending}
            data-testid="partner-rule-save-btn"
          >
            {editing ? 'Save changes' : 'Create rule'}
          </Button>
        </Stack>
      </Stack>
    </AdminDialog>
  );
}
