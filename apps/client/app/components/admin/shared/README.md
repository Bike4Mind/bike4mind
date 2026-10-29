# Admin toolkit

Use these internal Joy components for admin screens. Colors come from
`theme.palette.admin`, with contrast checks for both modes in `contrast.test.ts`.

`DataTable` receives the **complete filtered result**, then sorts and paginates it
locally. It preserves server ordering until the first sort. Do not pass a single
server page as though it were the complete result. Server-paged lists pass
`pagination` with a one-based page, page size, total and controlled callbacks,
plus only the fetched page. In that mode local sorting is off, because it cannot
safely operate on an incomplete result: pass `sort` and `onSortChange` to sort on
the server. Selection stays on; a caller that offers "select all matching" must
resolve it on the server. The caller owns filter resets; an empty page past the
end offers a way back to the first page. Pass
`pageResetKey` (e.g. the serialized filter state) so a changed filter opens on the
first page.

```tsx
const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });

<DataTable
  label="Accounts"
  rows={accounts}
  getRowId={account => account.id}
  columns={[
    { id: 'name', label: 'Name', render: account => account.name, sortValue: account => account.name },
  ]}
  selection={selection}
  onSelectionChange={setSelection}
  onRetry={() => void query.refetch()}
/>
<BulkActionBar
  selection={selection}
  totalMatching={accounts.length}
  onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
  onClear={() => setSelection({ mode: 'explicit', ids: [] })}
>
  {actions}
</BulkActionBar>
```

Selection belongs to the caller. Reset it when the filtered dataset changes, before
using it for an action. `allMatching` refers to the entire filtered result, not the
current page. The bar only renders supplied actions; it does not execute writes.

Use `FilterBar` and `SavedViews` with `useAdminListUrlState(keys)`. Register every
key in `adminTabParams.ts` so router validation and tab switching handle it. Only
persist searches over non-personal data. `SavedViews` receives named presets;
selecting a preset replaces all owned filters in one navigation. Editing a filter
clears the active preset. The URL is the source of truth on refresh and navigation.
The search box keeps local state and writes `query` to the URL once typing pauses;
every other change is written at once.
See `IntegrationDemandTab.tsx` for a complete query-backed example.

`EntityHeader` supplies copy controls with visible failure feedback and relative
timestamps with exact UTC tooltips. `SectionCard` groups read-only definition-list
facts; use separate settings components for forms.

## Settings forms

`SettingsSection` supplies a form surface without the definition-list semantics of
`SectionCard`. `SaveBar` is sticky and accepts a dirty count, save/discard callbacks,
pending state and validation/error text. It owns Cmd+S and Ctrl+S and removes its
listener when unmounted. `UnsavedChangesGuard` protects router navigation and page
unload; its caller defines which route changes leave the form.

Admin Settings uses `SettingsDraftProvider` to retain drafts while filtering or
switching sections. It saves through each editor's existing mutation, removes only
successful changes and retains failed/unattempted changes for retry. File uploads
and scoped override commands keep their existing explicit command flows.

## Audited writes

Every write that changes money or access goes through `ActionDialog` (see section 4
of `../DESIGN_GUIDE.md`). It owns the reason: pick presets from
`ADMIN_REASON_PRESETS` in `adminReason.ts` and the dialog hands `onConfirm` the
composed audit string ("Preset: note", or either alone). Put the before/after
preview, a bulk dry run or extra inputs in `children`, and pass `blockedReason`
while those inputs are not ready so the disabled commit explains itself.
Irreversible commands add `typedConfirm`; `tone="danger"` styles only the commit.

```tsx
<ActionDialog
  open={open}
  onClose={close}
  title="Adjust credits"
  reasonPresets={ADMIN_REASON_PRESETS.creditAdjustment}
  confirmLabel={`Set balance to ${next.toLocaleString()}`}
  blockedReason={isValid ? null : 'Enter a balance of 0 or more.'}
  pending={mutation.isPending}
  onConfirm={reason => mutation.mutate({ balance: next, reason }, { onSuccess: close })}
  data-testid="adjust-credits-dialog"
>
  <BalancePreview before={current} after={next} />
</ActionDialog>
```

Forms that keep their own submit button use `ReasonPicker` directly with an
`AdminReasonDraft`, submitting `composeAdminReason(draft)` and gating on
`isAdminReasonComplete(draft)`. Every preset must pass the shared
`adminActionReason` rule unchanged; `server/utils/adminAudit.test.ts` pins this.

After a write that can be reversed, call `useUndoToast()` (the provider is mounted
in `AdminPage`). `onUndo` must perform the reverse write, which records its own
audit entry; the toast only offers it for 30 seconds, one offer at a time.
