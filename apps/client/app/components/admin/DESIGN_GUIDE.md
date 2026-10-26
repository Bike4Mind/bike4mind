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

Defined once as Joy theme tokens in `apps/client/app/utils/themes`. Never hard-code a hex value or pixel size in an admin component. The values below are the light-theme targets; each token needs a dark-theme value that passes the same contrast checks (`contrast.test.ts`).

### Color

| Token | Light value | Use |
|---|---|---|
| `admin.canvas` | `#F6F6F4` | Page background |
| `admin.surface` | `#FFFFFF` | Cards, tables, dialogs |
| `admin.border` | `#E4E4DF` | Card and table borders |
| `admin.ink` | `#18181B` | Body text, primary button |
| `admin.inkMuted` | `#62626B` | Meta text (passes 4.5:1 on surface) |
| `admin.accent` | `#4F46E5` | Focus ring, links, selection |
| `admin.danger` | `#B42318` | Destructive actions only |

### Status tones

Five tones with one meaning each, used everywhere. They differ in lightness as well as hue, and every chip also has a text label.

| Tone | Means | Examples |
|---|---|---|
| good | Healthy, allowed | Active, Verified, Success |
| info | New or neutral-notable | New, Pro |
| warn | Needs a look | Medium risk |
| bad | Blocked or failing | Suspended, High risk, Blocked sign-in |
| neutral | Inactive, informational | Revoked, Free |

Shared terms: **Suspended** (not "banned"), **Restricted** (not "moderated"), **Revoked**, **Deleted**.

### Type (Inter, IDs in a monospace face)

| Role | Size / weight |
|---|---|
| Page title | 24 / 600 |
| Dialog title | 18 / 600 |
| Section title | 15 / 600 |
| Body | 14 / 400 |
| Meta, table header | 12 / 500 |
| IDs, key prefixes | mono 12 |

### Space and shape

- 4 px grid: 8 inside controls, 16 between cards, 20 to 24 between page regions, 32 page gutter (16 on phones).
- Radius: 6 small controls, 8 buttons and inputs, 12 cards, 16 dialogs.
- Targets: at least 36 px on desktop, 44 px on touch.

## 3. Page anatomy

Every admin page uses one of two skeletons, so admins always know where to look.

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

### Toolkit

| Component | Job | Rules |
|---|---|---|
| `AdminPageHeader` | Title, count or meta, page actions | Actions sit top-right and wrap below the title on small screens. |
| `EntityHeader` | Identity of a user, org or key | IDs and emails have a copy button. Times are relative, with the exact UTC time on hover. |
| `StatStrip` / `StatTile` | 3 to 5 key numbers | Label, value, comparison line. Optional sparkline. No decorative icons. |
| `SectionCard` | A group of facts | Title, optional ghost action, definition list. No form inputs inside. |
| `DataTable` | Every admin list | Sticky header, sortable columns, row selection, horizontal scroll on mobile, skeleton, empty and error states. Page sizes 25, 50, 100. |
| `FilterBar` / `SavedViews` | Narrowing a list | Every filter is kept in the URL. Dashed chip = unset, solid chip = set and removable. |
| `BulkActionBar` | Acting on a selection | Floats at the bottom. Offers "Select all N matching". Most destructive action last. |
| `ActionDialog` | Any audited write | Verb-phrase title, before/after preview or dry run, then a reason. Commit button bottom-right. |
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
- Focus is always visible: a 2 px accent ring.
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
