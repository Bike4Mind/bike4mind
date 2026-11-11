# Admin design guide

One set of rules for every admin page: users, organizations, credits, API keys, security, settings and audit. If two admin pages solve the same problem differently, one of them is wrong.

This guide is the target. Pages that predate it are being moved onto it tab by tab (see [Rollout](#9-rollout)); new admin UI follows it from day one. Every value below is meant to be implementable as written: if a rule leaves you guessing, fix the rule in the same PR.

## 1. Principles

1. **Commands, not forms.** A change to a user, org or key is a named action (Adjust credits, Suspend, Revoke) that applies right away. Only real settings pages are forms with a save bar.
2. **Every write explains itself.** Each change records who, what, before and after, and why. Reasons are one click away through preset chips, with free text when needed.
3. **Show the result before it happens.** Show before and after values, a dry-run count for bulk actions, and the side effects in plain words. No bare "Are you sure?".
4. **Undo beats confirm.** Reversible actions skip the confirm step and offer Undo for 30 seconds. Confirmation is only for actions that cannot be reversed.
5. **Built for the bad day.** Bulk select, "select all matching", keyboard shortcuts and filters kept in the URL. An abuse incident should take minutes, not an afternoon of clicking.
6. **Calm density.** Show plenty of data without noise. Use neutral surfaces and keep color for status. Numbers are tabular and right-aligned.

## 2. Foundations

Defined once in `apps/client/app/utils/themes/admin.ts` and applied by the admin skin (`utils/themes/customizations/adminSkin.ts`). Every token has a light and a dark value, and both must pass `contrast.test.ts`. Where the prototype (the admin redesign canvas) and this guide disagree, this guide wins and the prototype gets fixed.

### Color

The admin is a **monochrome UI with one accent**. Ink and warm greys do the work; indigo marks focus, links and selection; status colors appear only inside status chips, banners and charts. If a screen reads as "colorful", something is wrong.

| Token           | Light                                  | Dark                              | Use                                                              |
| --------------- | -------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `canvas`        | `#F6F6F4`                              | `#141416`                         | Page and sidebar background                                      |
| `surface`       | `#FFFFFF`                              | `#1E1E22`                         | Cards, tables, dialogs, active nav item                          |
| `surfaceSubtle` | `#FAFAF8`                              | `#232328`                         | Table header, row hover                                          |
| `hover`         | `#ECECE8`                              | `#2A2A30`                         | Hover on nav items, ghost buttons, chips                         |
| `border`        | `#E4E4DF`                              | `#2E2E34`                         | Card, table and sidebar edges; row dividers                      |
| `borderStrong`  | `#D9D9D4`                              | `#45454D`                         | Outlines of buttons, inputs, selects                             |
| `ink`           | `#18181B`                              | `#FAFAFA`                         | Headings, body text, primary button fill                         |
| `inkSecondary`  | `#3F3F46`                              | `#D4D4D8`                         | Nav labels, secondary text                                       |
| `inkMuted`      | `#62626B`                              | `#B4B4BE`                         | Meta text, table headers, icons at rest                          |
| `accent`        | `#4F46E5`                              | `#A5B4FC`                         | Focus ring, checkbox, data bars                                  |
| `link`          | `#3F3BC9`                              | `#A5B4FC`                         | Text links                                                       |
| `selection`     | `#F3F2FE` / `#C7C4F7` / `#2B27A3`      | `#26244A` / `#4B47A8` / `#C7C4F7` | Selected row, set filter chip (fill / border / text)             |
| `danger`        | `#B42318`                              | `#FCA5A5`                         | Destructive actions only                                         |
| `chartSeries`   | 10 colors, see `utils/themes/admin.ts` | 10 colors                         | Categorical chart series beyond what `accent` steps can separate |

**Using tokens.** Reference a token by its palette path, never by its hex: `sx={{ color: 'admin.inkMuted', bgcolor: 'admin.surface', borderColor: 'admin.border' }}`, a status tone as `'admin.status.bad.foreground'`, and in a raw CSS string `var(--joy-palette-admin-ink)`. That is what makes dark mode free. No hex, `rgb()`, `rgba()`, named colors, gradients or `white`/`black` in admin code, and no pixel sizes outside the scales below; a translucent overlay or shadow belongs in the skin, not in a page.

**Dark mode.** A page that uses only tokens needs no dark-mode code; never branch on the mode to pick a color. Two things the tokens cannot fix:

- An image, diagram or third-party embed with a baked-in light background sits on a `surface` card with a 1 px `border`, so it reads as a figure rather than a bright hole. Prefer an asset or embed theme that follows `theme.palette.mode`.
- A chart library's default palette and backgrounds are light-only; see [Data visualization](#data-visualization).

**Mapping onto Joy.** Inside the admin, Joy's color props are remapped so existing code cannot leak off-palette color:

| Joy `color`                       | Becomes                                          | Notes                                                                                                                     |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `primary` (solid)                 | `ink` fill, `canvas`-on-ink text                 | Dark theme inverts: light fill, dark text                                                                                 |
| `primary` (plain, soft, outlined) | `ink` text, `borderStrong` outline, `hover` fill | Not blue                                                                                                                  |
| `neutral`                         | Same as `primary` plain/outlined                 |                                                                                                                           |
| `danger`                          | `danger`                                         | Outlined opens a destructive flow; solid only for the final confirm                                                       |
| `success`, `warning`              | The `good` and `warn` status tones               | Only on `Chip`, `Alert` and charts. On a `Button` or `IconButton` the skin renders them neutral, so don't pass them there |

Never use Joy's default blue, orange or yellow anywhere in the admin, and never color an icon by meaning alone (icons are `inkMuted` at rest, `ink` when active).

### Status tones

Five tones with one meaning each, used everywhere. They differ in lightness as well as hue, and every chip also has a text label.

| Tone    | Means                   | Examples                              | Light fg / bg         | Dark fg / bg          |
| ------- | ----------------------- | ------------------------------------- | --------------------- | --------------------- |
| good    | Healthy, allowed        | Active, Verified, Success             | `#166534` / `#E7F5EC` | `#BBF7D0` / `#14532D` |
| info    | New or neutral-notable  | New, Pro                              | `#3730A3` / `#E8EEFF` | `#C7D2FE` / `#312E81` |
| warn    | Needs a look            | Medium risk                           | `#8A4B00` / `#FFF1DE` | `#FED7AA` / `#7C2D12` |
| bad     | Blocked or failing      | Suspended, High risk, Blocked sign-in | `#9F1C12` / `#FDECEA` | `#FECACA` / `#7F1D1D` |
| neutral | Inactive, informational | Revoked, Free, Low risk               | `#52525B` / `#F1F1EE` | `#E4E4E7` / `#3F3F46` |

Status chips are `StatusChip`: 22 px soft pills (12 / 500) with an optional 6 px dot in the same color, never a solid or outlined colored chip. A count of zero, an empty value or "not set" is **neutral**, not bad: red means something is wrong, not that a number is small, and green means healthy, not that a number exists ("0" and "0%" stay `ink`).

A chip is for a status. Categories, tags, plans and difficulty levels are neutral chips or plain text, never a row of different colors.

Shared terms: **Suspended** (not "banned"), **Restricted** (not "moderated"), **Revoked**, **Deleted**.

### Data visualization

Charts read every color from the admin tokens (no hex in a chart config, and never a library's default palette such as `['#0088FE', '#00C49F', ...]`), so they work in both themes. They use `accent` for the primary series and `inkMuted` at 40% for comparisons; categorical charts take the status tones only when the categories are statuses, and otherwise step `accent` down in opacity (`adminChartSeries`). Past about six series the steps blur together, so a chart with more categories takes the `chartSeries` slots in a fixed order instead. Chart backgrounds are transparent. Inline bars (spend, risk, storage) are 6 px tall with a 3 px radius on a `selection` fill track. Gridlines use `border`; axis labels use `inkMuted` 12 px.

### Type (Inter, IDs in JetBrains Mono)

| Role                                  | Size / weight      | Color                                | Joy level                            |
| ------------------------------------- | ------------------ | ------------------------------------ | ------------------------------------ |
| Page title                            | 24 / 600, -0.01em  | `ink`                                | `h1`, via `AdminPageHeader`          |
| Dialog title                          | 18 / 600           | `ink`                                | `DialogTitle`                        |
| Section and card title                | 15 / 600           | `ink`                                | `h2` to `h4`, `title-lg`, `title-md` |
| Body, table cell                      | 14 / 400           | `ink`                                | `body-md`                            |
| Nav item, button                      | 13 to 14 / 500     | `inkSecondary` (nav), `ink` (button) |                                      |
| Meta, table header, nav section label | 12 / 500           | `inkMuted`                           | `body-xs`                            |
| IDs, key prefixes, shortcut hints     | mono 12 (hints 11) | `inkMuted`                           |                                      |

There are only these seven levels. The skin maps every heading below `h1` to the section title, so a page title written as `h2` or `h3` silently renders at 15 px. No `fontSize` override on text. Headings are sentence case, never larger than the page title, never colored, carry no decorative icon or emoji, and are never followed by a help icon larger than 16 px.

### Space and shape

4 px grid; one Joy spacing unit is 8 px.

| Where                                                       | Value                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| Page gutter                                                 | 32 px sides, 16 on phones; see [Page frame](#page-frame)        |
| Between page regions                                        | 24 px (`ADMIN_REGION_GAP`)                                      |
| Between cards in a region or grid                           | 16 px                                                           |
| Between toolbar items, inside controls                      | 8 px                                                            |
| Card padding (`SectionCard`, `SettingsSection`, Joy `Card`) | 16 px; a card title bar is at least 50 px tall with 16 px sides |
| Stat tile padding                                           | 16 px sides, 14 px top and bottom                               |
| Dialog padding                                              | 24 px                                                           |
| Empty, error and loading blocks                             | 24 px                                                           |

- Radius: 6 small controls, 8 buttons and inputs, 12 cards (`SectionCard`, `SettingsSection`, `StatStrip` and the `DataTable` surface alike), 16 dialogs.
- Targets: at least 36 px on desktop, 44 px on touch.
- Content never sits deeper than the gutter: every region's left edge lines up with the page title. A wrapper that pads a whole page section is double padding.

## 3. Page anatomy

Every admin page renders inside the shared admin layout (`AdminLayout.tsx`: sidebar navigation plus content frame); there are no full-screen admin pages. New admin routes are children of the `/admin` layout route, never siblings of it.

### Sidebar

The sidebar is the frame of every admin page, so it sets the tone. Calm, scannable and never louder than the content. Sections and items live in `adminSidebarConfig.tsx`.

- **Size and surface.** 248 px wide on desktop, `canvas` background, 1 px `border` on its right edge, padding 20 px top and 14 px sides. No shadow, no colored background.
- **Brand row.** 28 px ink tile with the product mark, "Admin" in 14 / 600, a neutral environment chip (Local, Staging, Preview; hidden on production), and a `Cmd K` key hint pushed to the right that opens the command palette on click (the collapsed rail shows a Command button instead). 18 px below it before the first item.
- **Search.** A 32 px filter input under the brand row ("Filter pages", `/` to focus). Typing narrows items across all sections and hides empty sections.
- **Sections.** A small number of groups (Overview, People, Money, Trust and safety, AI, Platform, Settings) with a 12 / 500 `inkMuted` label in sentence case, 20 px above each label. Labels are static text, not accordions; there are no section icons, no section colors and no dividers between sections.
- **Items.** 36 px tall, 8 px radius, 10 px horizontal padding, 16 px stroke icon (2 px stroke, `inkMuted`) then the label in 14 / 500 `inkSecondary`. One line only: labels are short ("Credits", not "Credit Analytics"), sentence case, and truncate with a tooltip rather than wrap. An item and its page title name the same thing. Hover: `hover` fill and `ink` text.
- **Active item.** `surface` fill, `ink` text and icon, and a 1 px `border` ring. Exactly one active item; on a detail page the item of its list is active (Users on a user profile).
- **Badges.** A page whose items wait for an admin to act (pending, held, flagged, unreviewed or failed, with an approve, release, resolve, replay or dismiss action on the page) shows how many on its sidebar item; nothing else gets one. A log, a dashboard, a config editor or a population that is never meant to reach zero is not a queue. One look for every badge: a 20 px neutral pill (`admin.status.neutral` background and foreground, 11 / 600, tabular figures), never a status color, since a waiting queue is work, not an alarm. It hides at zero, and also when the count is unknown (failed, or the admin may not act on that queue). Counts stop at 100 and read "99+". The one other marker is the Subscriptions dot (new since your last visit, not work waiting): an 8 px dot in the same neutral tone. On the collapsed rail a section holding work shows a 6 px neutral dot on its icon; its menu shows the counts. Every count comes from the one batched `GET /api/admin/action-counts` request (`server/admin/actionCounts.ts`): a new queue adds a key to `adminActionCounts.ts`, a capped `countDocuments` on an indexed filter (new index, new `ensure-*` migration), gated by the permission that acts on the queue, and a `badge` on its item in `adminSidebarConfig.tsx`. Badges refresh on the 60 s poll and whenever the admin switches sidebar items; to drop a badge the moment its action lands, invalidate `adminActionCountsQueryKey` after that action (the audit, waitlist and feedback queues do).
- **Long lists.** A section with more than 7 items shows the 5 most used and a "More" row that expands in place. An item with work waiting stays in view under the visible ones, like the active item, so its badge is never hidden behind "More". The sidebar scrolls on its own, and every admin scroll area uses a thin overlay scrollbar that shows on hover or focus; the brand row and search stay pinned.
- **Footer.** Pinned at the bottom: the signed-in admin (24 px avatar, name, role in `inkMuted`: "Admin", or "Delegated admin" for a user with `adminPermissions` and no `isAdmin`) and a collapse button.
- **Delegated admins.** A delegate sees only the tabs `DELEGATED_ADMIN_TAB_PERMISSIONS` (`adminTabPermissions.ts`) maps to a permission they hold; the sidebar, the command palette and `?tab=` links all hide the rest, and a section left with none is omitted. Map a tab there only once every request it makes accepts that permission server-side, so a delegate never lands on a pane that answers 403; a list (`SETTINGS_PAGE_READ`) admits any one of its permissions and must match the GET declaration of the tab's routes. A write the tab offers but the delegate cannot make is wrapped in `AdminPermissionAction`. A detail page follows its list's tab and, when denied, shows `MissingPermissionState` in place of the page; a delegate whose permissions open no tab is not admitted.
- **App-wide chrome.** Anything that renders under the admin root but belongs to the whole app (the floating AI chat, the help panel) spreads `adminSurfaceExcludeProps` on its root so the admin skin stops there.
- **Collapsed and mobile.** Collapsed is a 64 px icon rail with tooltips, remembered per admin. Under 900 px (Joy `md`) the sidebar becomes a 280 px drawer opened from a menu button in a top bar.

### Page frame

The shell owns the frame, so every page lines up with every other page:

- **Gutter.** `adminPageFrame` (`shared/adminStyles.ts`): 32 px left and right (16 on phones), 24 px above the page header (16 on phones), 64 px below the last region, which is what keeps the bottom-right AI chat pill (20 px in, 40 px tall) off the table pager. `AdminPage` applies it to every tab panel; a detail route outside `AdminPage` spreads it on its root. A page **never sets its own outer padding** (`p`, `px`, `py` on its root), never wraps itself in a scrolling `Sheet`, and never sets `minHeight: 100vh`: the layout already fills the window and scrolls.
- **Width.** List pages and dashboards are full width. Detail and settings pages cap their content at `ADMIN_DETAIL_MAX_WIDTH` (1280 px), left-aligned so the page header stays on the same line as every other page. No other max width and no centered column (`mx: 'auto'`); a short form stays left-aligned and simply ends early.
- **Rhythm.** The page root is a `Stack` with `gap: ADMIN_REGION_GAP` (24 px) between regions (header, banner, views, filters, table, section grid). Cards inside a region sit 16 px apart. No `Divider` between regions: the gap is the separator.
- **Header first.** The first element of every page is `AdminPageHeader`: the page title (24 / 600, `h1`), an optional count, a one-line description in `inkMuted`, and the page actions top-right. Nothing sits above it: not tabs, not chips, not a banner, not a toolbar. The command palette's keyboard strip (`AdminCommandPalette`) stays out of the flow until it takes focus, and pointer users open the palette from the sidebar. The title names the page in sentence case ("Rate limits", not "Rate Limits Dashboard"), has no icon, and is the only `h1` on the page; sections inside the page use the 15 / 600 section level. A count goes in the header's `count`, not in a chip beside the title.
- **Horizontal overflow.** The page itself never scrolls sideways. A wide table scrolls inside its own container (`DataTable` does this), and a dialog never sets a fixed `width` or a `minWidth` wider than a phone; Joy already caps its width at the viewport.

### Page skeletons

Inside that frame, every page uses one of three skeletons, so admins always know where to look.

**List page**

1. `AdminPageHeader`: title, count, page actions (one primary button).
2. Anomaly banner: only when something is wrong (signup spike, key-creation spike). Use `shared/AnomalyBanner`; a list wraps it with its own headline, as `Users/AnomalyBanner.tsx` does.
3. `ViewTabs` or `SavedViews`.
4. `FilterBar`: search, filter chips, Group by.
5. `DataTable`: selection, sortable columns, row opens the detail page.
6. `BulkActionBar`: floats at the bottom while rows are selected.

A dashboard is a list page whose body is a `StatStrip` and chart cards in a 2-column grid instead of a table.

**Detail page**

1. Breadcrumb and shortcut hints.
2. `EntityHeader`: identity, status chips, up to two actions and a More menu.
3. `StatStrip`: 3 to 5 numbers that answer "is this normal?".
4. Tabs, kept in the URL as `?tab=`.
5. `SectionCard`s in a 2-column grid that drops to 1 column below 900 px.
6. An **Admin log** tab: every change ever made to this record.

**Settings page**

1. `AdminPageHeader`.
2. One `SettingsSection` per group of related fields, 16 px apart (with a section nav beside them when there are many groups).
3. One `SaveBar` for the whole page, plus `UnsavedChangesGuard`.

### Narrow screens

Check every page at 1440, 768 and 375 px wide, in both themes. At every width:

- **Tables** keep their columns and scroll sideways inside the `DataTable` container (`minWidth`, default 40rem). Columns never crush, headers never truncate to "Do..", and an ID never wraps over several lines: it truncates, with a copy button.
- **Stat strips** wrap whole tiles onto a new row, and a short last row stretches to the full width (`StatStrip` does this). Never a grid that leaves an empty cell beside an orphaned tile.
- **Tab strips** stay on one line and scroll sideways inside their own container. A tab label never wraps or drops to a second line, and tabs carry no icons.
- **Toolbars and filter bars** wrap as a whole onto extra lines, search first and at least 240 px wide. A control never shrinks to an icon, clips its label or overlaps its neighbour.
- **Header actions** drop below the title and wrap (`AdminPageHeader` does this).
- **Grids** of section cards become one column below 900 px; grids of many small cards use `repeat(auto-fill, minmax(280px, 1fr))`, not a fixed column count.
- **Fixed overlays** (the AI chat pill, `BulkActionBar`) never cover the last row or the pager; the frame's bottom padding leaves room for them.

## 4. Interaction model

Every write in the admin falls into exactly one row. If an action does not fit, raise it in design review before building it.

| Kind of action          | Pattern                                             | Reason       | Recovery                                | Examples                                                 |
| ----------------------- | --------------------------------------------------- | ------------ | --------------------------------------- | -------------------------------------------------------- |
| Reversible, low-risk    | Applies immediately                                 | Not required | Undo toast (30 s)                       | Add a tag, add a note, revoke a single key               |
| Changes money or access | `ActionDialog` with preview                         | Required     | Undo toast and Admin log entry          | Adjust credits, change role, grant subscription, suspend |
| Bulk                    | `BulkActionBar`, then `ActionDialog` with a dry run | Required     | Undo toast for the whole batch          | Contain, bulk suspend, bulk revoke keys                  |
| Irreversible            | `ActionDialog` with type-the-name confirm           | Required     | None, and the dialog says so            | Delete user, data erasure                                |
| Settings forms          | Edit in place with a sticky `SaveBar`               | Optional     | Discard and a leave-page guard          | Admin settings, org settings, model config               |
| Impersonation           | `ActionDialog` with step-up MFA                     | Required     | Time-boxed session and a visible banner | Log in as user                                           |

Do and don't:

- **Do** place the button that commits a change at the bottom-right of the dialog or bar that holds its inputs.
- **Don't** put a page-wide Update button in the header, far from the fields it saves, that only appears after an edit.
- **Don't** give each field its own Save icon, Save link or Save button, or put a "Save settings" button inside a card. A page of settings has one `SaveBar`; a single command is an `ActionDialog`.
- **Do** explain a disabled button in place, e.g. "Pick a reason or write at least 5 characters."
- **Don't** grey out a button with no hint, or mix staged and instant saves on the same page.
- **Do** allow every value the server allows. If the server accepts a balance of 0, the UI does too.

## 5. Components

Build new admin pages from these, imported from `apps/client/app/components/admin/shared` (`index.ts`). A new admin pattern starts as a proposal to add to this list, not as a one-off component.

### Buttons

- At most **one primary** button per view. A row of several solid buttons is wrong: make them secondary, or move them into a menu.
- **Outlined danger** opens a destructive flow; **solid danger** is only the final confirm inside a dialog.
- Labels start with a verb and name the object: "Suspend account", never "Submit" or "OK".
- The commit button repeats the consequence where it helps: "Set balance to 0".
- Sizes: 36 px (default), 32 px (toolbars, filter bars), 28 px (inside table rows). Radius 8, label 13 / 500, 16 px icon with a 6 px gap.
- Variants: **primary** is an `ink` fill; **secondary** is a `surface` fill with a `borderStrong` outline; **ghost** has no outline and a `hover` fill. No other colors, and no `color="success"` or `"warning"`.

### Tables

- One table is one surface: a single card with a `surfaceSubtle` 38 px header row and 56 px body rows separated by 1 px `border` lines. Rows are never separate cards with gaps between them, and the header and body are never two cards. A list of records is a `DataTable` even when it has two columns.
- The whole row opens the detail page. Row actions are ghost icon buttons (`rowActions`) or one "..." menu that appear on hover and focus, never a pair of buttons in every row ("Edit" and "Members").
- A destructive row action is never a red button or red icon in every row. It lives in the row's "..." menu or in the `BulkActionBar`, and opens an `ActionDialog`.
- Numbers are right-aligned and tabular; IDs are mono with a copy button that appears on hover; empty values render as an `inkMuted` dash.
- Pagination lives once, in the table footer: "1 to 25 of 1,204" on the left, a page-size select (25, 50, 100) and arrows on the right. Never a radio group of page sizes, and never a second pager above the table.
- `DataTable` renders its own skeleton, empty and error states in place of the rows (`loading`, `empty`, `error` plus `onRetry`); see [States](#states).

### Cards

- A card is one `surface` with a 1 px `border`, 12 px radius, 16 px padding and no shadow. Group facts in a `SectionCard` and form fields in a `SettingsSection`.
- **No card in a card.** Inside a card, separate groups with a 15 / 600 subheading, a `border` hairline or 16 px of space, never another bordered or grey box. The only surfaces allowed inside a card are a `DataTable`, a chart, a code block and an `Alert`.
- No tinted backgrounds or colored borders on a card to signal state; put a `StatusChip` or an `Alert` in it instead.
- Key numbers go in one `StatStrip`, not in separate tiles. A stat value is `ink` (`valueColor` only when the value is itself a status, such as a risk level); tiles are never solid green, orange or pastel, and carry no decorative icon.

### Toolkit

| Component                                                    | Job                                                 | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminPageHeader`                                            | Title, count or meta, page actions                  | The page `h1`. Actions sit top-right and wrap below the title on small screens. A sub-view rendered under a page that already has a header passes `level="section"` and gets a section-title `h2`.                                                                                                                                                                                                                                                                                  |
| `EntityHeader`                                               | Identity of a user, org or key                      | IDs and emails have a copy button. Times are relative, with the exact UTC time on hover.                                                                                                                                                                                                                                                                                                                                                                                            |
| `StatStrip` / `StatTile`                                     | 3 to 5 key numbers                                  | One card, tiles divided by hairlines. Label, value, comparison line. Optional `StatSparkline`, and an optional `help` control beside the label that defines the term (16 px icon). No decorative icons.                                                                                                                                                                                                                                                                             |
| `StatusChip`                                                 | A status                                            | One of the five tones, always with a text label.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SectionCard` / `Fact`                                       | A group of facts                                    | Title, optional ghost action, a definition list of `Fact`s (`body="custom"` for a table or chart). No form inputs inside.                                                                                                                                                                                                                                                                                                                                                           |
| `SettingsSection`                                            | A group of settings fields                          | A plain card for a form; the page saves through `SaveBar`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DataTable`                                                  | Every admin list                                    | Sticky header, sortable columns, row selection, row actions, sideways scroll below `minWidth`, skeleton, empty and error states. Page sizes 25, 50, 100. Server paging is described in `shared/README.md`.                                                                                                                                                                                                                                                                          |
| `FilterBar` / `AdminSearchInput`                             | Narrowing a list                                    | Every filter is kept in the URL (`useAdminListUrlState`). The Feedback and Email verification lists still keep their filters and page in local state; that is a known gap to move over later. Search first, then `FilterChip`s, 8 px apart on one line that wraps as a whole. No stacks of labelled selects, no native date inputs, no Apply button: a filter applies when picked. `AdminSearchInput` alone still goes in a row Stack; in a column it stretches to fill the height. |
| `FilterChip`                                                 | One filter in a `FilterBar`                         | Dashed with just the label while unset; "Label: Value" in the `selection` tint with a remove button once set. Picking a value opens a menu.                                                                                                                                                                                                                                                                                                                                         |
| `ViewTabs` / `SavedViews`                                    | Built-in and saved views above a list               | The active tab is ink-filled. Each tab may carry a count. A view is its filters, so matching filters light its tab (`matchSavedView`).                                                                                                                                                                                                                                                                                                                                              |
| `SegmentedControl`                                           | 2 to 4 mutually exclusive modes                     | Toggle buttons on a `hover` track, e.g. Group by None / Email domain. Not for filters with many values.                                                                                                                                                                                                                                                                                                                                                                             |
| `ToggleChipGroup`                                            | A small multi-select filter                         | On the `SegmentedControl` track; "All" when nothing is narrowed, never an empty set.                                                                                                                                                                                                                                                                                                                                                                                                |
| `InitialsAvatar`                                             | The person in a table row                           | The photo when there is one, else initials on a tone that stays stable per user.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `InlineBar`                                                  | A number's share of the largest in view             | Decorative only: the number itself stays in the cell.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BulkActionBar`                                              | Acting on a selection                               | Floats at the bottom. Offers "Select all N matching". Most destructive action last.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ActionDialog`                                               | Any audited write                                   | Verb-phrase title, before/after preview or dry run, then a reason. Commit button bottom-right.                                                                                                                                                                                                                                                                                                                                                                                      |
| `ChangePreview`                                              | The before/after inside an `ActionDialog`           | Old value, new value and the signed delta.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AdminDialog`                                                | An unaudited dialog, such as naming a saved view    | The modal shell `ActionDialog` is built on: title, close button, focus trap. No reason field.                                                                                                                                                                                                                                                                                                                                                                                       |
| `ReasonPicker`                                               | Audit reasons                                       | Preset chips per action type (`ADMIN_REASON_PRESETS`) plus free text (5 to 500 characters, the shared `adminActionReason` rule).                                                                                                                                                                                                                                                                                                                                                    |
| `UndoToast`                                                  | Recovery                                            | `useUndoToast()`. Bottom-center, 30 seconds, Undo plus a link to the audit entry. One at a time.                                                                                                                                                                                                                                                                                                                                                                                    |
| `SaveBar` / `UnsavedChangesGuard`                            | Settings forms only                                 | Sticky bottom bar: "3 unsaved changes", Discard, Save (Cmd+S); the guard catches navigation and unload.                                                                                                                                                                                                                                                                                                                                                                             |
| `EmptyState` / `ErrorState` / `LoadingState` / `UpdatingBar` | Nothing to show, a failure, a first load, a refetch | See [States](#states).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `UserSelector`                                               | Picking a user in a form or filter                  | Search-as-you-type over users.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Kbd`                                                        | A shortcut hint                                     | Mono 11 on a key cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 6. Writing

- Sentence case, verb first: "Revoke API keys", not "API Key Revocation". This covers page titles, sidebar items, tabs, section titles and buttons.
- State the consequence: "Requests using them start failing immediately.", not "This action may have side effects."
- Numbers people can scan: thousands separator, tabular figures, signed deltas (+2,000, -412), unit named once in the column header.
- Errors say what to do: "Reason must be at least 5 characters", not "Invalid input".
- A page description is one line. Longer guidance goes behind a 16 px help control or in the docs, not in a paragraph above the table.
- No emoji in admin UI text.

### Money

Every money value goes through `formatMoney` in `shared/formatMoney.ts`, so these rules live in one function.

- Amounts are stored and sent in minor units with Stripe's lowercase currency code. `formatMoney(minorUnits, currency)` displays them with `Intl.NumberFormat('en-US', { style: 'currency', currency })`, using Stripe's minor-unit exponent for the currency (2 by default; 0 for JPY and the other zero-decimal currencies; 3 for KWD, BHD, JOD, OMR, TND), not the digits Intl would show: "$1,234.56", and "CA$19.00" for another currency.
- Only a `StatTile` value goes compact (`{ compact: true }`): "$12.3K" from 10,000 major units up, with no trailing zero on round values ("$10K").
- Table cells are right-aligned and tabular (a `numeric` column), with the currency named once in the column header: "MRR (USD)".
- Negative money is "-$12.00" (refunds), never in parentheses.
- Credits are integers with a thousands separator and never carry a currency symbol. A credits value next to a money value is labeled "credits".
- A value that is not revenue (a comp) or not known yet is an `inkMuted` dash, never "$0.00" and never a list price read from the plan catalog. A row that should have an amount but Stripe sends none shows a neutral "No amount" chip instead, so it differs from a row that is not counted.

## 7. Accessibility, keyboard and states

Definition of done for any admin UI:

- Text contrast at least 4.5:1, muted meta text included, in light and dark themes.
- Every control is a real button, link or input reachable with Tab.
- Focus is always visible: one 2 px accent ring per control. A field (input, textarea, select, autocomplete) draws it on its rounded root; the native control inside never adds an outline of its own.
- Dialogs trap focus, close on Esc and return focus to the button that opened them.
- Icon-only buttons have an `aria-label`. Status is never shown by color alone.
- Every state in the table below is handled; none leaves an area blank.
- The page works at 768 and 375 px wide (see [Narrow screens](#narrow-screens)).
- Interactive elements carry a `data-testid` (`component-action-element`), per the repo testing guidelines.

### States

| State                                     | Use                                                                                             | Rules                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First load of a table or cards            | `DataTable` `loading`, or Joy `Skeleton` shaped like the cards                                  | The header, filters and table frame stay in place; only the body is a placeholder.                                                                                                                                                                                                                                                                                             |
| First load of an area with no known shape | `LoadingState`                                                                                  | A small spinner with a label ("Loading models"), inside that area. Never a bare `CircularProgress`, a bare "Loading..." line, or a spinner centered on a blank page.                                                                                                                                                                                                           |
| Refetch with data on screen               | `UpdatingBar`                                                                                   | The data stays visible; the bar keeps its height so nothing shifts. It sits inside the region it refreshes (the top of the table or chart region), never as its own region in the page stack, because the reserved 20 px would add two region gaps. Where the region has no room for it, `placement="overlay"` floats it in the gap above the region without reserving height. |
| Nothing exists yet                        | `EmptyState`                                                                                    | A title that says what is missing, an optional one-line description, and an `action` (required): the next step as a button ("Create rule"). It sits where the data would, never as a separate grey strip, dashed card or warning banner.                                                                                                                                       |
| Filters match nothing                     | `EmptyState`                                                                                    | "No users match these filters", with a "Clear filters" action.                                                                                                                                                                                                                                                                                                                 |
| Request failed                            | `ErrorState`                                                                                    | The message in plain words and "Try again" (`onRetry`). Never an empty table with a toast as the only signal.                                                                                                                                                                                                                                                                  |
| No permission                             | `MissingPermissionState` / `AdminPermissionGate` (an area), `AdminPermissionAction` (a control) | "Missing permission: X", from the same `missingAdminPermissionMessage` the server answers with. An action stays visible, disabled, with the message on hover and focus; never hide it silently or let it answer 403.                                                                                                                                                           |

Shortcuts:

| Key       | Action                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| Cmd+K     | Command palette (`AdminCommandPalette`): find any user, org or key, or run any action |
| `/`       | Focus search                                                                          |
| `x`       | Select the focused row                                                                |
| `a` / `o` | Accept / override the focused row's AI suggestion (tables that offer one)             |
| `c`       | Adjust credits (user profile)                                                         |
| `s`       | Suspend (user profile)                                                                |
| Cmd+S     | Save (settings forms)                                                                 |

## 8. Admin assistant eval

A new admin tab or admin tool adds at least one question to `b4m-core/services/src/llm/evals/adminAssistant/cases.ts`, so the admin assistant is measured on it. See that directory's README for the "Adding its question" step.

## 9. Rollout

1. **Tokens and toolkit.** Done: admin tokens in the Joy theme, the admin skin, and the components above in `components/admin/shared` with tests.
2. **Users first.** Done: the users list and user profile run on the toolkit and are the reference implementation.
3. **Shared frame.** Done: `AdminPage` gives every tab panel `adminPageFrame`, and `AdminPageHeader` renders the 24 px `h1`. Tabs that still pad themselves are marked `selfFramed` in `AdminPage.tsx`; a tab leaves that list in the PR that drops its own outer padding, and no tab joins it.
4. **Every other admin tab.** In progress, one PR per tab: page header, frame, toolkit table, states and the narrow-screen check.
5. **Lock it in.** The lint guard below, and the admin design-guide checkbox in the PR template.

### Lint guard

`b4m/no-raw-admin-joy` (`eslint-rules/no-raw-admin-joy.mjs`) rejects raw Joy `Card`, `Modal` and `Table` imports (including aliases and component subpaths) outside the root `admin/shared/` toolkit. Namespace imports and re-exports cannot bypass it. Use `SectionCard` or `SettingsSection`, `ActionDialog` (or `AdminDialog` for an unaudited dialog) and `DataTable` instead.

An exceptional import needs an immediately preceding comment: `// admin-toolkit-allow YYYY-MM-DD -- concrete reason the toolkit cannot serve this use case`. Keep exceptions local to one import; do not disable the rule for a file or directory.

Pre-toolkit imports are recorded in `eslint-rules/admin-joy-legacy.mjs` (file, component, date, justification), each pinned to its line and a SHA-256 text fingerprint in `eslint-rules/admin-joy-legacy-imports.mjs`, so an allowance cannot pass to another import. New imports fail even in legacy files, and a changed, moved or removed import raises a stale-exception error until it is re-justified or its entry deleted. Remove entries when migrating; never add new screens.

## 10. AI suggestions

An AI proposal is shown with `AiSuggestion` (`shared/AiSuggestion.tsx`), beside the admin's own control and never in its place. The admin decides; the AI only proposes. Reference host: Shadow detections (`ShadowDetectionsTab.tsx`, `ShadowDetectionAssessmentPanel.tsx`).

- **Two variants.** `row` is a neutral `StatusChip` for a table cell: the AI mark, the proposal and a confidence word, with the percentage, an optional `note` (which record it is about) and the `A`/`O` hint in its tooltip. `detail` is for a record or dialog: proposal, confidence word (percentage on hover), up to three reasons (each a link when its evidence is an in-app path; any other href renders as plain text), model and age, then the actions.
- **Neutral tone, always.** A suggestion is advisory, so it never uses `bad` or `good`, even when it proposes abuse. The verdict chip beside it keeps the real state.
- **Confidence is a word.** High (>= 80%), Medium (>= 50%), Low (below). The raw percentage is secondary and lives in a tooltip. No probability, no word.
- **No suggestion, no slot.** Pass `suggestion={null}` when AI is off, over budget, failed or forbidden (a 403): the component renders nothing. No empty box, no error banner, no "AI unavailable".
- **Accept goes through the host's own write.** `onAccept` opens the host's `ActionDialog` prefilled: the proposed value and `ACCEPTED_AI_REASON` ("Accepted AI suggestion") via `initialReason`, still editable. Bump `formKey` to re-seed an already open dialog. The admin still confirms, so nothing is applied on a click.
- **Override opens the manual control.** `onOverride` follows an optional "Why was the AI wrong?" pick (`AI_OVERRIDE_REASONS`) and receives it; the host opens its control with nothing preselected. A row's `O` key reaches the same picker: the host opens its record with `initialOverriding` on the detail suggestion. Shadow detections does not record the pick yet (see Recording decisions).
- **Dismiss** hides the suggestion locally. **Done by AI** (`status: 'auto_applied'`) shows a chip and, with `onUndo`, an Undo.
- **Keys.** Give `DataTable` `rowShortcuts` returning `a`/`o` only for rows with a suggestion and only when the admin holds the permission the host's write needs; otherwise return `{}` so the keys stay inert.
- **Row coverage follows the host's data.** Shadow detections' row chip reads the per-user AI advisory, which keeps each open account's strongest abuse judgment from the last 24 hours, so an unreviewed detection can carry an assessment without a row chip or `A`/`O`. Its review dialog still shows the latest assessment.
- **Bulk.** `AiSuggestionBulkAccept` accepts only pending High suggestions, behind an `ActionDialog` with a `ChangePreview`. It takes `reversible: true` as a literal, so an irreversible action cannot use it.

### Recording decisions

`onDecision` fires from the component only for Dismiss, and for Undo once `onUndo` resolves (a rejected revert is not reported). Accept and override are the host's to report: call `onDecision` with `accepted` or `overridden` after the host's own write lands, not when the button is clicked, because the admin can still cancel the dialog. Decisions are not stored yet; until the shared suggestion store exists, `onDecision` is a typed seam with no persistence behind it, and a dismissed suggestion returns on reload. Shadow detections does not wire `onDecision` yet.

### Copy

- Name the proposal as the value the admin would record ("Confirmed abuse"), not as a judgment of the person.
- Reasons name the evidence ("Burst of signups from one network"), never the model process ("The model analyzed the signups").
- Say "AI suggestion" or "AI advisory", never "AI verdict" or "AI decided".
- Pair any AI statement that could prompt action with its limit: "Advisory only" or "review before acting".
- The prefilled reason is exactly "Accepted AI suggestion"; admins add to it rather than replace it.
- Use the confidence words above; do not invent others ("Very likely", "Certain").
