# Spend monitor account tiers

The spend monitor evaluates rolling 15-minute credit usage every five minutes. Account alerts
use three tiers, resolved automatically on each evaluation:

| Tier     | Qualification                                           | Default spike floor | Default critical ceiling |
| -------- | ------------------------------------------------------- | ------------------: | -----------------------: |
| Standard | No qualifying paid standing or explicit trust           |       1,000 credits |            5,000 credits |
| Paid     | Established paid standing with the context checks below |      20,000 credits |           40,000 credits |
| Trusted  | Explicit trusted account ID or verified email domain    |      20,000 credits |           40,000 credits |

Recorded risk flags take precedence over explicit trust; otherwise explicit trust takes precedence over automatic paid classification. API keys and agents inherit the tier of
the account that pays for their usage. An organization-billed key follows the organization rather
than its creator's personal subscription. Personal accounts can qualify through an organization
plan only when they hold a seat under the existing owner, admin, or read/write membership rules.

Paid classification uses the same recognized plan and active-status rules as subscription
entitlements. Admin-granted paid plans qualify. A subscription scheduled to cancel still qualifies
while active; trialing, past-due, and canceled subscriptions do not. Unreversed credit purchases can also confer paid standing when the shared context checks below pass. Period dates are not an additional gate, consistent with the
entitlement resolver and its handling of delayed billing updates.

Paid usage remains included in platform spike detection. Only explicitly trusted accounts use the
existing trusted-spend exclusion. If subscription classification fails, the monitor logs the error and applies no subscription
standing; credit-purchase standing and explicit trust are evaluated independently. Unavailable account context (for example an API key whose payer cannot be resolved) suppresses all of them, including explicit trust and its trusted-spend exclusion.

Operators can tune `spendMonitorPaidAccountSpikeFloorCredits` and
`spendMonitorPaidAccountCeilingCredits`, and `spendMonitorPaidAccountMinAgeDays` in the admin credit settings under SecOps. No account list
or deployment is required for a subscription change to affect the next evaluation. The limits
control alerts, not billing or request admission. Slack incidents store the applied tier, spike
floor, and ceiling from their latest breaching evaluation. Resolution messages retain that snapshot
rather than reclassifying the account at message-render time.

The spike floor alone does not trigger a warning: usage must also reach the configured account
spike ratio against its seven-day p95 baseline. Without a positive baseline the required amount is
floor times ratio. The absolute ceiling always triggers a critical alert, regardless of baseline.

Use the paid defaults as an initial operating policy, then review legitimate busy-session windows
and resulting alert frequency over one to two weeks. Keep the ceiling above expected session bursts
but within the loss budget operators are willing to investigate immediately. Credit dollar figures
in account alerts are list-price approximations, not measured provider costs.

## Shared account context

Account facts are resolved by the read-only `server-utils/lib/accounts/accountContext` module.
It batches projected account records and payment-attempt summaries; it never writes review state,
access decisions, credit balances, or enforcement overrides. Organizations use their own age and
credit-purchase standing, and their responsible owner's age, verification, review, and payment-risk
facts. Keys and agents inherit their actual payer's context, rather than their creator's context.

Automatic paid limits require verified email, known account and responsible-owner ages at least
`spendMonitorPaidAccountMinAgeDays` (default 7), and a known review state that allows the policy.
An account with neither a review state nor a signup risk score (it predates scoring, or its scoring
never completed) is treated the same way: once it meets the age requirement, that absence alone does
not block paid limits (its alerts name it as `unscored_account`), and every recorded risk flag below
still applies.
An active recognized subscription or a dated unreversed credit-purchase stamp supplies paid standing.
A purchase stamp with an invalid or future date cannot supply automatic paid standing. Credit
purchase standing uses the existing purchase stamp, not a checkout/customer ID. A refund or dispute
clears a user's stamp once no unreversed purchase backs it. An organization's stamp is not cleared
on reversal.

Pending or banned reviews, a banned account (read from the account flag, since unscored accounts
have no review state), a reopened review not subsequently approved, recorded payment-risk
events, retained Radar-blocked payments, or elevated payment-risk outcomes select standard limits.
An unapproved numeric risk score at or above the existing signup review threshold also selects
standard limits; an explicit review approval takes precedence over that numeric score. Ordinary
payment failures alone do not imply abuse. Explicit operator trust may accommodate a young partner,
but does not override these recorded risk flags. A failed context lookup selects standard limits
and keeps the payer's usage in platform detection.

Payment summaries cover retained attempts in the preceding 90 days. No retained rows means unknown
history, not proof of clean payments; a current subscription can still establish paid standing.
Behavioral evidence is advisory: its presence and age are displayed, and neither old evidence nor
missing evidence silently grants or revokes trust. Alerts store the latest breached window's facts
and policy reasons, so resolution messages can explain the same decision without fresh lookups.

The minimum-age setting and this policy affect spend-monitor alerts only. Existing young-account
spend caps, young-account aggregate monitoring, API-key trust, risk review, and containment retain
their own independent policies. Setting the monitor's minimum age to zero does not lift a spend
cap or change any of those systems.
