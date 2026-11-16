# Credit economy overview

Open Money > Credits > Economy. The view is read-only and uses the existing
Credits page permission. Ownership, UTC dates and the transaction-flow filter
are shareable URL parameters. Select a flow to inspect its server-paginated
transactions. Export report (JSON) includes totals, coverage and definitions;
it is a summary export, not an unbounded transaction download.

## Accounting basis

All values are credit units, not money or revenue. The ledger window is
half-open `[from, to)`, at most 366 days. Completed purchase rows are purchased
issuance; pending and failed purchases contribute no balance delta. Generic
grants never imply purchases. Unknown reasons remain unknown movement.

The reconciliation equation is:

`closing = opening + purchased + subscription + granted + refunds + adjustments + unknown + signed transfers - consumption - expiry - clawbacks`

Flow values are signed deltas, so the displayed net is their sum. Transfers
are separate from issuance. One side may fall outside an ownership or date
filter; a nonzero transfer delta in that scope is not platform issuance.
Original purchase issuance is retained after a reversal, with the clawback
reported separately at its ledger date.

All-owner scope includes individuals, organizations, agents and internal
accounts. It does not infer internal-account exemptions. Available balances
are current, independently read user/organization balances, not period-end
snapshots. Missing values remain unknown; agent/all-owner balance totals
are unavailable because agent balance pools are not included in that read.

## Coverage, not fabricated history

- Immutable historical opening, closing and outstanding-hold snapshots do not
  exist. These metrics and their independent reconciliation difference are null,
  not zero. A reservation without settlement does not become consumption.
- Ledger consumption and usage-event debits are distinct sources. Their signed
  difference is displayed unresolved; the report does not force agreement.
- Recorded usage funding stamps are FIFO snapshot allocations, not exact
  purchase-lot histories. Missing/invalid stamps are unknown. Recorded write-offs
  are removed proportionally across valid funding categories.
- Current live-lot remainder estimates use `amount - consumedAssigned`, clamped
  at zero. Settled and expired lots are excluded. This is not a historical closing
  balance; stale sweeps, incomplete stamping and clawbacks can affect it.
- Mature purchase counts and original issued credits are available for 7/30-day
  horizons as of report time. Consumed credits are null and attributable coverage
  is zero because no immutable purchase-to-consumption link exists. Expiry and
  clawback are never substituted for consumption.
- Writer idempotency indexes prevent keyed retries from adding another ledger
  row. Unkeyed historical duplicates cannot be safely identified by analytics.
- Queries have a 15-second server timeout. Transaction pages contain at most
  100 rows and stop at 1,000 pages; narrow filters to inspect further. Reports
  are not atomic cross-collection snapshots.

No credit policy, balance mutation, pricing, spending order or spend alert
behavior changes. Full historical reconciliation and purchase-cohort consumption
remain unmet pending prospective immutable accounting records.
