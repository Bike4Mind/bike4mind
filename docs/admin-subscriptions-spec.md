# Admin subscriptions revamp: spec

Status: **approved**. The section 9 decisions follow the recommendations. Charts were added at approval (5.7).

Scope: the money side of the admin console. That means paid plans, Stripe subscriptions, comped (admin-granted) plans, seats, billing state, invoices, plan-tied credits and failed payments. It extends the admin polish and user-insights work: same layout, same shared toolkit (`apps/client/app/components/admin/shared/`), same rules (`apps/client/app/components/admin/DESIGN_GUIDE.md`).

Out of scope: the "Subscribers" page. It is the signup waitlist, not paying customers (see section 4), and gets only a rename here.

---

## 1. What exists today

### 1.1 Admin pages

| Surface | Where | What it shows / does | Data | Problems |
|---|---|---|---|---|
| Money > Subscriptions | `admin/Subscriptions/index.tsx` (`?tab=subscriptions`) | Four stat cards (Total, Active, Expiring this month, Canceled). Table with User, Plan, Status, Period start, Period end and Price. Search and a status select. **Read-only.** | `GET /api/subscriptions`, `GET /api/subscriptions/stats`, `GET /api/stripe/subscription-plans` (live Stripe price list) | Fetches 100 rows, then filters and paginates on the client, so it is wrong past 100. User-owned only: **org subscriptions never appear.** Unknown price ids show "Unknown Plan". Price is the list price, not what the customer gets. Stat cards ignore filters. No row link to the customer. Legacy Card/Table/Select styling. |
| Money > Credits | `admin/CreditAnalysis/*` (`?tab=credit-analytics`) | Seven inner tabs: User credits, Model pricing, Margins, Org usage, API usage, Ledger, Adjustments | Mongo, plus AI-provider invoices | Inner tab not in the URL (zustand only). "User credits" duplicates the profile's Adjust credits and writes through `PUT /api/users/:id/update`. "Invoices" here are **supplier** invoices, not customer invoices. |
| Money > Pricing | `AdminGrowthPricingTab.tsx`, `CheckoutCatalogPanel.tsx` | Settings for starter credits, referrals, price per credit and the team plan. Read-only catalog of what checkout sells. | AdminSettings, code constants | It holds more than pricing. `CheckoutCatalogPanel` is already on the new toolkit and is the reference for plan display. |
| Money > Email marketing | `EmailMarketingTab.tsx` | Campaigns | - | Not money. It is in the wrong section. |
| People > Organizations | `OrganizationsTab.tsx` | Row menu: Top up credits (ActionDialog), Adjust seats, Reconcile seats from Stripe, Convert to paid (creates a Stripe Checkout link), Revoke grant, Create / grant free org. Profile modal edits seats, billing contact and credits. | Mongo; Stripe for convert-to-paid | Mixes ActionDialog with legacy modals. Two seat editors with different rules. No billing status on the row. `OrganizationProfile.tsx` is dead code. |
| User profile > Overview > "Subscription" card | `Users/Details/UserSubscriptionStatus.tsx` rendered from `Profile/tabs/OverviewTab.tsx` | Individual and team subs. Edit credits per cycle (legacy modal, **no reason**). Remove subscription (confirm only, **no reason**). | `GET /api/admin/users/:id/subscriptions` | Remove hard-deletes the Mongo row and **never cancels at Stripe**, so the customer keeps being charged while we stop granting credits. |
| User profile > Grant subscription | `Users/Details/GrantSubscriptionModal.tsx` | Comp an individual or team plan for N months, with a ReasonPicker | `POST /api/admin/users/:id/grant-subscription` (Mongo only) | Legacy modal, but the flow is sound. |
| User profile > Credits tab | `Profile/tabs/credits/*`, `actions/AdjustCreditsDialog.tsx` | Ledger, spend chart, Adjust credits | audited admin endpoints | Already on the new toolkit: the reference pattern for money detail. |

There is no admin page for invoices, refunds, coupons, MRR/revenue, past due, trials, Stripe events, or Stripe-vs-database mismatches. The only one of these that can be done in-app is a credit "refund" (`top-up.ts` with `kind: refund`), which moves credits, not money.

### 1.2 Server routes and models

- **Subscription** (`apps/client/server/models/Subscription.ts`) mirrors Stripe. The webhook worker overwrites status, period, canceledAt, priceId and quantity on every `customer.subscription.updated`. Mongo is the source of truth only for admin grants (`source: admin_grant`, `subscriptionId: admin_grant_<uuid>`), `customCreditsPerCycle` and the dunning-notice claims.
- **Not stored in Mongo, Stripe only:** unit amount, currency, `cancel_at_period_end` (inferred from `canceledAt`), `trial_end`, payment method, invoices, discounts, pause state.
- **Plans** are code constants (`apps/client/lib/userSubscriptions/constants.ts`, team plan in `packages/server-utils/src/lib/subscriptions/constants`), with price ids from env and **no amounts**. So MRR cannot be computed from our data today.
- **Seats** are kept in three copies: `organization.seats`, `Subscription.quantity`, and the Stripe item quantity. When they disagree, the `customer.subscription.updated` worker makes Stripe win.
- **Webhook** (`pages/api/stripe/webhook.ts`):
  - Handles pack payments, `invoice.payment_succeeded` (through the worker: plan credit grants), `customer.subscription.updated/deleted`, `invoice.payment_failed` (marks past_due and sends a dunning email), `charge.refunded` and disputes (credit clawback), and `customer.deleted`.
  - Ignores `trial_will_end`, `invoice.paid/finalized/upcoming` and `subscription.created`.
  - **Persists no events**, so there is nothing to build a billing timeline from.
- **Reconciliation:** the only cron is `creditPurchaseReconciliation`, which checks credit packs only. Nothing compares subscriptions or seats with Stripe.
- **Guards on existing admin money routes:**

| Route | Reason | Audit | Idempotency | Notes |
|---|---|---|---|---|
| `grant-subscription` | required | strict | - | self-grant denied |
| `organizations/grant` | required | yes | - | |
| `organizations/[id]/top-up` | required | yes | key | credits only |
| `subscriptions/[id]/credits` | **none** | yes | - | changes future grants |
| `subscriptions/[id]/remove` | **none** | strict | - | no Stripe cancel |
| `organizations/[id]/revoke` | **optional** | yes | - | |
| `organizations/[id]/seats` | **none** | yes | - | refuses Stripe-billed orgs |
| `organizations/[id]/reconcile-seats` | **none** | when changed | - | trusts Mongo quantity |
| `organizations/[id]/convert-to-paid` | **none** | yes | - | creates Stripe customer + Checkout |

  No admin money route is rate-limited.
- **Audit:** `AdminAuditLogModel` is immutable, and its catalogue lives in `b4m-core/common/src/types/entities/adminAuditCatalogue.ts`. Reasons are free text of 5 to 500 characters (`AdminActionReasonSchema`); presets are client-only (`ADMIN_REASON_PRESETS`). There is no server undo token: the users-list bulk undo is its own mechanism.

---

## 2. Jobs a billing admin does

The admin runs a SaaS business, answers billing tickets, and reports revenue. **Need** blocks daily work; **wish** saves time or delights.

| # | Job / question | Need or wish | Today |
|---|---|---|---|
| J1 | "This customer says they were charged but have no credits." Find the customer, see plan, status, last invoice, and the credits that invoice granted, on one screen. | **Need** | Three surfaces, no invoices |
| J2 | Who pays, on which plan, individual and org together. | **Need** | Org subs missing |
| J3 | Past due / unpaid: who, how much, since when, was the dunning email sent. | **Need** | Filter exists but is client-side, capped at 100 |
| J4 | Who is about to churn: canceling at period end, past due, card expiring. | **Need** (first two), wish (card expiry) | No data |
| J5 | Comps: grant, extend, end, with a reason and an audit trail, and see all active comps. | **Need** | Grant exists; no list; reasons missing on edit/remove |
| J6 | Fix a broken record: Mongo says active, Stripe says canceled (or seats differ). | **Need** | Only manual seat reconcile, which trusts Mongo |
| J7 | Cancel a subscription on a customer's behalf (they emailed in). | **Need** | Impossible in-app; "Remove" silently keeps charging |
| J8 | MRR / ARR now, paying count, new vs churned this month. | **Need** for reporting | No amounts stored |
| J9 | MRR trend over 12 months. | Wish | No history |
| J10 | One customer's full billing timeline (signup, upgrades, invoices, failures, refunds, admin actions). | **Need** for disputes | No event store |
| J11 | Trials ending in 7 days. | Wish today: trials are not offered in checkout, and `trial_end` is not stored. Becomes a need if trials launch. | - |
| J12 | Seat usage vs seats paid for orgs. | **Need** for team-plan support | Data exists, not shown |
| J13 | Issue a money refund. | Wish in-app (Stripe Dashboard works; our webhook already claws back credits) | Dashboard only |
| J14 | Change plan / change billed seats for a customer. | Wish | Owner self-serve only |
| J15 | Retry a failed payment, send a "update your card" link. | Wish | Stripe handles retries |
| J16 | Coupons and discounts. | Wish | None |
| J17 | Export the filtered list to CSV for finance. | **Need** for reporting | None |

The examples in the brief hold. One change: "Trials ending soon" moves from need to wish, because we sell no trials today.

---

## 3. Information architecture

### 3.1 Sidebar, Money section

```
Money
  Revenue          (new: metrics overview)           /admin?tab=revenue
  Subscriptions    (rebuilt list + detail)           /admin?tab=subscriptions
                                                     /admin/subscriptions/$subscriptionId
  Credits          (unchanged in this epic)          /admin?tab=credit-analytics
  Pricing          (unchanged)                       /admin?tab=growth-pricing
```

- **Email marketing** leaves Money and moves to People, next to Waitlist, because its audiences are people. It is a one-line config change, shipped with the rename (section 4).
- **Revenue** is a separate item rather than a strip above the list. Reporting (J8, J9) and support work (J1, J3) are different moods. The list keeps a short StatStrip for its own counts.
- **Detail route**: `/admin/subscriptions/$subscriptionId` is a child of the `/admin` layout route, like `/admin/users/$userId` (DESIGN_GUIDE section "Page anatomy"). The key is the Mongo `_id`, never the Stripe id, so the URL works for comps too. Support often starts from a Stripe id, so `GET /admin/subscriptions/by-stripe/$stripeSubscriptionId` redirects to it.
- **Profile integration**: the user profile Overview "Subscription" card and the org profile get a compact read-only summary (plan, status chip, renews, MRR) that links to the detail page. The legacy `UserSubscriptionStatus` and its two modals are deleted once the detail page owns their actions.

### 3.2 Data sources: what comes from where

| Data | Source | Why |
|---|---|---|
| List rows, filters, counts, MRR | Mongo `Subscription` plus new mirror fields (6.1) | Fast, filterable, works when Stripe is slow |
| Invoices, payment method, upcoming invoice | Live Stripe read on the detail page only, cached 60 s | We do not mirror invoices (section 9, decision D5) |
| Timeline | New `BillingEvent` store (6.2), plus admin audit, plus credit ledger | One merged feed |
| Mismatches | New nightly reconciliation (6.3) | Stripe is the system of record for paid subs |

Every Stripe call in this spec is a **read**, except the actions in 5.2, which are each gated by a product decision.

---

## 4. Rename "Subscribers" to "Waitlist"

**What the page is:** the `Subscriber` collection (`packages/database/src/models/auth/SubscriberModel.ts`). It holds people who tried to sign up while open registration was off (`login_signup_closed`, `register_signup_closed`, `oauth_signup_closed`), plus `subscribe_page` sign-ups. The page's job is to generate invite codes for them.

**New name: "Waitlist".** These people are waiting for an invite; none of them subscribe to anything. The name also stops colliding with the paid "Subscriptions" page.

Where the rename touches:

| Place | Change |
|---|---|
| Sidebar | `adminSidebarConfig.tsx` label "Waitlist", icon unchanged. The badge `waitingSubscribers` keeps working; its tooltip becomes "N waiting for an invite". |
| Route / slug | `adminTabSlugs.ts`: new slug `waitlist`. `?tab=subscribers` stays an alias that redirects (replace navigation) to `?tab=waitlist`, so bookmarks and help links keep working. `AdminTab.Subscribers` enum member renamed to `AdminTab.Waitlist`; the numeric value is unchanged. |
| Command palette | `b4m-core/common/src/navigation/viewRegistry.ts` `admin.subscribers`: id kept for stability, label "Waitlist", description "People waiting for an invite code". |
| Page title and copy | `SubscribersTab.tsx` becomes `WaitlistTab.tsx`. Title "Waitlist". Banner "N people waiting for an invite". Status chips "Waiting" (info) / "Invited" (good). The "Generate invite" modal moves to `ActionDialog` while we are there (its starting credits are a money-adjacent grant, so it takes a reason). |
| Email marketing audiences | "All Subscribers" becomes "Waitlist"; "All Users & Subscribers" becomes "All users and waitlist". This is label-only: the audience enum values persisted on `EmailJob` stay unchanged. |
| Tests | `adminSidebarConfig.test.tsx`, `AdminLayout.test.tsx` |
| docs-site | `docs-site/docs/admin/subscribers.md` renamed to `waitlist.md`, with a Docusaurus redirect from the old path. `overview.md` (the "newsletter subscribers" wording is wrong), `email-marketing.md`, `bulk-import.md`, `invite-codes.md`. The generated help copies under `apps/client/app/generated/help-content-admin/` regenerate from these. `helpId` becomes `admin/waitlist`. |
| Unchanged | API paths (`/api/subscribers/*`), the Mongo model and collection, and the public subscribe form. These are internal names and renaming them has no admin value. |

---

## 5. Pages

All pages follow DESIGN_GUIDE.md page anatomy. Components named below are from `admin/shared/` unless noted.

### 5.1 Subscriptions list (`?tab=subscriptions`)

The anatomy matches the users list (`Users/index.tsx`, `Users/List/*`).

1. `AdminPageHeader`: title "Subscriptions", count = total matching. One primary action: **Export CSV** (exports the current filters, server-side, keyset-paged like `credit-ledger-export`).
2. `AnomalyBanner` (to be built in `shared/` if it is still missing): shown only when the last reconciliation found mismatches. "12 subscriptions disagree with Stripe. Review mismatches", which opens the Mismatched view.
3. `StatStrip`, 4 tiles, all scoped to the current filters and aggregated by the summary route (6.5), never summed from the current page: **Paying** (count), **MRR** (currency), **Past due** (count and amount, `valueColor` warn if > 0), **Canceling** (count).
   - **MRR** is the 5.3 definition, with that definition in a help popover beside the label. When rows count but are left out of the total, the comparison line says how many: "Not in total: 3 with no amount yet, 1 in another currency". So an undercount from rows whose amount is not mirrored yet (before the 6.1 backfill runs) is visible, not silent.
   - **Past due** keeps the count of the Past due view as its value. Its amount, on the comparison line, is "MRR at risk": the MRR of the rows that view counts. Unpaid and incomplete rows are not MRR, so only `past_due` rows add to it, and the amount is per month, not the balance owed (invoices are not mirrored, D5). Rows it leaves out are noted the same way ("$38.00 MRR at risk, 1 not in total").
4. `SavedViews` / `ViewTabs` built-in views:

| View | Filter | Job |
|---|---|---|
| Paying | status in active, past_due; source stripe | J2 |
| Past due | status in past_due, unpaid, incomplete | J3 |
| Canceling | canceledAt set (cancel requested) and status not terminal, via `cancel=scheduled`; switches to the mirrored Stripe cancel fields (6.1) once they are backfilled | J4 |
| Comped | source admin_grant, not terminal | J5 |
| Churned (30 days) | status canceled, canceledAt within 30 days. Windows on canceledAt (when the cancel was requested), not when the subscription ended, until an endedAt mirror exists | J8 |
| Mismatched | has an open reconciliation finding | J6 |
| All | none | |

   The default view is Paying (status active or past_due, source stripe), so comps and canceled rows stay hidden until another view or the Source filter brings them in.

   Saved custom views work as in the users list (built on the saved-views PR).
5. `FilterBar` filters, all server-side and in the URL through `useSubscriptionsTabParams` (`subscriptionsTabSearch.ts`), with keys registered in `adminTabParams.ts`:
   - Status
   - Plan (from the checkout catalog, plus "Unknown price")
   - Owner type (User / Organization)
   - Source (Stripe / Comped)
   - Interval (Monthly / Yearly)
   - Renews or ends (next 7 days / 30 days / overdue)
   - Cancellation (Scheduled / Last 30 days)
   - Mismatch (yes)

   Search covers owner name, owner email, org name, Stripe customer id and Stripe subscription id (exact match on ids). Group by: Plan, Status, Owner type.
6. `DataTable` in server-paged mode (`pagination` with a one-based page, `sort`/`onSortChange`, `pageResetKey`). The whole row opens the detail page. Until the detail page exists, a row opens its owner: the user profile, or the org in the Organizations tab.

Comped rows show a neutral Comped chip and never a price, including ended comps.

| Column | Content | Notes |
|---|---|---|
| Customer | Avatar and name, email underneath; org icon and org name for orgs | |
| Plan | Plan name, then "Monthly" or "Yearly" | "Unknown price" with a `warn` chip if the price id is not in the catalog |
| Status | `StatusChip`, tones in 5.4 | |
| MRR | the row's MRR (5.3), numeric; header "MRR (USD)" | dash for comps (they are not revenue), including a comp that carries an amount, and for statuses MRR excludes. A counted row with no mirrored amount is a dash whose hover says "No billed amount from Stripe yet". A row billed in another currency shows its own currency ("CA$18.00"), muted, with a hover saying it is not in the total |
| Seats | "8 / 10" (used / paid), with an `InlineBar` | orgs only; `warn` when used > paid |
| Renews | relative date, exact UTC on hover | "Ends" plus the date when canceling |
| Credits / cycle | number, numeric | shows the custom override with a "custom" chip |
| Started | relative date | sortable |

   Row actions (hover "..." menu): Open in Stripe (external, Stripe-billed only) and Copy Stripe id. The list has **no money actions and no bulk money actions**. `BulkActionBar` offers only "Export selected". Money actions happen one at a time, on the detail page, with full context.

### 5.2 Subscription detail (`/admin/subscriptions/$subscriptionId`)

Detail anatomy, max width 1280.

- **Breadcrumb**: Subscriptions / owner name.
- **`EntityHeader`**:
  - Identity: owner name, linking to the user or org profile.
  - Status chips: status, source (Comped), and Mismatch when there is a finding.
  - Up to two actions plus More. Both are context-sensitive:

| Kind | Action 1 | Action 2 | More |
|---|---|---|---|
| Stripe-billed | **Open in Stripe** (secondary, external) | **Cancel subscription** (outlined danger) | Sync from Stripe, Edit credits per cycle |
| Comped | **Extend comp** | **End comp** (outlined danger) | Edit credits per cycle |

- **`StatStrip`**:
  - MRR
  - Lifetime paid (sum of paid invoices, from the Stripe read; a dash while loading)
  - Next renewal (date and amount)
  - Credits per cycle
  - Seats used / paid (orgs only)
- **Tabs** (`?tab=`):
  - **Overview**: `SectionCard`s in two columns:
    - *Plan and billing*: plan, price, interval, period, cancel-at-period-end, Stripe ids with copy buttons, collection method.
    - *Payment*: card brand and last 4, expiry with a `warn` chip if it expires within 30 days, latest invoice status. From the live Stripe read.
    - *Credits from this plan*: per cycle (with the override), the last 6 grants from the credit ledger with links to the ledger rows, and the 72-hour re-subscribe cooldown state if it applied.
    - *Owner*: profile link, current credit balance, the other subscriptions this owner has (catches duplicate subs).
    - *Seats* (orgs): members, pending invites, paid quantity, platform min/max, and the three seat copies side by side when they disagree.
  - **Invoices**: `DataTable` from the live Stripe `invoices.list` for this customer, filtered to this subscription.
    - Columns: Number, Date, Amount, Status chip, Paid at, Attempts, Credits granted (joined from the ledger by payment intent or invoice id; a dash when no grant was found, which is exactly the J1 support case), and a link to the hosted invoice.
    - Read-only.
  - **Timeline**: one merged, reverse-chronological feed with a type filter:
    - `BillingEvent` rows: created, renewed, payment failed, dunning sent, plan changed, seats changed, canceled, refunded, disputed;
    - admin audit entries for this subscription or owner;
    - subscription credit grants and clawbacks.
  - **Admin log**: the shared Admin log tab, filtered to this subscription's target.

### 5.3 Revenue (`?tab=revenue`)

- Header: "Revenue", with a range `SegmentedControl` (30 days / 90 days / 12 months).
- `StatStrip`:
  - MRR (comparison vs the start of the range)
  - ARR (MRR x 12)
  - Paying customers
  - New MRR (range)
  - Churned MRR (range)
- Chart: MRR over time (line, `accent`), with paying count as a comparison series. The source is a daily snapshot (6.4). Before the first snapshot exists the chart shows the empty state "Trend starts collecting on <date>", with the current numbers still in the strip.
- Two compact tables, each linking into the list with the matching view:
  - **MRR by plan**: plan, subscriptions, MRR, share.
  - **At risk**: past due plus canceling, sorted by MRR.
- Definitions, shown in a help popover so finance and admins agree:
  - **MRR**: the sum over Stripe-billed subscriptions with status active or past_due of `unitAmount x quantity`, normalized to a month (yearly / 12), in the account currency. Excludes comps, trialing, canceled, incomplete. Past due is included but shown separately as "at risk".
    - As built (`server/admin/subscriptionsList/subscriptionMrr.ts`): `unitAmount` and `quantity` are the mirrored fields (6.1), so a Team row is the per-seat price times its seats. Never a price from the plan catalog: a row without a mirrored amount has none.
    - Normalizing divides by the months one billing period covers: `interval` month is 1, year is 12, and `intervalCount` multiplies it (every 3 months is 3). Week and day periods use the average month (52 / 12 weeks, 365 / 12 days). A row with no known interval counts as having no amount.
    - Statuses: only `active` and `past_due` (`MRR_STATUSES`). Excluded: `trialing`, `canceled`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`. A Canceling row (cancel requested, still active) counts until it ends.
    - "Stripe-billed" is `source: stripe` on the row, the same condition as the Paying view.
    - Amounts are before discounts and coupons: the mirror stores the price's unit amount, not the invoice total.
    - The account currency is USD (`MRR_CURRENCY`), the only currency checkout charges. A row whose `currency` is set to anything else is counted in the other-currency note. A counted row with no `unitAmount` (not yet synced or backfilled, or a price with no flat amount in the billed currency) is counted in the "no amount yet" note.
    - Rounding: a row's MRR is rounded to a whole minor unit; a total is summed unrounded and rounded once, so it can differ from the sum of the column by a cent per few yearly rows.
  - **New MRR**: subscriptions created in the range.
  - **Churned MRR**: MRR of subscriptions that reached canceled in the range.
  - Expansion/contraction (seat or plan changes) is a wish (needs BillingEvent history).
  - Single currency is assumed. A row in another currency is excluded from totals and counted in a "Not in totals: N other-currency subscriptions" note, never silently summed.

### 5.4 Status vocabulary and tones

There is one mapping, `subscriptionStatusTone.ts` in the Subscriptions folder, used by the list, the detail page, profile cards and the org list.

| Status | Label | Tone |
|---|---|---|
| active | Active | good |
| active and cancelAtPeriodEnd | Canceling | warn |
| trialing | Trial | info |
| past_due | Past due | warn |
| unpaid | Unpaid | bad |
| incomplete | Incomplete | warn |
| incomplete_expired | Expired | neutral |
| canceled | Canceled | neutral |
| paused | Paused | neutral |
| source admin_grant (not terminal) | Comped | info (shown next to the status chip) |
| reconciliation finding open | Mismatch | bad |

"Canceled" is neutral, not bad: it is an outcome, not a fault (DESIGN_GUIDE "Status tones").

### 5.5 Money formatting (add to DESIGN_GUIDE.md)

Added to DESIGN_GUIDE.md as section 6 "Money":

- Store amounts in minor units. Display with `Intl.NumberFormat(locale, { style: 'currency', currency })`: "$1,234.56", or "$12.3K" only inside StatTiles from 10,000 major units. The locale is `en-US`, like the rest of the admin's pricing copy, and "K" is Intl's compact suffix.
- Right-aligned, tabular, with the currency named once in the column header ("MRR (USD)").
- Credits are integers with a thousands separator and never carry a currency symbol. A credits value next to a money value is labeled "credits".
- Negative money is shown as "-$12.00" (refunds), never in parentheses.

Shared helper: `shared/formatMoney.ts`, so that every money cell goes through one function.

### 5.6 Empty, loading, error

| Case | Behavior |
|---|---|
| Loading | DataTable skeleton, StatTile value skeletons. The detail page renders Mongo sections first; the Stripe-backed sections (Payment, Invoices, Lifetime paid) have their own skeletons. |
| No subscriptions at all | EmptyState "No subscriptions yet", description "Paid plans appear here once someone checks out.", action "View pricing settings". |
| Filtered to empty | "No subscriptions match these filters", action "Clear filters". |
| Empty built-in view | Positive copy with a next step, for example Past due: "Nobody is past due", action "View all subscriptions". |
| List API error | `ErrorState` with "Try again". |
| Stripe unreachable or rate-limited on the detail page | Mongo sections still render. Stripe sections show the inline ErrorState "Couldn't reach Stripe. The rest of this page is from our records.", with Try again. Stripe-write actions are disabled, with the in-place reason "Stripe is unreachable". |
| Stripe not configured (self-host) | Revenue and the Stripe sections show "Stripe isn't configured on this deployment" with a link to the self-host docs. Comps still fully work. |
| Unknown price id | The row still renders: Plan "Unknown price" (warn), MRR a dash, and it shows in the Mismatched view. |

### 5.7 Charts

Charts are first-class, not decoration: every money page gets at least one.

**Rules:**
- Recharts, the same library as the profile `SpendChart`.
- `accent` is the primary series and `inkMuted` at 40% is the comparison (DESIGN_GUIDE "Color").
- Status-colored series (past due, failed) use the status tokens, never raw hex.
- Each chart has a title, a one-line takeaway caption, an accessible data-table fallback ("View as table"), and a tooltip with exact values in the money format (5.5).
- Charts sit in a `SectionCard`.
- Loading shows a chart-shaped skeleton. An empty or not-enough-history state says when data starts.

| Where | Chart | Type | Data |
|---|---|---|---|
| Revenue | **MRR over time**, with paying customers as the comparison line | line, dual series | RevenueSnapshot |
| Revenue | **MRR movement**: new, expansion, contraction, churned per month, with net as a line | diverging stacked bars (churn and contraction below zero) | RevenueSnapshot (new / churned in v1; expansion and contraction once BillingEvent history exists) |
| Revenue | **MRR by plan** | stacked area | RevenueSnapshot by plan |
| Revenue | **Paying customers by owner type** (individual vs org) | stacked bars | RevenueSnapshot |
| Revenue | **At-risk MRR**: past due plus canceling over time | area, `warn` token | RevenueSnapshot |
| Subscriptions list | **Sparklines** in the Paying, MRR and Past due tiles (last 30 days) | `StatSparkline` | RevenueSnapshot |
| Subscription detail | **Payment history**: invoice amount per period, bars toned by status (paid, failed, refunded) | bars | live Stripe invoices |
| Subscription detail | **Credits per cycle**: granted vs used per billing period | grouped bars | credit ledger |
| Subscription detail (orgs) | **Seats used vs paid** over time | step line, two series | BillingEvent + org history |

To make this possible, `RevenueSnapshot` (6.4) also stores per day:
- MRR by plan and by owner type;
- the paying count;
- new and churned MRR;
- past-due and canceling MRR.

### 5.8 Sidebar indicator

Money > Subscriptions shows a dot when Stripe-sourced subscriptions started after this browser last opened the tab.

- Last-seen is a localStorage timestamp, so it is per browser, not per admin account.
- The first visit sets the baseline and shows no dot.
- The count refreshes every 5 minutes while the admin sidebar is mounted and the browser tab is focused. The query sets `refetchInterval` only, so react-query's default `refetchIntervalInBackground: false` pauses polling in a background tab.
- Opening the tab clears the dot and marks the rows started since the previous visit with a New chip.
- Known limit: an org comp that converts to paid keeps the comp's `createdAt`, so the dot and the New chip miss it. The Slack new-paid post still fires.

---

## 6. Data and server work

### 6.1 Subscription mirror fields

Add to `Subscription`, written through one projection helper (for example `stripeMirrorFields(subscription)`) from the Stripe subscription each path already holds. The row is created on `invoice.payment_succeeded`, not by the updated handler, so every write path must call it: the three create paths in `apps/workers/src/lib/userSubscriptions/serverUtils.ts` (user create, org create, and `flipAdminGrantToStripe` when a comp turns paid), the `customer.subscription.updated` worker, and the `customer.subscription.deleted` handler (inline in `pages/api/stripe/webhook.ts`). The updated worker alone is not enough: it skips a missing row, and Stripe does not order the creation-time `updated` before `invoice.payment_succeeded`, so a new subscription would carry no `unitAmount` until its next update.

- `unitAmount` (minor units)
- `currency`
- `interval`
- `cancelAtPeriodEnd`
- `trialEndsAt`
- `stripeCustomerId`
- `lastSyncedAt`

Backfill with a script that only **reads** Stripe (`subscriptions.retrieve` per row) and writes Mongo, run per stage. Add `{ source: 1, status: 1, periodEndsAt: 1 }` and `{ cancelAtPeriodEnd: 1, status: 1 }` indexes through an ensure-index migration.

### 6.2 BillingEvent store

The webhook persists one `BillingEvent` per Stripe event this stage owns (the same `metadata.stage` check the handlers already apply, run before the write, so a stage never stores another stage's events from the shared test account):

- `stripeEventId` (unique; the row is upserted on it)
- `type`
- `ownerType`, `ownerId`
- `subscriptionId`
- `amount`, `currency`
- `occurredAt`
- a small `data` projection (no card data, no full payload)

Record it as an upsert on `stripeEventId` **after** the event's side effects succeed, and keep the existing per-entity keys (`stripeRefundId`, `stripeDisputeId`, and so on) as the dedupe. There is no event-level short-circuit: a failed side effect rethrows, the route returns non-2xx and Stripe redelivers the same event id, so a replay must re-run the side effects rather than be skipped as a duplicate (otherwise a transient failure loses a credit grant or clawback for good). The unhandled types (`invoice.paid`, `invoice.finalized`, `trial_will_end`, `subscription.created`) are stored too, but do nothing else. Retention: indefinite. The rows are small, and the store is the dispute record.

### 6.3 Reconciliation

A nightly cron. This is acceptable under infra principle 5 (cleanup and reconciliation).

- **Read-only to Stripe.**
- It compares each non-terminal Mongo Stripe-sourced row with Stripe on status, priceId, quantity, period end, cancel flag and unit amount, and compares `organization.seats` with the billed quantity.
- It finds one orphan case in each direction:
  - Stripe active subscriptions with no Mongo row, considering only subscriptions with `metadata.stage === Config.STAGE` (plus stage-less ones in production only, mirroring `isStageCreditPurchase`), because stages share the Stripe test account;
  - Mongo active rows whose Stripe subscription is gone (already stage-scoped, since it starts from this stage's rows).
- It writes `BillingMismatch` findings (open/resolved), which feed the banner, the Mismatched view and the Mismatch chip.

"Sync from Stripe" (5.2) resolves a finding by applying the same Stripe-wins rule the worker already uses. Has a DLQ. Pages Stripe with `autoPagingEach` under a time budget, the way `creditPurchaseReconciliation` does.

### 6.4 Daily snapshot

The same cron writes one `RevenueSnapshot` per day: date, MRR, paying count, MRR by plan. That is enough for the 12-month chart without replaying history.

### 6.5 Admin endpoints

The endpoints use the contract pattern only if they become public; these stay admin-internal, Zod-validated.

| Route | Purpose |
|---|---|
| `GET /api/admin/subscriptions` | Server filters, sort, keyset or page pagination, owner join for user and org |
| `GET /api/admin/subscriptions/summary` | Counts and MRR for the current filters (StatStrip, view counts). See the summary fields below. |
| `GET /api/admin/subscriptions/export` | CSV |
| `GET /api/admin/subscriptions/[id]` | Detail from Mongo |
| `GET /api/admin/subscriptions/[id]/stripe` | Live read: invoices, payment method, upcoming invoice; cached 60 s |
| `GET /api/admin/subscriptions/[id]/timeline` | Merged feed |
| `GET /api/admin/revenue` | Snapshot series and current totals |
| `POST /api/admin/subscriptions/[id]/sync` | Sync from Stripe (5.2, 7) |

`GET /api/admin/subscriptions` takes an optional `cancel` filter, inherited by the list, summary and export routes:

| Value | Meaning |
|---|---|
| `scheduled` | Status is not terminal and `canceledAt` is set. Stripe sets `canceled_at` when a cancel is requested. Switches to the mirrored cancel fields (6.1) once they exist. |
| `last30` | `canceledAt` is within the 30-day churn window. |

The Canceling view is `cancel=scheduled`. The Churned (30 days) view is status canceled plus `cancel=last30`, the same definition as `summary.views.churned`.

MRR on the list and summary routes (5.3 definition):

| Where | Field | Meaning |
|---|---|---|
| list row | `mrr: { amount, currency } \| null` | The row's MRR in minor units of its own billed currency. `null` for a row that does not count (comps, statuses outside MRR) and for one with no mirrored amount. |
| summary | `mrr: { currency, amount, unpriced, otherCurrency }` | MRR of the rows matching the filters: `amount` per month in minor units of `currency` (`usd`); `unpriced` counts rows that count but have no mirrored amount; `otherCurrency` counts rows billed in another currency. Neither is in `amount`. |
| summary | `pastDueMrr` (same shape) | The part of `mrr` from rows the Past due view counts: the Past due tile's "MRR at risk". |

The summary aggregates both in the same facet query as the counts, grouping by currency, interval and whether an amount is mirrored with only `$match`, `$group`, `$sum`, `$multiply`, `$ifNull` and `$ne`, so it runs unchanged under DocumentDB's split-facet path (`executeFacetCompatible`). The normalization to a month happens on the grouped sums in code.

The CSV export carries the list's MRR column as two columns after Source: `MRR` (major units at the currency's precision, "19.00", blank where the row has none) and `MRR currency` ("USD").

The old `GET /api/subscriptions` and `/stats` admin routes are deleted once nothing reads them.

### 6.6 Slack notifications

Subscription events post to a Slack channel for the admins.

- **Webhook:** the admin setting `SlackSubscriptionsWebhookUrl` (Feedback group), falling back to the default Slack webhook and then the `SLACK_WEBHOOK_URL` secret, like the other channels.
- **Stage:** posts only on the production stage. Self-host and preview stages never post.

Events:

| Event | Posts when |
|---|---|
| New paid subscription | The first invoice has amount paid > 0. Shows the recurring price per interval, plus a First charge line when the amount paid differs (for example a coupon or proration). |
| Plan upgraded / downgraded / changed | The plan changes on the stored row. |
| Cancellation scheduled | A cancel is requested. Shows the end date. |
| Cancellation reverted | A scheduled cancel is undone. |
| Subscription ended | The row transitions into canceled, from whichever of the update or delete event gets there first. Shows Stripe's cancellation reason. |
| Payment failed | The first failed attempt only. |

Renewals do not post. $0 first invoices do not post.

Content: plan, interval, amount, seats for org subscriptions, the owner's ID, and a link to the owner in admin (the user profile, or the org in the Organizations tab). Never email, name, username or org name.

Redelivery: plan and cancel posts are gated by the stored-row diff, and ended is gated by the prior status. An exact redelivery of a new-subscription or first-failure event can post twice.

Out-of-order updates: a canceled row overwritten by a stale live update and then canceled again posts Subscription ended twice.

The existing refund and dispute posts (Liveops channel) show the owner ID and admin link instead of names or emails. The earlier new-subscription post that included the customer email is removed.

---

## 7. Money actions: guard model

Every action fits one row of the DESIGN_GUIDE action table. "Moves money" means it changes what Stripe charges or pays out.

| Action | Moves money? | Pattern | Reason | Recovery | Status |
|---|---|---|---|---|---|
| Grant comp (individual / team) | No (credits only) | ActionDialog + ChangePreview (credits to grant) | required | Undo toast 30 s (ends the comp, claws back the unspent grant), then "End comp" | exists; move to ActionDialog |
| Extend comp | No | ActionDialog, before/after end date | required | Undo toast 30 s | new |
| End comp | No | ActionDialog | required (today optional) | Undo toast 30 s | fix |
| Edit credits per cycle | No (future credits) | ActionDialog + ChangePreview | **required** (today none) | Undo toast 30 s | fix |
| Remove subscription record | No, but dangerous | ActionDialog with typed confirm. **Allowed only for comps and terminal rows.** For a live Stripe-billed row the action is disabled: "Cancel it first; removing the record alone keeps charging the customer." | required (today none) | none (the dialog says so) | fix |
| Sync from Stripe | No (Mongo only) | ActionDialog with a field-by-field diff preview | required | Admin log only; Stripe is the source of truth, so no undo | new |
| Adjust seats (comped orgs) | No | ActionDialog | **required** (today none) | Undo toast 30 s | fix |
| Reconcile seats | No | Replaced by Sync from Stripe, which reads Stripe rather than the Mongo quantity | - | - | replace |
| Convert comped org to paid | Starts a checkout; the customer pays | ActionDialog | required (today none) | Link expires; no charge until the customer pays | fix |
| **Cancel at period end** | **Yes**: stops future charges | ActionDialog: "Cancels at the end of the period on <date>. They keep access and credits until then. No refund." | required | Undo toast 30 s, then a persistent **Resume subscription** action until the period ends | new, **D1** |
| **Cancel immediately** | **Yes** | ActionDialog with typed confirm (owner email). States access ends now and whether any proration refund is issued. | required | none | new, **D1/D2** |
| **Refund** | **Yes**: pays out | See D2 | required | none | **D2** |
| **Retry payment** | **Yes**: charges a card | ActionDialog showing the invoice amount and card | required | none | wish, **D3** |
| **Change plan / billed seats** | **Yes**: proration invoice | ActionDialog with Stripe's upcoming-invoice preview as the ChangePreview | required | Change back (a new proration) | wish, **D4** |
| Apply coupon | **Yes** (reduces future charges) | ActionDialog | required | Remove coupon | wish |

**Guards on every Stripe write** (built once, in a shared `adminStripeWrite` helper):

1. Admin JWT only (`auth: 'jwtOnly'`); no API keys. Self-target is denied (`denySelfAdminAction`), and so is acting while impersonating.
2. A reason is required (`parseAdminActionReason`). New `ADMIN_REASON_PRESETS` sets for `subscriptionCancel`, `subscriptionSync`, `compChange` and, if approved, `refund`.
3. An idempotency key per dialog open, sent to our route and passed to Stripe as its `Idempotency-Key`. A double-click or retry can never double-charge or double-refund.
4. Optimistic concurrency: the dialog sends the `lastSyncedAt` it previewed. If the row changed since, the server returns 409 "This subscription changed. Review and try again."
5. Strict audit inside the same request: new catalogue entries `billing.subscription.cancel_scheduled`, `billing.subscription.resumed`, `billing.subscription.canceled`, `billing.subscription.synced` and `billing.comp.changed`, all severity critical for Stripe writes. The `changes[]` array carries before and after values, and `details` carries the Stripe request id.
6. Rate limit: 10 Stripe writes per admin per minute.
7. Stage safety: a non-prod stage refuses a write when its Stripe key is a live-mode key (a fail-loud startup check).
8. Undo for Stripe writes is a **new forward write** (resume), audited separately; it never deletes the first audit entry. It uses the same 30 s UndoToast, and the persistent action stays available afterwards.
9. Per-action admin permissions, when they land, gate the Stripe-write actions behind a "billing" permission.

---

## 8. Issue breakdown

Ordered by value. Each item ships on its own behind the existing admin gate. Labels `admin-ux` and `UI/UX`. Children of epic [#6026](https://github.com/Bike4Mind/bike4mind/issues/6026).

| # | Issue | Size | Depends on |
|---|---|---|---|
| 1 ([#6012](https://github.com/Bike4Mind/bike4mind/issues/6012)) | **Rename Subscribers to Waitlist**: nav, slug alias redirect, palette, page copy, email audience labels, docs-site with redirect; move Email marketing to People | S | - |
| 2 ([#6013](https://github.com/Bike4Mind/bike4mind/issues/6013)) | **Close reason/audit gaps on existing money routes**: reason required on credits-per-cycle, remove, seats, revoke, convert-to-paid; block "remove" on live Stripe-billed rows; new reason preset sets. The existing Organizations-tab modals get the minimum change needed to send a reason; their redesign belongs to [#5772](https://github.com/Bike4Mind/bike4mind/issues/5772) | S | - |
| 3 ([#6014](https://github.com/Bike4Mind/bike4mind/issues/6014)) | **Admin subscriptions list API**: `GET /api/admin/subscriptions` + `summary` + `export`, server filters, org subscriptions included, indexes. **Shipped.** | M | - |
| 4 ([#6015](https://github.com/Bike4Mind/bike4mind/issues/6015)) | **Subscriptions list page on the shared toolkit**: views, FilterBar, DataTable server mode, StatStrip (counts only), status tone map, money formatter, CSV export. **Partly shipped.** Remaining: saved custom views, Group by, bulk Export selected, Open in Stripe, the Mismatched view and anomaly banner (with [#6021](https://github.com/Bike4Mind/bike4mind/issues/6021)), and the detail page link (with [#6016](https://github.com/Bike4Mind/bike4mind/issues/6016)) | M | 3 |
| 4b | **Additions shipped with [#6015](https://github.com/Bike4Mind/bike4mind/issues/6015)**: Slack notifications (6.6) and the sidebar indicator (5.8), and the Canceling and Churned (30 days) views (`cancel` filter, 6.5) | S | 3 |
| 5 ([#6016](https://github.com/Bike4Mind/bike4mind/issues/6016)) | **Subscription detail page (Mongo-only)**: header, Overview (Plan, Credits, Owner, Seats), Admin log, comp actions moved to ActionDialog (grant, extend, end, edit credits per cycle, remove); profile and org cards link here; delete legacy `UserSubscriptionStatus` and `EditCreditsModal`. The Organizations-tab modals (`AdjustSeatsModal`, revoke) stay with [#5772](https://github.com/Bike4Mind/bike4mind/issues/5772) | L | 2, 3 |
| 6 ([#6017](https://github.com/Bike4Mind/bike4mind/issues/6017)) | **Mirror price and cancel fields on Subscription** (6.1), plus a read-only backfill script | M | - |
| 7 ([#6018](https://github.com/Bike4Mind/bike4mind/issues/6018)) | **MRR in the list**: MRR column and tile, Past due amount, MRR definition popover, shared `formatMoney` and the DESIGN_GUIDE money rule, MRR in the CSV export. **Shipped in this branch.** The Canceling view shipped with 4b via `cancel=scheduled`; it moves to the mirrored cancel fields once their backfill has run | S | 4, 6 |
| 8 ([#6019](https://github.com/Bike4Mind/bike4mind/issues/6019)) | **Detail: live Stripe read**: Payment card, Invoices tab with credits-granted join, Lifetime paid | M | 5 |
| 9 ([#6020](https://github.com/Bike4Mind/bike4mind/issues/6020)) | **BillingEvent store and Timeline tab** (6.2) | M | 5 |
| 10 ([#6021](https://github.com/Bike4Mind/bike4mind/issues/6021)) | **Reconciliation cron, Mismatched view, AnomalyBanner, Sync from Stripe** (6.3); replaces Reconcile seats | M | 4, 6 |
| 11 ([#6022](https://github.com/Bike4Mind/bike4mind/issues/6022)) | **Revenue page** with daily snapshot (5.3, 6.4): StatStrip, MRR-over-time chart, MRR-by-plan and At-risk tables | M | 6, 7 |
| 11b ([#6023](https://github.com/Bike4Mind/bike4mind/issues/6023)) | **Revenue charts**: MRR movement, MRR by plan, paying customers by owner type, at-risk MRR; sparklines on the list tiles (5.7) | M | 11 |
| 11c ([#6024](https://github.com/Bike4Mind/bike4mind/issues/6024)) | **Detail charts**: payment history, credits granted vs used per cycle, seats used vs paid (5.7) | M | 8, 9 |
| 12 ([#6025](https://github.com/Bike4Mind/bike4mind/issues/6025)) | **Cancel at period end and resume** with the shared Stripe-write guard | M | 5, 2 |
| 13 | **Cancel immediately** | S | 12; deferred with D2, not filed |
| 14 | **Refund** | M | deferred (D2), not filed |
| 15 | Wishes, one issue each, when prioritized: retry payment (D3), plan / billed-seat change (D4), coupons, card-expiry churn signal, expansion and contraction MRR | - | 12 |
| - | The Credits and Organizations tab cleanup (inner tabs in the URL, the duplicate "User credits" adjuster, the dead `OrganizationProfile.tsx`, the legacy org modals) is already in scope of [#5772](https://github.com/Bike4Mind/bike4mind/issues/5772). Not filed again. | - | - |

- **Ship order:** 1 and 2 are immediate and stand alone.
- **First visible value:** 3, then 4, then 5. That alone answers J1 (minus invoices), J2, J3, J5 and J12, and fixes the "Remove keeps charging" trap.
- **Reporting:** 6, then 7, then 11.
- **Support depth:** 8 and 9.
- **Trust:** 10.
- **Money-moving actions:** 12 to 14, and only after the product decisions below.

---

## 9. Product decisions

The recommendations below were approved as written.

| # | Decision | Outcome |
|---|---|---|
| D1 | Do admins cancel Stripe subscriptions in-app, or keep using the Stripe Dashboard? | In-app **cancel at period end** with resume (low risk, reversible until the period ends). Cancel immediately only together with D2. |
| D2 | Do admins issue **money refunds** in-app? If yes: full only, or partial; a per-refund cap; a second-admin approval above the cap? | Not in the first release. Link to the invoice in Stripe; our `charge.refunded` webhook already claws back credits. If approved later: full or partial against one invoice, cap (for example $500) above which a second admin must approve, and typed confirm of the amount. |
| D3 | Retry a failed payment from admin (charges the card on file)? | No. Stripe Smart Retries already run. Wish only. |
| D4 | Change plan or billed seats on a customer's behalf (creates proration invoices)? | Defer. The owner can self-serve. Revisit when team-plan support load shows a need. |
| D5 | Mirror invoices into Mongo, or read them live? | Live read on the detail page only (no list-level invoice filters). Revisit if finance needs invoice-level reporting. |
| D6 | Who may use the Stripe-write actions? All admins, or a billing permission? | A billing permission, once per-action admin permissions exist. Until then all admins, with critical-severity audit alerts. |
| D7 | Do comps count as "customers" in Revenue? | No. Show them as a separate count; never in MRR. |
