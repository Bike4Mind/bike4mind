import { useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  LinearProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Sheet,
  Stack,
  Switch,
  Table,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import HandshakeIcon from '@mui/icons-material/Handshake';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import type { IPartnerSignupRuleDocument } from '@bike4mind/common';
import { KNOWN_ENTITLEMENT_KEYS } from '@client/lib/entitlements/registry';
import {
  fetchPartnerSignupRules,
  createPartnerSignupRule,
  updatePartnerSignupRule,
  deletePartnerSignupRule,
  searchOrganizations,
  fetchOrganizationById,
  previewPartnerRuleBackfill,
  runPartnerRuleBackfill,
  type OrganizationOption,
} from '@client/app/utils/partnerSignupRuleAPICalls';
import { getErrorMessage } from '@client/app/utils/error';

// Options for the entitlements picker; spread to a mutable array for Joy Autocomplete.
const ENTITLEMENT_OPTIONS = [...KNOWN_ENTITLEMENT_KEYS];

const QUERY_KEY = 'partner-signup-rules';
const PAGE_LIMIT = 25;

type FormState = {
  domain: string;
  label: string;
  entitlements: string[];
  signupCredits: string;
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
  signupCredits: '0',
  notes: '',
  enabled: true,
  organizationId: null,
  organization: null,
};

const ruleToForm = (rule: IPartnerSignupRuleDocument): FormState => ({
  domain: rule.domain,
  label: rule.label ?? '',
  entitlements: rule.entitlements ?? [],
  signupCredits: String(rule.signupCredits ?? 0),
  notes: rule.notes ?? '',
  enabled: rule.enabled,
  organizationId: rule.organizationId ?? null,
  organization: null,
});

export default function PartnerSignupRulesTab() {
  const queryClient = useQueryClient();
  // useDebounceValue owns the input state; `value` mirrors keystrokes, `debouncedValue` drives the query.
  const { value: searchInput, debouncedValue: search, setValue: setSearchInput } = useDebounceValue('');
  const [page, setPage] = useState(1);

  // Modal state: `editing` null => create; a rule => edit that rule.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<IPartnerSignupRuleDocument | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  // Rule pending deletion (drives the confirm dialog); null when closed.
  const [deleteTarget, setDeleteTarget] = useState<IPartnerSignupRuleDocument | null>(null);

  const { data, isPending } = useQuery({
    queryKey: [QUERY_KEY, { page, search }],
    queryFn: () => fetchPartnerSignupRules({ page, limit: PAGE_LIMIT, search: search || undefined }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Send label/notes as trimmed strings (not `|| undefined`): JSON drops undefined keys
      // and the API only $sets keys it receives, so coalescing to undefined would make a
      // cleared field un-clearable (the old value would persist on update).
      const payload = {
        entitlements: form.entitlements,
        signupCredits: Number(form.signupCredits),
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
      invalidate();
      setModalOpen(false);
      toast.success(editing ? `Updated rule for ${rule.domain}` : `Created signup rule for ${rule.domain}`);
    },
    onError: (error: unknown) => {
      setFormError(getErrorMessage(error));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => updatePartnerSignupRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: rule => {
      invalidate();
      toast.success(`${rule.domain} ${rule.enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => deletePartnerSignupRule(rule.id),
    onSuccess: (_result, rule) => {
      invalidate();
      setDeleteTarget(null);
      toast.success(`Deleted signup rule for ${rule.domain}`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  // Org picker: debounced name search, only queried while the modal is open. The Autocomplete
  // input stays uncontrolled so it shows the selected org's label; onInputChange feeds the search.
  const { debouncedValue: orgSearch, setValue: setOrgSearchInput } = useDebounceValue('');
  const { data: orgOptions = [], isFetching: orgOptionsLoading } = useQuery({
    queryKey: ['org-search', orgSearch],
    queryFn: () => searchOrganizations(orgSearch),
    enabled: modalOpen,
  });

  // Backfill: the rule whose existing users we're sweeping into its org (null = closed).
  const [backfillTarget, setBackfillTarget] = useState<IPartnerSignupRuleDocument | null>(null);
  const { data: backfillPreview, isPending: backfillPreviewLoading } = useQuery({
    queryKey: ['partner-rule-backfill-preview', backfillTarget?.id],
    queryFn: () => previewPartnerRuleBackfill(backfillTarget!.id),
    enabled: !!backfillTarget,
  });
  const backfillMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => runPartnerRuleBackfill(rule.id),
    onSuccess: result => {
      setBackfillTarget(null);
      toast.success(
        `Backfill complete: ${result.added} added` +
          (result.seatRaised ? `, ${result.seatRaised} seat${result.seatRaised === 1 ? '' : 's'} added` : '') +
          (result.alreadyMember ? `, ${result.alreadyMember} already members` : '') +
          (result.atCapacity ? `, ${result.atCapacity} at capacity (Stripe org - add seats)` : '') +
          (result.failed ? `, ${result.failed} failed` : '')
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (rule: IPartnerSignupRuleDocument) => {
    setEditing(rule);
    setForm(ruleToForm(rule));
    setFormError(null);
    setModalOpen(true);
    // Seed the picker's selected label. The rule stores only the id, so fetch the org name;
    // guard against a since-deleted org (fetch returns null) by leaving the picker empty.
    if (rule.organizationId) {
      fetchOrganizationById(rule.organizationId)
        .then(org => {
          if (org) setForm(f => (f.organizationId === org.id ? { ...f, organization: org } : f));
        })
        .catch(() => {
          /* non-fatal: the id still saves; only the display label is missing */
        });
    }
  };

  const rules = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const totalPages = data?.meta.totalPages ?? 1;
  const isEmpty = rules.length === 0 && !isPending;

  return (
    <Box sx={{ p: 2 }} data-testid="partner-signup-rules-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} gap={2}>
        <Box>
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography level="h4">Partner Signup Rules</Typography>
            {total > 0 && (
              <Chip size="sm" variant="soft" color="primary" data-testid="partner-rule-count">
                {total}
              </Chip>
            )}
          </Stack>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', maxWidth: 620 }}>
            Auto-grant entitlements, a one-time signup-credit bonus, and optional organization membership to anyone who
            registers with a verified email on a partner domain. Applied at email verification; disabled rules confer
            nothing.
          </Typography>
        </Box>
        <Button startDecorator={<AddIcon />} onClick={openCreate} data-testid="partner-rule-add-btn">
          Add rule
        </Button>
      </Stack>

      <Input
        placeholder="Search by domain or label..."
        value={searchInput}
        onChange={e => {
          setSearchInput(e.target.value);
          setPage(1);
        }}
        sx={{ mb: 2, maxWidth: 360 }}
        data-testid="partner-rule-search-input"
      />

      {isPending && <LinearProgress sx={{ mb: 1 }} />}

      {isEmpty ? (
        <Sheet
          variant="soft"
          sx={{
            borderRadius: 'md',
            py: 6,
            px: 3,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1.5,
          }}
        >
          <HandshakeIcon sx={{ fontSize: 44, color: 'neutral.400' }} />
          <Typography level="title-md">{search ? 'No matching rules' : 'No partner signup rules yet'}</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', maxWidth: 420 }}>
            {search
              ? 'Try a different domain or label.'
              : 'Create a rule to auto-grant entitlements and bonus credits to a partner’s verified signups.'}
          </Typography>
          {!search && (
            <Button
              startDecorator={<AddIcon />}
              onClick={openCreate}
              sx={{ mt: 1 }}
              data-testid="partner-rule-empty-add-btn"
            >
              Add your first rule
            </Button>
          )}
        </Sheet>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table stickyHeader hoverRow sx={{ '--TableCell-headBackground': 'var(--joy-palette-background-level1)' }}>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Label</th>
                <th>Entitlements</th>
                <th style={{ width: 140, textAlign: 'right' }}>Signup credits</th>
                <th style={{ width: 90, textAlign: 'center' }}>Org</th>
                <th style={{ width: 90, textAlign: 'center' }}>Enabled</th>
                <th style={{ width: 150, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => {
                const toggling = toggleMutation.isPending && toggleMutation.variables?.id === rule.id;
                return (
                  <tr
                    key={rule.id}
                    data-testid={`partner-rule-row-${rule.domain}`}
                    style={{ opacity: rule.enabled ? 1 : 0.55, transition: 'opacity 120ms ease' }}
                  >
                    <td>
                      <Typography level="body-sm" fontWeight="lg">
                        {rule.domain}
                      </Typography>
                    </td>
                    <td>
                      {rule.label || (
                        <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                          -
                        </Typography>
                      )}
                    </td>
                    <td>
                      {rule.entitlements.length ? (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {rule.entitlements.map(key => (
                            <Chip key={key} size="sm" variant="soft" color="primary">
                              {key}
                            </Chip>
                          ))}
                        </Stack>
                      ) : (
                        <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                          none
                        </Typography>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {rule.signupCredits > 0 ? (
                        <Typography level="body-sm">{rule.signupCredits.toLocaleString()}</Typography>
                      ) : (
                        <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                          none
                        </Typography>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {rule.organizationId ? (
                        <Tooltip title="Verified signups on this domain are auto-added to an organization">
                          <Chip
                            size="sm"
                            variant="soft"
                            color="success"
                            data-testid={`partner-rule-org-${rule.domain}`}
                          >
                            linked
                          </Chip>
                        </Tooltip>
                      ) : (
                        <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                          -
                        </Typography>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Tooltip title={rule.enabled ? 'Enabled - click to disable' : 'Disabled - click to enable'}>
                        <Switch
                          size="sm"
                          color={rule.enabled ? 'success' : 'neutral'}
                          checked={rule.enabled}
                          disabled={toggling}
                          onChange={() => toggleMutation.mutate(rule)}
                          data-testid={`partner-rule-toggle-${rule.domain}`}
                        />
                      </Tooltip>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {rule.organizationId && (
                          <Tooltip title="Backfill existing verified users into the organization">
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="success"
                              onClick={() => setBackfillTarget(rule)}
                              data-testid={`partner-rule-backfill-${rule.domain}`}
                            >
                              <GroupAddIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip title="Edit">
                          <IconButton
                            size="sm"
                            variant="plain"
                            onClick={() => openEdit(rule)}
                            data-testid={`partner-rule-edit-${rule.domain}`}
                          >
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="danger"
                            onClick={() => setDeleteTarget(rule)}
                            data-testid={`partner-rule-delete-${rule.domain}`}
                          >
                            <DeleteIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      {totalPages > 1 && (
        <Stack direction="row" spacing={1} justifyContent="center" alignItems="center" sx={{ mt: 2 }}>
          <Button size="sm" variant="outlined" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            Previous
          </Button>
          <Typography level="body-sm">
            Page {page} of {totalPages}
          </Typography>
          <Button size="sm" variant="outlined" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            Next
          </Button>
        </Stack>
      )}

      {/* Create / edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <ModalDialog sx={{ minWidth: 440, maxWidth: 540 }} data-testid="partner-rule-modal">
          <ModalClose />
          <Typography level="h4">{editing ? 'Edit signup rule' : 'Add signup rule'}</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: -0.5 }}>
            {editing ? editing.domain : 'Grant entitlements and bonus credits to a partner domain.'}
          </Typography>
          <Divider sx={{ my: 1 }} />

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
                Pick from the products the registry recognizes, or type a lake grant as{' '}
                <code>datalake:&lt;slug&gt;</code> and press Enter. A new product key must be added to the entitlement
                registry before it appears in the list.
              </FormHelperText>
            </FormControl>

            <FormControl>
              <FormLabel>Signup credits</FormLabel>
              <Input
                type="number"
                slotProps={{ input: { min: 0 } }}
                endDecorator={<Typography level="body-xs">credits</Typography>}
                value={form.signupCredits}
                onChange={e => setForm(f => ({ ...f, signupCredits: e.target.value }))}
                data-testid="partner-rule-credits-input"
              />
              <FormHelperText>One-time bonus granted at email verification. 0 = access only, no bonus.</FormHelperText>
            </FormControl>

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
                Optional. Verified signups on this domain are auto-added to this organization as members. Existing users
                are not touched - use the backfill action for those. Leave empty for no org.
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
              <Button variant="plain" color="neutral" onClick={() => setModalOpen(false)}>
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
        </ModalDialog>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <ModalDialog role="alertdialog" variant="outlined" data-testid="partner-rule-delete-modal">
          <Typography level="h4" startDecorator={<WarningRoundedIcon sx={{ color: 'danger.500' }} />}>
            Delete signup rule
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Typography level="body-sm">
            Delete the rule for <b>{deleteTarget?.domain}</b>? New signups on this domain will stop receiving its
            entitlements and bonus credits. Existing users keep what they already have.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setDeleteTarget(null)}
              data-testid="partner-rule-delete-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              color="danger"
              loading={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              data-testid="partner-rule-delete-confirm-btn"
            >
              Delete rule
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Backfill: preview (dry-run) then confirm */}
      <Modal open={!!backfillTarget} onClose={() => setBackfillTarget(null)}>
        <ModalDialog sx={{ minWidth: 440, maxWidth: 540 }} data-testid="partner-rule-backfill-modal">
          <ModalClose />
          <Typography level="h4" startDecorator={<GroupAddIcon />}>
            Backfill into organization
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Typography level="body-sm">
            Add existing <b>verified</b> users on <b>{backfillTarget?.domain}</b>
            {' to '}
            this rule&apos;s organization. Users already in the org are skipped, and no one is ever removed.
          </Typography>

          {backfillPreviewLoading ? (
            <LinearProgress sx={{ my: 2 }} />
          ) : (
            <Sheet
              variant="soft"
              sx={{ borderRadius: 'sm', p: 2, my: 1.5 }}
              data-testid="partner-rule-backfill-preview"
            >
              <Typography level="title-md">
                {backfillPreview?.matched ?? 0} user{(backfillPreview?.matched ?? 0) === 1 ? '' : 's'} will be added
              </Typography>
              {backfillPreview && (
                <Typography
                  level="body-sm"
                  sx={{ mt: 0.5, color: 'text.secondary' }}
                  data-testid="partner-rule-backfill-seat-impact"
                >
                  {backfillPreview.stripeBilled
                    ? `Stripe-billed org: seat ceiling stays at ${backfillPreview.seats}; candidates past it are rejected (add seats to admit them).`
                    : backfillPreview.projectedSeats > backfillPreview.seats
                      ? `Seat ceiling: ${backfillPreview.seats} -> ${backfillPreview.projectedSeats} (raised to fit)`
                      : `Seat ceiling: ${backfillPreview.seats} (unchanged; everyone fits under it)`}
                </Typography>
              )}
              {!!backfillPreview?.sample.length && (
                <Stack spacing={0.25} sx={{ mt: 1, maxHeight: 180, overflow: 'auto' }}>
                  {backfillPreview.sample.map(user => (
                    <Typography key={user.id} level="body-xs" sx={{ color: 'text.tertiary' }}>
                      {user.email || user.name}
                    </Typography>
                  ))}
                  {backfillPreview.matched > backfillPreview.sample.length && (
                    <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                      + {backfillPreview.matched - backfillPreview.sample.length} more
                    </Typography>
                  )}
                </Stack>
              )}
            </Sheet>
          )}

          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1 }}>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setBackfillTarget(null)}
              data-testid="partner-rule-backfill-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              color="success"
              loading={backfillMutation.isPending}
              disabled={backfillPreviewLoading || !backfillPreview?.matched}
              onClick={() => backfillTarget && backfillMutation.mutate(backfillTarget)}
              data-testid="partner-rule-backfill-confirm-btn"
            >
              Add {backfillPreview?.matched ?? 0} user{(backfillPreview?.matched ?? 0) === 1 ? '' : 's'}
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
}
