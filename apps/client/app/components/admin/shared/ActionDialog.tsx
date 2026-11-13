import React, { useId, useState } from 'react';
import { Button, DialogContent, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { AdminDialog, AdminDialogFooter } from './AdminDialog';
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
  reasonRequired?: boolean;
  /** Repeats the consequence where it helps: "Set balance to 0". */
  confirmLabel: string;
  /**
   * Receives the composed audit reason. The caller closes the dialog once the write succeeds and
   * surfaces its own failures: a rejection is not caught here and leaves the dialog open.
   */
  onConfirm: (reason: string) => void | Promise<void>;
  /**
   * Solid danger is reserved for this final confirm of a destructive command. Also set as the confirm
   * button's `data-tone`, so a test reads the tone without matching Joy's color class.
   */
  tone?: 'neutral' | 'danger';
  /** Why the caller's own inputs block the commit, shown in place; `null` when they are ready. */
  blockedReason?: string | null;
  /** Irreversible commands: the admin types `expected` before the commit unlocks. */
  typedConfirm?: TypedConfirm;
  pending?: boolean;
  /**
   * A second commit beside the primary one, gated the same way, e.g. "Save and next" in a review queue.
   * Its button id is `<id>-secondary-btn`; the reason draft is kept for the caller's next item.
   */
  secondaryAction?: { label: string; onConfirm: (reason: string) => void | Promise<void> };
  /**
   * Keeps Cancel enabled while the write is in flight, for a caller whose `onConfirm` stops at
   * `onClose` (a run of writes that checks between them and leaves the rest unsent).
   */
  cancelStopsWrite?: boolean;
  /** Seeds the reason when the dialog opens, still editable: an accepted AI suggestion prefills one. */
  initialReason?: AdminReasonDraft;
  /** Changing it remounts the form, re-seeding `initialReason` and clearing typed input in an open dialog. */
  formKey?: string | number;
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
    <ActionDialogForm key={props.formKey} {...props} />
  </AdminDialog>
);

// Separate from ActionDialog so its state lives inside the Modal and resets on every open.
const ActionDialogForm: React.FC<ActionDialogProps> = ({
  onClose,
  description,
  children,
  reasonPresets,
  reasonAudited = true,
  reasonRequired = true,
  confirmLabel,
  onConfirm,
  tone = 'neutral',
  blockedReason = null,
  typedConfirm,
  pending = false,
  secondaryAction,
  cancelStopsWrite = false,
  initialReason = EMPTY_ADMIN_REASON,
  'data-testid': testId,
  testIds = {},
}) => {
  const hintId = useId();
  const typedInputId = useId();
  const [reason, setReason] = useState<AdminReasonDraft>(initialReason);
  const [typedValue, setTypedValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const typedMatches = !typedConfirm || typedValue.trim() === typedConfirm.expected;
  const hint =
    blockedReason ??
    (reasonRequired && !isAdminReasonComplete(reason) ? ADMIN_REASON_HINT : null) ??
    (!typedMatches && typedConfirm ? `Type the ${typedConfirm.noun} exactly to confirm.` : null);
  const busy = pending || submitting;

  const handleConfirm = async (confirm: (reason: string) => void | Promise<void> = onConfirm) => {
    if (hint || busy) return;
    setSubmitting(true);
    try {
      await confirm(composeAdminReason(reason));
    } catch {
      // The caller reports its own failure (toast); a rejection only means the dialog stays open.
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // Portaled child dialogs must not also submit an enclosing admin command.
    event.stopPropagation();
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
        {reasonRequired && (
          <ReasonPicker
            presets={reasonPresets}
            value={reason}
            onChange={setReason}
            audited={reasonAudited}
            data-testid={testIds.reason ?? `${testId}-reason-input`}
          />
        )}
        {typedConfirm && (
          <FormControl required>
            {/* One inline span: FormLabel is a flex row, which drops bare space text nodes around the code and
                wraps its own required star onto a line of its own after a long name. Typography renders as a
                block, so the code is forced inline, and the star is drawn here on a non-breaking space. */}
            <FormLabel htmlFor={typedInputId} slotProps={{ asterisk: { sx: { display: 'none' } } }}>
              <span>
                This cannot be undone. Type{' '}
                <Typography
                  component="code"
                  fontFamily="code"
                  sx={{ display: 'inline' }}
                  data-testid={`${testId}-typed-expected`}
                >
                  {typedConfirm.expected}
                </Typography>{' '}
                to confirm.
                <Typography
                  component="span"
                  aria-hidden="true"
                  sx={{ display: 'inline', color: 'var(--FormLabel-asteriskColor)' }}
                  data-testid={`${testId}-typed-required`}
                >
                  {'\u00a0*'}
                </Typography>
              </span>
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
      <AdminDialogFooter>
        {hint ? (
          <Typography id={hintId} level="body-sm" data-testid={`${testId}-hint`} sx={{ mr: 'auto' }}>
            {hint}
          </Typography>
        ) : (
          <Typography level="body-xs" sx={{ mr: 'auto', fontWeight: 400 }}>
            <Kbd>Enter</Kbd> to apply
          </Typography>
        )}
        {/* Held while the write is in flight (closing would not cancel it) unless the caller stops at close. */}
        <Button
          variant="plain"
          color="neutral"
          onClick={onClose}
          disabled={busy && !cancelStopsWrite}
          data-testid={`${testId}-cancel-btn`}
        >
          Cancel
        </Button>
        {secondaryAction && (
          <Button
            variant="outlined"
            color="neutral"
            disabled={!!hint || busy}
            aria-describedby={hint ? hintId : undefined}
            onClick={() => void handleConfirm(secondaryAction.onConfirm)}
            data-testid={`${testId}-secondary-btn`}
          >
            {secondaryAction.label}
          </Button>
        )}
        <Button
          variant="solid"
          color={tone === 'danger' ? 'danger' : 'primary'}
          disabled={!!hint}
          loading={busy}
          aria-describedby={hint ? hintId : undefined}
          type="submit"
          data-tone={tone}
          data-testid={testIds.confirm ?? `${testId}-confirm-btn`}
        >
          {confirmLabel}
        </Button>
      </AdminDialogFooter>
    </Stack>
  );
};
