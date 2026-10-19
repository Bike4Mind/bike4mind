export type AdminAuditCategory = 'credits' | 'access' | 'identity' | 'account' | 'org' | 'settings' | 'support';
export type AdminAuditSeverity = 'info' | 'notice' | 'critical';

export type AdminAuditCatalogueEntry = {
  category: AdminAuditCategory;
  severity: AdminAuditSeverity;
  /** strict: a failed audit write fails the action; bestEffort: failure is logged and swallowed. */
  write: 'strict' | 'bestEffort';
};

export const ADMIN_AUDIT_CATALOGUE = {
  'org.credits.granted': { category: 'credits', severity: 'notice', write: 'strict' },
  'org.credits.topped_up': { category: 'credits', severity: 'notice', write: 'strict' },
  'user.subscription.granted': { category: 'credits', severity: 'notice', write: 'strict' },
  // Only written by the backfill in the first release; the live writer lands later.
  'user.credits.adjusted': { category: 'credits', severity: 'notice', write: 'strict' },

  'org.seats.changed': { category: 'org', severity: 'notice', write: 'bestEffort' },
  'org.seats.ceiling_raised': { category: 'org', severity: 'info', write: 'bestEffort' },
  'org.conversion.initiated': { category: 'org', severity: 'notice', write: 'bestEffort' },
  'org.revoked': { category: 'org', severity: 'notice', write: 'strict' },
  'org.group_types.updated': { category: 'org', severity: 'info', write: 'bestEffort' },
  'org.admins.updated': { category: 'org', severity: 'notice', write: 'bestEffort' },
  'org.group_member.assigned': { category: 'org', severity: 'info', write: 'bestEffort' },
  'org.group_member.unassigned': { category: 'org', severity: 'info', write: 'bestEffort' },
  'org.invite.created': { category: 'org', severity: 'info', write: 'bestEffort' },
  'org.member_budget.updated': { category: 'org', severity: 'notice', write: 'bestEffort' },

  'settings.whats_new.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.whats_new.synced': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.security_scan.enabled': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.security_scan.disabled': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.security_scan.triggered': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'security.attack_simulation.run': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.secret_rotated': { category: 'settings', severity: 'notice', write: 'bestEffort' },

  'user.email.verified': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.unverified': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.verification_resent': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.change_resent': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.change_cancelled': { category: 'identity', severity: 'info', write: 'bestEffort' },
} as const satisfies Record<string, AdminAuditCatalogueEntry>;

export type AdminAuditAction = keyof typeof ADMIN_AUDIT_CATALOGUE;
