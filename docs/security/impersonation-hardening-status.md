# Impersonation hardening: implementation status

This branch is partial and is not ready to merge as a complete support workflow.

## Implemented

- Fixed server-side impersonation deadline; `IMPERSONATION_TTL_MINUTES` defaults to 60.
- Live session lookup only for impersonated access JWTs; ordinary authentication pays no new lookup.
- Refresh cannot slide the impersonation deadline.
- Read-only default, explicit audited escalation, and conservative route admission.
- Persistent banner with identity, countdown, End and a shared reason dialog.
- Durable support-access records; customer projection omits admin identity and internal reasons.
- Transactional, compare-and-swap end bookkeeping and bounded expiry reconciliation in the existing audit worker.
- Admin timeline uses the existing admin-audit source; sessions view includes support history.

## Security boundary and unresolved scope

The route gate intentionally fails closed. Read-only admission is an explicit set of reviewed GET/HEAD routes, not a rule that all GET requests are safe. Reviewed notebook navigation, message reads, organization lists and published modals are admitted. The briefcase catalog is an explicitly admitted read-only POST. Escalation admits notebook creation/cloning, stored-message edits, file edits and notebook associations. The dialog describes this limited scope. Agent writes remain blocked because agent creation can transfer customer credits. Integration credentials, automated tool execution and realtime credentials remain blocked; the client does not request websocket tickets during impersonation.

Sensitive families are blocked before escalation admission: auth/MFA/passkeys/step-up, OAuth, OTC, email, Stripe, subscriptions, credit operations, API keys, admin routes, websocket credentials, account update/deletion and customer session revocation. Account update is blocked wholesale because it combines ordinary profile preferences with password/email and privilege changes. Email-settings has another write path and is also blocked. API-key rotation is treated as secret creation. Token-only unauthenticated routes are blocked when the browser presents the parked admin cookie, except refresh/return and selected public bootstrap reads. CLI/completion and realtime bearer paths refuse impersonation, rather than bypass the route policy.

The route inventory is not exhaustive. Remaining work requires reviewing notebook reads/writes, content-producing GET routes, read-only POST routes, public/token-only alternate paths, generic resource handlers and asynchronous actions before expanding admission. Merely allowing all GETs or all escalated requests would weaken the requested guarantee. The stricter policy must not be presented as a completed implementation of general support access.

## Verification limits

Focused unit/component tests and real Mongo replica-set tests cover the implemented boundaries, including escalation audit rollback, customer response redaction and expired-session recovery. The latest focused run passed 114 tests; typecheck and lint passed. Deployment environment wiring and the self-host configuration example now expose the TTL setting.

An isolated branch runtime on port 3002 with a separate disposable database exercised Login as User through the normal authenticator/reason dialog, displayed the read-only countdown banner, and exercised reason-based escalation. The admin profile displayed start/escalation/end timeline records. The shared port-3000 app and its database records were not changed. Browser testing still reports forbidden auxiliary shell queries; a complete notebook-edit round trip, customer activity view, light/dark/mobile and all sensitive alternate paths remain unverified. A screenshot was refused because the page embeds an authenticated third-party Stripe origin. Do not close the feature acceptance checklist based on this partial browser result.
