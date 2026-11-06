import { useState } from 'react';
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Switch,
} from '@mui/joy';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  requiresGrantReason,
  updateRequiresGrantReason,
  type GrantPackageReasonPolicy,
  type IGrantPackageDocument,
} from '@bike4mind/common';
import {
  ADMIN_REASON_HINT,
  ADMIN_REASON_PRESETS,
  AdminDialog,
  EMPTY_ADMIN_REASON,
  ReasonPicker,
  composeAdminReason,
  isAdminReasonComplete,
  type AdminReasonDraft,
} from '@client/app/components/admin/shared';
import { createGrantPackage, updateGrantPackage } from '@client/app/utils/grantPackageAPICalls';
import { getErrorMessage } from '@client/app/utils/error';

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Null creates a package; otherwise the package being edited. */
  editing: IGrantPackageDocument | null;
  reasonPolicy: GrantPackageReasonPolicy;
};

type Draft = { name: string; credits: string; totalCap: string; dailyCap: string; active: boolean };

const toDraft = (pkg: IGrantPackageDocument | null): Draft => ({
  name: pkg?.name ?? '',
  credits: pkg ? String(pkg.credits) : '',
  totalCap: pkg?.totalCap != null ? String(pkg.totalCap) : '',
  dailyCap: pkg?.dailyCap != null ? String(pkg.dailyCap) : '',
  active: pkg?.active ?? true,
});

const WHOLE = /^\d+$/;

/** Empty means unlimited; anything else must be a whole number of at least 1. */
const parseCap = (value: string): number | null | 'invalid' => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return WHOLE.test(trimmed) && Number(trimmed) >= 1 ? Number(trimmed) : 'invalid';
};

export function GrantPackageFormModal({ open, onClose, onSaved, editing, reasonPolicy }: Props) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(editing));
  const [reason, setReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);
  const [formError, setFormError] = useState<string | null>(null);

  const creditsText = draft.credits.trim();
  const credits = WHOLE.test(creditsText) ? Number(creditsText) : null;
  const totalCap = parseCap(draft.totalCap);
  const dailyCap = parseCap(draft.dailyCap);
  const valid = draft.name.trim() !== '' && credits !== null && totalCap !== 'invalid' && dailyCap !== 'invalid';

  const reasonRequired =
    valid &&
    (editing
      ? updateRequiresGrantReason(editing, { credits, totalCap, active: draft.active }, reasonPolicy)
      : requiresGrantReason({ credits, totalCap }, reasonPolicy));

  const save = useMutation({
    mutationFn: () => {
      if (!valid) throw new Error('Fix the highlighted fields first');
      const body = {
        name: draft.name.trim(),
        credits,
        totalCap,
        dailyCap,
        active: draft.active,
        ...(reasonRequired ? { reason: composeAdminReason(reason) } : {}),
      };
      return editing ? updateGrantPackage(editing.id, body) : createGrantPackage(body);
    },
    onSuccess: pkg => {
      toast.success(editing ? `Updated ${pkg.name}` : `Created ${pkg.name}`);
      onSaved();
      onClose();
    },
    onError: (error: unknown) => setFormError(getErrorMessage(error)),
  });

  const blocked = !valid
    ? 'Fill in a name, credits and valid caps.'
    : reasonRequired && !isAdminReasonComplete(reason)
      ? ADMIN_REASON_HINT
      : null;
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));

  return (
    <AdminDialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit grant package' : 'Create grant package'}
      width={520}
      data-testid="grant-package-form"
    >
      <DialogContent>
        <Stack gap={1.5}>
          {formError && (
            <Alert color="danger" data-testid="grant-package-form-error">
              {formError}
            </Alert>
          )}
          <FormControl required>
            <FormLabel>Name</FormLabel>
            <Input
              value={draft.name}
              onChange={e => set({ name: e.target.value })}
              slotProps={{ input: { 'data-testid': 'grant-package-name-input' } }}
            />
          </FormControl>
          <FormControl required error={creditsText !== '' && credits === null}>
            <FormLabel>Credits per signup</FormLabel>
            <Input
              value={draft.credits}
              inputMode="numeric"
              onChange={e => set({ credits: e.target.value })}
              slotProps={{ input: { 'data-testid': 'grant-package-credits-input' } }}
            />
          </FormControl>
          <Stack direction="row" gap={1.5}>
            <FormControl error={totalCap === 'invalid'} sx={{ flex: 1 }}>
              <FormLabel>Total signups cap</FormLabel>
              <Input
                value={draft.totalCap}
                inputMode="numeric"
                placeholder="Unlimited"
                onChange={e => set({ totalCap: e.target.value })}
                slotProps={{ input: { 'data-testid': 'grant-package-total-cap-input' } }}
              />
            </FormControl>
            <FormControl error={dailyCap === 'invalid'} sx={{ flex: 1 }}>
              <FormLabel>Daily signups cap</FormLabel>
              <Input
                value={draft.dailyCap}
                inputMode="numeric"
                placeholder="Unlimited"
                onChange={e => set({ dailyCap: e.target.value })}
                slotProps={{ input: { 'data-testid': 'grant-package-daily-cap-input' } }}
              />
            </FormControl>
          </Stack>
          <FormHelperText>Leave a cap empty for no limit. Daily caps reset at midnight UTC.</FormHelperText>
          {editing && (
            <FormControl orientation="horizontal" sx={{ gap: 1 }}>
              <Switch
                checked={draft.active}
                onChange={e => set({ active: e.target.checked })}
                slotProps={{ input: { 'data-testid': 'grant-package-active-switch' } }}
              />
              <FormLabel>Active</FormLabel>
            </FormControl>
          )}
          {reasonRequired && (
            <>
              <Alert color="warning" data-testid="grant-package-large-grant-alert">
                This package can hand out more credits than the large-grant threshold, so it needs a reason.
              </Alert>
              <ReasonPicker
                presets={ADMIN_REASON_PRESETS.grantPackage}
                value={reason}
                onChange={setReason}
                data-testid="grant-package-reason"
              />
            </>
          )}
          {blocked && <FormHelperText data-testid="grant-package-blocked-hint">{blocked}</FormHelperText>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={blocked !== null}
          data-testid="grant-package-save-btn"
        >
          {editing ? 'Save package' : 'Create package'}
        </Button>
        <Button variant="plain" color="neutral" onClick={onClose} data-testid="grant-package-cancel-btn">
          Cancel
        </Button>
      </DialogActions>
    </AdminDialog>
  );
}
