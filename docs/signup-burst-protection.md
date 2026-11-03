# Signup burst protection

## Account risk review and AI access

Accounts whose signup risk score reaches the review threshold enter **Admin > Risk review**, as do
accounts whose signup credits the signup grant risk policy holds in its review band (marked
**Credits held**). While a review is pending, AI requests are refused with an account-review message, including
free models and requests made with API keys. Sign-in and access to existing data remain available;
users can contact support to request a review. Existing pending reviews also receive this hold.

**Approve** lifts the signup review hold and pays any held signup credits. A separate manual AI restriction or account suspension
still applies. **Undo** restores the pending review and AI hold but keeps the paid credits. Rescoring updates the score and
signals but never clears a pending hold or overturns an approval. To deny access to the account
as a whole, use **Suspend** in the review queue.

This hold is independent of the domain and signup-credit controls below. It does not deduct
credits or turn a credit-only domain hold into an account suspension. If an approved user still
cannot use AI, check for a manual AI restriction, suspension, and normal plan and credit limits.

## Domain holds

Admins can enable **Auto-hold Signup Bursts** in Admin > Settings > Users.
The default is off. **Signup Burst Threshold** defaults to 5 verified signups
and **Signup Burst Window (hours)** defaults to 6 (maximum 168).

Detection groups verified signups by registrable email domain, including private
public suffixes, and requires generated local parts as well as the volume threshold.
The newest 1,000 observations per domain bound each evaluation; reported counts
refer to that analyzed sample. It recognizes shared alphabetic prefixes with hexadecimal counters and increasing
hexadecimal suffixes that climb across at least 80% of the generated addresses, so unrelated
addresses may interrupt the counter cohort but a short run among ID-style addresses does not count,
with rotating short subdomains included in the review reason.
Ordinary employee names and volume alone do not trigger a hold. Observations begin
when detection is enabled; historical users are not reclassified as fresh signups.
Shared-MX and cross-domain infrastructure correlation are outside this detector.

A held domain can still register, but its pending flat free-credit grants and
staged signup tranches are withheld. Activity, organization-invite and admin
unlocks also wait for domain release, before consuming eligibility evidence.
Already granted balances are never deducted. The manual
`blockedEmailDomains` setting remains independent and continues to reject regular
registration. Public mailbox providers, configured synthetic email domains, and
enabled organization signup-rule domains are exempt from automatic holds.

Review domains in **Admin > Signup Domain Holds**. **Confirm** keeps grants held.
**Release** permanently exempts that domain from automatic re-holding and retries
up to 100 verified pending grants. Use **Retry pending grants** if grants remain
or a credit write failed. Each retry advances past the previous batch; after the
last batch, another retry starts a fresh pass over failures. A staged account's
pending signup tranche resumes without granting its remaining unlock entitlement;
later unlocks still require their normal validators. Manual email blocks still take precedence. The queue
retains decisions and the admin identity/time of each review; observations expire
after seven days. A domain's original cohort and five sample emails are retained
with its review record.

Each newly created hold attempts one Slack notification through
`SlackSecurityAlertsWebhookUrl`. An empty security URL disables these alerts;
signup samples never fall back to a general webhook.
The webhook request times out after three seconds. Configure `APP_URL` for an absolute link to the queue. If delivery fails or no
webhook is configured, the hold remains effective and the server logs a delivery
error; notification delivery is not automatically retried. Inspect the queue
and server logs when detection is enabled but no alert arrives.

Core service consumers can supply `db.signupProtection` with a
`SignupProtectionRepository` and an optional `notifyHold` callback. The client
runtime and credit recovery scripts wire the database repository into the shared
flat-grant and staged-release boundaries. Recovery scripts use `mode: 'enforce'` to check existing holds
without replaying signup observations or creating holds without notifications. External service consumers without that adapter retain their
existing behavior.

## Disposable lists and domain intelligence

A daily job (`apps/workers/src/cron/disposableDomainRefresh.ts`) refreshes three upstream disposable-domain lists into MongoDB: the curated `disposable-email-domains/disposable-email-domains` list, `7c/fakefilter`, and the `disposable/disposable-email-domains` aggregate. A source that fails, returns nothing, or shrinks below half of its last good size keeps its previous entries. Per-source counts, last success and last error appear in **Admin > Signup Domain Holds**; the `disposableDomainRefreshFailures` alarm fires after two failing days. If an upstream genuinely shrinks by half, the floor refuses it every day; delete that source's `disposabledomainsources` document to accept the next snapshot.

- **Rejected** at registration (and withheld on OAuth signup and email change) under **Block Disposable Emails**: the admin `blockedEmailDomains` list, the bundled package list, the curated list and fakefilter. Organization and internal staff domains are never rejected on a refreshed-list hit, since those lists change without review.
- **Held** for review (account created, free credits pending) when **Hold Risky Signup Domains** is on (default on):
  - `disposable-aggregate`: the domain is only on the aggregate list, which also scrapes and so carries more false positives.
  - `young-domain`: RDAP reports a registration younger than **Hold Signups From Domains Younger Than (days)** (default 30; 0 turns it off).
  - `burner-mx`: the domain's MX host belongs to a rejected provider.
  - `disposable-list`: a rejected-tier domain reached the hold step because **Block Disposable Emails** is off.

Shared commodity mail hosting (Cloudflare Email Routing, Google Workspace) is recorded as a flag and never held on its own; `domainRiskFacts` exposes the flags for a signup risk score. Forwarding/relay services are not ingested.

RDAP and MX lookups run once per registrable domain, in parallel within **Domain Lookup Timeout (ms)** (default 2000). Results are cached for seven days, failures for an hour (a cold start can spend most of the budget fetching the RDAP bootstrap). A timeout, a registry without RDAP, a rate limit or a DNS error logs a warning and lets the signup through. Domain-intelligence holds share the review queue, Slack alert and Release flow above, apply only to fresh signups, and do not depend on **Auto-hold Signup Bursts**. Mailbox providers, synthetic, organization and internal staff (`NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS`) domains are exempt.
