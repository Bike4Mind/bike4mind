# Product billing implementation boundary

Status checked 2026-11-16 against [the billing request](https://github.com/Bike4Mind/bike4mind/issues/6559), the current implementation, and [the published offer](https://paintbox.bike4mind.com/pricing).

## Implemented slice

Active Professional and Team subscriptions grant `paintbox:pro` through the existing price-to-entitlement registry. Team seat membership uses the existing active-subscription resolver, so the grant applies to eligible organization members as well as owners. Lapsed subscriptions stop granting access on the next read. Unknown, unconfigured, unrelated product prices and free accounts do not acquire the grant from this mapping.

Clients read `entitlements` from `GET /api/v1/me` using existing authentication and the `me:read` scope. No token-claim migration or new endpoint is needed. This key is a product subscription signal, not permission to paywall every feature: the published offer explicitly keeps attended MCP editing free. PaintBox-side feature gating remains outside this change.

No new purchasable plan, Stripe price, wallet grant, storage allowance or production configuration is created here.

## Remaining requirements and decisions

| Requirement | Evidence and remaining work |
| --- | --- |
| Monthly SKU and 90-day credits | The issue suggests 8,000-10,000 credits; the live offer now says $10/month and 10,000 credits, marked coming soon. The published offer disproves the assumption that no concrete amount exists, but does not answer the spending-scope decision below. Keep checkout inactive until that decision and test/live price configuration are approved. Existing subscription renewal and credit-expiry infrastructure should be reused after the scope is settled. |
| Product-only spending | The issue explicitly leaves app-tagged charges versus one shared wallet undecided. Existing paid standing grants broader paid-model access and subscriber entitlements even to standalone plans (`entitlements/paidStanding.ts`). Registering the new SKU as an ordinary standalone plan would therefore not implement a product-only subscription. Decide whether its 10,000 credits are restricted to PaintBox or freely spendable across Bike4Mind, and whether its paid standing remains product-only. Restricted credits require trusted client attribution throughout reservations, settlement, refunds and all spend paths, not a caller-provided app label. |
| Prorated upgrade with credit carryover | The current change handler rejects tier-less standalone plans. An explicit PaintBox-to-Professional transition must be added after the wallet policy is chosen; restricted credit conversion and existing bucket expiry on upgrade need an explicit rule. Do not assign the new SKU a global ladder tier just to bypass the standalone guard. No upgrade flow is claimed verified here. |
| Storage | The live page says Free 100 MB, PaintBox 10 GB, Professional 100 GB and Team 100 GB per seat. Enterprise is not represented by a configured plan in the current catalog. Confirm byte units and Enterprise entitlement/quota mapping before publishing a stable quota contract; no quota values are invented here. |
| Checkout from the product | Main now provides `/subscriptions/checkout?plan=professional&return_to=...`, HTTPS origin-allowlisted return validation (`app/utils/checkoutReturn.ts`), sign-in continuation, and post-checkout return handling. Do not rebuild this plumbing. The new SKU still needs registration and a stable plan alias, plus test-mode checkout/cancel/return verification with the existing consent, availability and payment-risk gates intact. No paid checkout is claimed verified here. |
| Enterprise entitlement | The issue requires it but current plan constants define only individual Professional and organization Team plans (plus a separate product). Identify the authoritative Enterprise subscription/contract mapping; do not infer access from an arbitrary plan name or account tag. |

The smallest blocking commercial decision is **restricted PaintBox credits and paid standing, or a shared wallet with broader paid standing**. Confirm the published amount and quota units in the same decision. Production price creation and rollout require separate authorization; they are not a prerequisite for reviewing this entitlement-only slice.

## Ready-for-review boundary

This entitlement-only slice can be reviewed independently of the new commercial plan. If it is split from the full billing request, replace the PR's closing reference with a non-closing issue reference so merging it cannot close unfinished work. Validate the real registry through the `/api/v1/me` response for an individual subscriber, an organization seat member and a free account; the focused tests currently cover registry behavior and resolver wiring separately. Marking a PR ready must also run the lint, build and test jobs that draft CI skips; a successful draft CI aggregate is not evidence those jobs passed.

Completing the full request instead requires the SKU/renewal grant, wallet and paid-standing scope enforcement, explicit prorated upgrade with preserved credit expiry, readable storage quota and Enterprise mapping, and new-plan checkout verification described above. These are implementation work, not reasons to mutate production during development.

## Coordination

[Federated API limits](https://github.com/Bike4Mind/bike4mind/issues/7143) owns OAuth client rate-limit profiles, token mint inheritance and user-plus-client quota counters. This change does not modify those APIs. Request limits do not establish credit ownership or authorize spending from a product-restricted balance.
