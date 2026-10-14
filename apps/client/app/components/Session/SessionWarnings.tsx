import { Box, Button, Divider, IconButton, Typography } from '@mui/joy';
import type { ReactNode } from 'react';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { CreditOfferActions } from './CreditOfferActions';
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
 * Low but not out: an in-flow banner above the message box, so typing is never blocked. Dismissal
 * is the caller's to remember (see creditNudgeDismissal).
 */
export function LowCreditsWarning({ show, currentCredits, onDismiss, actions }: LowCreditsWarningProps) {
  if (!show) return null;

  return (
    <Box
      data-testid="session-low-credits-warning"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        flexWrap: 'wrap',
        backgroundColor: 'background.level1',
        border: '1px solid',
        borderColor: 'warning.outlinedBorder',
        borderRadius: '8px',
        px: 1.5,
        py: 1,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
        <WarningAmberRoundedIcon
          data-testid="low-credits-warning-icon"
          sx={{ fontSize: '22px', color: 'warning.plainColor', flexShrink: 0 }}
        />
        <Box>
          <Typography data-testid="low-credits-warning-text" level="title-sm">
            Running low on credits
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {formatCreditAmount(currentCredits)} credits remaining. Your work isn&apos;t interrupted.
          </Typography>
        </Box>
      </Box>
      <Box data-testid="low-credits-warning-actions" display="flex" gap={1.5} alignItems="center">
        {actions ?? <CreditOfferActions moment="low" />}
        <IconButton
          data-testid="low-credits-warning-dismiss"
          aria-label="Dismiss low credits notice"
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onDismiss}
        >
          <CloseRoundedIcon />
        </IconButton>
      </Box>
    </Box>
  );
}

/**
 * Out of credits: takes the place of the message box rather than covering it.
 * There is nothing to type into, so the box is not drawn at all - the block
 * sits above the toolbar, divided from it, and says what happened and what to
 * do in the same calm register as the rest of the composer.
 */
export function CreditsWarning({ show, actions }: CreditsWarningProps) {
  if (!show) return null;

  return (
    // The 10px top padding matches the message row this replaces, which carries the
    // same padding to clear the grid's negative margin above it.
    <Box data-testid="session-credits-warning" sx={{ width: '100%', pt: '10px' }}>
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
          py: '12px',
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
            Your message is saved. Pick up where you left off once you have credits.
          </Typography>
        </Box>
        <Box data-testid="credits-warning-actions" sx={{ flexShrink: 0 }}>
          {actions ?? <CreditOfferActions moment="out" />}
        </Box>
      </Box>
      <Divider />
    </Box>
  );
}
