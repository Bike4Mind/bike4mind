# Spend monitor account tiers

The spend monitor evaluates rolling 15-minute credit usage every five minutes. Account alerts
use three tiers, resolved automatically on each evaluation:

| Tier     | Qualification                                                                   | Default spike floor | Default critical ceiling |
| -------- | ------------------------------------------------------------------------------- | ------------------: | -----------------------: |
| Standard | No qualifying active subscription or explicit trust                             |       1,000 credits |            5,000 credits |
| Paid     | Active recognized paid plan, directly or through a qualifying organization seat |      20,000 credits |           40,000 credits |
| Trusted  | Explicit trusted account ID or verified email domain                            |      20,000 credits |           40,000 credits |

Explicit trust takes precedence over paid classification. API keys and agents inherit the tier of
the account that pays for their usage. An organization-billed key follows the organization rather
than its creator's personal subscription. Personal accounts can qualify through an organization
plan only when they hold a seat under the existing owner, admin, or read/write membership rules.

Paid classification uses the same recognized plan and active-status rules as subscription
entitlements. Admin-granted paid plans qualify. A subscription scheduled to cancel still qualifies
while active; trialing, past-due, and canceled subscriptions do not. Credit purchases alone do not
qualify for this subscription tier. Period dates are not an additional gate, consistent with the
entitlement resolver and its handling of delayed billing updates.

Paid usage remains included in platform spike detection. Only explicitly trusted accounts use the
existing trusted-spend exclusion. If subscription classification fails, the monitor logs the error
and evaluates accounts using standard limits; explicit trust is resolved independently.

Operators can tune `spendMonitorPaidAccountSpikeFloorCredits` and
`spendMonitorPaidAccountCeilingCredits` in the admin credit settings under SecOps. No account list
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
