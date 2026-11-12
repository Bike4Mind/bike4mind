/**
 * Mutating admin handler verbs that deliberately write no AdminAuditLog row, keyed `METHOD /api/route`,
 * each with a one-line reason. Checked by checkAdminAuditCoverage.test.ts, which also fails on an entry
 * whose verb is gone or has since gained an audit call. Add an entry only when the verb changes nothing
 * an admin would need to answer for.
 */
export const ADMIN_AUDIT_COVERAGE_EXEMPTIONS: Readonly<Record<string, string>> = {
  // The admin's own preferences
  'POST /api/admin/saved-views': "the admin's own saved filter views on the admin pages",
  'PATCH /api/admin/saved-views/[id]': "the admin's own saved filter views on the admin pages",
  'DELETE /api/admin/saved-views/[id]': "the admin's own saved filter views on the admin pages",

  // Reads, previews and dry runs sent as POST
  'POST /api/admin/abuse/bulk-preview': 'dry run: counts what a bulk action would touch, writes nothing',
  'POST /api/admin/users/bulk/preview': 'dry run: counts what a bulk action would touch, writes nothing',
  'POST /api/admin/email/jobs/preview-recipients': 'read: resolves the recipient list of a draft job',
  'POST /api/admin/email/jobs/[id]/check-status': 'bookkeeping: refreshes delivery status from the provider',
  'POST /api/admin/whats-new-highlights-preview': 'preview: renders highlights without saving them',
  'POST /api/admin/system-prompts/[promptId]/test': 'preview: runs a prompt against a model, saves nothing',
  'POST /api/admin/github/test': 'probe: checks the GitHub connection, saves nothing',
  'POST /api/admin/pr-report/generate': 'preview: drafts a PR report; sending it is audited by pr-report/send',
  'POST /api/admin/liveops-triage-configs/[id]/trigger':
    'queues a run of an existing triage config; the run is logged in the triage config audit log',

  // Machine ingests (auth: false, a shared ingest token, no admin actor)
  'POST /api/admin/rate-limits/ingest': 'machine ingest of rate-limit events, token-authenticated',
  'POST /api/admin/security-dashboard/web-owasp-ingest': 'machine ingest of scan results, token-authenticated',
  'POST /api/admin/security-dashboard/cloud-prowler-ingest': 'machine ingest of scan results, token-authenticated',
  'POST /api/admin/security-dashboard/attack-simulation-ingest':
    'machine ingest of simulation results, token-authenticated',
};
