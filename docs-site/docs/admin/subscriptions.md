---
title: Subscriptions
description: Monitor and manage user subscription plans, billing status, and subscription lifecycle metrics
sidebar_position: 10
tags: [admin, subscriptions, billing]
---

# Subscriptions

The Subscriptions tab provides a centralized view of all user subscription plans on the platform. Administrators can monitor subscription health through summary statistics, search for specific subscriptions, filter by status, and review detailed billing information for each subscriber.

## Acquisition attribution

Individual checkout can record the consenting buyer's first and last campaign
touches. These are available on the subscription record and in the admin
subscription API; the table does not yet display acquisition columns. See
[telemetry data classification](https://github.com/Bike4Mind/bike4mind/blob/main/docs-site/docs/security/telemetry-data-classification.md)
for consent rules, retention, and troubleshooting missing attribution.

## Stats Cards

Four summary cards are displayed at the top of the page, providing an at-a-glance overview of subscription health:

| Card | Description |
|------|-------------|
| **Total Subscriptions** | The total number of subscriptions across all statuses. |
| **Active Subscriptions** | The count of currently active subscriptions. |
| **Expiring This Month** | The number of subscriptions set to expire within the current calendar month. |
| **Canceled Subscriptions** | The total count of canceled subscriptions. |

## Filters and Search

A filter bar above the table provides the following controls:

| Control | Description |
|---------|-------------|
| **Search** | Filter subscriptions by user email or name. Search is debounced for performance. |
| **Status Filter** | A dropdown to filter by subscription status. Available options: All Status, Active, Canceled, Past Due, Trialing, Incomplete, Unpaid. |
| **Refresh** | Reloads subscription data, stats, and plan information from the server. |

Changing the status filter or search resets the pagination back to the first page.

## Subscription Table

The main table displays subscription records with the following columns:

| Column | Description |
|--------|-------------|
| **User** | The subscriber's username and email address. |
| **Plan** | The subscription plan name (e.g., Pro, Team) and billing interval (e.g., monthly, yearly). |
| **Status** | A color-coded status chip. Active subscriptions that have been canceled show an additional clock icon indicating the cancellation date. Hovering reveals a tooltip with additional context. |
| **Period Start** | The start date of the current billing period, formatted as "MMM D, YYYY". |
| **Period End** | The end date of the current billing period, formatted as "MMM D, YYYY". |
| **Price** | The subscription price displayed as amount per interval (e.g., "$9.99/monthly"). |

### Status Indicators

Subscriptions display color-coded status chips:

| Status | Color | Description |
|--------|-------|-------------|
| **Active** | Success (green) | Subscription is currently active and in good standing. |
| **Canceled** | Neutral (gray) | Subscription has been canceled. |
| **Past Due** | Warning (yellow) | Payment is overdue. |
| **Trialing** | Primary (blue) | Subscription is in a trial period. |
| **Incomplete** | Warning (yellow) | Subscription setup is incomplete. |
| **Unpaid** | Danger (red) | Subscription is unpaid. |

Active subscriptions that have a cancellation date set display an additional schedule icon, with a tooltip indicating when the subscription will cancel (e.g., "Subscription will cancel on Jan 15, 2026").

## Mismatches with Stripe

Each night the platform compares every Stripe subscription with its own record. It only reads from Stripe and never changes anything there. Differences in status, plan, quantity, renewal date, scheduled cancellation, price or an organization's seat count are recorded as open findings.

When findings are open, a banner above the views shows how many subscriptions differ from Stripe. Select **Review mismatches** to open the **Mismatched** view, which lists only those subscriptions. Dismissing the banner hides it until the count changes.

The Mismatched view also lists Stripe subscriptions that have no record on the platform, each with a link to open it in Stripe. Those need to be resolved in Stripe or by the customer's owner, because there is nothing to sync.

### Sync from Stripe

A subscription with an open mismatch shows a **Mismatch** chip on its detail page. To fix it:

1. Open **More** and select **Sync from Stripe**.
2. Review the preview. It is read from Stripe at that moment and lists each value that will change, from the current value to Stripe's value.
3. Choose a reason and confirm.

Sync copies Stripe's values onto the platform record and, for an organization, its seat count. If Stripe no longer has the subscription, the record is marked canceled. Stripe is never changed. If someone else changed the record after you opened the dialog, the sync stops and you reopen it to see the current values. Every sync is written to the admin log with the before and after values.

## Pagination

Pagination controls appear both above and below the subscription table:

- **Previous / Next** buttons for page navigation
- **Page indicator** showing "Page X of Y"
- **Items per page** selector with options: 5, 10, or 20 per page
- **Total Items** count

## Best Practices

- Use the "Expiring This Month" stat card to proactively identify subscriptions that may need attention or renewal outreach.
- Filter by "Past Due" or "Unpaid" statuses regularly to catch billing issues before they lead to churn.
- Use the search field to quickly locate specific users when handling support requests about their subscription.
- Monitor the ratio of active to canceled subscriptions over time as a health metric for the platform.

## Related Articles

- [Credit Analytics](./credit-analytics.md)
- [Organizations](./organizations.md)
