# Lake systemPrompt Copy Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every description of `IDataLake.systemPrompt` (two code comments, one UI help text) state its real behavior - retrieval-scoped, trusted-only injection - with a test pinning the UI copy.

**Architecture:** No behavior change anywhere. Three copy edits: the schema comment in `DataLakeModel.ts`, the type doc comment in `DataLakeTypes.ts`, and the FormHelperText in `DataLakeSettingsModal.tsx`, plus a test assertion that the help text names the retrieval-scoped condition.

**Tech Stack:** TypeScript comments; React (MUI Joy) copy string; vitest + testing-library for the modal test.

## Global Constraints

- ASCII only on every added `.ts`/`.tsx` line (CI-gated). Apostrophes in copy are ASCII `'`.
- The new FormHelperText copy is EXACT (from the spec): "Extra instructions added to answers on turns that actually pull content from this lake. They apply to you and to members of this lake's organization - not to users granted access by tag or entitlement - and never fire on turns that don't use the lake. Your organization's prompt stays authoritative on conflict, and only people who can manage this lake can read this text in the app."
- No behavior change: no runtime code path may differ. Comments and one string literal only.
- Node 24 for every command: prefix with `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`.
- Client tests: NEVER `pnpm --filter @bike4mind/client test -- run <path>` (runs the full suite). Use `pnpm --filter @bike4mind/client exec vitest run <path>`.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server-side comments (schema + type doc)

**Files:**
- Modify: `packages/database/src/models/ai/DataLakeModel.ts:48-50`
- Modify: `b4m-core/common/src/types/entities/DataLakeTypes.ts:67-74`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on (comments only).

Both comments claim the field is "Not yet consumed" with "a later PR (#843)" injecting it. That PR landed long ago and the behavior it shipped was later narrowed to retrieval-scoped injection (#1108). Ground truth to encode (verified in the spec, `docs/superpowers/specs/2026-08-14-lake-systemprompt-copy-design.md`): injected retrieval-scoped via `getAccessibleDataLakePrompts` on two channels (forced retrieval in `ChatCompletionFeatures.ts`'s `KnowledgeRetrievalFeature`; model-driven knowledge tools via `prependRetrievedLakePrompts`), only for TRUSTED actors (`isTrustedForInjection`: lake creator, or member of the lake's organization), org prompt authoritative on conflict.

- [ ] **Step 1: Rewrite the schema comment in `DataLakeModel.ts`**

Replace exactly this (currently at lines 48-49):

```ts
    // Per-lake system prompt (see IDataLake.systemPrompt). Not yet consumed; a later PR (#843)
    // injects it at answer time. Stored uncapped, matching the other system-prompt fields.
```

with:

```ts
    // Per-lake system prompt, injected RETRIEVAL-SCOPED at answer time (see
    // IDataLake.systemPrompt for the full contract). Stored uncapped, matching the other
    // system-prompt fields.
```

- [ ] **Step 2: Rewrite the type doc comment in `DataLakeTypes.ts`**

Replace exactly this block (currently at lines 67-74, the doc comment on `systemPrompt?: string;`):

```ts
  /**
   * Optional per-lake system prompt, so a lake can carry its own answering instructions.
   * Not yet consumed: a later PR (#843) injects it as a labeled system message whenever this
   * lake is active in a chat turn, refining behavior WITHIN the org prompt (which stays
   * authoritative on conflict). Editable only by the lake creator or an admin (canManageLake);
   * uncapped, matching the other system prompts in the codebase. Absent/empty = no per-lake prompt.
   */
```

with:

```ts
  /**
   * Optional per-lake system prompt, so a lake can carry its own answering instructions.
   * Injected RETRIEVAL-SCOPED: it rides only on turns that actually retrieved content from
   * this lake, on both channels - forced retrieval (KnowledgeRetrievalFeature) and the
   * model-driven knowledge tools (prependRetrievedLakePrompts) - resolved by
   * getAccessibleDataLakePrompts and rendered with the renderDataLakePromptSection defenses.
   * Injected only for TRUSTED actors (the lake's creator, or a member of the lake's
   * organization - see isTrustedForInjection); users reached via tag/entitlement grants read
   * the lake WITHOUT this prompt. The org prompt stays authoritative on conflict. Editable
   * only via canManageLake and withheld from non-managers by the server; uncapped, matching
   * the other system prompts in the codebase. Absent/empty = no per-lake prompt.
   */
```

If the current text differs from either "Replace exactly" block (drift since the plan was written), stop and report BLOCKED rather than guessing.

- [ ] **Step 3: Typecheck the two touched packages**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/common typecheck && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/database typecheck`
Expected: both exit 0 (comments cannot break types; this catches accidental token damage).

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/models/ai/DataLakeModel.ts b4m-core/common/src/types/entities/DataLakeTypes.ts
git commit -m "docs(data-lake): state systemPrompt's real retrieval-scoped contract in the schema and type comments

Both claimed 'Not yet consumed' long after the injection shipped and was
narrowed to retrieval-scoped, trusted-only delivery.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Modal help text + copy-pinning test

**Files:**
- Modify: `apps/client/app/components/DataLakeWizard/DataLakeSettingsModal.tsx:228`
- Test: `apps/client/app/components/DataLakeWizard/DataLakeSettingsModal.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces: nothing later tasks rely on.

The FormHelperText currently describes the REMOVED always-on behavior ("while this lake is accessible - not only when the lake is used"). The test file already has a copy test at `it('states that the org prompt wins and that the text is editors-only', ...)` (~line 295) whose two assertions survive the new copy unchanged; render setup for it uses the existing `promptedLake` fixture and `Wrapper` - reuse both.

- [ ] **Step 1: Add the failing copy test**

Insert after the existing `it('states that the org prompt wins and that the text is editors-only', ...)` block (~line 305):

```tsx
  it('states the retrieval-scoped condition, so the copy cannot regress to always-on wording', () => {
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={promptedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    const help = screen.getByTestId('datalake-systemprompt-help');
    // The two halves of the real contract: fires on retrieval turns, never otherwise.
    expect(help).toHaveTextContent(/pull content from this lake/i);
    expect(help).toHaveTextContent(/never fire on turns that don't use the lake/i);
    // The pre-#1108 always-on wording must not come back.
    expect(help).not.toHaveTextContent(/not only when the lake is used/i);
  });
```

- [ ] **Step 2: Run the test file, verify the new test fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client exec vitest run app/components/DataLakeWizard/DataLakeSettingsModal.test.tsx`
Expected: the new test FAILS on `/pull content from this lake/i` (old copy present); every other test passes.

- [ ] **Step 3: Replace the help copy**

In `DataLakeSettingsModal.tsx` line 228, replace the template-literal prefix exactly:

Old:

```tsx
                    {`Extra instructions applied to your chats, and to your organization's chats, while this lake is accessible - not only when the lake is used. Your organization's prompt stays authoritative on conflict, and only people who can manage this lake can read this text in the app.${
```

New:

```tsx
                    {`Extra instructions added to answers on turns that actually pull content from this lake. They apply to you and to members of this lake's organization - not to users granted access by tag or entitlement - and never fire on turns that don't use the lake. Your organization's prompt stays authoritative on conflict, and only people who can manage this lake can read this text in the app.${
```

The trimmed-character-counter suffix (`systemPrompt.trim() ? ...`), the placeholder text, and the editor-only render comment above the block all stay untouched.

- [ ] **Step 4: Run the test file, verify all pass**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client exec vitest run app/components/DataLakeWizard/DataLakeSettingsModal.test.tsx`
Expected: PASS, including the pre-existing copy test (its `/organization's prompt stays authoritative/i` and `/only people who can manage this lake can read this text/i` substrings survive in the new copy).

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/DataLakeWizard/DataLakeSettingsModal.tsx apps/client/app/components/DataLakeWizard/DataLakeSettingsModal.test.tsx
git commit -m "fix(client): lake prompt help text described the removed always-on behavior

State the real contract: retrieval-scoped, org-member/creator only, org
prompt authoritative. Pin it with a test so the copy cannot silently
regress.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## After both tasks (orchestrator, not a task)

The spec's item 4 (correct the "inert" claim on issue #1768 with file:line evidence) happens when the PR opens - it references the PR link and is posted by the orchestrator, not an implementer.
