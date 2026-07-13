---
title: Credit Analytics
description: Manage user credit balances, model pricing, and margin analytics for the platform
sidebar_position: 12
tags: [admin, credits, analytics, billing]
---

# Credit Analytics

The Credit Analytics tab provides tools for managing the platform's credit economy. It is organized into three sub-tabs: **User Credits** for viewing and adjusting individual user credit balances, **Model Pricing** for managing the versioned model price catalog, and **Margins** for reviewing revenue-versus-cost analytics.

## User Credits Manager

### Search and Sorting

A filter card at the top provides the following controls:

| Control | Description |
|---------|-------------|
| **Search users** | Filter users by name or email address. |
| **Sort by Credits** | Sort users by credit balance: Highest First or Lowest First. |
| **Refresh** | Reloads the user list from the server. |

### User Table

The user table displays the following columns:

| Column | Description |
|--------|-------------|
| **User** | The user's full name and email address. |
| **Credits** | The user's current credit balance, formatted with locale-appropriate separators. |
| **Last Login** | The date of the user's most recent login, or "Never" if they have not logged in. |
| **Status** | Status chips showing Active/Inactive state and an "Admin" badge for admin users. |
| **Created** | The date the user account was created. |
| **Actions** | View Profile and Credits adjustment buttons. |

### Actions

Each user row provides two actions:

| Action | Description |
|--------|-------------|
| **View Profile** | Opens the admin profile viewer for the user. |
| **Credits** | Opens the credit adjustment modal for the user. |

### Credit Adjustment Modal

The credit adjustment modal allows administrators to add or remove credits from a user's balance:

| Field | Description |
|-------|-------------|
| **User** | Displays the selected user's name or email (read-only). |
| **Current Balance** | Shows the user's current credit count (read-only). |
| **Amount** | The number of credits to add or remove. Minimum value is 10, with increments of 10. Default is 100. |
| **Note** | An optional text field for documenting the reason for the adjustment (e.g., "Promotional bonus", "Compensation for issue"). |

Two action buttons are provided:
- **Add Credits** (green) - Adds the specified amount to the user's balance.
- **Remove Credits** (red) - Subtracts the specified amount from the user's balance.

### Pagination

Pagination controls appear above and below the user table:

- **Previous / Next** buttons for page navigation
- **Page indicator** showing "Page X of Y"
- **Items per page** selector with options: 10, 20, 50, or 100 per page
- **Total Users** count

## Model Pricing

The Model Pricing sub-tab manages the versioned model price catalog. **Rates are provider costs in USD (displayed per 1M tokens), not credit prices**: what a user pays is always this cost multiplied by the platform's published uniform markup, so this screen manages cost data and never markup.

Each row shows the price currently in force for one model: input/output rates (plus audio rates for realtime voice models), the date it took effect, and a source chip - `seed` for prices managed automatically from the adapter tables, `operator` for manual reprices.

| Action | Description |
|--------|-------------|
| **Reprice** | Appends a new operator price row taking effect immediately. Requires a note documenting where the price comes from (an invoice, a provider pricing page); the note is the audit trail. While an operator row is newest, automatic seed updates skip that model. |
| **History** | Shows every price the model has ever had, with dates and notes. Rows are append-only and never edited, so history is complete by construction. |
| **Revert** | Offered on operator-priced rows. Appends the adapter table's current rates back under seed management, so future automatic price updates flow to the model again. The operator row remains in history. |

## Margins

The Margins sub-tab reports revenue versus provider cost over the last 30 days, with a header chip showing the current pricing target (credits charged per $1 of provider cost). A refresh button reloads all four views:

| View | Description |
|------|-------------|
| **By model by day** | Daily credits charged, provider cost, and effective margin per model. |
| **By user (worst margin first)** | Per-user margin over the window, sorted so underpriced usage surfaces first. |
| **Monthly COGS by provider** | Month-by-month provider cost totals with invoice reconciliation (below). |
| **Settlement basis** | How usage was priced: provider-reported token counts versus the local estimate fallback, with average token deltas as an estimate-quality signal. |

Rows below the target chip's rate were charged under older pricing or indicate a leak worth investigating.

### Invoice reconciliation

Each closed month-by-provider row accepts the provider's actual invoice total (with a required note naming the invoice and its billing period). The table then shows the delta between the invoice and recorded cost, and a status chip:

| Chip | Meaning |
|------|---------|
| **match** | Delta under 2% of the invoice. No action. |
| **review** | Delta between 2% and 10%. Worth a look. |
| **gap** | Delta over 10%. Decompose it (below). |
| **no invoice** | Nothing entered yet. The current month stays here until it closes. |

Entries are append-only: a correction is a new entry, and the newest one counts. The recorded-cost side always includes all traffic (user-billed, organization-billed, and internal operational usage), because providers invoice everything.

#### Monthly runbook

1. Wait for the month to close (months are UTC) and provider invoices to arrive.
2. Enter each invoice total with a note naming the invoice id and its billing period.
3. Green chips: done. Otherwise decompose the gap:

| Gap signature | Likely cause | Action |
|---------------|--------------|--------|
| Uniform percentage across a provider's models | Stale catalog prices | Update rates in the Model Pricing tab |
| Invoice exceeds recorded cost, token counts look low | Missing usage events | Instrument the unmetered path |
| Provider invoices you but has no row at all | Fully unmetered feature | Loudest signature; treat as a bug |
| Small constant offset | Billing-period or timezone skew, provider rounding | Note it; no action inside tolerance |

Two standing caveats: months here are UTC while some providers bill in local-time periods, and recorded cost can move slightly after month close as late events land, so re-check a chip before escalating.

## Best Practices

- Use the "Sort by Credits: Lowest First" option to identify users who may be running low on credits and could benefit from a top-up or subscription upgrade.
- Always include a note when adjusting credits to maintain an audit trail of why changes were made.

## Related Articles

- [Subscriptions](./subscriptions.md)
- [Organizations](./organizations.md)
