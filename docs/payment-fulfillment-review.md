# Payment fulfillment review

This read-only Revenue review compares live Stripe payment intents and subscription invoices with the credit ledger. It never replays events, adjusts balances, refunds, or changes subscriptions.

## Expected fulfillment

* Credit packs: user-owned payments carrying server-set positive `metadata.credits` expect one completed `purchase` row with the same payment intent, owner and credits. Organization-owned packs are not supported by the purchase handler; they remain unknown.
* Individual subscriptions: initial grants use plan credits but can legitimately be suppressed by the 72-hour cooldown. Renewals and updates use the configured cycle override or plan credits. These historical settings are not durably captured on every invoice or grant, so this review does not infer expected amounts from today's settings.
* Organization subscriptions: initial and renewal grants use seats times credits per seat. Updates use positive prorated seat increases; other updates can legitimately issue nothing. Historical seat and settings evidence is required to assert an expected amount.
* Subscription grants use payment intent IDs, or invoice IDs when no payment intent exists. The Subscription invoices source covers both keys, including zero-dollar and invoice-only cycles. A paid renewal with positive billed quantity and matching local subscription/customer ownership expects a positive grant; a missing grant is pending during grace and unmatched afterward. Its historical amount remains unknown. Initial and update invoices can legitimately grant nothing, so absence alone remains unknown. Subscription record mismatches remain with the existing checker; each invoice links to its subscription timeline.

## Evidence and timing

Matching uses exact payment intent, refund and dispute IDs, never amount/date proximity. A provider customer must resolve unambiguously to a local user or organization. Internal accounts are not excluded: they follow the same evidence rules. Unknown ownership is not a mismatch.

Stage-owned credit-pack payments remain visible as unknown when neither a customer link nor a ledger row exists. Foreign-stage payments and invoices are excluded. The unique sparse payment-intent index prevents same-key duplicate grants. Invoice review also matches every provider-linked payment-intent key and the invoice fallback key: multiple issuance rows are duplicate candidates. No fuzzy owner/time matching is used. Multi-payment or truncated invoices remain unknown rather than assuming a one-payment/one-grant relationship.

A 72-hour operational grace period from the successful charge (or refund creation) accommodates webhook retries and asynchronous delivery. This is a review policy, not a promise that delivery occurs within that period. Recent missing issuance is pending; older missing credit-pack issuance is unmatched. Repeated reads recompute findings, so a delayed ledger row resolves the finding without any review-state mutation.

Succeeded credit-pack refunds expect a deduction per refund ID of `round(purchasedCredits * refundAmount / chargeAmount)`. Fully refunded purchases also require a reversal marker. Partial refunds are not expected to mark the purchase fully reversed. Pending refunds and active/lost disputes remain distinct from settled issuance. Subscription refunds require reversal review rather than assuming pack clawback semantics. A won dispute with a remaining credit deduction also requires reversal review; a provider win alone is not credit-restoration evidence.

## Coverage

Each request reads at most 25 provider payment intents or invoices created in a 1-90 day window, up to 100 invoice payments/refunds and 102 ledger rows per item. The sources paginate separately using shareable source-specific cursors. This is a creation-window review, not a complete feed of recent refunds against older payments. Filters are applied server-side within each provider page, not to an unbounded account scan. A filtered page can be empty and still have a next page. Category counts derive from exactly the displayed rows, not account-wide totals. Truncated evidence is unknown. Missing credentials, provider failures or local read failures produce unavailable, never an empty all-clear. Freshness is the read timestamp, not a persisted reconciliation checkpoint.

Ledger agreement is not independent proof that a historical balance increment committed. This surface does not claim accounting reconciliation, complete historical coverage, or independent balance delivery verification.
