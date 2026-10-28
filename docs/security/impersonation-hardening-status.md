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

The route gate intentionally fails closed. Read-only admission is an explicit set of reviewed GET/HEAD routes, not a rule that all GET requests are safe. Escalation currently admits only the files, agents and sessions collection/detail endpoints. Unreviewed routes remain blocked after escalation. The current UI therefore overstates the breadth of "Allow changes" and the ordinary notebook workflow is not complete.

Sensitive families are blocked before escalation admission: auth/MFA/passkeys/step-up, OAuth, OTC, email, Stripe, subscriptions, credit operations, API keys, admin routes, websocket credentials, account update/deletion and customer session revocation. Account update is blocked wholesale because it combines ordinary profile preferences with password/email and privilege changes. Email-settings has another write path and is also blocked. API-key rotation is treated as secret creation. Token-only unauthenticated routes are blocked when the browser presents the parked admin cookie, except refresh/return and selected public bootstrap reads. CLI/completion and realtime bearer paths refuse impersonation, rather than bypass the route policy.

The route inventory is not exhaustive. Remaining work requires reviewing notebook reads/writes, content-producing GET routes, read-only POST routes, public/token-only alternate paths, generic resource handlers and asynchronous actions before expanding admission. Merely allowing all GETs or all escalated requests would weaken the requested guarantee. The stricter policy must not be presented as a completed implementation of general support access.

## Verification limits

Focused unit/component tests and real Mongo replica-set tests cover the implemented boundaries. Browser E2E has not been run: the shared port-3000 app and its data were deliberately left untouched. Light/dark/mobile rendering, complete route navigation, all sensitive alternate paths and production environment-variable wiring still require validation. Do not close the feature acceptance checklist based on the partial implementation.
