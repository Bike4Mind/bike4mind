import React from 'react';
import { Box, Sheet, Typography } from '@mui/joy';
import KeyIcon from '@mui/icons-material/Key';
import DomainIcon from '@mui/icons-material/Domain';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';

/**
 * The stored-gate display and the confirmed Clear that every non-public share surface offers.
 * AccessGateEditor (Live Artifacts sharing panel) and PublishShareModal both render these, so the
 * gate description and the consequences named before a clear stay identical. The clear itself is
 * `updatePublishedAccessGate(publicId, null)`, which the server accepts at any visibility.
 */

export type StoredGateKind = 'passphrase' | 'domain';

/** Success toast after clearing a gate on a non-public page. */
export const STORED_GATE_CLEARED_MESSAGE = 'Gate cleared - private links no longer ask for it';

/** Who opens a non-public page at its own address (/p/...), which checks visibility and membership
 *  only, never a stored gate (checkVisibility). An unknown level is owner-only there, like private. */
function pageAddressNote(visibility: string): string {
  if (visibility === 'organization')
    return 'Team members who open the page itself, not a private link, are not asked for it.';
  if (visibility === 'project')
    return 'Project members who open the page itself, not a private link, are not asked for it.';
  return 'The page itself, not a private link, still opens only for you.';
}

export interface StoredGateNoteProps {
  kind: StoredGateKind;
  /** The page's current visibility, which decides who still opens the page itself without the gate. */
  visibility: string;
  /** Rendered under the description, e.g. the Clear action. */
  children?: React.ReactNode;
  sx?: React.ComponentProps<typeof Sheet>['sx'];
  'data-testid'?: string;
}

/** What a gate stored on a non-public page guards: the private links, not the page's own address. */
export function StoredGateNote({ kind, visibility, children, sx, 'data-testid': testId }: StoredGateNoteProps) {
  return (
    <Sheet variant="soft" sx={[{ borderRadius: 'md', p: 1 }, ...(Array.isArray(sx) ? sx : [sx])]} data-testid={testId}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
        {kind === 'passphrase' ? <KeyIcon sx={{ fontSize: 16 }} /> : <DomainIcon sx={{ fontSize: 16 }} />}
        <Typography level="body-sm" sx={{ fontWeight: 600 }}>
          {kind === 'passphrase' ? 'Passphrase gate' : 'Email domain gate'}
        </Typography>
      </Box>
      {/* Mirrors the server: /a/<token> runs the stored gate at any visibility, while the
          page's own address (/p/...) checks visibility only. Keep in sync with
          checkShareGrant and checkVisibility. */}
      <Typography level="body-xs">
        {kind === 'passphrase'
          ? 'Private links to this page need the passphrase.'
          : 'Private links to this page need a verified email from an allowed domain.'}{' '}
        {pageAddressNote(visibility)}
      </Typography>
      {children}
    </Sheet>
  );
}

export interface ClearGateConfirmModalProps {
  open: boolean;
  /** The gate being cleared; the passphrase wording adds that it cannot be recovered. */
  kind: StoredGateKind;
  loading?: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/** The confirmation shown before a stored gate is cleared. */
export function ClearGateConfirmModal({ open, kind, loading, onClose, onConfirm }: ClearGateConfirmModalProps) {
  return (
    <ConfirmationModal
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      loading={loading}
      title="Clear access gate"
      description={
        kind === 'passphrase'
          ? 'Anyone with a private link to this page will open it without a passphrase. The current passphrase cannot be recovered.'
          : 'Anyone with a private link to this page will open it without signing in.'
      }
      confirmText="Clear gate"
      confirmColor="danger"
      showWarningIcon
    />
  );
}
