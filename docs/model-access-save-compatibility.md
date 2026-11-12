# Model access saves during the dashboard transition

The current LLM Dashboard remains usable while the Models console is developed separately. Its Save action asks for an audit reason and sends only changed entries, using the stamps loaded into the editor. Each entry's write and audit share one transaction, and the entire dashboard Save either commits or rolls back. Other models are not replaced. Fallback and rank removals are explicit changes.

`PUT /api/admin/llm-models/configurations` accepts a full-administrator session and this conditional request:

```json
{
  "changes": [
    {
      "id": "model-a",
      "change": { "enabled": false },
      "expectedUpdatedAt": "2026-11-01T00:00:00.000Z"
    }
  ],
  "reason": "Update model availability"
}
```

Use the actual model ID and stamp returned to the full-admin editor. `expectedUpdatedAt: null` means the editor loaded an absent or unstamped entry. A newly created entry includes all displayed access defaults. Requests are limited to 500 unique changed models. A change that leaves an enabled model visible only to administrators requires explicit `confirmAdminOnly: true`. Delegates and API keys cannot use this Save endpoint.

Old clients that send an unversioned `configurations` array receive 409 with a reload-required message and perform no writes. Reloading loads the updated editor; do not retry an old array or fetch fresh stamps merely to apply old desired values. A real concurrent change also returns 409, leaves the entire Save unchanged, and requires reviewing the newly loaded values. The per-model PATCH and bulk dry-run/apply/undo APIs remain available with their documented contracts.

Configuration GET retains the picker array body. Full administrators additionally receive each entry's `updatedAt`. Its access-revision header describes the read; open clients reconcile that header with the broadcast `modelAccessRevision`, including a push during their first fetch. A failed access read remains an error and does not restore default access. A failed refresh retains cached editor data and unsaved changes with a retry notice.

Deploy the updated server and client together, drain the previous whole-array writer instances, and run the additive `20260921239998_stamp-model-access-entries` migration. The migration is idempotent and changes only unstamped entries. The independent replacement Models UI is not a prerequisite. Intentional preview environment seeding remains separate from an administrator's Save.

Before release, verify the current dashboard on its preview: change one model, save with a reason, reload and confirm the result; edit the same model from two tabs and confirm the older editor receives 409 without overwriting the newer value; confirm that an open picker refreshes after another administrator changes access. Hosted CI and deployed QA are separate from local tests.
