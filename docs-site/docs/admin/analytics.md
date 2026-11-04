---
title: Analytics
description: Track active users, stickiness, real versus suspected signups, AI usage and the heaviest accounts over time in the Bike4Mind admin panel
sidebar_position: 6
tags: [admin, analytics]
---

# Analytics

The Analytics page (**Overview > Analytics**) shows who uses Bike4Mind, how often, and whether they come back. It is a trend page: the Dashboard answers "is anything wrong right now?", Analytics answers "are we growing?".

All days are UTC days, and every chart says so. Counts exclude admin accounts, system accounts, accounts flagged as automated test accounts, and accounts on your internal staff email domains. Every other account is counted, including a test account that carries none of those flags.

## Toolbar

| Control | Options | Default |
|---------|---------|---------|
| **Range** | 7d, 28d, 90d, 12m, Custom | 28d |
| **Compare** | Previous period, Off | Previous period |
| **Signups** | Legit only, All | Legit only |

**Custom** shows two date inputs. Both days are included, and the range can cover at most 366 days.

The toolbar is kept in the page URL (`range`, `start`, `end`, `compare`, `signups`), so a copied link opens the same view.

**Last updated** shows when the nightly rollup last ran. A **Stale** chip appears when it is more than 30 hours old.

## Key numbers

| Tile | What it shows |
|------|---------------|
| **Active users (MAU)** | Users active in the 28 days ending on the last complete day of the range |
| **Daily active (avg)** | The average number of users active per day |
| **Stickiness** | Average daily active users as a share of MAU |
| **New signups** | Signups in the range (legit only, or all, per the Signups toggle), with the number of suspected signups underneath |
| **Activation rate** | Not available yet |

A user is active on a day when they make at least one successful AI request that UTC day, from any source. That includes requests made through the public API and internal system traffic, so a user active only through the API still counts toward daily, weekly and monthly active users.

The tiles cover complete days only. When the range ends today, today is still counting, so it is left out of the tiles and comparisons. With **Compare** on, each tile compares against the same number of days right before the range.

## Active users

A line chart of daily, weekly and monthly active users per day. With **Compare** on, a faint dashed line shows MAU for the previous period. Today is drawn dashed because it is not finished.

Switch to **By surface** to see AI requests per day stacked by surface as bars. Internal system traffic is not shown.

## Signups: real vs suspected

Stacked bars of likely legit, suspected and not-yet-classified signups. Bars are days for 7d and 28d, ISO weeks (starting Monday) for 90d, and months for 12m.

Click a bar to open the Users list filtered to the accounts created in that bar's window. Below the chart, the signals that marked accounts in the range are listed with their counts.

## Usage

Three cards show what people use. Rankings and totals cover the complete days in the range, so they add up to the nightly rollup; the daily charts also show today so far, drawn faded.

- **Usage by feature**: AI requests per day, stacked by feature. The six busiest features in the range get their own color, and everything else is grouped as **Other**.
- **Requests by model**: the ten models with the most requests, with each model's share of all requests. **Open in Models** goes to **AI > Models** for latency, tokens and errors.
- **Credits consumed**: credits charged per day. **Open in Credits** goes to the Credits page for spend by account and model. Analytics never shows a currency amount.

## Top organizations and users

Two tables list the 10 heaviest users and the 10 heaviest organizations over the complete days of the range. Rows are ranked by active days, then by AI requests. Each row shows the plan, active days, AI requests, credits consumed and its share of all requests. Click a column header to sort, or a row to open the user's profile or the organization.

Suspected signups and suspended users are left out of both tables, and their usage is not added to any organization. The line under each table says how many accounts were left out.

An organization's numbers add up the usage of its members on the days they worked in that organization.

## Export

**Export CSV** downloads a zip file with one CSV per section for the range on screen: active users, requests by surface, signups, signup signals, usage by feature, requests by model, credits consumed, top users and top organizations. Days are UTC `YYYY-MM-DD`, units are in the column headers, and a day with no rollup is an empty cell rather than 0. The files open directly in Excel, Numbers or Google Sheets.

## Tables and accessibility

Each chart has a **View as table** button that shows the same numbers as a table you can read with a screen reader or copy.

## Gaps, empty ranges and errors

- **Missing days**: if the nightly rollup did not run for some days, a banner says how many. Those days are drawn as gaps, never as zero. Select **Show missing days** to list them.
- **No activity**: a section with nothing to show offers **Show last 90 days**.
- **Errors**: a section that fails to load shows **Try again**.

## Per-user activity

The raw per-user activity log (a row per day, action and user, with organization, date, search and metadata filters and CSV export) is on **Overview > Events**, in the **By user** view. See [Metrics](./metrics.md).

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [Metrics](./metrics.md) - Event metrics and the per-user activity log
- [User Management](./user-management.md) - Managing user accounts
