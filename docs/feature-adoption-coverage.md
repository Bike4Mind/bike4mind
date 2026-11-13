# Feature adoption: observed-use first slice

The Adoption view on Feature activity / Event metrics reads the usage ledger for
`chat`, `image_generation`, and `image_edit`. Labels are presentation-only; stable
feature IDs remain the grouping keys. This is not the complete adoption and
discovery scope.

## Read contract

`GET /api/admin/analytics/feature-adoption` requires a JWT session with
`support:read`. Parameters: `accounts=external|internal|all` (default external),
`client=all|web|cli|api|agent|unknown`, `days=7|28|90`, optional inclusive `end`
(a complete UTC day; default yesterday). Two adjacent equal windows exclude today,
matching Analytics' complete-day comparison rule. Repeat use is the intersection
of successful users in those two windows, not signup-cohort retention.

Only `status=ok` settlements with nonempty user/request IDs count. Grouping is by
canonical feature, user and request ID, not provider rows or event-name keywords.
The first successful settlement within the queried two-window span owns the
operation. Tool, operational and other unverified features, system source,
worker runs and non-turn run purposes are excluded. Missing or conflicting source
attribution is unknown; no device is inferred from it. API/agent sources can be
isolated without changing their user denominator. Account classification and
access exclusions reuse Analytics' current counting helpers (including its
orphan-user behavior), not a new staff-domain list.

The query has a 15-second per-query deadline, at most 180 days of ledger data,
and a 5,000 user/feature/period-group response budget. Exceeding the budget fails
explicitly; results are never silently truncated. Summary, user contribution
detail and JSON export use the same response and filters. Raw Events and By user
remain available. No landing dashboard or campaign attribution changes are made.

## Interpretation and limitations

- Ledger writes are best-effort. Historical completeness and instrumentation
  start dates are unknown. Every count is an observation, not a population total.
  Previous windows without records are unavailable, not evidence of zero users.
- Launch date, rollout/client/plan eligibility, eligible population and comparison
  maturity are unknown. The view cannot distinguish unavailable from unused.
- Attempts and failures do not have consistent coverage, so no success rate is
  calculated. Missing records are not treated as failed attempts.
- Discovery/exposure is not measured. Low observed use is not evidence of poor
  demand. No automatic keep/remove verdict or causal release claim is made.
- User detail reports contributions, not raw operation receipts. JSON exports
  include both periods' user contributions and the exact effective filters.
- The operation key is only as reliable as recorder request IDs. A retried
  operation with a new request ID cannot be joined retrospectively. Settlements
  outside the bounded read span cannot be used to assign first-ever success.

## Remaining acceptance scope / instrumentation follow-ups

1. Add a versioned canonical operation registry spanning all product features,
   including rename aliases and a durable user-operation ID across retries.
2. Record attempts and final outcomes under that ID with per-feature coverage
   intervals and backfill/completeness markers before reporting success rates.
3. Maintain authoritative release/launch, client/plan rollout and eligibility
   history and population snapshots; then mark comparisons immature as needed.
4. Record eligible exposure/discovery events with matching attribution and exact
   denominators before showing eligible -> exposed -> attempted -> successful
   -> returned funnels.
5. Add release-aware equal-window, mature-cohort comparisons as observations,
   with no causal attribution claim.
6. Add permission-preserving, paginated operation receipts and broader feature
   coverage; validate rollout, failed-attempt and historical alias scenarios
   against that telemetry. Do not close the full issue on this first slice alone.
