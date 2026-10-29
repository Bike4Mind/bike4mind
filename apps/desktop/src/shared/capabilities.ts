export const CAPABILITY_AUDIT_LIMIT = 200;

export type Capability = 'files' | 'tool' | 'browser-origin' | 'credits' | 'imported-identity' | 'project-trust';

export type CapabilitySubject =
  | { kind: 'desktop-user' }
  | { kind: 'project'; directory: string }
  | { kind: 'session'; sessionId: string; scopeKey?: string };

export type CapabilityScope =
  | { kind: 'path'; value: string }
  | { kind: 'permission-rule'; value: string }
  | { kind: 'browser-origin'; value: string; access: 'network' | 'read' | 'act' | 'script' }
  | { kind: 'tool'; value: string }
  | { kind: 'project'; value: string }
  | { kind: 'approval'; value: string };

export interface CapabilityGrant {
  id: string;
  subject: CapabilitySubject;
  capability: Capability;
  scope: CapabilityScope;
  createdAt: string;
  /** Exact standing approval to remove when this session grant is revoked. */
  approvalKey?: string;
  revokedAt?: string;
  source: 'folder-picker' | 'permission-rule' | 'project-trust' | 'approval' | 'migration';
}

export type CapabilityAuditEvent =
  | { sequence: number; type: 'grant'; timestamp: string; grant: CapabilityGrant; migrationKey?: string }
  | {
      sequence: number;
      type: 'use';
      timestamp: string;
      grantId?: string;
      capability: Capability;
      scope: CapabilityScope;
    }
  | { sequence: number; type: 'revoke'; timestamp: string; grantId: string };

export interface CapabilityLedgerState {
  grants: CapabilityGrant[];
  audit: CapabilityAuditEvent[];
}
