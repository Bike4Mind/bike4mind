# Admin toolkit

Use these internal Joy components for admin screens. Colors come from
`theme.palette.admin`, with contrast checks for both modes in `contrast.test.ts`.

`DataTable` receives the **complete filtered result**, then sorts and paginates it
locally. It preserves server ordering until the first sort. Do not pass a single
server page as though it were the complete result. Infinite requester lists can
keep their existing server pagination until they have a compatible adapter. Pass
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
