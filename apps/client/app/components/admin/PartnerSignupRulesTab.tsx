import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import type { IPartnerSignupRuleDocument } from '@bike4mind/common';
import {
  fetchPartnerSignupRules,
  createPartnerSignupRule,
  updatePartnerSignupRule,
  deletePartnerSignupRule,
} from '@client/app/utils/partnerSignupRuleAPICalls';

const QUERY_KEY = 'partner-signup-rules';
const PAGE_LIMIT = 25;

type FormState = {
  domain: string;
  label: string;
  entitlements: string; // comma/space separated in the form; parsed to string[] on submit
  signupCredits: string;
  notes: string;
  enabled: boolean;
};

const emptyForm: FormState = {
  domain: '',
  label: '',
  entitlements: '',
  signupCredits: '0',
  notes: '',
  enabled: true,
};

/** Parse the comma/space separated entitlements field into a normalized, de-duplicated list. */
const parseEntitlements = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[,\s]+/)
      .map(token => token.trim().toLowerCase())
      .filter(Boolean)
  ),
];

const ruleToForm = (rule: IPartnerSignupRuleDocument): FormState => ({
  domain: rule.domain,
  label: rule.label ?? '',
  entitlements: (rule.entitlements ?? []).join(', '),
  signupCredits: String(rule.signupCredits ?? 0),
  notes: rule.notes ?? '',
  enabled: rule.enabled,
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
        entitlements: parseEntitlements(form.entitlements),
        signupCredits: Number(form.signupCredits),
        label: form.label.trim(),
        notes: form.notes.trim(),
        enabled: form.enabled,
      };
      if (editing) {
        return updatePartnerSignupRule(editing.id, payload);
      }
      return createPartnerSignupRule({ domain: form.domain, ...payload });
    },
    onSuccess: () => {
      invalidate();
      setModalOpen(false);
    },
    onError: (error: unknown) => {
      setFormError(extractApiError(error));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => updatePartnerSignupRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePartnerSignupRule(id),
    onSuccess: invalidate,
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
  };

  const handleDelete = (rule: IPartnerSignupRuleDocument) => {
    if (window.confirm(`Delete the signup rule for "${rule.domain}"? Future signups on this domain lose the grant.`)) {
      deleteMutation.mutate(rule.id);
    }
  };

  const rules = data?.data ?? [];
  const totalPages = data?.meta.totalPages ?? 1;

  return (
    <Box sx={{ p: 2 }} data-testid="partner-signup-rules-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography level="h4">Partner Signup Rules</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            Auto-grant entitlements and one-time signup credits to verified emails on a partner domain.
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

      <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
        <Table stickyHeader hoverRow>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Label</th>
              <th>Entitlements</th>
              <th style={{ width: 120 }}>Signup credits</th>
              <th style={{ width: 90 }}>Enabled</th>
              <th style={{ width: 110 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && !isPending && (
              <tr>
                <td colSpan={6}>
                  <Typography level="body-sm" sx={{ p: 2, textAlign: 'center', color: 'neutral.500' }}>
                    No partner signup rules yet.
                  </Typography>
                </td>
              </tr>
            )}
            {rules.map(rule => (
              <tr key={rule.id} data-testid={`partner-rule-row-${rule.domain}`}>
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
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {rule.entitlements.map(key => (
                      <Chip key={key} size="sm" variant="soft">
                        {key}
                      </Chip>
                    ))}
                  </Stack>
                </td>
                <td>{rule.signupCredits.toLocaleString()}</td>
                <td>
                  <Switch
                    checked={rule.enabled}
                    onChange={() => toggleMutation.mutate(rule)}
                    data-testid={`partner-rule-toggle-${rule.domain}`}
                  />
                </td>
                <td>
                  <Stack direction="row" spacing={0.5}>
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
                        onClick={() => handleDelete(rule)}
                        data-testid={`partner-rule-delete-${rule.domain}`}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Sheet>

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

      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <ModalDialog sx={{ minWidth: 420, maxWidth: 520 }} data-testid="partner-rule-modal">
          <ModalClose />
          <Typography level="h4">{editing ? 'Edit signup rule' : 'Add signup rule'}</Typography>

          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <FormControl required>
              <FormLabel>Domain</FormLabel>
              <Input
                placeholder="partner.com"
                value={form.domain}
                disabled={!!editing}
                onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                data-testid="partner-rule-domain-input"
              />
              {editing && (
                <FormHelperText>Domain is the key and cannot be changed. Delete and re-add to move it.</FormHelperText>
              )}
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
              <Input
                placeholder="optihashi:pro, another:pro"
                value={form.entitlements}
                onChange={e => setForm(f => ({ ...f, entitlements: e.target.value }))}
                data-testid="partner-rule-entitlements-input"
              />
              <FormHelperText>Comma or space separated. Lowercased on save.</FormHelperText>
            </FormControl>

            <FormControl>
              <FormLabel>Signup credits</FormLabel>
              <Input
                type="number"
                slotProps={{ input: { min: 0 } }}
                value={form.signupCredits}
                onChange={e => setForm(f => ({ ...f, signupCredits: e.target.value }))}
                data-testid="partner-rule-credits-input"
              />
              <FormHelperText>One-time bonus granted at email verification. 0 = access only, no bonus.</FormHelperText>
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

            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
              <FormLabel>Enabled</FormLabel>
              <Switch
                checked={form.enabled}
                onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                data-testid="partner-rule-enabled-switch"
              />
            </FormControl>

            {formError && (
              <Alert color="danger" data-testid="partner-rule-form-error">
                {formError}
              </Alert>
            )}

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
        </ModalDialog>
      </Modal>
    </Box>
  );
}

/** Pull a human message out of an axios-style error, falling back to a generic string. */
function extractApiError(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { message?: string; error?: string } } }).response;
    const message = response?.data?.message ?? response?.data?.error;
    if (message) return message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
