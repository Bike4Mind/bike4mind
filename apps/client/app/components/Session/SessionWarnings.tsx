import { Box, Button, Typography } from '@mui/joy';
import type { ReactNode } from 'react';
import { CreditOfferActions } from './CreditOfferActions';
import { ComposerNote } from './ComposerNote';
import { formatCreditAmount } from '@client/app/utils/formatCredits';

const NO_MODELS_COPY = {
  denied: {
    title: "You don't have access to any AI models.",
    description: 'Please contact your administrator to request the appropriate permissions.',
  },
  loadError: {
    title: "Couldn't load AI models.",
    description: 'Check your connection and try again.',
  },
};

/** The no-models notice as one sentence, for the editor's aria-placeholder. */
export function noModelsPlaceholder(loadError: boolean): string {
  const copy = loadError ? NO_MODELS_COPY.loadError : NO_MODELS_COPY.denied;
  return `${copy.title} ${copy.description}`;
}

/**
 * What the composer shows in place of its placeholder when there is no model to send with: a red
 * line and a description under it, inside the box rather than a banner over it. A failed load
 * gets Retry beside the text.
 */
export function NoModelsPlaceholder({ loadError, onRetry }: { loadError: boolean; onRetry?: () => void }) {
  const copy = loadError ? NO_MODELS_COPY.loadError : NO_MODELS_COPY.denied;
  return (
    <Box data-testid="session-no-models-placeholder" sx={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
      <Box>
        <Typography
          data-testid="no-models-warning-text"
          sx={theme => ({
            fontSize: '13px',
            fontWeight: 600,
            lineHeight: 1.4,
            color: theme.palette.mode === 'dark' ? theme.vars.palette.danger[400] : theme.vars.palette.danger[500],
          })}
        >
          {copy.title}
        </Typography>
        <Typography sx={{ fontSize: '12px', lineHeight: 1.4, color: 'text.tertiary' }}>{copy.description}</Typography>
      </Box>
      {loadError && onRetry && (
        <Button
          size="sm"
          variant="soft"
          color="danger"
          onClick={onRetry}
          data-testid="no-models-retry-btn"
          // The editor placeholder this sits in ignores the pointer; the button must not.
          sx={{ pointerEvents: 'auto', flexShrink: 0 }}
        >
          Retry
        </Button>
      )}
    </Box>
  );
}

interface CreditsWarningProps {
  show: boolean;
  /** Why the balance is 0. */
  reason?: string;
  /** Whether the composer holds text that will wait for credits. */
  hasDraft?: boolean;
  /** Free routes to credits, alongside the paid actions. */
  freeRoutes?: ReactNode;
  /** Replaces the account-aware CreditOfferActions, e.g. to preview one kind of account. */
  actions?: ReactNode;
}

interface LowCreditsWarningProps {
  show: boolean;
  currentCredits: number;
  onDismiss: () => void;
  /** Replaces the account-aware CreditOfferActions, e.g. to preview one kind of account. */
  actions?: ReactNode;
}

/**
 * Low but not out: a note in the stack above the composer's status line (SessionBottom), so typing
 * is never blocked and the box does not move. Dismissal is the caller's to remember (see
 * creditNudgeDismissal).
 */
export function LowCreditsWarning({ show, currentCredits, onDismiss, actions }: LowCreditsWarningProps) {
  if (!show) return null;

  return (
    <ComposerNote
      data-testid="session-low-credits-warning"
      dismissTestId="low-credits-warning-dismiss"
      dismissLabel="Dismiss low credits notice"
      onDismiss={onDismiss}
    >
      <Typography
        data-testid="low-credits-warning-text"
        sx={{ fontSize: '13px', fontWeight: 600, color: 'text.primary' }}
      >
        Running low on credits
      </Typography>
      <Typography sx={{ fontSize: '13px', color: 'text.primary' }}>
        {formatCreditAmount(currentCredits)} credits remaining. Your work isn&apos;t interrupted.
      </Typography>
      {/* The actions go under the copy, not beside it. */}
      <Box data-testid="low-credits-warning-actions" sx={{ mt: '12px' }}>
        {actions ?? <CreditOfferActions moment="low" />}
      </Box>
    </ComposerNote>
  );
}

/**
 * Out of credits: takes the place of the message box rather than covering it.
 * There is nothing to type into, so the box is not drawn at all - the block
 * sits above the toolbar and says what happened and what to
 * do in the same calm register as the rest of the composer.
 */
export function CreditsWarning({ show, actions, reason, hasDraft = false, freeRoutes }: CreditsWarningProps) {
  if (!show) return null;

  return (
    <Box data-testid="session-credits-warning" sx={{ width: '100%' }}>
      {/* One row on desktop. On a phone the row is too narrow for the copy and two
          buttons side by side, so the copy goes on top and the buttons share a full-width
          row under it, split evenly. */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
          gap: { xs: '12px', sm: 2 },
          // 4px on top of the box's own 12px puts the heading 16px down, where the message text
          // it replaces starts (SessionBottom, .lexical-chat-input).
          pt: '4px',
          // The same 20px down to the toolbar as the message text (the editor wrapper's bottom padding).
          pb: '20px',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            data-testid="credits-warning-text"
            level="title-sm"
            sx={{ fontSize: '14px', fontWeight: 500, color: 'danger.softColor' }}
          >
            Out of Credits
          </Typography>
          <Typography level="body-sm" sx={{ mt: '2px', fontSize: '13px', color: 'text.tertiary' }}>
            Subscribe or top up to continue. Your chats and files are safe, and you can still review and export your
            work.
          </Typography>
          {reason && (
            <Typography
              data-testid="credits-warning-reason"
              level="body-sm"
              sx={{ mt: '2px', fontSize: '13px', color: 'text.tertiary' }}
            >
              {reason}
            </Typography>
          )}
          {hasDraft && (
            <Typography
              data-testid="credits-warning-draft-saved"
              level="body-sm"
              sx={{ mt: '2px', fontSize: '13px', color: 'text.tertiary' }}
            >
              Your message is saved. Pick up where you left off once you have credits.
            </Typography>
          )}
          {freeRoutes && (
            <Box data-testid="credits-warning-free-routes" sx={{ mt: '12px' }}>
              {freeRoutes}
            </Box>
          )}
        </Box>
        <Box data-testid="credits-warning-actions" sx={{ flexShrink: 0 }}>
          {actions ?? <CreditOfferActions moment="out" />}
        </Box>
      </Box>
    </Box>
  );
}
