import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { z } from 'zod';
import { USERNAME_MAX_LENGTH, USERNAME_RULES_MESSAGE, usernameSchema } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview } from '../../../shared';
import { adminUpdateErrorMessage } from './useAdminUserUpdate';
import type { ProfileDialogProps } from './profileActions';
import type { AdminUserProfile } from '../userProfileModel';

type Field = 'name' | 'username' | 'email';
type FieldState = { value: string; changed: boolean; error: string | null };

const FIELDS: readonly { field: Field; label: string; maxLength: number }[] = [
  { field: 'name', label: 'Name', maxLength: 200 },
  { field: 'username', label: 'Username', maxLength: USERNAME_MAX_LENGTH },
  { field: 'email', label: 'Email', maxLength: 254 },
];

const INVALID_EMAIL = 'Enter a valid email address.';
const MISSING_NAME = 'Enter a name.';
// Same normalization as PATCH /api/admin/users/[userId]/profile.
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

const unchanged = (value: string): FieldState => ({ value, changed: false, error: null });

// An untouched field is never validated, so a legacy username that predates the rules does not block the save.
const fieldState = (user: AdminUserProfile, field: Field, raw: string): FieldState => {
  if (field === 'name') {
    const value = raw.trim();
    const changed = value !== (user.name ?? '');
    return { value, changed, error: changed && !value ? MISSING_NAME : null };
  }
  if (field === 'username') {
    if (raw === (user.username ?? '')) return unchanged(raw);
    const parsed = usernameSchema.safeParse(raw);
    if (!parsed.success) return { value: raw, changed: true, error: USERNAME_RULES_MESSAGE };
    return { value: parsed.data, changed: parsed.data !== user.username, error: null };
  }
  const current = user.email ?? '';
  if (raw.trim().toLowerCase() === current.toLowerCase()) return unchanged(current);
  const parsed = emailSchema.safeParse(raw);
  return parsed.success
    ? { value: parsed.data, changed: true, error: null }
    : { value: raw, changed: true, error: INVALID_EMAIL };
};

/** The field and message of a 400/409 the route tied to one input, e.g. a username another account holds. */
const serverFieldError = (error: unknown): { field: Field; message: string } | null => {
  const body: unknown = isAxiosError(error) ? error.response?.data : undefined;
  if (!body || typeof body !== 'object') return null;
  const { field, error: message } = body as { field?: unknown; error?: unknown };
  const known = FIELDS.find(entry => entry.field === field);
  return known && typeof message === 'string' ? { field: known.field, message } : null;
};

const EmailNote: React.FC<{ user: AdminUserProfile; email: string }> = ({ user, email }) => (
  <Typography level="body-sm" data-testid="edit-profile-dialog-email-note">
    We email a confirmation link to {email}.{' '}
    {user.email
      ? `The account keeps ${user.email} until the link is clicked, and ${user.email} is told about the request.`
      : 'The address is added once the link is clicked.'}
    {user.pendingEmail && ` This replaces the pending change to ${user.pendingEmail}.`}
  </Typography>
);

/** Name and username change at once; a new email goes through the user's own verification flow. */
export const EditProfileDialog: React.FC<ProfileDialogProps> = ({ user, onClose }) => {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<Field, string>>({
    name: user.name ?? '',
    username: user.username ?? '',
    email: user.email ?? '',
  });
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({});

  const states = Object.fromEntries(
    FIELDS.map(({ field }) => [field, fieldState(user, field, draft[field])])
  ) as Record<Field, FieldState>;
  const errorFor = (field: Field) => serverErrors[field] ?? states[field].error;
  const changedFields = FIELDS.filter(({ field }) => states[field].changed);
  const hasErrors = FIELDS.some(({ field }) => errorFor(field));
  const emailChange = states.email.changed && !states.email.error ? states.email.value : null;

  const edit = (field: Field) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(previous => ({ ...previous, [field]: event.target.value }));
    setServerErrors(previous => ({ ...previous, [field]: undefined }));
  };

  const handleConfirm = async (reason: string) => {
    const body = Object.fromEntries(changedFields.map(({ field }) => [field, states[field].value]));
    try {
      await api.patch(`/api/admin/users/${encodeURIComponent(user.id)}/profile`, { ...body, reason });
    } catch (error) {
      const inline = serverFieldError(error);
      if (inline) setServerErrors(previous => ({ ...previous, [inline.field]: inline.message }));
      else if (!isStepUpCancelled(error)) toast.error(adminUpdateErrorMessage(error, 'The profile was not saved.'));
      throw error;
    }
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users', user.id] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    toast.success(emailChange ? `Profile saved. Confirmation link sent to ${emailChange}.` : 'Profile saved');
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Edit profile"
      description="Name and username change right away. A new email only takes effect once the user confirms it from that address."
      reasonPresets={ADMIN_REASON_PRESETS.profileEdit}
      confirmLabel="Save profile"
      blockedReason={
        hasErrors
          ? 'Fix the highlighted field to continue.'
          : changedFields.length === 0
            ? 'Change the name, username or email.'
            : null
      }
      onConfirm={handleConfirm}
      data-testid="edit-profile-dialog"
    >
      {FIELDS.map(({ field, label, maxLength }) => (
        <FormControl key={field} error={!!errorFor(field)}>
          <FormLabel>{label}</FormLabel>
          <Input
            autoFocus={field === 'name'}
            value={draft[field]}
            onChange={edit(field)}
            slotProps={{
              input: {
                maxLength,
                type: field === 'email' ? 'email' : 'text',
                'data-testid': `edit-profile-dialog-${field}-input`,
              },
            }}
          />
          {errorFor(field) && (
            <FormHelperText data-testid={`edit-profile-dialog-${field}-error`}>{errorFor(field)}</FormHelperText>
          )}
        </FormControl>
      ))}
      {!hasErrors &&
        changedFields.map(({ field, label }) => (
          <Stack key={field} gap={0.5}>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {label}
            </Typography>
            <ChangePreview
              before={user[field] || '-'}
              after={states[field].value}
              delta={field === 'email' ? { label: 'Needs verification', tone: 'warn' } : undefined}
              data-testid={`edit-profile-dialog-preview-${field}`}
            />
          </Stack>
        ))}
      {!hasErrors && emailChange && <EmailNote user={user} email={emailChange} />}
    </ActionDialog>
  );
};
