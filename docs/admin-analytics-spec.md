# Admin analytics revamp: spec

Status: **approved** (decisions D1-D7 accepted as recommended). Epic: [#6064](https://github.com/Bike4Mind/bike4mind/issues/6064).

Scope: the admin **Overview > Analytics** page (`?tab=analytics`): what it is for, what it shows, where the numbers come from, and the bugs in today's page.

Out of scope:
- Money. MRR, ARR, paying customers, new and churned MRR live on the **Revenue** page (`docs/admin-subscriptions-spec.md`, epic #6026). Analytics links there and never recomputes them.
- Credit and cost deep dives stay on **Money > Credits**; model latency and errors stay on **AI > Models** and **Overview > System health**.
- The Slack daily and weekly report cron (`apps/workers/src/cron/userActivityReport.ts`) keeps running; this spec only fixes the shared code it calls (bug B1).

This extends the admin polish (#5764) and user-insights (#5574) work and follows `apps/client/app/components/admin/DESIGN_GUIDE.md`.

---

## 1. What exists today

### 1.1 The page

| Tab | What it shows | Data | Problems |
|---|---|---|---|
| User Activity | A paged grid: Date, Action (`counterName`), User email, one metadata sample, Count. Filters: org multi-select, three "Exclude" checkboxes, date range (Today / 7 / 30 days, hidden behind "Show Advanced Filters"), counter and email search, metadata filters, CSV export. | `GET /api/users/counterLogs` -> `server/analytics/userActivityQuery.ts`, a `$group` over `counterlogs` by day (browser time zone), counter, user | A raw event log, not analytics. No chart, no totals, no definition of "active". |
| Daily Report | One preformatted Slack message per day in the range (bold markers, emoji, "Reply with details"), each with an LLM "AI-powered insights" block. | Same route with `report=true&includeInsights=true` -> `CounterLogRepository.metricsByDate` + an LLM call per day; stored forever in `dailyreports` | Slack text pasted into the admin. Slow (an LLM call per day). Bugs B2-B6. |
| Weekly Report | Pick up to 4 ISO weeks; one Slack message per week with LLM insights. | Same route with `weeklyReport=true`; stored forever in `weeklyreports` | Counts one day, not the week (B1). |

Note: `pages/api/admin/analytics.ts` is **not** this page. It feeds the Models page (`ModelMetrics/components/AnalyticsTab.tsx`).

The page has no `AdminPageHeader`, no chart, no stat tile, and none of the shared toolkit. It predates the design guide.

### 1.2 Neighbouring pages

| Page | Question it answers | Keep or change |
|---|---|---|
| Overview > Dashboard | "Is anything on fire right now?" New signups (30d, likely legit), client usage (7d), recent CounterLog activity (7 UTC days). | Keep. It stays the "today" glance; Analytics is the trend page. Dashboard tiles link into Analytics for the long view. |
| Overview > Events | Per-event rows from CounterLog with filters. | Becomes the home of the raw event grid (see 3.2). |
| Money > Revenue (planned, #6022) | Money: MRR and its movement. | Analytics never shows a currency amount. |
| Money > Credits | Credit burn, spend by account and model. | Analytics shows one credits-consumed trend and links here. |
| AI > Models | Per-model latency, tokens, errors. | Analytics shows requests by model and links here. |

---

## 2. Audit: confirmed bugs and suspicions

Method: the page was run in a real browser against a private copy of the local database (local dev, 64 users, about 120 CounterLog rows in the last week), and every number was checked against a direct Mongo query or traced in code. Production was not queried. Aggregates only.

### 2.1 Confirmed

| # | Bug | Evidence | Symptom |
|---|---|---|---|
| B1 | **Weekly report counts one day, not the week.** | `b4m-core/services/src/countersService/getAllCounterFrom24Hours.ts:63-77` sets the window to `startOf('day')` of the end date; `packages/database/src/models/infra/ops/CounterLogModel.ts:254-264` does the same ("startDate only flags a weekly report"). Runtime: week of Oct 26 - Nov 1 holds 54 events (6 "Model Started") by direct query; the report's window (Sunday Nov 1) holds 0. | The current week is all zeros and the LLM insight says there is "a complete lack of activity" in "Model Started". Past weeks are one Sunday compared against a 30-day/4 average, so they always read as a steep drop. The weekly Slack post shares this path. |
| B2 | **Daily Report date range snaps back.** | `filters/DateFilterComponent.tsx:53,65,87` writes the shared store; `Analytics/index.tsx:17,73` re-runs the parent query and unmounts the tab while loading; `DailyReportTab.tsx:22` resets to the default. Runtime: picking "Last 30 Days" spins about 40 s, then shows 10/22-10/29 again. | The admin can never see more than the default week of daily reports. |
| B3 | **Hidden, wasted report requests.** | `index.tsx:17` + `app/hooks/useAnalyticsData.ts:39-94`. Runtime: opening Weekly fired a `weeklyReport=true` request for the User Activity date range (an 8-day window nobody picked), and each report request fires twice. | Extra LLM calls and seconds of spinner; the parent's error renders as "Could not load weekly reports"; a junk `weeklyreports` row is stored for a range nobody asked for. |
| B4 | **Time zones disagree.** | User Activity buckets days in the browser time zone (`userActivityQuery.ts:151,184`); reports and the Dashboard use UTC. Runtime (UTC+8): a login at 19:11 UTC shows as "2026-10-29" in the grid, while "Report for 2026-10-29" says "No activity". | The grid, the daily cards and the Dashboard never reconcile for the same day. The report header reads "October 27 16:00 UTC" for "Report for 2026-10-28". |
| B5 | **Default exclusions do nothing.** | The only producer writes `userOrganization = organization name or ''` (`b4m-core/services/src/countersService/incrementUserCounter.ts:48,57`). "Unknown" and "Personal" are report-only labels. Runtime: `distinct('userOrganization')` returns `''` and real org names only; rows with `''` still show with both boxes checked. A third checkbox is a hard-coded org name. | Admin thinks no-org and personal users are hidden; they are not. |
| B6 | **Errors cached as reports, and reports never refresh.** | `pages/api/users/counterLogs.ts:470-483,647-652` returns "Error generating report: ..." as a report; the response is cached 1 h (`:236-246`). Past days are written to `dailyreports`/`weeklyreports` with no expiry. | A transient failure shows for an hour; a fixed metric (B1) never reaches past dates; Refresh does nothing. |
| B7 | **"Last 7 days" is 8 days, "Last 30 days" is 31.** | `store.ts:30`, `DateFilterComponent.tsx:38` (expects `diffDays === 6`, gets 7). | Totals differ from the Dashboard's 7 days; the preset button never stays selected. |
| B8 | **Clearing every org shows everything with exclusions silently off.** | `UserActivityTab.tsx:103`, `userActivityRequest.ts:41,55-60`. | Label still says "All Organizations"; checkboxes look checked but are disabled. |
| B9 | **Dashboard and Analytics count different events.** | Dashboard drops API-key-used rows and non-string counter names (`server/admin/getActivitySummary.ts:20-23`); Analytics does not. | Same metric, two totals. |
| B10 | **Staff and test accounts are counted as users.** | DAU excludes staff only by the `NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS` email regex; no `isAdmin`, `isSystem`, `isSynthetic` or suspended filter anywhere on the page. Runtime: "Internal Team: 0 users" while all three active users were admins or e2e fixtures. | DAU and "most active users" are inflated by staff, test and bot accounts. |
| B11 | **"Most active users" ranks by credits, not activity.** | Runtime: the top entry had 576 credits and **0 events**, while "Total Active Users" counted 2. | A user can be "most active" without being active. |
| B12 | **CSV export is malformed for some rows.** | `app/hooks/useExportToCSV.ts:34` quotes a value only when it contains a comma, so metadata JSON with quotes breaks the row; no formula-injection guard. | Broken rows in a spreadsheet; a cell starting with `=` executes. |
| B13 | **Slow on tiny data.** | Runtime: 7 days of daily reports took 9.5 s, 30 days took 23.5 s on about 120 events (one aggregation plus one LLM call per uncached day, run one after another; `counterLogs.ts:579-662`). | See S1 for production. |

### 2.2 Suspected (needs a production check)

| # | Suspicion | Check |
|---|---|---|
| S1 | A 30-day Daily Report times out (60 s Lambda budget) on production volumes: per-day `findAllWithUserByDate` joins full user documents with no projection (`CounterLogModel.ts:161-197`) and the LLM prompt includes every raw log line. | Cold-cache 30-day Daily Report on staging; look for 504 and prompt token counts. |
| S2 | Week-over-week "+600%" from a zero base and the "Health score" are not meaningful numbers. | Product call, not a code check: both are removed in the new page. |
| S3 | `SearchBox` debounce is reset by parent re-renders, dropping a pending search. | Type fast while the grid refetches. |

Discarded on checking: the org filter looks double-encoded in the URL (`%2520`), but the server decodes twice, so names with spaces still match.

---

## 3. What Analytics is for

### 3.1 Jobs

The admin running this SaaS opens Analytics weekly, or after a launch, a pricing change or a bot wave. Each job maps to a section in 4.

| # | Job (question) | Need or wish | Today |
|---|---|---|---|
| J1 | Are we growing? How many people actually use the product, and is that up or down vs last period? | Need | No |
| J2 | Do people stick? What share of monthly users come back daily or weekly? | Need | Fake (DAU/WAU on one day) |
| J3 | Are signups real? Real vs suspected, so a bot wave doesn't read as growth. | Need | Dashboard tile, 30 days only |
| J4 | Do new users get value? Signup -> first AI action -> return -> paid. | Need | No |
| J5 | Do cohorts retain? Of the people who signed up in week W, how many are still active in week W+n? | Need | No |
| J6 | What do people use? Usage by feature, by surface (web, CLI, API), by model. | Need | Partial (event grid) |
| J7 | How much AI do we burn? Credits consumed trend (not money). | Need (one chart) | On Credits |
| J8 | Who are our heaviest orgs and users? | Need | Wrong (B11) |
| J9 | What did user X do on day D? (support) | Need, but not here | The User Activity grid; moves to Events |
| J10 | An LLM-written narrative of the week | Wish, low | The Daily/Weekly reports; stays in Slack only |
| J11 | Segment everything by plan, org, signup method or country | Wish | No |
| J12 | Alerts when a metric moves (DAU drop, activation drop) | Wish | No |
| J13 | Errors and latency | Not here | System health, Models |

### 3.2 Information architecture

```
Overview
  Dashboard        today: anomalies, last 24h-30d tiles      (unchanged; tiles link into Analytics)
  Analytics        trends: growth, stickiness, activation, retention, usage
  System health
  Events           raw CounterLog explorer (absorbs the User Activity grid)
Money
  Revenue          money (epic #6026)
  Credits          credit and cost detail
```

- The Daily and Weekly report tabs are removed from the admin (**D1**). Their numbers are replaced by real charts; the LLM narrative stays in Slack.
- The User Activity grid moves to **Overview > Events** as its "By user" view (**D2**), with its filters kept in the URL.

### 3.3 Definitions every section shares

- **Counted user**: any user that is not `isSystem`, `isSynthetic` or `isAdmin` and not on the staff email domains. A `userId` with no `users` row (deleted, or not an ObjectId) still counts, so DAU equals a direct distinct count over `usageevents`. Suspended users are counted in history (they were active then) but excluded from "Top users". A footer note on the page says this once.
- **Active user (day D)**: a counted user with at least one `usageevents` row (any feature, `status: 'ok'`) on UTC day D. Why `UsageEvent`: it is written for every billable AI call on every surface (web, CLI, desktop, API, agent), it is indexed on `createdAt`, and it has no TTL. CounterLog is a product-event stream with free-form `userId` and is used only for feature adoption. `lastActiveAt` is socket-driven and misses API users, so it is not used.
- **DAU / WAU / MAU (day D)**: distinct active users on D / in the 7 UTC days ending D / in the 28 UTC days ending D. 28 rather than 30 so MAU windows hold the same weekdays.
- **Stickiness**: average DAU over the range / MAU at the range end, as a percent.
- **Legit signup / suspected signup**: `isSuspectedSignup(classifySignups(...))` from `apps/client/server/users/signupClassifier.ts` and `apps/client/app/utils/signupSignals.ts`, including the Gmail-aware signals from #6037. Users not yet classified are "unclassified", never folded into legit.
- **Time zone**: all buckets are **UTC days** and **ISO weeks starting Monday UTC** (**D3**). Every chart subtitle says "UTC". The partial current day is drawn dashed and excluded from comparisons.

---

## 4. The page

### 4.1 Anatomy

Analytics is neither a list nor a detail page; it uses this composition (design guide section 3, with the tokens and type scale unchanged):

1. `AdminPageHeader`: title "Analytics", description "Who uses Bike4Mind, how often, and whether they come back. UTC." Action: "Export CSV" (secondary; there is no primary action on a read-only page).
2. Toolbar (`FilterBar`-style row, 32 px controls):
   - Range `SegmentedControl`: 7d, 28d, 90d, 12m, Custom (custom opens two date inputs, inclusive UTC days).
   - Compare `SegmentedControl`: "Previous period" / "Off" (default Previous period).
   - Signups `SegmentedControl`: "Legit only" / "All" (default Legit only; applies to every section that counts signups or cohorts).
   - "Last updated 04:10 UTC" meta text (from the rollup, see 6).
3. `StatStrip` (5 tiles, see 4.2).
4. Sections, each a `SectionCard` holding one chart, in a 2-column grid (1 column under 900 px): 4.3 to 4.8.
5. Footer meta line: "Counts exclude staff, system and test accounts. Days are UTC."

URL state (registered in `adminTabParams.ts`, read and written with `useAdminListUrlState`):

| Param | Values | Default |
|---|---|---|
| `range` | `7d`, `28d`, `90d`, `12m`, `custom` | `28d` |
| `from`, `to` | `YYYY-MM-DD` UTC, inclusive; only with `range=custom` | - |
| `compare` | `prev`, `off` | `prev` |
| `signups` | `legit`, `all` | `legit` |

A link with these params reproduces the exact view.

### 4.2 Stat strip

Each tile: label, value, comparison line ("+12% vs prev 28d", signed, tabular), `StatSparkline` of the daily series. Neutral tone; a comparison is never colored red just for being negative (the guide: red means something is wrong). Tiles:

| Tile | Value | Comparison |
|---|---|---|
| Active users (MAU) | MAU at range end | MAU at previous range end |
| Daily active (avg) | mean DAU over the range | same over previous range |
| Stickiness | DAU avg / MAU | percentage points vs previous |
| New signups | legit signups in range (or all, per toggle); meta line "N suspected" | previous range |
| Activation rate | share of the range's legit signups activated (4.5), cohorts at least 7 days old only | previous range |

### 4.3 Active users (J1, J2)

- Chart: line, DAU / WAU / MAU over the range. Primary series `accent` (MAU), WAU and DAU in the guide's comparison style (`inkMuted`, dashed for the previous period when compare is on). Takeaway caption under the title, e.g. "MAU up 12% vs previous 28 days".
- Secondary toggle in the card action: "By surface" stacks DAU by `UsageEvent.source` (web, cli, desktop, api, agent, plus "unclassified" for older rows with no `source`; `system` excluded).
- Drill-down: clicking a day opens the users list for users active that day (needs the new `activeOn` filter, issue 7).

### 4.4 Signups: real vs suspected (J3)

- Chart: stacked bars per day (per week at 90d, per month at 12m): likely legit (`accent`) and suspected (the validated warn series from `Signups/SignupChart.tsx`), unclassified in `inkMuted`. Reuses `SignupChart` and its validated colors.
- Below: one line per strong signal count in the range (`domainBurst`, `signupSpike`, ...), as `InlineBar` rows.
- Drill-down: a bar opens `/admin?tab=users&createdFrom=...&createdTo=...` (exists today via `bucketWindow`), plus `&verdict=suspected|legit` once issue 7 lands.

### 4.5 Activation funnel (J4)

Cohort: counted users who signed up in the range (legit only unless toggled), and whose signup is at least 7 days old (younger ones are listed as "N too new to judge").

| Step | Definition |
|---|---|
| Signed up | `users.createdAt` in range |
| First AI action | at least one `usageevents` row within 7 days of signup |
| Came back | active on a UTC day other than the signup day, within days 1-7 after signup |
| Converted to paid | a paid subscription or a credit-pack purchase within 30 days of signup (counts people only; amounts belong to Revenue). Cohorts younger than 30 days show this step as pending. |

- Chart: horizontal funnel bars (`accent` fill on a `selection` track, as the guide's inline bars), each with count and percent of the previous step.
- Drill-down: each step opens the users list of people who reached that step and not the next (issue 7 filters).
- "Activated" (tile in 4.2) = reached "Came back".

### 4.6 Retention cohorts (J5)

- Table (`DataTable`, numeric columns right-aligned): rows = signup ISO week (last 12), columns = week 0..8, cell = % of the cohort active in that week. Cell background is a single-hue `accent` ramp (opacity steps), with the number always printed; no traffic-light colors.
- Cohort size column first. Cells in the future are blank, not 0.
- Honors the Signups toggle. Default legit only, so a bot wave does not crash the curve.

### 4.7 Usage (J6, J7)

- Chart A: stacked area, AI requests per day by feature (`UsageEvent.feature`, top 6 plus "Other"), categorical palette from `SignupChart` in fixed order.
- Chart B: horizontal bars, requests by model (top 10) with share; link "Open in Models".
- Chart C: line, credits consumed per day (sum of `UsageEvent.creditsCharged`); link "Open in Credits". No currency, no COGS here.
- Feature adoption (wish, issue 12): share of MAU that used each product feature (CounterLog `counterName` groups: notebooks, files, agents, gears, voice).

### 4.8 Top orgs and users (J8)

- Two `DataTable`s, 10 rows each, sortable: name, active days in range, AI requests, credits consumed, plan chip (`StatusChip`), and a share `InlineBar`.
- Ranked by active days, then requests. Suspended and suspected accounts are excluded; a meta line says how many were left out.
- Row click opens `/admin/users/$userId` or the org page.

### 4.9 States

| State | Pattern |
|---|---|
| Loading | Skeletons shaped like each tile and chart; the toolbar stays interactive. Sections load independently. |
| Empty range | `EmptyState` per section: "No activity in this range" + "Show last 90 days" button. |
| Rollup missing for some days | Banner above the strip: "Rollup is missing for N days; those days show as gaps." + "Show missing days". Gaps are drawn as gaps, never as zero. |
| Rollup stale (older than 30 h) | `warn` chip next to "Last updated". |
| Section error | `ErrorState` in that card only, with "Try again"; other sections keep working. |
| Classifier truncated | Meta line under 4.4: "N signups not classified (over the scan limit)". |

### 4.10 Export

"Export CSV" downloads the visible range and sections as one file per section (zip) or one sheet per section; columns are named with units once in the header, days as `YYYY-MM-DD` (UTC). Values are escaped per RFC 4180 (always quoted when they contain a quote, comma, CR or LF) and cells starting with `=`, `+`, `-`, `@` are prefixed with `'`. The shared `useExportToCSV` gets this fix (B12) so every admin export benefits.

### 4.11 Charts (applies to every chart above)

- Recharts, inside `SectionCard body="custom"`; title (15/600) plus a one-line takeaway caption (`inkMuted`).
- Primary series `accent`; comparisons `inkMuted` at 40%; gridlines `border`, horizontal only; axis labels `inkMuted` 12 px; no axis line on Y.
- Tooltip: date (UTC), value with thousands separator, delta vs the comparison point.
- Every chart has a "View as table" toggle (accessibility and copy-paste) and an `aria-label` summarizing the takeaway.
- Status is never shown by color alone: legends always carry text.
- Works at 375 px: charts go full width, the table scrolls inside its card.

---

## 5. Data sources

| Section | Source | Live or rollup |
|---|---|---|
| Active users, stickiness | `analytics_user_days` (new) | Rollup; today live |
| Signups | `users.createdAt` + signup classifier | Rollup per day (verdict re-evaluated for the last 14 days nightly, since `dormantAfterSignup` matures); today live via `signupTimeseries` |
| Activation, retention | `analytics_user_days` + `users.createdAt` + subscriptions / credit purchases | Rollup |
| Usage by feature, source, model, credits | `usageevents` | Rollup per day; today live |
| Top orgs and users | `analytics_user_days` + `usageevents` grouped by user and owner | Live over the rollup (bounded, top 10) |

---

## 6. Performance and storage

Live aggregation over `usageevents` for 12 months and cohort retention does not fit a 60 s request. The page reads precomputed rollups; only "today" is live.

**`analytics_user_days`** (new collection): one row per counted user per active UTC day.
- Fields: `day` (`YYYY-MM-DD`), `userId`, `ownerType`, `orgId?`, `requests`, `creditsCharged`, `features` (string array), `sources` (string array), `signupDay`, `suspected` (boolean; the signup verdict for the user, set when the user first appears and refreshed with the signup cohort for the trailing 14 days).
- Indexes, declared together at the bottom of the schema: unique `{ day: 1, userId: 1 }`; `{ userId: 1, day: 1 }` (retention); `{ signupDay: 1, day: 1 }` (cohorts).
- DAU = count of rows for `day`; WAU/MAU = distinct `userId` over 7/28 days of rows (one `$group` over at most 28 x DAU rows).

**`analytics_daily`** (new collection): one row per UTC day with totals: signups (legit, suspected, unclassified, by signal), DAU, WAU, MAU, requests by feature/source/model, credits consumed. Unique `{ day: 1 }`.

**Writer**: a nightly cron at 04:00 UTC in `apps/workers/src/cron/` (cron is acceptable here: it is a rollup, not a trigger), with a DLQ. It recomputes yesterday and re-evaluates signup verdicts for the last 14 days; idempotent upserts. A backfill script (`packages/scripts`) fills history from `usageevents` (no TTL) in day-sized batches with `maxTimeMS`.

**Read API**: `GET /api/admin/analytics/overview?from=&to=&compare=&signups=` returns the strip, series and tables from the two collections plus a live "today" slice; `GET /api/admin/analytics/cohorts?weeks=12`. Admin-only, `Cache-Control: private, no-store`, client `staleTime` 5 min. Both validated with Zod; neither is a public API contract.

Existing indexes already cover the live slices: `usageevents {createdAt: -1}`, `users {createdAt: 1}`.

---

## 7. Issue breakdown

Ordered by value; confirmed bugs first. All issues: labels `admin-ux` and `UI/UX`, sub-issues of epic [#6064](https://github.com/Bike4Mind/bike4mind/issues/6064), which is blocked by every child.

| # | Issue | Size | Depends on |
|---|---|---|---|
| 1 ([#6053](https://github.com/Bike4Mind/bike4mind/issues/6053)) | **Fix the weekly report window** (B1): use the full Mon-Sun UTC range for this week, last week and the 4-week average; one test per facet. Also fixes the Slack weekly post. Invalidate stored `weeklyreports`. | S | - |
| 2 ([#6054](https://github.com/Bike4Mind/bike4mind/issues/6054)) | **Stop caching error reports and let past reports refresh** (B6): never persist or cache an "Error generating report" result; add a version key so a metric fix regenerates stored reports. | S | - |
| 3 ([#6055](https://github.com/Bike4Mind/bike4mind/issues/6055)) | **Fix the Analytics tab state bugs** (B2, B3, B7, B8): no parent report query; Daily dates owned by the tab; "Last 7 days" = 7 days; empty org selection is "none", not "all". | S | - |
| 4 ([#6056](https://github.com/Bike4Mind/bike4mind/issues/6056)) | **Fix the org exclusion filter and staff counting** (B5, B10, B11): replace the three hard-coded labels with "Exclude users without an org" and "Exclude staff and test accounts" (`isAdmin`, `isSystem`, `isSynthetic`); rank "most active" by events. | S | - |
| 5 ([#6057](https://github.com/Bike4Mind/bike4mind/issues/6057)) | **Safe CSV export** (B12): RFC 4180 quoting and formula guard in `useExportToCSV`. | S | - |
| 6 ([#6058](https://github.com/Bike4Mind/bike4mind/issues/6058)) | **Analytics rollups**: `analytics_user_days` and `analytics_daily` models, nightly cron with DLQ, backfill script, index migration. | L | - |
| 7 ([#6059](https://github.com/Bike4Mind/bike4mind/issues/6059)) | **Users list filters for drill-down**: `verdict` (suspected / legit), `activeOn` / `activeFrom`-`activeTo`, `funnelStep`; server filter plumbing in `adminUsersFilter.ts` and `listAdminUsers.ts`; URL keys registered. | M | 6 (for activity filters) |
| 8 ([#6060](https://github.com/Bike4Mind/bike4mind/issues/6060)) | **New Analytics page shell + Active users + Signups**: header, toolbar with URL state, stat strip, sections 4.3 and 4.4, states, UTC labels. Move the User Activity grid to Events; remove the Daily/Weekly tabs (**D1**, **D2**). | M | 6 |
| 9 ([#6061](https://github.com/Bike4Mind/bike4mind/issues/6061)) | **Activation funnel** (4.5) with drill-down. | M | 6, 7, 8 |
| 10 ([#6062](https://github.com/Bike4Mind/bike4mind/issues/6062)) | **Retention cohorts** (4.6). | M | 6, 8 |
| 11 ([#6063](https://github.com/Bike4Mind/bike4mind/issues/6063)) | **Usage and top accounts** (4.7, 4.8) + section CSV export. | M | 6, 8 |
| 12 | Feature adoption (share of MAU per product feature). | M | 8; wish, not filed |
| 13 | Segments: plan, org, signup method, country. | L | 8; wish, not filed |
| 14 | Metric alerts (DAU or activation drop) to Slack. | M | 6; wish, not filed |

- Ship order: 1-5 are independent bug fixes and can go in parallel, today, against the current page. 6 is the critical path for everything new.
- First visible value: issue 8 (a correct DAU/WAU/MAU and real-vs-suspected signups over 90 days and 12 months).
- With D1 accepted, issues 2 and 3 can be trimmed to the minimum that keeps the Slack cron correct, since the tabs go away in 8.

---

## 8. Product decisions

| # | Decision | Outcome |
|---|---|---|
| D1 | Keep the Daily and Weekly report tabs in the admin? | Remove them. Keep the Slack posts (fixed by issue 1). The LLM narrative is a wish for the page, not a need. |
| D2 | Where does the raw User Activity grid go? | Overview > Events, as a "By user" view. Analytics shows aggregates only. |
| D3 | Time zone for buckets? | UTC everywhere, labelled. Rollups are shared across admins, and Revenue's daily snapshot is UTC too. The Signups tile on the Dashboard (browser-local today) switches to UTC for consistency. |
| D4 | What makes a user "active"? | At least one successful AI action (`UsageEvent`) that UTC day. Logins and page views do not count. |
| D5 | Count suspected signups by default? | No. Legit only by default, with an "All" toggle. |
| D6 | Who is excluded from all counts? | Admins, staff domains, system and synthetic accounts. Suspended users stay in history. |
| D7 | Paid conversion step: what counts as paid? | A paid subscription or any credit-pack purchase within 30 days. People only; amounts stay on Revenue. |
