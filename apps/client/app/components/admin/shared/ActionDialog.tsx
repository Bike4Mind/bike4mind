import React, { useId, useState } from 'react';
import { Button, DialogContent, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { AdminDialog } from './AdminDialog';
import {
  ADMIN_REASON_HINT,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
} from './adminReason';
import { ReasonPicker } from './ReasonPicker';
import { Kbd } from './Kbd';

type TypedConfirm = {
  /** The exact text the admin must type, e.g. the account email. */
  expected: string;
  /** What `expected` is, for the label: "Type the email address to confirm". */
  noun: string;
};

export type ActionDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Verb phrase naming the command: "Adjust credits", "Delete user". */
  title: string;
  /** The consequence in one or two sentences. */
  description?: React.ReactNode;
  /** Before/after preview, a bulk dry-run summary, or extra inputs the command needs. */
  children?: React.ReactNode;
  reasonPresets: readonly string[];
  /** False while the endpoint has no reason field; see ReasonPicker's `audited`. */
  reasonAudited?: boolean;
  /** Repeats the consequence where it helps: "Set balance to 0". */
  confirmLabel: string;
  /**
   * Receives the composed audit reason. The caller closes the dialog once the write succeeds and
   * surfaces its own failures: a rejection is not caught here and leaves the dialog open.
   */
  onConfirm: (reason: string) => void | Promise<void>;
  /** Solid danger is reserved for this final confirm of a destructive command. */
  tone?: 'neutral' | 'danger';
  /** Why the caller's own inputs block the commit, shown in place; `null` when they are ready. */
  blockedReason?: string | null;
  /** Irreversible commands: the admin types `expected` before the commit unlocks. */
  typedConfirm?: TypedConfirm;
  pending?: boolean;
  /** Derived ids: `<id>-reason-input`, `<id>-confirm-btn`, `<id>-cancel-btn`, `<id>-hint`, `<id>-typed-input`. */
  'data-testid': string;
  /** Overrides individual derived ids where an existing test or page object depends on them. */
  testIds?: Partial<Record<'reason' | 'confirm' | 'typed', string>>;
};

/**
 * The one dialog for audited admin writes (DESIGN_GUIDE.md section 4), built on the AdminDialog
 * shell, which supplies the focus trap, Esc to close and focus return to the opener.
 */
export const ActionDialog: React.FC<ActionDialogProps> = props => (
  <AdminDialog
    open={props.open}
    onClose={props.onClose}
    title={props.title}
    width={560}
    data-testid={props['data-testid']}
  >
    <ActionDialogForm {...props} />
  </AdminDialog>
);

// Separate from ActionDialog so its state lives inside the Modal and resets on every open.
const ActionDialogForm: React.FC<ActionDialogProps> = ({
  onClose,
  description,
  children,
  reasonPresets,
  reasonAudited = true,
  confirmLabel,
  onConfirm,
  tone = 'neutral',
  blockedReason = null,
  typedConfirm,
  pending = false,
  'data-testid': testId,
  testIds = {},
}) => {
  const hintId = useId();
  const typedInputId = useId();
  const [reason, setReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);
  const [typedValue, setTypedValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const typedMatches = !typedConfirm || typedValue.trim() === typedConfirm.expected;
  const hint =
    blockedReason ??
    (!isAdminReasonComplete(reason) ? ADMIN_REASON_HINT : null) ??
    (!typedMatches && typedConfirm ? `Type the ${typedConfirm.noun} exactly to confirm.` : null);
  const busy = pending || submitting;

  const handleConfirm = async () => {
    if (hint || busy) return;
    setSubmitting(true);
    try {
      await onConfirm(composeAdminReason(reason));
    } catch {
      // The caller reports its own failure (toast); a rejection only means the dialog stays open.
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void handleConfirm();
  };

  return (
    <Stack component="form" noValidate onSubmit={handleSubmit} gap={1}>
      <DialogContent sx={{ gap: 2 }}>
        {description && (
          <Typography level="body-sm" component="div">
            {description}
          </Typography>
        )}
        {children}
        <ReasonPicker
          presets={reasonPresets}
          value={reason}
          onChange={setReason}
          audited={reasonAudited}
          data-testid={testIds.reason ?? `${testId}-reason-input`}
        />
        {typedConfirm && (
          <FormControl required>
            <FormLabel htmlFor={typedInputId}>
              This cannot be undone. Type{' '}
              <Typography component="code" fontFamily="code" data-testid={`${testId}-typed-expected`}>
                {typedConfirm.expected}
              </Typography>{' '}
              to confirm.
            </FormLabel>
            <Input
              value={typedValue}
              onChange={event => setTypedValue(event.target.value)}
              autoComplete="off"
              slotProps={{ input: { id: typedInputId, 'data-testid': testIds.typed ?? `${testId}-typed-input` } }}
            />
          </FormControl>
        )}
      </DialogContent>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="flex-end"
        gap={1}
        flexWrap="wrap"
        sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
      >
        {hint ? (
          <Typography id={hintId} level="body-sm" data-testid={`${testId}-hint`} sx={{ mr: 'auto' }}>
            {hint}
          </Typography>
        ) : (
          <Typography level="body-xs" sx={{ mr: 'auto', fontWeight: 400 }}>
            <Kbd>Enter</Kbd> to apply
          </Typography>
        )}
        <Button variant="plain" color="neutral" onClick={onClose} data-testid={`${testId}-cancel-btn`}>
          Cancel
        </Button>
        <Button
          variant="solid"
          color={tone === 'danger' ? 'danger' : 'primary'}
          disabled={!!hint}
          loading={busy}
          aria-describedby={hint ? hintId : undefined}
          type="submit"
          data-testid={testIds.confirm ?? `${testId}-confirm-btn`}
        >
          {confirmLabel}
        </Button>
      </Stack>
    </Stack>
  );
};
