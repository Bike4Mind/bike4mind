# Lake systemPrompt: reconcile stale comments and UI copy (issue #1768, small slice)

## Problem

`IDataLake.systemPrompt` demonstrably reaches the model, but three places in the codebase
describe it wrongly, in two different wrong directions:

1. `packages/database/src/models/ai/DataLakeModel.ts` (~line 48): "Not yet consumed; a later
   PR (#843) injects it at answer time." Wrong: it is consumed today.
2. `b4m-core/common/src/types/entities/DataLakeTypes.ts` (~line 69, the `IDataLake.systemPrompt`
   doc comment): "Not yet consumed: a later PR (#843) injects it as a labeled system message
   whenever this lake is active in a chat turn." Wrong twice: it is consumed, and the trigger is
   not "active in a turn" but "retrieved from in a turn".
3. `apps/client/app/components/DataLakeWizard/DataLakeSettingsModal.tsx` (~line 228, the
   FormHelperText): "Extra instructions applied to your chats, and to your organization's
   chats, while this lake is accessible - not only when the lake is used." This describes the
   removed always-on behavior - the OPPOSITE of what ships.

Issue #1768 names this reconciliation its "Immediate, smaller, independently shippable" slice.
A correction comment on the issue (issuecomment-5288527943) still calls the field "inert"; that claim is
also wrong and gets corrected on the issue as part of this work.

## Ground truth (verified on main, 2026-08-14)

Per-lake prompt injection is RETRIEVAL-SCOPED, through two channels, both feeding the shared
`renderDataLakePromptSection` defenses:

- Forced retrieval: `KnowledgeRetrievalFeature` in `b4m-core/services/src/llm/ChatCompletionFeatures.ts`
  (the removal-of-always-on note sits at ~line 1342 and is accurate).
- Model-driven KB tools: `prependRetrievedLakePrompts` in
  `b4m-core/services/src/llm/tools/implementation/retrievedLakePrompts.ts`, used by the
  knowledgeBaseSearch / knowledgeBaseRetrieve tools.

A lake's prompt is injected only when ALL hold (`getAccessibleDataLakePrompts` in
`b4m-core/services/src/dataLakeService/getDataLakePrompts.ts`):

- the lake is active and accessible to the actor;
- the lake is TRUSTED for the actor (`isTrustedForInjection`: the actor created the lake, or is
  a member of the lake's organization);
- `systemPrompt` is non-empty after trim;
- the turn actually retrieved content from that lake (`restrictToDatalakeTags` matches the
  lake's `datalakeTag` on the returned files).

The organization prompt stays authoritative on conflict (org-deference header in the rendered
block). Only lake managers can read the text in the app (server withholds it otherwise).

## Change

No behavior change anywhere. Three copy fixes plus issue hygiene:

### 1. `DataLakeModel.ts` schema comment

Replace the "Not yet consumed" sentence with the real contract, kept short since the type doc
carries the detail: consumed retrieval-scoped (see IDataLake.systemPrompt); stored uncapped,
matching the other system-prompt fields.

### 2. `DataLakeTypes.ts` `IDataLake.systemPrompt` doc comment

Rewrite to state: injected retrieval-scoped on turns that actually retrieve from this lake
(both the forced-retrieval path and the model-driven knowledge tools), only for TRUSTED lakes
(creator or same-org actor - see `isTrustedForInjection`), rendered with the
`renderDataLakePromptSection` defenses; the org prompt stays authoritative on conflict;
editable only via `canManageLake`; uncapped; absent/empty = no per-lake prompt. Keep the
existing cross-references style.

### 3. `DataLakeSettingsModal.tsx` help text

New FormHelperText copy (exact string, ASCII only). Note the audience precision: injection is
trusted-only, so the prompt does NOT apply to users reached via tag/entitlement grants - the
copy must not claim it does:

"Extra instructions added to answers on turns that actually pull content from this lake. They
apply to you and to members of this lake's organization - not to users granted access by tag
or entitlement - and never fire on turns that don't use the lake. Your organization's prompt
stays authoritative on conflict, and only people who can manage this lake can read this text
in the app."

The trimmed character counter suffix stays as is. The placeholder stays as is. The editor-only
render comment above the block stays as is.

`DataLakeSettingsModal.test.tsx` currently asserts the help element exists
(`datalake-systemprompt-help`); update any assertion that pins the old wording, and add/keep an
assertion that the help text mentions the retrieval-scoped condition (substring "pull content
from this lake"), so the copy cannot silently regress to always-on wording.

### 4. Issue #1768 comment

After the PR merges (or opens - with a link), post a comment correcting the record with
file:line evidence: the freeform field is NOT inert - it is consumed retrieval-scoped via the
two channels above; the shipped slice fixes the three wrong descriptions; what remains open in
the issue is the design work (owner-authored registry-prompt ceiling, discoverability of the
two coupled surfaces, UI signal for retrieval-scoped vs session-mode semantics).

## Out of scope

- Any change to injection behavior, trust rule, or the preferred-prompt picker.
- The larger #1768 design (one-field consolidation, owner authoring path, discoverability).
- Disabling the editor: the issue offered "mark clearly or disable"; the field works, so mark.

## Testing

- Updated `DataLakeSettingsModal.test.tsx` assertions (theme wrapper pattern already in place).
- No server-side tests needed: comments only.
- Full client typecheck + focused vitest on the modal test file before push.
