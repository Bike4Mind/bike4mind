---
title: Analytics
description: Track active users, stickiness and real versus suspected signups over time in the Bike4Mind admin panel
sidebar_position: 6
tags: [admin, analytics]
---

# Analytics

The Analytics page (**Overview > Analytics**) shows who uses Bike4Mind, how often, and whether they come back. It is a trend page: the Dashboard answers "is anything wrong right now?", Analytics answers "are we growing?".

All days are UTC days, and every chart says so. Counts exclude admin accounts, system accounts, accounts flagged as automated test accounts, accounts on your internal staff email domains, accounts tagged Developer, and test personas (a `persona-` username or an email on a configured test domain). Active users and real signups also exclude banned accounts and accounts whose AI access is held (moderated, awaiting review, suspended or under a payment dispute). Every other account is counted. The activation funnel and its user lists follow the same rule, so banned or held accounts do not appear in any step.

## Toolbar

| Control | Options | Default |
|---------|---------|---------|
| **Range** | 7d, 28d, 90d, 12m, Custom | 28d |
| **Compare** | Previous period, Off | Previous period |
| **Signups** | Real only, All | Real only |

**Custom** shows two date inputs. Both days are included, and the range can cover at most 366 days.

The toolbar is kept in the page URL (`range`, `start`, `end`, `compare`, `signups`), so a copied link opens the same view.

**Last updated** shows when the nightly rollup last ran. A **Stale** chip appears when it is more than 30 hours old.

## Key numbers

| Tile | What it shows |
|------|---------------|
| **Active users (MAU)** | Users active in the 28 days ending on the last complete day of the range |
| **Daily active (avg)** | The average number of users active per day |
| **Stickiness** | Average daily active users as a share of MAU |
| **New signups** | Signups in the range (real only, or all, per the Signups toggle), with the number of suspected signups underneath |
| **Activation rate** | Not available yet |

A user is active on a day when they make at least one successful AI request that UTC day, from the web app, the CLI, Desktop or an agent run. Requests made through the public API and internal system traffic do not make a user active, so a user active only through the API is not counted in daily, weekly or monthly active users.

The tiles cover complete days only. When the range ends today, today is still counting, so it is left out of the tiles and comparisons. With **Compare** on, each tile compares against the same number of days right before the range.

## Active users

A line chart of daily, weekly and monthly active users per day. With **Compare** on, a faint dashed line shows MAU for the previous period. Today is drawn dashed because it is not finished. A separate **API users (not counted)** line shows how many people used the public API each day; it is never part of the active user numbers.

Switch to **By surface** to see AI requests per day stacked by surface as bars. Internal system traffic is not shown.

## Signups: real vs suspected

Stacked bars of real and suspected signups. A signup is real when the account has a verified email, is not banned or held, and made a successful AI request within 7 days of signing up (system traffic does not count). Every other signup is suspected, so there is no unclassified bucket; a signup moves from suspected to real when its first request lands inside the 7 days, which the nightly job re-checks for 14 days. Bars are days for 7d and 28d, ISO weeks (starting Monday) for 90d, and months for 12m.

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
