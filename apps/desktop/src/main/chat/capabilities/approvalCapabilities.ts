import type { Capability, CapabilityGrant, CapabilityScope } from '@shared/capabilities';
import type { PermissionScope } from '@shared/permissions';
import type { ApprovalGate } from '../tools/ApprovalGate';
import { spendsCredits } from '../tools/riskAssessment';

export function capabilityFor(toolName: string, approvalKey?: string): Capability {
  if (spendsCredits(toolName)) return 'credits';
  if (['file_read', 'file_write', 'file_edit', 'apply_patch', 'glob_files', 'grep_search'].includes(toolName)) {
    return 'files';
  }
  if (approvalKey?.startsWith('browser-')) {
    return approvalKey.includes('-as-you:') ? 'imported-identity' : 'browser-origin';
  }
  return 'tool';
}

export function capabilityScope(toolName: string, approvalKey?: string): CapabilityScope {
  if (!approvalKey?.startsWith('browser-')) return { kind: 'tool', value: toolName };
  const origin = approvalKey.slice(approvalKey.indexOf(':') + 1);
  const access = approvalKey.startsWith('browser-script')
    ? 'script'
    : approvalKey.startsWith('browser-act')
      ? 'act'
      : approvalKey.startsWith('browser-open-as-you:')
        ? 'read'
        : 'network';
  return { kind: 'browser-origin', value: origin, access };
}

export function revokeSessionCapability(grant: CapabilityGrant, approvals: Pick<ApprovalGate, 'revoke'>): void {
  if (grant.subject.kind !== 'session') return;
  if (grant.approvalKey !== undefined) {
    approvals.revoke(grant.subject.sessionId, grant.approvalKey);
    return;
  }
  // Older browser grants can recover their key from the recorded origin and access.
  if (grant.scope.kind !== 'browser-origin') return;
  const prefix =
    grant.scope.access === 'script' ? 'browser-script' : grant.scope.access === 'act' ? 'browser-act' : 'browser-open';
  const identity = grant.capability === 'imported-identity' ? '-as-you' : '';
  approvals.revoke(grant.subject.sessionId, `${prefix}${identity}:${grant.scope.value}`);
}

export interface RevocationTargets {
  approvals: Pick<ApprovalGate, 'revoke'>;
  removeSessionDirectory(sessionId: string, directory: string): Promise<unknown>;
  revokeRoot(root: string): Promise<unknown>;
  untrustProject(directory: string): Promise<unknown>;
  revokeAllow(scope: PermissionScope, rule: string): Promise<unknown>;
}

/** Withdraws what a grant allowed; the ledger records the revoke only once this resolves. */
export async function enforceRevocation(grant: CapabilityGrant, targets: RevocationTargets): Promise<void> {
  revokeSessionCapability(grant, targets.approvals);
  if (grant.scope.kind === 'path') {
    if (grant.subject.kind === 'session') {
      await targets.removeSessionDirectory(grant.subject.sessionId, grant.scope.value);
    } else await targets.revokeRoot(grant.scope.value);
  }
  if (grant.scope.kind === 'project') await targets.untrustProject(grant.scope.value);
  if (grant.scope.kind === 'permission-rule') {
    const scope: PermissionScope =
      grant.subject.kind === 'project' ? { kind: 'project', directory: grant.subject.directory } : { kind: 'user' };
    await targets.revokeAllow(scope, grant.scope.value);
  }
}
