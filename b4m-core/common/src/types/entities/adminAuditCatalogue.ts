/** App defaults for the AdminSettings grant thresholds (AdminAuditCriticalGrantCredits / AdminAuditDailyGrantCredits). */
export const ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS = 50_000;
export const ADMIN_AUDIT_DEFAULT_DAILY_GRANT_CREDITS = 200_000;

export type AdminAuditCategory = 'credits' | 'access' | 'identity' | 'account' | 'org' | 'settings' | 'support';
export type AdminAuditSeverity = 'info' | 'notice' | 'critical';

export type AdminAuditCatalogueEntry = {
  category: AdminAuditCategory;
  severity: AdminAuditSeverity;
  /** strict: a failed audit write fails the action; bestEffort: failure is logged and swallowed. */
  write: 'strict' | 'bestEffort';
  /**
   * A grant (positive signed `details.credits`) above the single-grant or per-admin daily
   * threshold is written as critical instead of `severity`. See recordAdminAction.
   */
  escalatesAboveGrantThreshold?: true;
};

export const ADMIN_AUDIT_CATALOGUE = {
  'org.credits.granted': {
    category: 'credits',
    severity: 'notice',
    write: 'strict',
    escalatesAboveGrantThreshold: true,
  },
  'org.credits.topped_up': {
    category: 'credits',
    severity: 'notice',
    write: 'strict',
    escalatesAboveGrantThreshold: true,
  },
  'org.credits.adjusted': {
    category: 'credits',
    severity: 'notice',
    write: 'strict',
    escalatesAboveGrantThreshold: true,
  },
  'user.subscription.granted': { category: 'credits', severity: 'notice', write: 'strict' },
  'user.credits.adjusted': {
    category: 'credits',
    severity: 'notice',
    write: 'strict',
    escalatesAboveGrantThreshold: true,
  },
  'user.credits.denied': { category: 'credits', severity: 'critical', write: 'bestEffort' },
  'user.subscription.denied': { category: 'credits', severity: 'critical', write: 'bestEffort' },

  'user.role.admin_granted': { category: 'access', severity: 'critical', write: 'strict' },
  'user.role.admin_revoked': { category: 'access', severity: 'critical', write: 'strict' },
  'user.role.denied': { category: 'access', severity: 'critical', write: 'bestEffort' },
  'user.impersonation.started': { category: 'access', severity: 'critical', write: 'strict' },
  'user.impersonation.ended': { category: 'access', severity: 'info', write: 'bestEffort' },
  'user.impersonation.denied': { category: 'access', severity: 'critical', write: 'bestEffort' },

  'user.deleted': { category: 'account', severity: 'critical', write: 'strict' },
  'user.deletion.denied': { category: 'account', severity: 'critical', write: 'bestEffort' },

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

  'settings.admin_settings.updated': { category: 'settings', severity: 'notice', write: 'strict' },
  'settings.whats_new.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.whats_new.synced': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.security_scan.enabled': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.security_scan.disabled': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.security_scan.triggered': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'security.attack_simulation.run': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.secret_rotated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.activated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'oauth_client.deactivated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'system_health.test_run': { category: 'settings', severity: 'info', write: 'bestEffort' },

  'user.email.verified': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.unverified': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.verification_resent': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.change_resent': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.change_cancelled': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.mfa.reset': { category: 'identity', severity: 'notice', write: 'strict' },
  'user.mfa.denied': { category: 'identity', severity: 'critical', write: 'bestEffort' },

  'audit.exported': { category: 'support', severity: 'info', write: 'bestEffort' },
} as const satisfies Record<string, AdminAuditCatalogueEntry>;

export type AdminAuditAction = keyof typeof ADMIN_AUDIT_CATALOGUE;

/** Actions whose positive `details.credits` count as a credit grant (thresholds and burst detection). */
export const ADMIN_AUDIT_CREDIT_GRANT_ACTIONS = (Object.keys(ADMIN_AUDIT_CATALOGUE) as AdminAuditAction[]).filter(
  action => 'escalatesAboveGrantThreshold' in ADMIN_AUDIT_CATALOGUE[action]
);
