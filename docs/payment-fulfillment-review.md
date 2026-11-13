# Payment fulfillment review

This read-only Revenue review compares live Stripe payment intents with the credit ledger. It never replays events, adjusts balances, refunds, or changes subscriptions.

## Expected fulfillment

* Credit packs: user-owned payments carrying server-set positive `metadata.credits` expect one completed `purchase` row with the same payment intent, owner and credits. Organization-owned packs are not supported by the purchase handler; they remain unknown.
* Individual subscriptions: initial grants use plan credits but can legitimately be suppressed by the 72-hour cooldown. Renewals and updates use the configured cycle override or plan credits. These historical settings are not durably captured on every invoice or grant, so this review does not infer expected amounts from today's settings.
* Organization subscriptions: initial and renewal grants use seats times credits per seat. Updates use positive prorated seat increases; other updates can legitimately issue nothing. Historical seat and settings evidence is required to assert an expected amount.
* Subscription grants use payment intent IDs, or invoice IDs when no payment intent exists. This initial surface covers payment intents only; invoice-only grants, zero-dollar invoices and subscription record mismatches are not covered. Use the existing Subscriptions review and timeline for those records.

## Evidence and timing

Matching uses exact payment intent, refund and dispute IDs, never amount/date proximity. A provider customer must resolve unambiguously to a local user or organization. Internal accounts are not excluded: they follow the same evidence rules. Unknown ownership is not a mismatch.

Stage-owned credit-pack payments remain visible as unknown when neither a customer link nor a ledger row exists. Foreign-stage payments are excluded. The unique sparse payment-intent index prevents duplicate grants under the same key; this review does not detect duplicate issuance under alternate keys (such as an invoice ID), and does not advertise a duplicate category.

A 72-hour operational grace period from the successful charge (or refund creation) accommodates webhook retries and asynchronous delivery. This is a review policy, not a promise that delivery occurs within that period. Recent missing issuance is pending; older missing credit-pack issuance is unmatched. Repeated reads recompute findings, so a delayed ledger row resolves the finding without any review-state mutation.

Succeeded credit-pack refunds expect a deduction per refund ID of `round(purchasedCredits * refundAmount / chargeAmount)`. Fully refunded purchases also require a reversal marker. Partial refunds are not expected to mark the purchase fully reversed. Pending refunds and active/lost disputes remain distinct from settled issuance. Subscription refunds remain unknown rather than assuming pack clawback semantics.

## Coverage

Each request reads at most 25 provider payment intents in a 1-90 day window, up to 100 refunds and 102 ledger rows per intent. Filters are applied server-side within each provider page, not to an unbounded account scan. A filtered page can be empty and still have a next page. Counts describe only that page, not account-wide totals. Truncated evidence is unknown. Missing credentials, provider failures or local read failures produce unavailable, never an empty all-clear. Freshness is the read timestamp, not a persisted reconciliation checkpoint.

Ledger agreement is not independent proof that a historical balance increment committed. This surface does not claim accounting reconciliation, complete historical coverage, or independent balance delivery verification.
