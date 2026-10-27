# Business metric anomaly alerts

The scheduled worker reconciles the current UTC period against the same period yesterday at
five minutes past each hour. The midnight run compares the last two complete days. Other runs
compare midnight through the last completed hour on each day. Every alert includes the preceding
seven comparable periods' median and, where attributable, the five largest contributor changes
in the anomaly's direction. Contributor values are signed current-minus-previous deltas,
including previous contributors whose current value is zero.

## Configuration

- Set the existing **User Activity Channel Webhook URL** (`SlackUserActivityWebhookUrl`) in
  Admin Settings > Feedback to the destination channel's incoming webhook. Configure it
  separately in staging (`dev`) and production. There is no general-channel fallback. A missing
  webhook logs the configuration gap and returns `status: 'skipped'` before collecting metrics.
- Scheduled resources exist only on `dev` and `production`. Set
  `BUSINESS_METRIC_ALERTS_ENABLED=false` in the deployment environment to disable the schedule.
- `BUSINESS_METRIC_THRESHOLDS` is a JSON object in the deployment environment. Each entry has
  `percent` (default 5) and a required positive `minimumDelta`. Exact metric names override
  families. For example:

```json
{
  "verifiedSignups": { "percent": 5, "minimumDelta": 10 },
  "spendUsd": { "percent": 5, "minimumDelta": 5 },
  "spendUsd:openai": { "percent": 10, "minimumDelta": 10 },
  "revenueMinor:usd": { "percent": 5, "minimumDelta": 1000 }
}
```

An alert requires an absolute change at least `minimumDelta` and a relative change strictly
greater than `percent`, in either direction. A zero baseline with enough new activity alerts
without dividing by zero; zero against zero stays quiet. Default absolute guards are USD 5
for spend, 100 for credits, 2 for paying subscribers, 1000 minor currency units for revenue, and 10 for other metrics.
Set revenue guards per currency before enabling production.

## Metric definitions and exclusions

| Metric                                       | Definition                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifiedSignups`                            | An external account counts as a signup in a period only if it verified (`emailVerifiedAt`, falling back to `createdAt`) before that period's cutoff; email changes do not count as new signups.           |
| `activeUsers`                                | Distinct external users with a successful app/CLI/desktop usage event, original Quest message, or agent execution. Public API activity is separate.                                                       |
| `payingSubscribers`                          | Distinct external user or organization owners with an active Stripe-managed subscription and an unexpired period. Admin grants and trials are excluded.                                                   |
| `spendUsd`, `spendUsd:<provider>`            | Frozen estimated provider costs from UsageEvent, including failed calls with recorded cost. These are estimates, not provider invoices.                                                                   |
| `credits`                                    | Credits charged on those same usage records.                                                                                                                                                              |
| `requests:user`, `requests:firstParty`       | API-key request log rows, split into third-party `api` and first-party `cli`/`desktop` sources. Includes failed requests.                                                                                 |
| `completions:user`, `completions:firstParty` | `completion_api` usage records with an API key, using the same source split.                                                                                                                              |
| `revenueMinor:<currency>`                    | Successful Stripe charges at the payment-event timestamp, deduplicated by charge ID. Gross receipts, including credit packs and subscriptions; refunds are not subtracted. Currencies are never combined. |

Missing API source stamps are counted in `requests:unclassified` or `completions:unclassified`,
so legacy traffic is visible without guessing its origin. Contributors use user/organization
IDs and model names, not email addresses or IPs. Spend contributor cuts overlap (a user and
their model describe the same cost); they must not be summed together.

All business figures exclude admins, synthetic accounts, staff domains from
`NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS`, test addresses matching an explicitly configured `ANALYTICS_TEST_PATTERN` (no email heuristic
is applied when unset), and orphaned users. Organization owners must
also be external. System usage and API keys tagged with a `productId` are excluded, including
internal ingestion activity. Ordinary first-party CLI/desktop traffic remains in its named cut.
Stripe customers must map to an eligible account in this stage's database.
Usage billed to Agent owners is included in spend, credits and completions when the agent
resolves to an eligible user or organization owner; the same exclusions apply to that owner.

Subscription rows contain only current state, so the worker persists one observed count per UTC
hour instead of inventing history. Yesterday's comparison becomes available after 24 hours;
the median needs seven prior samples. Missing samples stay unknown and cannot cause an alert.
Subscriber snapshots provide counts, so subscriber alerts omit contributor identities rather than
listing arbitrary currently subscribed owners. Samples are observed at the scheduled run (about five minutes after the boundary). A replay more
than an hour late does not create a historical subscription sample. Other metrics are rebuilt
from their source records; delayed writes and later email verification can revise their history.

The included database migration creates the state collection's `expiresAt` TTL index and
`stripeCustomerId` indexes on User and Organization for payment-customer lookups through the normal migration deployment process. State samples and
delivery receipts are retained for ten days.

## Verification and response

1. Run `pnpm --filter @bike4mind/workers test:integration src/cron/businessMetrics/collect.e2e.test.ts`
   for seeded database exclusions, API source splits, comparable periods, subscription warm-up,
   concurrent delivery claims, and rejected-delivery retries.
2. Run `pnpm --filter @bike4mind/workers exec vitest run src/cron/businessMetricAlerts.test.ts`
   for the full handler's seeded >5% and <5% decisions with an isolated Slack transport.
3. Deploy to `dev` with a test-channel webhook. Seed source records for two comparable periods
   with a change above both configured guards; invoke the worker with an EventBridge-shaped
   `{ "time": "<scheduled UTC ISO timestamp>" }`. Confirm the named alert in Slack. Repeat
   with a change under 5%, using a new period, and confirm no post. Never seed production data.
4. Configure production's webhook and per-currency guards, deploy, and confirm the
   `business-metric-alerts` success log plus actual channel delivery. A missing webhook logs a
   skipped run. Source query, Stripe API, and Slack errors fail the invocation; inspect the
   Business Metric Alerts DLQ and its shared DLQ alarms if retries exhaust.

Delivery receipts are stored only after Slack accepts a post. A lease prevents simultaneous
workers from sending the same metric/day/direction/run kind, and failed posts are retried.
A contended lease skips that anomaly and continues delivering the others. A crashed sender's
lease expires after 15 minutes, allowing a later invocation or replay to retry. An early retry
that encounters the lease can succeed without sending that alert or reaching the DLQ. For a
crashed daily-close sender, manually replay the original event after lease expiry; the next
hourly run compares a new window rather than retrying that daily close. As with any
incoming webhook, a crash after Slack accepts but before the receipt commits can cause a duplicate.
Replaying after ten-day receipt expiry can also resend a historical alert. Each metric alerts
only on its first intraday threshold crossing in each direction per UTC day. Later hourly
cutoffs in the same direction stay quiet; a reversal can alert once in the opposite direction. The midnight run closes the previous UTC
day with a separate receipt, so it can alert even after an intraday alert in the same direction.
Repeated delivery of that closing alert is suppressed. The next UTC day starts fresh.
Failed posts do not consume the receipt and remain retryable.

On an alert, inspect the named user/org/model contributors, compare the 7-day median, and check
the relevant source data before changing thresholds. A small-number guard prevents noise; it
does not make a changing business baseline safe to ignore. Check `subscriberBaselineReady` in
the success log while the subscription snapshots warm up.

## Independent provider budget backstop

Configure Anthropic and OpenAI organization/project budget notifications in the provider
accounts as a separate operational step. Route notifications to an actively monitored owner,
set both notification thresholds and supported enforcement controls, and verify a test
notification arrives. Record the configured owner, limit, thresholds and verification date in
the private operations runbook. Do not put provider account identifiers or billing details here.
Provider controls vary; verify the available controls in each account before relying on them.
These notifications must work independently of the application metrics worker and its database.
The code in this change does not modify provider budgets or deploy a production webhook.
