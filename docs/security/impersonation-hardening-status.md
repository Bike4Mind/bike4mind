# Impersonation hardening: implementation status

Support access provides a bounded, explicitly admitted notebook/content workflow. It is not an unrestricted customer session, even after escalation.

## Implemented

- Fixed server-side impersonation deadline; `IMPERSONATION_TTL_MINUTES` defaults to 60.
- Live session lookup only for impersonated access JWTs; ordinary authentication pays no new lookup.
- Refresh cannot slide the impersonation deadline.
- Read-only default, explicit audited escalation, and conservative route admission.
- Persistent banner with identity, countdown, End and a shared reason dialog.
- Durable support-access records; customer projection omits admin identity and internal reasons.
- Transactional, compare-and-swap end bookkeeping and bounded expiry reconciliation in the existing audit worker.
- Admin timeline uses the existing admin-audit source; sessions view includes support history.

## Security boundary

The route gate intentionally fails closed. Read-only admission is an explicit set of reviewed GET/HEAD routes, not a rule that all GET requests are safe. Reviewed notebook navigation, message reads, organization lists and published modals are admitted. The briefcase catalog is an explicitly admitted read-only POST. Escalation admits notebook creation/cloning, stored-message edits, file edits and notebook associations. The dialog describes this limited scope. Agent writes remain blocked because agent creation can transfer customer credits. Integration credentials, automated tool execution and realtime credentials remain blocked; the client does not request websocket tickets during impersonation.

Sensitive families are blocked before escalation admission: auth/MFA/passkeys/step-up, OAuth, OTC, email, Stripe, subscriptions, credit operations, API keys, admin routes, websocket credentials, account update/deletion and customer session revocation. Account update is blocked wholesale because it combines ordinary profile preferences with password/email and privilege changes. Email-settings has another write path and is also blocked. API-key rotation is treated as secret creation. Token-only unauthenticated routes are blocked when the browser presents the parked admin cookie, except refresh/return and selected public bootstrap reads. CLI/completion and realtime bearer paths refuse impersonation, rather than bypass the route policy.

Unreviewed routes fail closed, including generic resource handlers and asynchronous actions. Expanding support capabilities requires reviewing each handler's effects; neither GET nor escalation alone grants admission. MCP schema reads remain blocked because they use integration credentials and refresh persisted schemas. Nonessential credential, help and lake-picker queries are suppressed during support access; reviewed shell reads are admitted explicitly.

## Verification limits

Focused unit/component tests and real Mongo replica-set tests cover the implemented boundaries, including escalation audit rollback, customer response redaction and expired-session recovery. The latest focused run passed 114 tests; typecheck and lint passed. Deployment environment wiring and the self-host configuration example now expose the TTL setting.

An isolated branch runtime on port 3002, separate disposable database and separate mail sink exercised normal email/MFA login, Login as User, read-only refusal (403), invalid-short-reason UI refusal, escalation, notebook creation and inline rename, persisted customer-visible rename, and End restoring the original admin. The customer's Settings > Security now displays support access dates/durations without internal reasons or admin identity. The admin timeline displayed start/escalation/end records.

Live requests after escalation returned 403 for account identity update/deletion, MFA setup, subscription changes, API-key creation, agent funding, Google Drive credentials and MCP schemas. The token-only email-change route returned 403 through the parked-cookie guard. Unit tests cover additional methods and alternate paths; this is not a claim that every route has been individually exercised live.

A fresh browser context at 390x844 verified the banner and End fit in both light and dark modes. Refresh preserved the signed deadline. Shortening only the disposable session's persisted deadline verified the visible countdown automatically restored the admin, the old JWT returned 401, and a durable end record was written. This accelerated check is not a natural one-minute TTL run. A page-load wait initially timed out on an unrelated external sky-greeting fetch; the successful check used DOM readiness.

Shared port 3000 and shared database records were preserved. Screenshot capture was refused because the page embeds an authenticated third-party Stripe origin; that restriction was not bypassed. The bootstrap visit beacon remains refused during support access rather than recording a customer visit. Existing local help-index 404 and disabled-data-lake responses also occur outside support access and are not acceptance evidence for this feature.
