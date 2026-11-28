import { useHostEntries } from './hostRegistry';
import { sendBlockedReason } from './hostPresentation';

export type HostSendBlock = { reason: string | null; action: { label: string; onClick: () => void } | null };

const NOT_BLOCKED: HostSendBlock = { reason: null, action: null };

/**
 * Why a session on `hostId` cannot send right now, and the fix when Reconnect is one. The local
 * host is always there, so it never blocks. The composer stays editable: the draft is kept for
 * when the host is back.
 */
export function useHostSendBlock(hostId: string): HostSendBlock {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  if (!entry || entry.kind === 'local') return NOT_BLOCKED;
  const reason = sendBlockedReason(entry.label, entry.state, Date.now());
  if (!reason) return NOT_BLOCKED;
  const retryable = entry.state.status === 'offline' || entry.state.status === 'failed';
  return {
    reason,
    action: retryable ? { label: 'Reconnect', onClick: () => void window.b4m.host.connect(hostId) } : null,
  };
}
