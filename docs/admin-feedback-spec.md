# Admin Feedback page: a daily triage tool

Status: approved with D1 to D7 as recommended. Tracked in epic #7000 (#7001 to #7015).

Scope: `/admin?tab=feedback`, judged as the support person who opens it every morning. Layout moved onto the admin toolkit in #6833 (closed #6701), and the sidebar "new feedback" badge shipped in #6931. Neither is re-proposed here.

## How this was checked

- Code: `apps/client/app/components/admin/Feedback/**`, `apps/client/pages/api/feedback/**`, `packages/database/src/models/social/FeedbackModel.ts`, `b4m-core/common/src/types/entities/FeedbackTypes.ts`, and every producer of feedback documents.
- Local: ran the app on current `main` with 30 seeded reports (bugs, thumbs up and down with and without comments, help ratings, product feedback, duplicates, "coming soon" signups) and worked a triage pass at 1440 px and 768 px in dark mode.
- Prod: not checked; the built-in browser was not signed in. Real volume and the share of non-actionable rows are open questions (see D1).

## What each report carries today

| Producer | type | subject | Conversation link | Model and tools (`promptMeta`) | Notifies Slack/email |
|---|---|---|---|---|---|
| Report button and chat thumbs (`BugReportModal`) | Bug / Feedback / Thumbs Up / Thumbs Down | turn | yes | yes | yes |
| Help modal (`HelpModal`) | none | product | session only | no | yes |
| `/feedback` slash command | Feedback | session | yes | no | yes |
| Help article and help chat ratings (`helpFeedbackRouting`, bypasses `POST /api/feedback`) | from the rating | help | no | no | no, by design |
| "Coming soon" signup (`ComingSoon.tsx`) | none | product | no | no | yes |

No producer records the page URL, browser, app version, platform (web, desktop, iOS) or a screenshot. The schema has no plan, assignee, note, resolution or handled-by field. Report text moves to a 90-day TTL sibling and then reads "[content expired]".

## Problems, ranked by daily friction

Each item: what I saw, why it hurts support, the change, and whether it needs backend or data work.

### F1. You cannot tell what kind of report a row is

- **Seen:** the list has no Type column. A thumbs-up "Great summary", a thumbs-down "Answer ignored the attached file" and a bug report look identical; all carry a generic `feedback` tag. A thumbs-down with no comment renders as an empty Feedback cell, and changing its status toasts `"No content" feedback from <user> updated to: Closed` (`""` on older reports that store empty content). Subject (turn, conversation, product, help) is a filter but not shown per row.
- **Why:** severity is the first triage call. Today it takes reading every row, and an empty row gives nothing to read.
- **Change:** a Type chip (bug, thumbs down, thumbs up, feedback, help rating) with the subject beside it; an empty comment reads "No comment" in muted text; the toast names the type instead of quoting empty text. Add a Type multi-select filter.
- **Work:** frontend only. `type` and `subject` are already in the list projection. A `type` filter needs one API param; add a `{ type, status, createdAt }` index if the filter is used at volume.

### F2. The queue is padded with rows that are not feedback

- **Seen:** `ComingSoon.tsx` writes each launch-waitlist email as a feedback document (`userId: 'Unknown'`, content "Coming soon signup", status New). Comment-less thumbs-ups also land as New. Both count toward the header total and the sidebar badge from #6931.
- **Why:** support has to close noise before reaching real reports, and the badge never reaches zero, so it stops meaning anything.
- **Change:** stop writing waitlist signups to `feedbacks` (send them to the existing waitlist/subscriber flow) and close or move the existing ones with a migration. Decide how comment-less thumbs are handled (D1).
- **Work:** backend and a data migration.

### F3. No detail view: everything is read inside an 80 px scroll box

- **Seen:** no row click or drawer. Long text scrolls inside a fixed box. Model, tools and retrieval metadata (`promptMeta`) are excluded from the list response and never shown. The deep-link card (`?feedbackId=`) exists but only via "Copy link".
- **Why:** to judge a thumbs-down you need the model and what the turn did. Today that means opening the conversation in a new tab, which only works for turn reports.
- **Change:** row click (and Enter) opens a side drawer, per the guide's "whole row opens the detail" rule: full text, type and subject, reporter card (F4), "Open conversation at this turn", model and tools used, help article for help reports, status and history (F5), with previous and next to move through the queue. The URL keeps `feedbackId` so the drawer is shareable.
- **Work:** frontend. `GET /api/feedback/[id]/read` already returns `promptMeta`.

### F4. No reporter context

- **Seen:** the reporter shows username, email, org name and a user-id chip that only copies. No link to the user's admin profile, no plan or subscription, no count of their earlier reports.
- **Why:** "charged twice" from a paying team admin and the same text from a free account are different tickets. Finding out means copying the id and searching the Users tab.
- **Change:** the username links to `/admin/users/$userId` (the route other admin pages use). The drawer shows plan, account age, suspension state and "N earlier reports" (filters the list to that user).
- **Work:** the profile link is frontend only. Plan and history need the read endpoint to join the user and subscription (backend, no schema change).

### F5. Status changes leave no trail and cannot be undone

- **Seen:** the status Select applies instantly with no undo. The client sends the whole row to `PUT /api/feedback/[id]/update`; the server accepts any string as status (`z.string()`) and logs the event under the reporter's `userId` from the body, not the admin who acted. Delete has no reason and no Admin log entry.
- **Why:** with two people on support, nobody can see who closed what or why, and a mis-click on the Select silently removes a report from the New view.
- **Change:** a dedicated status action that takes the enum, records `handledBy` and `handledAt`, writes an Admin log entry, and offers a 30 s Undo (guide principle 4). Delete takes a reason and is audited.
- **Work:** backend (new endpoint or a tightened update, two schema fields, audit write) plus frontend.

### F6. No bulk actions

- **Seen:** no row selection. Closing a run of duplicates or waitlist rows is one Select per row.
- **Why:** the guide's "built for the bad day": after an outage, dozens of identical reports arrive at once.
- **Change:** row checkboxes and `BulkActionBar`: set status (with close reason), delete, and "select all matching" with a dry-run count.
- **Work:** backend bulk endpoint (bounded, audited) plus frontend.

### F7. "Closed" says nothing about the outcome

- **Seen:** three states: New, In progress, Closed. No resolution, no internal note, no owner.
- **Why:** "closed, fixed in release X", "closed, won't fix" and "closed, duplicate" need different follow-ups, and a teammate picking up an In progress item has no notes.
- **Change:** keep the three states; closing asks for a resolution (Fixed, Won't fix, Duplicate, No action needed) and accepts an optional internal note. Notes appear in the drawer history. See D2 and D3.
- **Work:** backend (schema fields, validation) plus frontend.

### F8. No way to close the loop with the reporter

- **Seen:** no reply, no contact action, and nothing tells the user their report was handled.
- **Why:** support has to leave the page for an email client and copy the address, and users who report bugs never hear back.
- **Change:** phase 1, an "Email reporter" action (`mailto:` with the subject and a quote of the report) in the drawer. Phase 2, an in-app reply sent through the app's mailer and logged on the report (D4).
- **Work:** phase 1 frontend; phase 2 backend.

### F9. Missing filters for the questions support actually asks

- **Seen:** filters are search, status, subject and organization. No type, date range, "has a comment" or plan filter.
- **Why:** "thumbs-downs this week", "bugs since yesterday's deploy" and "reports from paid teams" are the common daily questions.
- **Change:** Type (F1), Created date range presets (24 h, 7 d, 30 d, custom), "Has comment", and Plan once F4 exists. All kept in the URL like the current filters.
- **Work:** API params plus frontend; Plan needs the F4 join.

### F10. Reports arrive without technical context

- **Seen:** no page URL, browser, app version or platform on any report, and no screenshot. Help-modal and slash-command reports also lack the model.
- **Why:** a bug report without the platform or version usually needs a round trip with the user before anyone can reproduce it.
- **Change:** every producer sends a `clientContext` (page path, app version, platform, viewport); the server adds the user agent from the request. Show it in the drawer and the CSV. Screenshots are a separate decision (D5).
- **Work:** backend and schema, plus small changes in each producer.

### F11. Duplicates are not grouped

- **Seen:** three reports of the same PDF-export failure on the same day sit as three unrelated rows.
- **Why:** support cannot tell an incident from a one-off, and closes the same issue three times.
- **Change:** phase 1, the drawer shows "Similar reports" (same type, text search over the last 14 days) with "Close all as duplicate". Phase 2, automatic grouping (D6).
- **Work:** phase 1 backend query plus frontend; phase 2 a clustering job.

### F12. No trend signal

- **Seen:** nothing on the page shows volume over time or the mix by type. An org-level rollup exists elsewhere (`components/feedback/FeedbackRollupView.tsx`) but not here.
- **Why:** "thumbs-downs doubled since Tuesday" is the most useful thing this page could say, and today nobody would notice.
- **Change:** a compact summary strip above the table: open count, new in the last 24 h, thumbs-down share over 7 days versus the prior 7, and a 30-day sparkline by type. Each figure is a link that applies the matching filter.
- **Work:** one aggregate endpoint (backend) plus frontend.

### F13. Keyboard triage

- **Seen:** `/` focuses search; nothing else.
- **Change:** `j`/`k` move the selection, Enter opens the drawer, `x` selects, `c` closes with a resolution, `i` marks In progress, `e` emails the reporter. List them in the global shortcuts sheet.
- **Work:** frontend, after F3.

### F14. CSV export misses the fields support filters on

- **Seen:** columns are ID, Status, Username, Content, HelpArticle, Organization, UpdatedAt. No type, subject, created date, email or user id.
- **Change:** add Type, Subject, CreatedAt, UserEmail and UserId (and the F5, F7 and F10 fields when they land).
- **Work:** frontend only.

## Layout gaps #6833 did not cover

#6701 is closed by #6833, so these need a home. Listed separately in case you would rather reopen it or comment there.

- **L1. Low row density.** The Created column stacks absolute date, relative time and every tag, so a row is about three lines tall and roughly five rows fit at 1440 x 900. Show relative time with the absolute time in a tooltip, and drop internal tags (`bugReport`, `feedback`) from the row once the Type chip exists.
- **L2. Status falls off at 768 px.** The table scrolls inside its container as intended, but the Status column, the main action, sits past the visible edge. Pin Status (or the row menu) to the right edge, or move status into the drawer at narrow widths.
- **L3. Empty-comment rows.** The empty cell and the `"No content"` toast (F1) are the visible symptom.

## Decisions

- **D1. Comment-less thumbs.** Options: (a) keep them in the queue as New; (b) store them as Closed with resolution "No action needed" so they count in trends but not in the queue; (c) keep thumbs-ups out of the queue only. **Recommend (c) for thumbs-ups and keep comment-less thumbs-downs New:** a bare thumbs-down still flags a bad answer and the drawer's model context makes it actionable. Needs a look at prod volume before final sign-off.
- **D2. Status model.** Options: (a) keep New / In progress / Closed and add a required resolution on close; (b) add Won't fix and Duplicate as top-level states. **Recommend (a):** fewer states for the filter and badge, and the resolution carries the outcome.
- **D3. Assignee.** Options: (a) none, rely on `handledBy`; (b) an assignee field and an "Assigned to me" view. **Recommend (a) now:** support is a small team; revisit if more than two people triage daily.
- **D4. Replying from the page.** Options: (a) `mailto:` only; (b) in-app reply through the app's mailer, logged on the report. **Recommend (a) first, then (b)** once the status trail (F5) exists to log it against.
- **D5. Screenshots.** Options: (a) none; (b) optional screenshot in the report modal, stored with the same 90-day retention as the text. **Recommend (b), but as a separate later issue:** it touches uploads, storage cost and privacy review.
- **D6. Duplicate grouping.** Options: (a) "Similar reports" lookup only; (b) automatic clustering into themes. **Recommend (a) now;** (b) after trends (F12) show whether volume justifies it.
- **D7. Default view.** Today it is status New, newest first. Options: (a) keep; (b) New and In progress, newest first. **Recommend (a)** plus an "Open" preset chip (New + In progress), so the inbox stays the inbox and in-flight work is one click away.

## Order of work

**Quick wins (frontend only, one PR each or batched):**

1. F1 Type chip, empty-comment text, toast fix, Type filter.
2. F4 profile link on the reporter.
3. F14 CSV columns.
4. L1 and L2 density and narrow-width fixes.

**Larger features, in order:**

5. F2 stop waitlist writes and migrate existing rows (unblocks a meaningful badge).
6. F3 detail drawer (the base for F4 context, F7 notes, F8 reply, F11 similar reports, F13 keys).
7. F5 status trail, undo and audited delete.
8. F7 resolution and internal notes.
9. F6 bulk actions.
10. F9 date, has-comment and plan filters (with the F4 join).
11. F8 phase 1 email reporter; phase 2 after F5.
12. F12 trend strip.
13. F10 client context on every producer.
14. F11 similar reports.
15. F13 keyboard triage.

## Issue map

| Item | Issue |
|---|---|
| F1 | #7001 |
| L1, L2 | #7002 |
| F14 | #7003 |
| F2 (check prod volume first, D1) | #7004 |
| F3 | #7005 |
| F5 | #7006 |
| F7 | #7007 |
| F6 | #7008 |
| F4 (the profile link ships with the quick wins) | #7009 |
| F9 | #7010 |
| F8 phase 1 | #7011 |
| F12 | #7012 |
| F10 | #7013 |
| F11 phase 1 | #7014 |
| F13 | #7015 |
