---
title: Security Dashboard
description: Check whether signups, spend, firewall traffic and payments look normal, then review firewall traffic and scan results
sidebar_position: 28
tags: [admin, security, dashboard, monitoring]
---

# Security Dashboard

The Security Dashboard is the first place to look when something seems wrong with signups, spend or payments. It answers one question quickly: does the platform look normal right now? From there you can move to the queues where you act, to live firewall traffic, or to the results of the security scans.

You open it from **Security** in the admin sidebar. A help button in the page header opens this article.

## Views

The dashboard has three views. The one you pick is kept in the page address, so a link you share or bookmark opens the same view.

| View | What it shows |
|------|---------------|
| **Incident** | The default view: key numbers, the defenses in force, the review queues, alarms, payments and signups |
| **Firewall** | Live web application firewall traffic, rule activity and blocked requests |
| **Scans** | The latest result of each security scan, with a panel for each scan type |

## Incident view

### Time range and freshness

A range control at the top switches the numbers between the last hour, the last 24 hours (the default) and the last 7 days. The line next to it shows how old the data is, for example "As of 2 minutes ago". Hover over it to see the exact time in UTC. The view refreshes itself every minute.

If the last hour shows a signup or API key spike, a banner appears above the numbers. **Review cluster** opens the user list filtered to that hour and grouped by email domain.

### Key numbers

Five numbers sit at the top. Each has a help button that explains what it counts.

| Number | What it counts | Second line |
|--------|----------------|-------------|
| **Signups** | Successful signups counted by the hourly census | How many of them received the full signup grant |
| **Young-account spend** | Spend by accounts younger than seven days, estimated from the price table | Notes that it is a ledger estimate |
| **WAF blocked** | Requests the firewall blocked | The total number of requests in the range |
| **Alarms firing** | Alarms that are currently in the ALARM state | The total number of alarms |
| **Payments 24h** | Card payments started in the last 24 hours | How many Stripe Radar blocked and how many it rated elevated risk |

The newest hour of signups can lag by up to two hours, because the census counts completed hours.

### Cards

Below the numbers, cards sit in two columns, or one column on a narrow screen.

| Card | What it shows |
|------|---------------|
| **Defenses** | Whether the signup challenge is on and fails closed, each firewall block list with its size and whether it blocks or only counts, the runtime blocker, today's spend against the signup and trickle grant pools (or Paused), the new-account spend cap, and the payment risk settings |
| **Queues** | The number of items waiting in **Risk review**, **Held signup grants** and **Signup domain holds**, each with an **Open** button that takes you to that admin page |
| **Alarms** | Every alarm that is firing, newest first, with how long ago it started |
| **Payments** | Attempts, successes, failures, Stripe Radar blocks, elevated risk, payments from hosting networks and distinct cards, for the last 24 hours and the last 7 days |
| **More signals** | Signup code sends, API key creations, refused social sign-in signups and challenge setup errors over the selected range |

A **Signups** chart under the cards shows signups over time, split into likely legitimate and suspected accounts, with a band for the typical range. When the range is the last hour, the chart shows the last 24 hours so you can see that hour in context.

### Reading the values

- A zero, an empty list or a setting that is off is shown in a neutral tone. Red is reserved for something that is failing or blocked.
- When a value cannot be read, you see a dash with a short reason under it. The rest of the page keeps working.
- When a whole data source fails, the cards that depend on it show the error with a **Try again** button.

## Firewall view

The Firewall view shows live traffic handled by the web application firewall. It has its own range control, with preset ranges and a custom start and end time.

- **Traffic overview** with allowed, blocked and counted requests
- **Top rules** that matched requests
- **Logs insights** summarizing recent firewall activity
- **Blocked requests** listing recent requests the firewall rejected

The firewall data loads only while this view is open.

## Scans view

### Summary

A table at the top lists each scan type: **Website**, **Cloud baseline**, **Prowler** and **Active defense**. Each row shows:

| Column | Description |
|--------|-------------|
| **Status** | The result of the latest run, or "Not run" if the scan has never run |
| **Last run** | How long ago the latest run happened, with the exact UTC time on hover |
| **Findings** | Open findings by severity, for example "2 high, 5 medium" |
| **Next run** | When the next scheduled run starts, or "Manual" if the scan only runs when you start it |

Select a row to open that scan's panel below the table. You can also switch panels with the control above them. The open panel is kept in the page address.

### Scan panels

| Panel | What it does |
|-------|--------------|
| **Website** | Results of the automated website vulnerability scan, with a button to run it and a weekly schedule switch |
| **Cloud baseline** | Baseline checks of the cloud account configuration, with a button to run them and a weekly schedule switch |
| **Prowler** | Results of a deeper cloud account audit. Results arrive about ten minutes after you start a run |
| **Active defense** | Live probes against the platform, the findings they reproduce, and the history of runs |

### Scan cooldowns

After a scan runs, its button is disabled for a cooldown period. A message tells you how long remains before you can run it again. Turning a weekly schedule on or off takes effect right away.

## Best practices

- Start with the Incident view when something seems off, and compare the selected range with the 7 day view before you act.
- Work the review queues from the **Queues** card rather than searching for each admin page.
- Run the website and cloud scans after significant deployments to catch new issues early.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Navigation and layout
