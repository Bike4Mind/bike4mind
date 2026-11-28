import { hostCommands, useHostCommandError } from './hostCommands';
import { useHostEntries } from './hostRegistry';
import { sendBlockAction, sendBlockedReason } from './hostPresentation';
import { useNow } from './useNow';

export type HostSendBlock = { reason: string | null; action: { label: string; onClick: () => void } | null };

const NOT_BLOCKED: HostSendBlock = { reason: null, action: null };

/**
 * Why a session on `hostId` cannot send right now, and the fix when there is one. The local host
 * is always there, so it never blocks. The composer stays editable: the draft is kept for when the
 * host is back. A failed fix is added to the reason, from the same record the host panel reads.
 */
export function useHostSendBlock(hostId: string): HostSendBlock {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  const now = useNow();
  const commandError = useHostCommandError(hostId);
  if (!entry || entry.kind === 'local') return NOT_BLOCKED;
  const reason = sendBlockedReason(entry.label, entry.state, now);
  if (!reason) return NOT_BLOCKED;
  const fix = sendBlockAction(entry.state);
  const detail = commandError ? `${reason} ${commandError}` : reason;
  if (fix === 'signInApp')
    return { reason: detail, action: { label: 'Sign in', onClick: () => void hostCommands.signInApp(hostId) } };
  if (fix === 'reconnect')
    return {
      reason: detail,
      action: { label: 'Reconnect', onClick: () => void hostCommands.reconnect(hostId, false) },
    };
  return { reason: detail, action: null };
}
