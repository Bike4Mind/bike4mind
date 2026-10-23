# Signup burst protection

Admins can enable **Auto-hold Signup Bursts** in Admin > Settings > Users.
The default is off. **Signup Burst Threshold** defaults to 5 verified signups
and **Signup Burst Window (hours)** defaults to 6 (maximum 168).

Detection groups verified signups by registrable email domain, including private
public suffixes, and requires generated local parts as well as the volume threshold.
The newest 1,000 observations per domain bound each evaluation; reported counts
refer to that analyzed sample. It recognizes shared alphabetic prefixes with hexadecimal counters and increasing
hexadecimal suffixes, with rotating short subdomains included in the review reason.
Ordinary employee names and volume alone do not trigger a hold. Observations begin
when detection is enabled; historical users are not reclassified as fresh signups.
Shared-MX and cross-domain infrastructure correlation are outside this detector.

A held domain can still register, but its pending flat free-credit grants are
withheld. Already granted balances are never deducted. The manual
`blockedEmailDomains` setting remains independent and continues to reject regular
registration. Public mailbox providers, configured synthetic email domains, and
enabled organization signup-rule domains are exempt from automatic holds.

Review domains in **Admin > Signup Domain Holds**. **Confirm** keeps grants held.
**Release** permanently exempts that domain from automatic re-holding and retries
up to 100 verified pending grants. Use **Retry pending grants** if grants remain
or a credit write failed. Each retry advances past the previous batch; after the
last batch, another retry starts a fresh pass over failures. Manual email blocks still take precedence. The queue
retains decisions and the admin identity/time of each review; observations expire
after seven days. A domain's original cohort and five sample emails are retained
with its review record.

Each newly created hold attempts one Slack notification through
`SlackSecurityAlertsWebhookUrl` (with the existing default webhook fallback).
The webhook request times out after three seconds. Configure `APP_URL` for an absolute link to the queue. If delivery fails or no
webhook is configured, the hold remains effective and the server logs a delivery
error; notification delivery is not automatically retried. Inspect the queue
and server logs when detection is enabled but no alert arrives.

Core service consumers can supply `db.signupProtection` with a
`SignupProtectionRepository` and an optional `notifyHold` callback. The client
runtime and credit recovery scripts wire the database repository into the shared
flat-grant boundary. External service consumers without that adapter retain their
existing behavior.
