# Organization audit integration

Organization-visible events live in `OrganizationAuditEvent`, not the platform audit collection. The read API never queries platform audit records. Logging starts at deployment; there is no historical backfill.

## Mutation contract

Import `recordOrganizationAuditEvent` from `@bike4mind/server-utils/utils/organizationAudit`. Await it inside the mutation's `withTransaction` callback so persistence failures roll back both writes. Mongoose uses the ambient transaction session.

The input is `{ organizationId, actorUserId, action, targetId? }`. Organization and actor IDs are required; `targetId` is an optional non-secret entity ID. The writer generates the timestamp. Never pass tokens, key material, invite links, prompts, internal reasons or free-form metadata. Unknown fields and action names are rejected at runtime.

Allowed actions:

- `member.added`, `member.removed`, `member.role_changed`
- `owner.transferred`
- `invite.created`, `invite.revoked`
- `policy.updated`, `billing.updated`
- `api_key.created`, `api_key.revoked`
- `connector.connected`, `connector.disconnected`

Policy siblings (MFA and sharing defaults) use `policy.updated`; service-key siblings use `api_key.created` and `api_key.revoked`. `targetId` can identify a policy or key, but must never contain a credential. Those branches must integrate this writer before their routes compile and must test their own transactional event writes. This foundation does not implement their policy features.

Standard group provisioning and project-to-group sharing use `policy.updated`, targeting the fixed `group-type:<catalog key>` policy identifier or project ID. Each successful apply request is recorded, including idempotent repeats, within the same transaction as the policy mutation.

Existing post-commit lifecycle hooks use `recordOrganizationAuditEventSafe` because an audit outage cannot roll back an already-completed mutation. It awaits and logs failures without turning success into a retryable error. New transactional mutations should use the strict writer instead.

Membership analytics producers pass `organizationAuditActorUserId` from the trusted request principal. Under impersonation this names the real admin, while the analytics `userId` continues to identify the account whose counters are updated. Both add-member routes include the resolved member ID for the audit target. The client telemetry endpoint refuses organization membership event types.

The personal-data registry retains actor references under `AUDIT_LOG`. It treats `targetId` as a user reference only for `member.added` and `member.removed`; invitation, connector and policy identifiers keep their entity meanings. The append-only model is preserved.

## Reads and export

`GET /api/organizations/:id/audit` is session-only. The owner or a manager with a current membership row may read; unrelated platform staff and ordinary members cannot. The API returns only time, actor ID, action, target ID and event ID. Filters are `actor`, `action`, `from`, `to`; dates are inclusive UTC calendar dates. JSON uses bounded cursor pages. `format=csv` requires both dates and exports all matching records, independent of the visible page. Exports over 10,000 records fail explicitly; narrow the date range rather than receiving a truncated file. CSV cells are quoted and spreadsheet-formula prefixes neutralized.
