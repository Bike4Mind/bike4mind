# Admin design guide

One set of rules for every admin page: users, organizations, credits, API keys, security, settings and audit. If two admin pages solve the same problem differently, one of them is wrong.

This guide is the target. Pages that predate it are being moved onto it tab by tab (see [Rollout](#8-rollout)); new admin UI follows it from day one.

## 1. Principles

1. **Commands, not forms.** A change to a user, org or key is a named action (Adjust credits, Suspend, Revoke) that applies right away. Only real settings pages are forms with a save bar.
2. **Every write explains itself.** Each change records who, what, before and after, and why. Reasons are one click away through preset chips, with free text when needed.
3. **Show the result before it happens.** Show before and after values, a dry-run count for bulk actions, and the side effects in plain words. No bare "Are you sure?".
4. **Undo beats confirm.** Reversible actions skip the confirm step and offer Undo for 30 seconds. Confirmation is only for actions that cannot be reversed.
5. **Built for the bad day.** Bulk select, "select all matching", keyboard shortcuts and filters kept in the URL. An abuse incident should take minutes, not an afternoon of clicking.
6. **Calm density.** Show plenty of data without noise. Use neutral surfaces and keep color for status. Numbers are tabular and right-aligned.

## 2. Foundations

Defined once in `apps/client/app/utils/themes/admin.ts` and applied by the admin skin. Never hard-code a hex value or pixel size in an admin component. Every token has a light and a dark value, and both must pass `contrast.test.ts`. The prototype (the admin redesign canvas) is the visual reference; where it and this table disagree, this table wins and the prototype gets fixed.

### Color

The admin is a **monochrome UI with one accent**. Ink and warm greys do the work; indigo marks focus, links and selection; status colors appear only inside status chips, banners and charts. If a screen reads as "colorful", something is wrong.

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F6F6F4` | `#141416` | Page and sidebar background |
| `surface` | `#FFFFFF` | `#1E1E22` | Cards, tables, dialogs, active nav item |
| `surfaceSubtle` | `#FAFAF8` | `#232328` | Table header, row hover |
| `hover` | `#ECECE8` | `#2A2A30` | Hover on nav items, ghost buttons, chips |
| `border` | `#E4E4DF` | `#2E2E34` | Card, table and sidebar edges; row dividers |
| `borderStrong` | `#D9D9D4` | `#45454D` | Outlines of buttons, inputs, selects |
| `ink` | `#18181B` | `#FAFAFA` | Headings, body text, primary button fill |
| `inkSecondary` | `#3F3F46` | `#D4D4D8` | Nav labels, secondary text |
| `inkMuted` | `#62626B` | `#B4B4BE` | Meta text, table headers, icons at rest |
| `accent` | `#4F46E5` | `#A5B4FC` | Focus ring, checkbox, data bars |
| `link` | `#3F3BC9` | `#A5B4FC` | Text links |
| `selection` | `#F3F2FE` / `#C7C4F7` / `#2B27A3` | `#26244A` / `#4B47A8` / `#C7C4F7` | Selected row, set filter chip (fill / border / text) |
| `danger` | `#B42318` | `#FCA5A5` | Destructive actions only |

**Mapping onto Joy.** Inside the admin, Joy's color props are remapped so existing code cannot leak off-palette color:

| Joy `color` | Becomes | Notes |
|---|---|---|
| `primary` (solid) | `ink` fill, `canvas`-on-ink text | Dark theme inverts: light fill, dark text |
| `primary` (plain, soft, outlined) | `ink` text, `borderStrong` outline, `hover` fill | Not blue |
| `neutral` | Same as `primary` plain/outlined | |
| `danger` | `danger` | Outlined opens a destructive flow; solid only for the final confirm |
| `success`, `warning` | The `good` and `warn` status tones | Only valid on `Chip`, `Alert` and charts; never on a `Button` |

Never use Joy's default blue, orange or yellow anywhere in the admin, and never color an icon by meaning alone (icons are `inkMuted` at rest, `ink` when active).

### Status tones

Five tones with one meaning each, used everywhere. They differ in lightness as well as hue, and every chip also has a text label.

| Tone | Means | Examples | Light fg / bg | Dark fg / bg |
|---|---|---|---|---|
| good | Healthy, allowed | Active, Verified, Success | `#166534` / `#E7F5EC` | `#BBF7D0` / `#14532D` |
| info | New or neutral-notable | New, Pro | `#3730A3` / `#E8EEFF` | `#C7D2FE` / `#312E81` |
| warn | Needs a look | Medium risk | `#8A4B00` / `#FFF1DE` | `#FED7AA` / `#7C2D12` |
| bad | Blocked or failing | Suspended, High risk, Blocked sign-in | `#9F1C12` / `#FDECEA` | `#FECACA` / `#7F1D1D` |
| neutral | Inactive, informational | Revoked, Free, Low risk | `#52525B` / `#F1F1EE` | `#E4E4E7` / `#3F3F46` |

Status chips are 22 px pills (12 / 500) with an optional 6 px dot in the same color. A count of zero, an empty value or "not set" is **neutral**, not bad: red means something is wrong, not that a number is small.

Shared terms: **Suspended** (not "banned"), **Restricted** (not "moderated"), **Revoked**, **Deleted**.

### Data visualization

Charts use `accent` for the primary series and `inkMuted` at 40% for comparisons; categorical charts take the status tones only when the categories are statuses. Inline bars (spend, risk, storage) are 6 px tall with a 3 px radius on a `selection` fill track. Gridlines use `border`; axis labels use `inkMuted` 12 px.

### Type (Inter, IDs in JetBrains Mono)

| Role | Size / weight | Color |
|---|---|---|
| Page title | 24 / 600, -0.01em | `ink` |
| Dialog title | 18 / 600 | `ink` |
| Section and card title | 15 / 600 | `ink` |
| Body, table cell | 14 / 400 | `ink` |
| Nav item, button | 13 to 14 / 500 | `inkSecondary` (nav), `ink` (button) |
| Meta, table header, nav section label | 12 / 500 | `inkMuted` |
| IDs, key prefixes, shortcut hints | mono 12 (hints 11) | `inkMuted` |

There are only these seven levels. Headings are never larger than the page title, never colored, and never followed by a help icon larger than 16 px.

### Space and shape

- 4 px grid: 8 inside controls, 16 between cards, 20 to 24 between page regions, 32 page gutter (16 on phones).
- Radius: 6 small controls, 8 buttons and inputs, 12 cards, 16 dialogs.
- Targets: at least 36 px on desktop, 44 px on touch.

## 3. Page anatomy

Every admin page renders inside the shared admin layout (sidebar navigation plus content frame); there are no full-screen admin pages. New admin routes are children of the `/admin` layout route, never siblings of it.

### Sidebar

The sidebar is the frame of every admin page, so it sets the tone. Calm, scannable and never louder than the content.

- **Size and surface.** 248 px wide on desktop, `canvas` background, 1 px `border` on its right edge, padding 20 px top and 14 px sides. No shadow, no colored background.
- **Brand row.** 28 px ink tile with the product mark, "Admin" in 14 / 600, a neutral environment chip (Local, Staging, Preview; hidden on production), and a `Cmd K` key hint pushed to the right. 18 px below it before the first item.
- **Search.** A 32 px filter input under the brand row ("Filter pages", `/` to focus). Typing narrows items across all sections and hides empty sections.
- **Sections.** A small number of groups (Overview, People, Money, Trust and safety, AI, Platform, Settings) with a 12 / 500 `inkMuted` label in sentence case, 20 px above each label. Labels are static text, not accordions; there are no section icons, no section colors and no dividers between sections.
- **Items.** 36 px tall, 8 px radius, 10 px horizontal padding, 16 px stroke icon (2 px stroke, `inkMuted`) then the label in 14 / 500 `inkSecondary`. One line only: labels are short ("Credits", not "Credit Analytics") and truncate with a tooltip rather than wrap. Hover: `hover` fill and `ink` text.
- **Active item.** `surface` fill, `ink` text and icon, and a 1 px `border` ring. Exactly one active item; on a detail page the item of its list is active (Users on a user profile).
- **Long lists.** A section with more than 7 items shows the 5 most used and a "More" row that expands in place. The sidebar scrolls on its own, and every admin scroll area uses a thin overlay scrollbar that shows on hover or focus; the brand row and search stay pinned.
- **Footer.** Pinned at the bottom: the signed-in admin (24 px avatar, name, role in `inkMuted`) and a collapse button.
- **App-wide chrome.** Anything that renders under the admin root but belongs to the whole app (the floating AI chat, the help panel) spreads `adminSurfaceExcludeProps` on its root so the admin skin stops there.
- **Collapsed and mobile.** Collapsed is a 64 px icon rail with tooltips, remembered per admin. Under 900 px the sidebar becomes a drawer opened from a menu button in the page header.

### Page skeletons

Inside that layout, every page uses one of two skeletons, so admins always know where to look. The content frame has a 32 px gutter (16 on phones), a 1280 px max width for detail and settings pages, and full width for list pages.

**List page**

1. `AdminPageHeader`: title, count, page actions (one primary button).
2. `AnomalyBanner`: only when something is wrong (signup spike, key-creation spike).
3. `SavedViews` tabs.
4. `FilterBar`: search, filter chips, Group by.
5. `DataTable`: selection, sortable columns, row opens the detail page.
6. `BulkActionBar`: floats at the bottom while rows are selected.

**Detail page**

1. Breadcrumb and shortcut hints.
2. `EntityHeader`: identity, status chips, up to two actions and a More menu.
3. `StatStrip`: 3 to 5 numbers that answer "is this normal?".
4. Tabs, kept in the URL as `?tab=`.
5. `SectionCard`s in a 2-column grid that drops to 1 column on narrow screens.
6. An **Admin log** tab: every change ever made to this record.

## 4. Interaction model

Every write in the admin falls into exactly one row. If an action does not fit, raise it in design review before building it.

| Kind of action | Pattern | Reason | Recovery | Examples |
|---|---|---|---|---|
| Reversible, low-risk | Applies immediately | Not required | Undo toast (30 s) | Add a tag, add a note, revoke a single key |
| Changes money or access | `ActionDialog` with preview | Required | Undo toast and Admin log entry | Adjust credits, change role, grant subscription, suspend |
| Bulk | `BulkActionBar`, then `ActionDialog` with a dry run | Required | Undo toast for the whole batch | Contain, bulk suspend, bulk revoke keys |
| Irreversible | `ActionDialog` with type-the-name confirm | Required | None, and the dialog says so | Delete user, data erasure |
| Settings forms | Edit in place with a sticky `SaveBar` | Optional | Discard and a leave-page guard | Admin settings, org settings, model config |
| Impersonation | `ActionDialog` with step-up MFA | Required | Time-boxed session and a visible banner | Log in as user |

Do and don't:

- **Do** place the button that commits a change at the bottom-right of the dialog or bar that holds its inputs.
- **Don't** put a page-wide Update button in the header, far from the fields it saves, that only appears after an edit.
- **Do** explain a disabled button in place, e.g. "Pick a reason or write at least 5 characters."
- **Don't** grey out a button with no hint, or mix staged and instant saves on the same page.
- **Do** allow every value the server allows. If the server accepts a balance of 0, the UI does too.

## 5. Components

Build new admin pages from these, in `apps/client/app/components/admin/shared/`. A new admin pattern starts as a proposal to add to this list, not as a one-off component.

### Buttons

- At most **one primary** button per view.
- **Outlined danger** opens a destructive flow; **solid danger** is only the final confirm inside a dialog.
- Labels start with a verb and name the object: "Suspend account", never "Submit" or "OK".
- The commit button repeats the consequence where it helps: "Set balance to 0".
- Sizes: 36 px (default), 32 px (toolbars, filter bars), 28 px (inside table rows). Radius 8, label 13 / 500, 16 px icon with a 6 px gap.
- Variants: **primary** is an `ink` fill; **secondary** is a `surface` fill with a `borderStrong` outline; **ghost** has no outline and a `hover` fill. No other colors.

### Tables

- One table is one surface: a single card with a `surfaceSubtle` 38 px header row and 56 px body rows separated by 1 px `border` lines. Rows are never separate cards with gaps between them.
- The whole row opens the detail page. Row actions are ghost icon buttons (or one "..." menu) that appear on hover and focus, never a pair of solid buttons in every row.
- Numbers are right-aligned and tabular; IDs are mono with a copy button that appears on hover; empty values render as an `inkMuted` dash.
- Pagination lives once, in the table footer: "1 to 25 of 1,204" on the left, page size and arrows on the right.

### Toolkit

| Component | Job | Rules |
|---|---|---|
| `AdminPageHeader` | Title, count or meta, page actions | Actions sit top-right and wrap below the title on small screens. |
| `EntityHeader` | Identity of a user, org or key | IDs and emails have a copy button. Times are relative, with the exact UTC time on hover. |
| `StatStrip` / `StatTile` | 3 to 5 key numbers | Label, value, comparison line. Optional sparkline. No decorative icons. |
| `SectionCard` | A group of facts | Title, optional ghost action, definition list. No form inputs inside. |
| `DataTable` | Every admin list | Sticky header, sortable columns, row selection, horizontal scroll on mobile, skeleton, empty and error states. Page sizes 25, 50, 100. |
| `FilterBar` / `SavedViews` | Narrowing a list | Every filter is kept in the URL. Dashed chip = unset, solid chip = set and removable. |
| `FilterChip` | One filter in a `FilterBar` | Dashed with just the label while unset; "Label: Value" in the `selection` tint with a remove button once set. Picking a value opens a menu. |
| `ViewTabs` | Built-in and saved views above a list | The active tab is ink-filled. Each tab may carry a count. A view is its filters, so matching filters light its tab. |
| `SegmentedControl` | 2 to 4 mutually exclusive modes | Toggle buttons on a `hover` track, e.g. Group by None / Email domain. Not for filters with many values. |
| `InitialsAvatar` | The person in a table row | The photo when there is one, else initials on a tone that stays stable per user. |
| `InlineBar` | A number's share of the largest in view | Decorative only: the number itself stays in the cell. |
| `BulkActionBar` | Acting on a selection | Floats at the bottom. Offers "Select all N matching". Most destructive action last. |
| `ActionDialog` | Any audited write | Verb-phrase title, before/after preview or dry run, then a reason. Commit button bottom-right. |
| `AdminDialog` | An unaudited dialog, such as naming a saved view | The modal shell `ActionDialog` is built on: title, close button, focus trap. No reason field. |
| `ReasonPicker` | Audit reasons | Preset chips per action type plus free text (5 to 500 characters, the shared `adminActionReason` rule). Replaces `AdminReasonField`. |
| `UndoToast` | Recovery | Bottom-center, 30 seconds, Undo plus a link to the audit entry. One at a time. |
| `SaveBar` | Settings forms only | Sticky bottom bar: "3 unsaved changes", Discard, Save (Cmd+S). |
| `EmptyState` / `ErrorState` | Nothing to show, or a failure | Say what happened, then give the next step as a button. Never leave the area blank. |

## 6. Writing

- Sentence case, verb first: "Revoke API keys", not "API Key Revocation".
- State the consequence: "Requests using them start failing immediately.", not "This action may have side effects."
- Numbers people can scan: thousands separator, tabular figures, signed deltas (+2,000, -412), unit named once in the column header.
- Errors say what to do: "Reason must be at least 5 characters", not "Invalid input".

## 7. Accessibility, keyboard and states

Definition of done for any admin UI:

- Text contrast at least 4.5:1, muted meta text included, in light and dark themes.
- Every control is a real button, link or input reachable with Tab.
- Focus is always visible: one 2 px accent ring per control. A field (input, textarea, select, autocomplete) draws it on its rounded root; the native control inside never adds an outline of its own.
- Dialogs trap focus, close on Esc and return focus to the button that opened them.
- Icon-only buttons have an `aria-label`. Status is never shown by color alone.
- Loading uses a skeleton shaped like the content. Empty, filtered-empty and error states each offer a next step.
- The page works at 375 px wide: tables scroll, menus stack.
- Interactive elements carry a `data-testid` (`component-action-element`), per the repo testing guidelines.

Shortcuts:

| Key | Action |
|---|---|
| Cmd+K | Command palette: find any user, org or key, or run any action |
| `/` | Focus search |
| `x` | Select the focused row |
| `c` | Adjust credits (user profile) |
| `s` | Suspend (user profile) |
| Cmd+S | Save (settings forms) |

## 8. Rollout

1. **Tokens and toolkit.** Admin tokens in the Joy theme; the components above in `components/admin/shared` with tests.
2. **Users first.** Rebuild the users list and user profile on the toolkit; split `FullUsersView` into the profile shell and section cards.
3. **Every other admin tab.** Organizations, credits, API keys, security, settings and audit log move onto the same page anatomy, one PR per tab.
4. **Lock it in.** A lint rule against raw Joy `Card`, `Modal` and `Table` in admin code outside `shared/`, and a design-review checkbox in the PR template.

### Lint guard

`b4m/no-raw-admin-joy` rejects raw Joy `Card`, `Modal` and `Table` imports (including aliases and component subpaths) outside the root `admin/shared/` toolkit. Namespace imports and re-exports cannot bypass it. Use `SectionCard`, `ActionDialog` (or `AdminDialog` for an unaudited dialog) and `DataTable` instead.

An exceptional import needs an immediately preceding comment: `// admin-toolkit-allow YYYY-MM-DD -- concrete reason the toolkit cannot serve this use case`. Keep exceptions local to one import; do not disable the rule for a file or directory.

Pre-toolkit imports are recorded by file and component in `eslint-rules/admin-joy-legacy.mjs`, with their recording date and migration justification. Each declaration is pinned to its original line and a SHA-256 text fingerprint in `eslint-rules/admin-joy-legacy-imports.mjs`, not a transferable import count. New declarations fail even in legacy files, and changed or removed declarations produce a stale-exception error. Remove baseline entries when migrating; do not add new screens. Formatting or line shifts also require explicitly re-justifying the affected exception. This strictness avoids granting a removed import's allowance to another declaration without editing tabs awaiting their own migrations.
