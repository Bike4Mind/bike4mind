---
title: Analytics
description: Track active users, stickiness and real versus suspected signups over time in the Bike4Mind admin panel
sidebar_position: 6
tags: [admin, analytics]
---

# Analytics

The Analytics page (**Overview > Analytics**) shows who uses Bike4Mind, how often, and whether they come back. It is a trend page: the Dashboard answers "is anything wrong right now?", Analytics answers "are we growing?".

All days are UTC days, and every chart says so. Counts exclude staff, system and test accounts.

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

A user is active on a day when they make at least one successful AI request that UTC day, from any surface (web, CLI, desktop, API or agent).

The tiles cover complete days only. When the range ends today, today is still counting, so it is left out of the tiles and comparisons. With **Compare** on, each tile compares against the same number of days right before the range.

## Active users

A line chart of daily, weekly and monthly active users per day. With **Compare** on, a faint dashed line shows MAU for the previous period. Today is drawn dashed because it is not finished.

Switch to **By surface** to see AI requests per day stacked by surface. Internal system traffic is not shown.

## Signups: real vs suspected

Stacked bars of likely legit, suspected and not-yet-classified signups. Bars are days for 7d and 28d, ISO weeks (starting Monday) for 90d, and months for 12m.

Click a bar to open the Users list filtered to the accounts created in that bar's window. Below the chart, the signals that marked accounts in the range are listed with their counts.

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
