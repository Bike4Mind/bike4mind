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
  'org.credits.refunded': {
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
  'user.impersonation.escalated': { category: 'access', severity: 'critical', write: 'strict' },
  'user.impersonation.ended': { category: 'access', severity: 'info', write: 'bestEffort' },
  'user.impersonation.denied': { category: 'access', severity: 'critical', write: 'bestEffort' },
  // Single-user counterparts of user.bulk.suspended / user.bulk.restricted, written by PUT /api/users/[id]/update.
  'user.suspended': { category: 'access', severity: 'critical', write: 'strict' },
  'user.reinstated': { category: 'access', severity: 'notice', write: 'strict' },
  'user.restricted': { category: 'access', severity: 'notice', write: 'strict' },
  'user.restriction_lifted': { category: 'access', severity: 'notice', write: 'strict' },

  'user.deleted': { category: 'account', severity: 'critical', write: 'strict' },
  'user.deletion.denied': { category: 'account', severity: 'critical', write: 'bestEffort' },
  // notice, not info: the same entry carries an admin's change to another user's email, password and tags.
  'user.profile.updated': { category: 'account', severity: 'notice', write: 'bestEffort' },
  'user.note.created': { category: 'support', severity: 'info', write: 'strict' },
  'user.note.edited': { category: 'support', severity: 'notice', write: 'strict' },
  'user.note.deleted': { category: 'support', severity: 'notice', write: 'strict' },
  'user.note.restored': { category: 'support', severity: 'notice', write: 'strict' },
  'user.tags.updated': { category: 'account', severity: 'notice', write: 'strict' },
  // Name and username as written, plus a requested email change that the user still has to verify.
  'user.identity.updated': { category: 'identity', severity: 'notice', write: 'strict' },

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
  'org.custom_mcp_policy.updated': { category: 'org', severity: 'notice', write: 'bestEffort' },
  // Target the member, not the org, so the entry reaches the user's Admin log; organizationId names the org.
  'org.member.added': { category: 'org', severity: 'notice', write: 'strict' },
  'org.member.removed': { category: 'org', severity: 'notice', write: 'strict' },
  'org.member.role_changed': { category: 'org', severity: 'notice', write: 'strict' },

  'settings.admin_settings.updated': { category: 'settings', severity: 'notice', write: 'strict' },
  'settings.admin_settings.denied': { category: 'settings', severity: 'critical', write: 'bestEffort' },
  'settings.whats_new.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.whats_new.synced': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.whats_new.generation_triggered': { category: 'settings', severity: 'info', write: 'bestEffort' },
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
  'user.api_key_trust.approved': { category: 'identity', severity: 'notice', write: 'strict' },
  'user.api_key_trust.revoked': { category: 'identity', severity: 'notice', write: 'bestEffort' },
  'user.email.unverified': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.verification_resent': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.change_resent': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.email.change_cancelled': { category: 'identity', severity: 'info', write: 'bestEffort' },
  'user.sessions.revoked': { category: 'identity', severity: 'notice', write: 'bestEffort' },
  'user.session.revoked': { category: 'identity', severity: 'notice', write: 'bestEffort' },
  // Bulk abuse response (apps/client/pages/api/admin/abuse/bulk-*.ts): one strict entry per user and
  // step, written in that user's transaction, plus a summary per execute. The summary is bestEffort
  // because the per-user entries are the record and the work is already committed when it is written.
  'abuse.bulk.executed': { category: 'account', severity: 'critical', write: 'bestEffort' },
  'abuse.bulk.ban': { category: 'access', severity: 'critical', write: 'strict' },
  'abuse.bulk.revoke_keys': { category: 'access', severity: 'notice', write: 'strict' },
  'abuse.bulk.revoke_sessions': { category: 'identity', severity: 'notice', write: 'strict' },
  'abuse.bulk.clawback': { category: 'credits', severity: 'notice', write: 'strict' },
  'abuse.bulk.denied': { category: 'account', severity: 'critical', write: 'bestEffort' },
  // Signup risk review (apps/client/pages/api/admin/signup-risk-reviews.ts): one strict entry per user,
  // written in that user's transaction. reopened is the undo of approved.
  'user.signup_risk.approved': { category: 'access', severity: 'notice', write: 'strict' },
  'user.signup_risk.reopened': { category: 'access', severity: 'notice', write: 'strict' },
  'user.signup_risk.denied': { category: 'access', severity: 'critical', write: 'bestEffort' },
  // Users-list bulk actions (apps/client/pages/api/admin/users/bulk/*): one strict entry per changed
  // user, written in that user's transaction, plus a bestEffort summary per batch.
  'user.bulk.executed': { category: 'account', severity: 'notice', write: 'bestEffort' },
  'user.bulk.suspended': { category: 'access', severity: 'critical', write: 'strict' },
  'user.bulk.restricted': { category: 'access', severity: 'notice', write: 'strict' },
  'user.bulk.credits_adjusted': {
    category: 'credits',
    severity: 'notice',
    write: 'strict',
    escalatesAboveGrantThreshold: true,
  },
  'user.bulk.api_keys_revoked': { category: 'access', severity: 'notice', write: 'strict' },
  'user.bulk.tagged': { category: 'account', severity: 'info', write: 'strict' },
  'user.bulk.contained': { category: 'access', severity: 'critical', write: 'strict' },
  // An undo that reverses a deduction adds credits, so it is held to the same grant thresholds.
  'user.bulk.undone': {
    category: 'account',
    severity: 'notice',
    write: 'strict',
    escalatesAboveGrantThreshold: true,
  },
  'user.mfa.reset': { category: 'identity', severity: 'notice', write: 'strict' },
  'user.mfa.denied': { category: 'identity', severity: 'critical', write: 'bestEffort' },

  // Handler coverage: secrets and integration credentials
  'settings.system_secret.upserted': { category: 'settings', severity: 'critical', write: 'strict' },
  'settings.system_secret.deleted': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.github_connection.created': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.github_connection.updated': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.github_connection.deleted': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.github_connection.key_rotated': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.slack_app.created': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.slack_app.reconnected': { category: 'settings', severity: 'critical', write: 'strict' },
  'integration.slack_app.manifest_updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'integration.slack_workspace.deactivated': { category: 'settings', severity: 'critical', write: 'strict' },
  'identity.sso_provider.created': { category: 'identity', severity: 'critical', write: 'strict' },
  'identity.sso_provider.updated': { category: 'identity', severity: 'critical', write: 'strict' },
  'identity.sso_provider.deleted': { category: 'identity', severity: 'critical', write: 'strict' },

  // Handler coverage: email and messaging
  // Job entries record the claim and enqueue request, not delivery.
  'email.job.started': { category: 'support', severity: 'critical', write: 'strict' },
  'email.job.sent': { category: 'support', severity: 'critical', write: 'strict' },
  'email.job.test_sent': { category: 'support', severity: 'notice', write: 'strict' },
  'email.job.created': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.job.updated': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.job.cloned': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.job.scheduled': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.job.cancelled': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.template.created': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.template.updated': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.template.deleted': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.template.cloned': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'email.template.test_sent': { category: 'support', severity: 'info', write: 'bestEffort' },
  'support.inbox.message_sent': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'support.pr_report.sent': { category: 'support', severity: 'info', write: 'bestEffort' },

  // Handler coverage: users and credentials
  'user.created': { category: 'account', severity: 'critical', write: 'strict' },
  'user.bulk_created': {
    category: 'account',
    severity: 'notice',
    write: 'bestEffort',
    escalatesAboveGrantThreshold: true,
  },
  'user.emergency_login.challenged': { category: 'access', severity: 'critical', write: 'strict' },
  'user.emergency_login.denied': { category: 'access', severity: 'notice', write: 'bestEffort' },
  'user.api_key.generated': { category: 'access', severity: 'critical', write: 'strict' },
  'user.subscription.removed': { category: 'credits', severity: 'critical', write: 'strict' },
  'user.api_key.rate_limit_updated': { category: 'access', severity: 'notice', write: 'bestEffort' },
  'user.api_key.rate_limit_reset': { category: 'access', severity: 'info', write: 'bestEffort' },
  'user.api_key.revoked': { category: 'access', severity: 'notice', write: 'strict' },
  'user.api_key.restored': { category: 'access', severity: 'notice', write: 'strict' },
  'user.api_key.rotated': { category: 'access', severity: 'critical', write: 'strict' },
  'user.api_keys.revoked_all': { category: 'access', severity: 'notice', write: 'strict' },
  'org.data_lake.embedding_spend_reset': { category: 'credits', severity: 'notice', write: 'strict' },
  'user.storage.recalculated': { category: 'support', severity: 'info', write: 'bestEffort' },
  // Handler coverage: liveops, sre and queues

  // ops

  // Handler coverage: liveops, sre and queues
  'ops.triage_config.created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'ops.triage_config.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'ops.triage_config.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'ops.sre.scan_triggered': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.sre.run_triggered': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.sre.pattern_updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'ops.sre.tracking_dismissed': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.sre.tracking_rerun': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.sre.tracking_retried': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.dlq.replayed': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.agent_executions.cleaned_up': { category: 'support', severity: 'notice', write: 'bestEffort' },
  // Handler coverage: billing and model config
  'settings.model_price.repriced': { category: 'settings', severity: 'notice', write: 'strict' },
  'settings.provider_invoice.recorded': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.model_lifecycle.suggestion_resolved': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.model_discovery.triggered': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.gear_override.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.gear_override.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.tool_definition.override_updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.tool_definition.override_deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  // Handler coverage: rapid reply
  'settings.rapid_reply_prompt.created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_prompt.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_prompt.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_prompt.activated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_mapping.created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_mapping.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_mapping.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply_mapping.bulk_updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.rapid_reply.test_run': { category: 'settings', severity: 'info', write: 'bestEffort' },
  // Handler coverage: content and directory config
  'settings.modal.variants_updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.modal.variants_cleared': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.modal.created': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.modal.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.modal.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.release_note.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.release_note.status_changed': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.business_link.created': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.business_link.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.business_link.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.business_link.imported': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.business_link_category.created': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.business_link_category.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.business_link_category.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.team_member.created': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.team_member.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.team_member.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.voice_agent.created': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.voice_agent.updated': { category: 'settings', severity: 'info', write: 'bestEffort' },
  'settings.voice_agent.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },

  // Handler coverage: signup and org access
  'org.partner_signup_rule.created': { category: 'access', severity: 'notice', write: 'strict' },
  'org.partner_signup_rule.updated': { category: 'access', severity: 'notice', write: 'strict' },
  'org.partner_signup_rule.deleted': { category: 'access', severity: 'notice', write: 'strict' },
  'org.partner_signup_rule.backfilled': { category: 'access', severity: 'notice', write: 'bestEffort' },
  'user.accounts.migrated': { category: 'account', severity: 'notice', write: 'bestEffort' },
  'user.reg_invite.updated': { category: 'access', severity: 'notice', write: 'strict' },
  'user.reg_invite.created': { category: 'access', severity: 'notice', write: 'strict' },
  'user.waitlist_subscriber.deleted': { category: 'support', severity: 'info', write: 'bestEffort' },
  'org.created': { category: 'org', severity: 'notice', write: 'bestEffort' },
  // Handler coverage: telemetry, backfills and health
  'ops.context_telemetry.deleted': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.context_telemetry.analyzed': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.context_telemetry.issue_created': { category: 'support', severity: 'notice', write: 'bestEffort' },
  'ops.context_telemetry.test_run': { category: 'support', severity: 'info', write: 'bestEffort' },
  'ops.mementos.reembedded': { category: 'support', severity: 'info', write: 'bestEffort' },
  'ops.memory_ledger.reembedded': { category: 'support', severity: 'info', write: 'bestEffort' },
  'ops.overwatch.first_seen_backfilled': { category: 'support', severity: 'info', write: 'bestEffort' },
  'ops.spider_job.started': { category: 'support', severity: 'info', write: 'bestEffort' },
  'system_health.integration_override_set': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'system_health.integration_probe_run': { category: 'settings', severity: 'info', write: 'bestEffort' },

  // Handler coverage: security and trust and safety
  'security.blocked_ip.added': { category: 'access', severity: 'notice', write: 'strict' },
  'security.blocked_ip.removed': { category: 'access', severity: 'critical', write: 'strict' }, // critical: removing a block lifts a security control
  'security.blocked_ip.auto_added': { category: 'access', severity: 'notice', write: 'strict' },
  'moderation.incident.verdict_recorded': { category: 'support', severity: 'notice', write: 'strict' },
  'moderation.published_artifact.taken_down': { category: 'support', severity: 'notice', write: 'strict' },
  'moderation.published_artifact.takedown_reverted': { category: 'support', severity: 'notice', write: 'strict' },

  // Handler coverage: system prompts and agent ops
  'settings.system_prompt.created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.system_prompt.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.system_prompt.deleted': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.system_prompt.version_created': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.system_prompt.version_saved': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.system_prompt.version_switched': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.system_prompt.reset': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.agent_ops.updated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.agent_ops.version_added': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.agent_ops.seeded': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.agent_ops.version_activated': { category: 'settings', severity: 'notice', write: 'bestEffort' },
  'settings.agent_ops.repaired': { category: 'settings', severity: 'info', write: 'bestEffort' },

  'audit.exported': { category: 'support', severity: 'info', write: 'bestEffort' },
} as const satisfies Record<string, AdminAuditCatalogueEntry>;

export type AdminAuditAction = keyof typeof ADMIN_AUDIT_CATALOGUE;

/** Actions whose positive `details.credits` count as a credit grant (thresholds and burst detection). */
export const ADMIN_AUDIT_CREDIT_GRANT_ACTIONS = (Object.keys(ADMIN_AUDIT_CATALOGUE) as AdminAuditAction[]).filter(
  action => 'escalatesAboveGrantThreshold' in ADMIN_AUDIT_CATALOGUE[action]
);
