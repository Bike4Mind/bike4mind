# Video Generation: Studio UI (Plan 3 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/studio/video` page: a capability-driven generation form, a live gallery of the user's video jobs built from a standalone `VideoJobCard`, a global websocket listener that keeps every card live, a `video` filter in the Files browser, and the server change that labels SPA-created jobs `studio`.

**Architecture:** Server data lives in React Query under one key registry (`videoGenerationKeys`); a pure cache module (`videoGenerationCache.ts`) owns every write into it (list seed, create prepend, cancel upsert, websocket patch) so the ordering rules live in one place. A global `VideoGenerationUpdatesListener`, mounted next to `WebsocketReactQueryInvalidateListener`, patches `generation_job_updated` frames into that cache and refetches on terminal states; per-job detail queries poll only as a fallback. The form's rules (defaults, clamping on model switch, request body, credit estimate) are a pure module (`videoForm.ts`) the Joy form component renders.

**Tech Stack:** TypeScript (strict), React 19, MUI Joy 5 beta, TanStack Query v5 (`useInfiniteQuery`, `InfiniteData`), TanStack Router v1 (code-based routes), Zustand (Files drawer store), sonner, vitest 4 + Testing Library (jsdom project), Zod v4 schemas from `@bike4mind/common`.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-provider-video-generation-design.md`, section 9 (this phase), with section 8 (the API this page calls) and section 10 (the agent tool that will reuse `VideoJobCard`). Epic #3890, phase 4. Built on #3968 (`feat/video-generation-omni-flash-api`, merged). Previous plan: `docs/superpowers/plans/2026-10-06-video-generation-omni-flash-api.md`.

## Plan-time corrections

Each item is a place where the code contradicted a decision's or the survey's factual premise; the plan follows the code.

1. **D4, multi-listener dispatch.** The survey suggested only the first registered listener of an action receives it. `WebsocketContext.tsx` (line ~240) calls **every** listener for the action (`actionListeners.forEach(...)`); only when an action has **no** listener does the frame go to `lastJsonMessage`. The listener is still one global component (D4). Consequence: once it subscribes, `generation_job_updated` never reaches `lastJsonMessage`; nothing in `apps/client/app` reads it from there today (grep confirms), and phase 5's chat card reads the cache, not the socket.
2. **D4, patching `error` from the frame.** `toJobUpdate` (`apps/client/server/generationJobs/wiring.ts:90`) copies the stored `job.error` verbatim: an internal code (`orphaned_submit`, `enqueue_failed`) and a message that may carry provider wording. The public mapper replaces both with a fixed message per public code. So the listener patches only `state` and `progress`, and a terminal frame refetches the job, which brings the public `error` and the signed `output`.
3. **D6, Cancel while non-terminal.** `requestCancel` returns `null` once a job is `storing` (spec 6.6; `[id]/cancel.ts` then returns the job unchanged). A Cancel button in `storing` would do nothing, so the card offers Cancel only in `pending` and `running`.
4. **D6, Open in Files.** `KnowledgeModal` is a text/markdown editor that special-cases only images and PDFs (`KnowledgeModal.tsx:630-670`); a video would open as an editor. "Open in Files" opens the Files drawer (`useFileBrowser.setOpen(true)` from `components/Files/fileBrowserStore.ts`), where the clip is listed newest-first and the new Video filter (Task 2) applies.
5. **Survey, models response.** `GET /api/v1/video-models` returns `{ models: VideoModel[] }` (`video-models.ts`), not `{ data }`. The list endpoint does return `{ data, next_cursor }`.
6. **D5/D7, audio toggle.** No catalog model is `audio: 'optional'` today (Gemini Omni, Grok and Veo are `always`, `test-video` is `none`). The switch is exercised with a synthetic `VideoModel` fixture; its estimate is `null` because the id is not in `VIDEO_MODEL_CATALOG`.
7. **D6, image picker hook.** The live hook is `app/hooks/agent/useImageBrowser.ts` (used by `AgentForm` through the `hooks/agent` barrel and by `ContentPreviewModal`); `app/hooks/useImageBrowser.ts` is an unused duplicate. The form uses the agent hook and leaves the duplicate alone (out of scope).
8. **D3, refetch when `expires_at` passes.** Every video route is per-user rate-limited (`perUserRateLimit` in `server/videoGenerations/routeDeps.ts`; the floor is `FALLBACK_RATE_LIMIT_PER_MIN = 10` per bucket in `server/utils/userRateTier.ts`), and a gallery page of cards shares one `expires_at` because the list signs them in one request. Refetching each detail at expiry would fire 12 GETs at once and 429. So the detail refetches 60s **before** expiry, the gallery list re-signs a whole page 120s before (one request per page, which re-seeds every detail and resets their timers), and Download always re-reads the job first. A re-signed URL never restarts a playing clip (Task 8 keeps the player's `src` until it errors).
9. **D2, the duplicated unions.** All seven sites can import `@bike4mind/common` (`packages/database` and `b4m-core/services` both depend on it; the client already imports types from it), so no literal is left. `packages/database`'s exported alias `FabFileFilterType` has no consumer in core or in any overlay checkout (grepped), so it is replaced by `FabFileTypeFilter` rather than kept. The two `(value as any)` casts that feed the filter (`Files/Browser/Filter.tsx:31`, `Files/Browser/Content.tsx:606`) are replaced by the new `isFabFileTypeFilter` guard.
10. **D6, i18n.** `app/locales/en.json` carries no `sidenav.*` keys; sidenav rows call `t('sidenav.<key>', 'Fallback')` (e.g. `sidenav.hearth`, `sidenav.published`). Full-page surfaces (`routes/gears`, `routes/hearth.tsx`) use plain English strings. The sidenav row follows the first convention and the studio page the second.
11. **D6, route file.** Routes live in directories (`routes/gears/index.tsx`, `routes/skills/new.tsx`), so the page is `app/routes/studio/video.tsx`.
12. **D1, existing test.** `pages/api/v1/__tests__/video-generations.integration.test.ts` "accepts a JWT caller and fills catalog defaults (202)" pins `source: 'api'` for a JWT caller; Task 1 changes that expectation to `'studio'`.
13. **Survey, auto Idempotency-Key.** `apiClient.ts` mints the key per request id (`getOrCreateIdempotencyKeyWithUUID(url, requestId)` with a fresh `X-Request-ID`), so it dedupes only axios-level retries; two Generate clicks are two jobs. The submit button is disabled while the create is pending.

## Execution order

Tasks run in number order. Tasks 1 and 2 are independent of each other and of the client data layer. Tasks 3 -> 4 -> 5 are a chain (keys and cache, then hooks, then the listener). Task 6 (pure form logic) and Task 7 (modal props) are independent of 3-5 and both precede Task 9. Task 8 needs Task 4. Task 10 needs Task 8; Task 11 needs Tasks 9 and 10; Task 12 needs Task 4. Task 13 is last.

After Task 2 changes `@bike4mind/common`, run `pnpm turbo:core:build` before any test outside `b4m-core/common` (cross-package tests read `dist`).

## Global Constraints

- ASCII only in every added `.ts`/`.tsx` line (`scripts/check-no-smart-punctuation.sh`, `scripts/check-no-control-bytes.sh`). UI copy uses plain hyphens and `...`; write the `—`-style escape if a typographic character is genuinely needed.
- Never `any`. Use `unknown` + narrowing, generics, or Zod-inferred types from `@bike4mind/common`. Test-only casts are limited to building an `AxiosError` and typing a deliberately invalid input, each with the type it targets.
- MUI Joy only (`@mui/joy`, `@mui/icons-material`); no `@emotion`. Theme mode via `useTheme().palette.mode` if needed.
- TanStack Router only (`useNavigate`, `useLocation`); never `next/router` or `next/navigation`.
- Server data in React Query; form state local `useState` (spec 9). Every video query key comes from `videoGenerationKeys`; never write one as a literal outside `videoGenerationKeys.ts` and its parity test.
- User-facing error text is derived from the error **code**, never from raw server or provider text (spec 8). The card shows `job.error.message`, which the server already renders from a fixed per-code table (`PUBLIC_ERROR_MESSAGES` in `server/videoGenerations/toPublicVideoGeneration.ts`).
- Play from the signed S3/CloudFront URL only; never a `data:` URL (the CSP `media-src` forbids it).
- The credit estimate shown is `estimateVideoCostCredits` from `@bike4mind/common`, the same function the server reserves with, so display and hold cannot drift (spec 11.5).
- No unbounded client loops: every polling interval and every recovery retry in this plan has a stop condition stated in its task.
- Tests co-located (`Foo.tsx` + `Foo.test.tsx`); `app/**` tests run in the `jsdom` project; `pages/**` integration tests keep their `// @vitest-environment node` docblock. Select elements by `data-testid` named `component-action-element`; Joy `Select`/`Textarea`/`Slider`/`Switch` put the test id on the inner slot (`slotProps.button` / `textarea` / `input`).
- MUI Joy component tests wrap in `CssVarsProvider` with `extendTheme({ ...getThemeConfig() })`.
- Comment hygiene per CLAUDE.md: comments carry the why, cross-references and invariants only.
- Conventional Commits `feat(video): ...` (or `test(video)`/`refactor(files)` where that is the honest type); never hand-write a `Co-Authored-By` trailer. Public repo: no internal tracker numbers (only #3890 and #3968), no customer names.
- Long commands (typecheck, full test, lint) are dispatched to a `verify` subagent; report the verdict and the failing lines only.

Repo commands used throughout:

| What | Command |
|---|---|
| One client test file | `pnpm --filter @bike4mind/client exec vitest run <path-relative-to-apps/client>` |
| One package test file | `pnpm --filter <pkg> exec vitest run <path-relative-to-package>` |
| Rebuild core after a common change | `pnpm turbo:core:build` |
| Typecheck | `pnpm turbo:typecheck` |
| Lint (CI parity) | `pnpm lint:check` |

## Review Focus

Five real-world failures the happy-path tests would not catch, each pinned by a named test in its owning task.

1. **The socket drops while a job finishes, then reconnects.** Frames sent while it was down are lost; the card must still reach its terminal state without a page reload. Detail queries poll every 15s while the socket is not `OPEN` (the per-user 10/min detail bucket rules out anything faster), and the listener refreshes the list and every unfinished job once on reconnect (never on the first connect). Pinned in Task 4 "polls every 15s while the socket is down and stops when it is open" and Task 5 "on reconnect refreshes the list and only the unfinished jobs, once".
2. **The signed URL is re-signed while the user is watching, or has expired when they press play.** Swapping `src` on a playing `<video>` restarts it; an expired URL fails with 403. The card keeps the URL it started with until the element errors, then takes the newest one, and gives up after two refreshes so a permanently broken file cannot loop. Pinned in Task 8 "keeps the player src across a re-sign and swaps on error" and "stops refreshing after MAX_PLAYER_URL_REFRESHES failed loads".
3. **A late frame or an older snapshot moves a finished job back to running.** Websocket frames can arrive out of order, and a list request issued before a detail refetch can land after it. A cached terminal job is never overwritten by a non-terminal one, and an older `updated_at` never replaces a newer one. Pinned in Task 3 "never regresses a terminal job" (patch) and "does not overwrite a newer cached job with an older list row" (seed).
4. **A full gallery page reaches its URL expiry at the same instant.** Twelve per-card refetches against a per-user limit as low as 10/min would 429 and leave dead players. The list re-signs the page before any card's own timer. Pinned in Task 4 "the list refresh fires before any card's own refresh".
5. **An admin disables the selected model while the form is open.** The next models refetch drops it; submitting would 422 `model_disabled`. The form moves to the first offered model, clamps the other fields to it, and says so. Pinned in Task 9 "switches to an offered model when the selected one disappears".

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/client/pages/api/v1/video-generations/index.ts` (+ integration test) | `source` from auth kind; idempotency key namespaced `${source}:${userId}:${key}` |
| `b4m-core/common/src/types/entities/FabFileTypes.ts` (+ new `FabFileTypes.test.ts`) | `FAB_FILE_TYPE_FILTERS`, `FabFileTypeFilter`, `isFabFileTypeFilter` |
| `packages/database/src/queries/fabFileSearchQuery.ts` (+ `__tests__/fabFileSearchQuery.test.ts`) | `case 'video'`; unions derived from common |
| `packages/database/src/models/content/FabFileModel.ts` | `search` filter type from common |
| `b4m-core/services/src/fabFileService/search.ts` (+ test) | zod enum from `FAB_FILE_TYPE_FILTERS` |
| `apps/client/app/components/Files/Browser/constants.ts` (+ new `constants.test.ts`), `Filter.tsx`, `Content.tsx` | Video option; guard instead of `as any` |
| `apps/client/app/hooks/data/fabFileKeys.ts`, `fabFileSearch.ts` | filter type from common |
| `apps/client/app/hooks/data/credits.ts` | exports `CREDITS_BALANCE_KEY` |
| `apps/client/app/hooks/data/videoGenerationKeys.ts` (+ test) | the key registry |
| `apps/client/app/hooks/data/videoGenerationCache.ts` (+ test) | every write into the video cache: seed, prepend, upsert, websocket patch |
| `apps/client/app/hooks/data/videoGenerationErrors.ts` (+ test) | error code -> user message |
| `apps/client/app/hooks/data/__test__/videoGenerationFixtures.ts` | test-only `VideoGeneration` / `VideoModel` builders shared by every video test |
| `apps/client/app/hooks/data/videoGenerations.ts` (+ `videoGenerations.test.tsx`) | `useVideoModels`, `useVideoGenerations`, `useVideoGeneration`, `useCreateVideoGeneration`, `useCancelVideoGeneration`, polling intervals |
| `apps/client/app/components/VideoGenerationUpdatesListener.ts` (+ test), `apps/client/app/providers.tsx` | global `generation_job_updated` -> cache |
| `apps/client/app/components/VideoStudio/videoForm.ts` (+ test) | form state, clamping, request body, estimate |
| `apps/client/app/components/Agent/ImageBrowserModal.tsx` (+ new test) | optional `title` and `emptyHint` |
| `apps/client/app/components/VideoStudio/VideoJobCard.tsx` (+ test) | standalone card keyed by `jobId` |
| `apps/client/app/components/VideoStudio/VideoStudioForm.tsx` (+ test) | the Joy form |
| `apps/client/app/components/VideoStudio/VideoGallery.tsx` (+ test) | infinite gallery |
| `apps/client/app/routes/studio/video.tsx` (+ test), `apps/client/app/router.tsx` (+ `router.test.ts`) | `/studio/video` page and route |
| `apps/client/app/seo/crawlPolicy.ts` (+ test) | `/studio` disallowed |
| `apps/client/app/components/layouts/Notebook/Sidenav/SidenavNav.tsx` (+ test) | Video Studio row when a model is usable |

---

### Task 1: Label SPA-created jobs `studio` and namespace their idempotency keys (server)

**Files:**
- Modify: `apps/client/pages/api/v1/video-generations/index.ts` (the `createRouter` handler, lines ~70-90)
- Test: `apps/client/pages/api/v1/__tests__/video-generations.integration.test.ts`

The SPA calls the contract routes with its session token (`auth: 'apiKeyOrJwt'`); `isApiKeyAuth(req)` (`server/middlewares/apiKeyAuth.ts:286`, `!!req.apiKeyInfo`) is true only for API-key callers. The route harness's `fire({ apiKey: null })` takes the JWT path (its `authMock` sets `req.user` to `jwt-user`), and an API-key call runs the real `apiKeyAuth`, which sets `req.apiKeyInfo`.

**Interfaces:**
- Consumes: `isApiKeyAuth(req: Request): boolean` from `@server/middlewares/apiKeyAuth`; `GenerationJobSource` from `@bike4mind/common`.
- Produces: jobs created through the SPA carry `source: 'studio'`; idempotency keys reach `createVideoJob` as `api:<userId>:<key>` or `studio:<userId>:<key>`.

- [ ] **Step 1: Write the failing tests**

In `video-generations.integration.test.ts`, change the expectation in "accepts a JWT caller and fills catalog defaults (202)" from `source: 'api',` to:

```ts
        source: 'studio',
```

In "namespaces the Idempotency-Key per user and returns 202 on replay", add after the existing `idempotencyKey` assertion:

```ts
    expect(h.createVideoJob.mock.calls[0][0].source).toBe('api');
```

Add a new test inside `describe('POST /api/v1/video-generations', ...)`:

```ts
  it('labels a session (studio) caller studio and keeps its Idempotency-Key apart from API keys', async () => {
    h.createVideoJob.mockResolvedValue({
      ok: true,
      job: videoJob({ requestedBy: 'jwt-user', source: 'studio' }),
      created: true,
    });
    const { req, res } = fire({
      method: 'POST',
      url: '/api/v1/video-generations',
      apiKey: null,
      body: { model: 'gemini-omni-1.1-flash', prompt: 'a lighthouse' },
      headers: { 'idempotency-key': 'ui-1' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ source: 'studio' });
    expect(h.createVideoJob.mock.calls[0][0]).toMatchObject({
      source: 'studio',
      idempotencyKey: 'studio:jwt-user:ui-1',
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bike4mind/client exec vitest run pages/api/v1/__tests__/video-generations.integration.test.ts`
Expected: FAIL. "accepts a JWT caller" receives `source: 'api'`; the new test receives `idempotencyKey: 'api:jwt-user:ui-1'`.

- [ ] **Step 3: Implement**

In `video-generations/index.ts`, add the imports:

```ts
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
```

and add `type GenerationJobSource,` to the existing `@bike4mind/common` import list. Replace the body of the `.post(...)` handler with:

```ts
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  const request = toDomainRequest(req.validated);
  // A session token is the SPA (the studio); an API key is the public API.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  // createVideoJob refuses a keyless provider itself, after its idempotent replay lookup.
  const result = await createVideoJob(
    {
      user: { id: req.user.id, organizationId: await resolveBillingOrgId(req, undefined) },
      request,
      source,
      // The domain scopes keys per credit owner (the org for members): per user keeps members apart, and per
      // source keeps a studio retry from replaying an API job that reused the same key.
      ...(idempotencyKey && { idempotencyKey: `${source}:${req.user.id}:${idempotencyKey}` }),
    },
    getCreateVideoJobDeps()
  );
  if (!result.ok) throw toHttpError(result);
  return res.status(202).json(await toPublicVideoGeneration(result.job, mapperDeps));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bike4mind/client exec vitest run pages/api/v1/__tests__/video-generations.integration.test.ts`
Expected: PASS (all tests in the file, including "the same Idempotency-Key from two org members reaches the domain under different keys", which still sees `api:member-a:shared` / `api:member-b:shared`).

- [ ] **Step 5: Commit**

```bash
git add apps/client/pages/api/v1/video-generations/index.ts apps/client/pages/api/v1/__tests__/video-generations.integration.test.ts
git commit -m "feat(video): label studio-created jobs and namespace their idempotency keys"
```

---

### Task 2: One file-type filter list, with video (common, database, services, Files UI)

**Files:**
- Modify: `b4m-core/common/src/types/entities/FabFileTypes.ts` (after `MimeTypes`, line ~10; the `search` filter type, line ~1218)
- Create: `b4m-core/common/src/types/entities/FabFileTypes.test.ts`
- Modify: `packages/database/src/queries/fabFileSearchQuery.ts` (`getMimeTypeFilter` line 108-138; `FabFileFilterType` line 337-345)
- Modify: `packages/database/src/models/content/FabFileModel.ts` (`search` filters, line ~854)
- Test: `packages/database/src/__tests__/fabFileSearchQuery.test.ts` (the `getMimeTypeFilter` describe, line ~134)
- Modify: `b4m-core/services/src/fabFileService/search.ts` (line 9-12); Test: `b4m-core/services/src/fabFileService/search.test.ts`
- Modify: `apps/client/app/components/Files/Browser/constants.ts`, `Filter.tsx` (line 26-34), `Content.tsx` (line ~601-608)
- Create: `apps/client/app/components/Files/Browser/constants.test.ts`
- Modify: `apps/client/app/hooks/data/fabFileKeys.ts` (line 22), `apps/client/app/hooks/data/fabFileSearch.ts` (line 113)

**Interfaces:**
- Produces (`@bike4mind/common`): `FAB_FILE_TYPE_FILTERS: readonly ['text','pdf','url','image','excel','word','json','csv','markdown','code','audio','video']`; `type FabFileTypeFilter`; `isFabFileTypeFilter(value: unknown): value is FabFileTypeFilter`.
- Produces (`packages/database`): `getMimeTypeFilter('video')` returns `{ mimeType: { $regex: '^video/' } }`. `FabFileFilterType` is removed (Plan-time correction 9).

- [ ] **Step 1: Write the failing common test** (`FabFileTypes.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { FAB_FILE_TYPE_FILTERS, isFabFileTypeFilter } from './FabFileTypes';

describe('FAB_FILE_TYPE_FILTERS', () => {
  it('lists every Files type filter, video included', () => {
    expect(FAB_FILE_TYPE_FILTERS).toEqual([
      'text',
      'pdf',
      'url',
      'image',
      'excel',
      'word',
      'json',
      'csv',
      'markdown',
      'code',
      'audio',
      'video',
    ]);
  });

  it.each(['video', 'audio', 'pdf'])('accepts %s', value => {
    expect(isFabFileTypeFilter(value)).toBe(true);
  });

  it.each(['all', 'VIDEO', '', 3, undefined, null])('rejects %s', value => {
    expect(isFabFileTypeFilter(value)).toBe(false);
  });
});
```

Run: `pnpm --filter @bike4mind/common exec vitest run src/types/entities/FabFileTypes.test.ts`
Expected: FAIL (`FAB_FILE_TYPE_FILTERS` is not exported).

- [ ] **Step 2: Add the list to common**

In `FabFileTypes.ts`, after `export const MimeTypes ...`:

```ts
// The Files type filter. getMimeTypeFilter (packages/database/src/queries/fabFileSearchQuery.ts) maps every value
// to a query and FILE_TYPE_OPTIONS (apps/client/app/components/Files/Browser/constants.ts) labels every value.
export const FAB_FILE_TYPE_FILTERS = [
  'text',
  'pdf',
  'url',
  'image',
  'excel',
  'word',
  'json',
  'csv',
  'markdown',
  'code',
  'audio',
  'video',
] as const;
export type FabFileTypeFilter = (typeof FAB_FILE_TYPE_FILTERS)[number];

export const isFabFileTypeFilter = (value: unknown): value is FabFileTypeFilter =>
  typeof value === 'string' && (FAB_FILE_TYPE_FILTERS as readonly string[]).includes(value);
```

In the repository `search` signature (line ~1218), replace the literal union with:

```ts
      type?: FabFileTypeFilter;
```

Run: `pnpm --filter @bike4mind/common exec vitest run src/types/entities/FabFileTypes.test.ts`
Expected: PASS.

Then: `pnpm turbo:core:build`
Expected: success (every later step in this task reads common's `dist`).

- [ ] **Step 3: Write the failing database and services tests**

In `packages/database/src/__tests__/fabFileSearchQuery.test.ts`, add `FAB_FILE_TYPE_FILTERS` to the existing `@bike4mind/common` import and add inside `describe('getMimeTypeFilter', ...)`:

```ts
    it('maps video to regex ^video/', () => {
      expect(getMimeTypeFilter('video')).toEqual({ mimeType: { $regex: '^video/' } });
    });

    it('maps every type filter to a non-empty condition', () => {
      for (const type of FAB_FILE_TYPE_FILTERS) {
        expect(Object.keys(getMimeTypeFilter(type) ?? {})).not.toHaveLength(0);
      }
    });
```

In `b4m-core/services/src/fabFileService/search.test.ts`, append:

```ts
describe('fabFileService search - type filter', () => {
  it('passes the video type filter through to the repository', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', { filters: { type: 'video' } }, a);

    expect(filtersArgOf(fabFilesSearch).type).toBe('video');
  });

  it('rejects a type filter the Files browser does not offer', async () => {
    const { adapters: a } = adapters();
    const params = { filters: { type: 'hologram' } } as unknown as Parameters<typeof search>[1];

    await expect(search('u1', params, a)).rejects.toThrow();
  });
});
```

Run: `pnpm --filter @bike4mind/database exec vitest run src/__tests__/fabFileSearchQuery.test.ts && pnpm --filter @bike4mind/services exec vitest run src/fabFileService/search.test.ts`
Expected: FAIL. `getMimeTypeFilter('video')` returns `undefined`; the services zod enum rejects `'video'`.

- [ ] **Step 4: Derive the database and services sites from common and add the video case**

`fabFileSearchQuery.ts`: add `type FabFileTypeFilter,` to the `@bike4mind/common` import. Change the signature and add the case:

```ts
export function getMimeTypeFilter(type: FabFileTypeFilter): Record<string, unknown> {
```

```ts
    case 'audio':
      return { mimeType: { $regex: '^audio/' } };
    case 'video':
      return { mimeType: { $regex: '^video/' } };
```

Delete the `export type FabFileFilterType = ...;` declaration (line ~337) and change `FabFileSearchParams.filters.type` to `type?: FabFileTypeFilter;`.

`FabFileModel.ts`: add `type FabFileTypeFilter,` to its `@bike4mind/common` import and change the `search` filter to `type?: FabFileTypeFilter;`.

`search.ts` (services): change the import to `import { FAB_FILE_TYPE_FILTERS, IFabFileRepository, IProjectRepository, type DataLakeMembershipScope } from '@bike4mind/common';` and the filter to:

```ts
      type: z.enum(FAB_FILE_TYPE_FILTERS).optional(),
```

Run: `pnpm --filter @bike4mind/database exec vitest run src/__tests__/fabFileSearchQuery.test.ts && pnpm --filter @bike4mind/services exec vitest run src/fabFileService/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing client test** (`apps/client/app/components/Files/Browser/constants.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { FAB_FILE_TYPE_FILTERS } from '@bike4mind/common';
import { FILE_TYPE_OPTIONS } from './constants';

describe('FILE_TYPE_OPTIONS', () => {
  it('offers "all" plus every type filter the server accepts, in order', () => {
    expect(FILE_TYPE_OPTIONS.map(option => option.value)).toEqual(['all', ...FAB_FILE_TYPE_FILTERS]);
  });

  it('labels the video filter', () => {
    expect(FILE_TYPE_OPTIONS).toContainEqual({ value: 'video', label: 'Video' });
  });
});
```

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/Files/Browser/constants.test.ts`
Expected: FAIL (no `video` option).

- [ ] **Step 6: Update the client sites**

`constants.ts`:

```ts
import type { FabFileTypeFilter } from '@bike4mind/common';

export const FILE_TYPE_OPTIONS = [
  { value: 'all', label: 'All Files Type' },
  { value: 'text', label: 'Text' },
  { value: 'pdf', label: 'PDF' },
  { value: 'url', label: 'URL' },
  { value: 'image', label: 'Image' },
  { value: 'excel', label: 'Excel' },
  { value: 'word', label: 'Word (DOCX)' },
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'code', label: 'Code' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
] as const satisfies ReadonlyArray<{ value: FabFileTypeFilter | 'all'; label: string }>;

export type FileTypeValue = Exclude<(typeof FILE_TYPE_OPTIONS)[number]['value'], 'all'>;
```

`Filter.tsx`: add `import { isFabFileTypeFilter } from '@bike4mind/common';` and in `handleFileTypeChange` replace `type: val === 'all' ? undefined : (val as any),` with:

```ts
        type: isFabFileTypeFilter(val) ? val : undefined,
```

`Content.tsx`: add `isFabFileTypeFilter` to an `@bike4mind/common` import and in `onFileTypeChange` replace `type: type === 'all' ? undefined : (type as any),` with:

```ts
                  type: isFabFileTypeFilter(type) ? type : undefined,
```

`fabFileKeys.ts`: add `import type { FabFileTypeFilter } from '@bike4mind/common';` (type-only, so the registry stays runtime-free) and change `FabFileListFilters.type` to `type?: FabFileTypeFilter;`.

`fabFileSearch.ts`: add `FabFileTypeFilter` to its `import type { ... } from '@bike4mind/common'` and change `ISearchFabFilesParams.filters.type` (line 113) to `type?: FabFileTypeFilter;`.

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/Files/Browser`
Expected: PASS (the new test and the existing Browser suites).

Run (dispatch to `verify`): `pnpm turbo:typecheck`
Expected: PASS. Then `command grep -rn "'code' | 'audio'" b4m-core/*/src packages/*/src apps/client/app` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add b4m-core/common/src/types/entities/FabFileTypes.ts b4m-core/common/src/types/entities/FabFileTypes.test.ts \
  packages/database/src/queries/fabFileSearchQuery.ts packages/database/src/models/content/FabFileModel.ts \
  packages/database/src/__tests__/fabFileSearchQuery.test.ts \
  b4m-core/services/src/fabFileService/search.ts b4m-core/services/src/fabFileService/search.test.ts \
  apps/client/app/components/Files/Browser/constants.ts apps/client/app/components/Files/Browser/constants.test.ts \
  apps/client/app/components/Files/Browser/Filter.tsx apps/client/app/components/Files/Browser/Content.tsx \
  apps/client/app/hooks/data/fabFileKeys.ts apps/client/app/hooks/data/fabFileSearch.ts
git commit -m "feat(files): add a video type filter from one shared filter list"
```

---

### Task 3: Video query keys, cache writes and error messages (client data layer)

**Files:**
- Create: `apps/client/app/hooks/data/videoGenerationKeys.ts`, `videoGenerationKeys.test.ts`
- Create: `apps/client/app/hooks/data/videoGenerationCache.ts`, `videoGenerationCache.test.ts`
- Create: `apps/client/app/hooks/data/videoGenerationErrors.ts`, `videoGenerationErrors.test.ts`
- Create: `apps/client/app/hooks/data/__test__/videoGenerationFixtures.ts` (test-only; not matched by vitest's `*.test.*` include)
- Modify: `apps/client/app/hooks/data/credits.ts` (export the balance key)

**Interfaces:**
- Produces `videoGenerationKeys`:
  - `all: ['videoGenerations']`, `models: ['videoGenerations', 'models']`, `list: ['videoGenerations', 'list']`, `details: ['videoGenerations', 'detail']`, `detail(id: string): ['videoGenerations', 'detail', id]`.
- Produces from `videoGenerationCache.ts`:
  - `type VideoGenerationPage = { data: VideoGeneration[]; next_cursor: string | null }`
  - `type VideoGenerationList = InfiniteData<VideoGenerationPage, string | undefined>`
  - `type VideoJobLiveUpdate = { id: string; state: GenerationJobState; progress?: number }`
  - `isTerminalVideoState(state: GenerationJobState): boolean`
  - `shouldReplaceVideoGeneration(existing: VideoGeneration | undefined, incoming: VideoGeneration): boolean`
  - `seedVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void`
  - `upsertVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void`
  - `prependVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void`
  - `patchVideoGeneration(queryClient: QueryClient, update: VideoJobLiveUpdate): boolean` (true when the job was cached in the detail or the list)
- Produces `describeVideoGenerationError(error: unknown, fallback: string): string` and `VIDEO_RATE_LIMITED_MESSAGE`.
- Produces `CREDITS_BALANCE_KEY = ['credits-balance'] as const` from `credits.ts`.
- Produces fixtures: `videoJob(overrides?)`, `readyOutput(overrides?)`, `listOf(...pages)`, `rangeModel`, `discreteModel`, `optionalAudioModel`.

- [ ] **Step 1: Write the fixtures module** (`__test__/videoGenerationFixtures.ts`)

```ts
/**
 * Test-only builders shared by the video data-layer, listener and studio component tests. App code must never
 * import this module. Model fixtures mirror the wire shape of GET /api/v1/video-models; rangeModel and
 * discreteModel use real catalog ids so estimates resolve, optionalAudioModel does not (no catalog model has
 * optional audio today).
 */
import type { VideoGeneration, VideoModel } from '@bike4mind/common';
import type { VideoGenerationList } from '../videoGenerationCache';

type VideoOutput = NonNullable<VideoGeneration['output']>;

export const videoJob = (overrides: Partial<VideoGeneration> = {}): VideoGeneration => ({
  id: 'job-1',
  object: 'video_generation',
  state: 'running',
  model: 'grok-imagine-video-1.5',
  mode: 'text_to_video',
  prompt: 'a lighthouse at dusk',
  duration_seconds: 6,
  aspect_ratio: '16:9',
  resolution: '480p',
  source: 'studio',
  progress: null,
  error: null,
  output: null,
  credits: { reserved: 10, settled: null },
  created_at: '2026-10-07T00:00:00.000Z',
  updated_at: '2026-10-07T00:00:00.000Z',
  ...overrides,
});

export const readyOutput = (overrides: Partial<VideoOutput> = {}): VideoOutput => ({
  availability: 'ready',
  url: 'https://files.example/video-1.mp4?sig=a',
  expires_at: '2026-10-07T00:15:00.000Z',
  content_type: 'video/mp4',
  duration_seconds: 6,
  file_id: 'file-1',
  ...overrides,
});

export const listOf = (...pages: VideoGeneration[][]): VideoGenerationList => ({
  pages: pages.map((data, index) => ({ data, next_cursor: index < pages.length - 1 ? `cursor-${index + 1}` : null })),
  pageParams: pages.map((_, index) => (index === 0 ? undefined : `cursor-${index}`)),
});

export const rangeModel: VideoModel = {
  id: 'grok-imagine-video-1.5',
  object: 'video_model',
  display_name: 'Grok Imagine Video 1.5',
  provider: 'xai',
  modes: ['text_to_video', 'image_to_video'],
  duration: { kind: 'range', min: 1, max: 15, step: 1 },
  aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
  resolutions: ['480p', '720p'],
  defaults: { duration_seconds: 6, aspect_ratio: '16:9', resolution: '480p' },
  audio: 'always',
  credits_per_second: { '480p': 133, '720p': 233 },
  deprecation_date: null,
};

export const discreteModel: VideoModel = {
  id: 'veo-3.1-fast-generate-preview',
  object: 'video_model',
  display_name: 'Veo 3.1 Fast',
  provider: 'veo',
  modes: ['text_to_video', 'image_to_video'],
  duration: { kind: 'discrete', values: [4, 6, 8] },
  aspect_ratios: ['16:9', '9:16'],
  resolutions: ['720p'],
  defaults: { duration_seconds: 4, aspect_ratio: '16:9', resolution: '720p' },
  audio: 'always',
  credits_per_second: { '720p': 167 },
  deprecation_date: null,
};

export const optionalAudioModel: VideoModel = {
  id: 'synthetic-optional-audio',
  object: 'video_model',
  display_name: 'Synthetic Optional Audio',
  provider: 'test',
  modes: ['text_to_video'],
  duration: { kind: 'range', min: 2, max: 6, step: 2 },
  aspect_ratios: ['16:9'],
  resolutions: ['1080p'],
  defaults: { duration_seconds: 4, aspect_ratio: '16:9', resolution: '1080p' },
  audio: 'optional',
  credits_per_second: null,
  deprecation_date: null,
};
```

- [ ] **Step 2: Write the failing tests**

`videoGenerationKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { videoGenerationKeys } from './videoGenerationKeys';

// Pins each entry to its literal: if one changes shape, cached data silently detaches from its invalidations
// (the websocket listener and the list seed both write by these keys).
describe('videoGenerationKeys', () => {
  it('nests every key under the all prefix', () => {
    expect(videoGenerationKeys.all).toEqual(['videoGenerations']);
    expect(videoGenerationKeys.models).toEqual(['videoGenerations', 'models']);
    expect(videoGenerationKeys.list).toEqual(['videoGenerations', 'list']);
    expect(videoGenerationKeys.details).toEqual(['videoGenerations', 'detail']);
    expect(videoGenerationKeys.detail('job-1')).toEqual(['videoGenerations', 'detail', 'job-1']);
  });

  it('keeps details a prefix of every detail key', () => {
    expect(videoGenerationKeys.detail('job-1').slice(0, 2)).toEqual([...videoGenerationKeys.details]);
  });
});
```

`videoGenerationCache.test.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';
import type { VideoGeneration } from '@bike4mind/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { listOf, videoJob } from './__test__/videoGenerationFixtures';
import {
  isTerminalVideoState,
  patchVideoGeneration,
  prependVideoGeneration,
  seedVideoGeneration,
  shouldReplaceVideoGeneration,
  upsertVideoGeneration,
  type VideoGenerationList,
} from './videoGenerationCache';
import { videoGenerationKeys } from './videoGenerationKeys';

const LATER = '2026-10-07T00:01:00.000Z';
let queryClient: QueryClient;

const detail = (id: string) => queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(id));
const listIds = () =>
  queryClient.getQueryData<VideoGenerationList>(videoGenerationKeys.list)?.pages.map(page => page.data.map(j => j.id));
const listJob = (id: string) =>
  queryClient
    .getQueryData<VideoGenerationList>(videoGenerationKeys.list)
    ?.pages.flatMap(page => page.data)
    .find(job => job.id === id);

beforeEach(() => {
  queryClient = new QueryClient();
});

describe('isTerminalVideoState', () => {
  it.each(['succeeded', 'failed', 'blocked', 'cancelled'] as const)('%s is terminal', state => {
    expect(isTerminalVideoState(state)).toBe(true);
  });
  it.each(['pending', 'running', 'storing'] as const)('%s is not', state => {
    expect(isTerminalVideoState(state)).toBe(false);
  });
});

describe('shouldReplaceVideoGeneration', () => {
  it('replaces when nothing is cached', () => {
    expect(shouldReplaceVideoGeneration(undefined, videoJob())).toBe(true);
  });
  it('replaces with a newer or equally new snapshot', () => {
    expect(shouldReplaceVideoGeneration(videoJob(), videoJob({ updated_at: LATER }))).toBe(true);
    expect(shouldReplaceVideoGeneration(videoJob(), videoJob())).toBe(true);
  });
  it('keeps the cached job when the incoming one is older', () => {
    expect(shouldReplaceVideoGeneration(videoJob({ updated_at: LATER }), videoJob())).toBe(false);
  });
  it('never replaces a terminal job with a non-terminal one', () => {
    const cached = videoJob({ state: 'succeeded' });
    expect(shouldReplaceVideoGeneration(cached, videoJob({ state: 'running', updated_at: LATER }))).toBe(false);
  });
});

describe('seedVideoGeneration', () => {
  it('writes a listed job into its detail entry', () => {
    seedVideoGeneration(queryClient, videoJob());
    expect(detail('job-1')).toEqual(videoJob());
  });

  it('does not overwrite a newer cached job with an older list row', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'storing', updated_at: LATER }));
    seedVideoGeneration(queryClient, videoJob({ state: 'running' }));
    expect(detail('job-1')?.state).toBe('storing');
  });
});

describe('prependVideoGeneration', () => {
  it('puts a new job at the top of the first page and seeds its detail', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'old' })], [videoJob({ id: 'older' })]));
    prependVideoGeneration(queryClient, videoJob({ id: 'new' }));
    expect(listIds()).toEqual([['new', 'old'], ['older']]);
    expect(detail('new')?.id).toBe('new');
  });

  it('does not duplicate a replayed job already on the first page', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'a' }), videoJob({ id: 'b' })]));
    prependVideoGeneration(queryClient, videoJob({ id: 'b' }));
    expect(listIds()).toEqual([['b', 'a']]);
  });

  it('leaves an unloaded list alone', () => {
    prependVideoGeneration(queryClient, videoJob({ id: 'new' }));
    expect(queryClient.getQueryData(videoGenerationKeys.list)).toBeUndefined();
  });
});

describe('upsertVideoGeneration', () => {
  it('replaces the detail and the list row with the server response', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    upsertVideoGeneration(queryClient, videoJob({ state: 'cancelled', updated_at: LATER }));
    expect(detail('job-1')?.state).toBe('cancelled');
    expect(listJob('job-1')?.state).toBe('cancelled');
  });
});

describe('patchVideoGeneration', () => {
  it('patches state and progress into the detail and the list row', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob());
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    const found = patchVideoGeneration(queryClient, { id: 'job-1', state: 'running', progress: 0.4 });
    expect(found).toBe(true);
    expect(detail('job-1')).toMatchObject({ state: 'running', progress: 0.4 });
    expect(listJob('job-1')).toMatchObject({ state: 'running', progress: 0.4 });
  });

  it('keeps the last progress when a frame omits it', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ progress: 0.7 }));
    patchVideoGeneration(queryClient, { id: 'job-1', state: 'storing' });
    expect(detail('job-1')).toMatchObject({ state: 'storing', progress: 0.7 });
  });

  it('never regresses a terminal job', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'succeeded' }));
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ state: 'succeeded' })]));
    patchVideoGeneration(queryClient, { id: 'job-1', state: 'running', progress: 0.9 });
    expect(detail('job-1')?.state).toBe('succeeded');
    expect(listJob('job-1')?.state).toBe('succeeded');
  });

  it('reports a job it has never seen', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    expect(patchVideoGeneration(queryClient, { id: 'elsewhere', state: 'pending' })).toBe(false);
  });
});
```

`videoGenerationErrors.test.ts`:

```ts
import { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';
import { describeVideoGenerationError, VIDEO_RATE_LIMITED_MESSAGE } from './videoGenerationErrors';

const FALLBACK = 'Could not start the video. Try again.';
const axiosError = (status: number, data: unknown) =>
  Object.assign(new AxiosError('Request failed'), { response: { status, data } });

describe('describeVideoGenerationError', () => {
  it('maps an errorCode to its message', () => {
    const error = axiosError(422, { error: 'x', request_id: 'r', errorCode: 'insufficient_credits' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe('You do not have enough credits for this video.');
  });

  it('maps a 404 input_image_not_found', () => {
    const error = axiosError(404, { error: 'x', request_id: 'r', errorCode: 'input_image_not_found' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe('The selected image was not found. Pick another image.');
  });

  it('never echoes the server text, even without a code', () => {
    const error = axiosError(500, { error: 'upstream said: quota exceeded for project 42', request_id: 'r' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe(FALLBACK);
  });

  it('ignores a code it does not know', () => {
    const error = axiosError(422, { error: 'x', request_id: 'r', errorCode: 'something_new' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe(FALLBACK);
  });

  it('explains a rate limit', () => {
    expect(describeVideoGenerationError(axiosError(429, { error: 'x' }), FALLBACK)).toBe(VIDEO_RATE_LIMITED_MESSAGE);
  });

  it('falls back for a non-HTTP error', () => {
    expect(describeVideoGenerationError(new Error('network'), FALLBACK)).toBe(FALLBACK);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/data/videoGenerationKeys.test.ts app/hooks/data/videoGenerationCache.test.ts app/hooks/data/videoGenerationErrors.test.ts`
Expected: FAIL (the three modules do not exist).

- [ ] **Step 4: Implement the three modules and the credits key**

`videoGenerationKeys.ts`:

```ts
/**
 * The single registry for every video-generation react-query key (mirrors fabFileKeys.ts). Never write one of
 * these keys as a literal outside this file; the parity test is the one exception.
 *
 * - `all` prefixes everything below.
 * - `details` prefixes every `detail(id)`. Every write into a detail goes through videoGenerationCache.ts.
 * - `list` is the gallery's infinite query (GET /api/v1/video-generations); its pages seed `detail(id)`.
 */
export const videoGenerationKeys = {
  all: ['videoGenerations'] as const,
  models: ['videoGenerations', 'models'] as const,
  list: ['videoGenerations', 'list'] as const,
  details: ['videoGenerations', 'detail'] as const,
  detail: (id: string) => ['videoGenerations', 'detail', id] as const,
};
```

`videoGenerationCache.ts`:

```ts
/**
 * Every write into the video-generation cache. The list seed, the create and cancel responses and the websocket
 * listener all go through here so one set of ordering rules decides what may overwrite what.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { TERMINAL_GENERATION_JOB_STATES, type GenerationJobState, type VideoGeneration } from '@bike4mind/common';
import { videoGenerationKeys } from './videoGenerationKeys';

export type VideoGenerationPage = { data: VideoGeneration[]; next_cursor: string | null };
export type VideoGenerationList = InfiniteData<VideoGenerationPage, string | undefined>;
export type VideoJobLiveUpdate = { id: string; state: GenerationJobState; progress?: number };

export const isTerminalVideoState = (state: GenerationJobState): boolean =>
  TERMINAL_GENERATION_JOB_STATES.includes(state);

// A terminal job is final, and a snapshot read earlier (a list request that was in flight while a detail
// refetch landed) must not replace a later one.
export const shouldReplaceVideoGeneration = (
  existing: VideoGeneration | undefined,
  incoming: VideoGeneration
): boolean => {
  if (!existing) return true;
  if (isTerminalVideoState(existing.state) && !isTerminalVideoState(incoming.state)) return false;
  return Date.parse(incoming.updated_at) >= Date.parse(existing.updated_at);
};

const mapListedJobs = (queryClient: QueryClient, mapJob: (job: VideoGeneration) => VideoGeneration): void => {
  queryClient.setQueryData<VideoGenerationList>(
    videoGenerationKeys.list,
    list => list && { ...list, pages: list.pages.map(page => ({ ...page, data: page.data.map(mapJob) })) }
  );
};

/** Writes a job read as part of a list into its detail entry, unless the cache already holds something newer. */
export function seedVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void {
  const key = videoGenerationKeys.detail(job.id);
  if (shouldReplaceVideoGeneration(queryClient.getQueryData<VideoGeneration>(key), job)) {
    queryClient.setQueryData(key, job);
  }
}

/** Writes an authoritative server response (cancel) into the detail entry and its list row. */
export function upsertVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void {
  queryClient.setQueryData(videoGenerationKeys.detail(job.id), job);
  mapListedJobs(queryClient, cached => (cached.id === job.id ? job : cached));
}

/** Puts a just-created job at the top of the gallery. A replayed create (same Idempotency-Key) moves, not doubles. */
export function prependVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void {
  queryClient.setQueryData(videoGenerationKeys.detail(job.id), job);
  queryClient.setQueryData<VideoGenerationList>(videoGenerationKeys.list, list => {
    if (!list || list.pages.length === 0) return list;
    const [first, ...rest] = list.pages;
    return {
      ...list,
      pages: [{ ...first, data: [job, ...first.data.filter(cached => cached.id !== job.id)] }, ...rest],
    };
  });
}

/** Applies a websocket frame's state and progress. Returns whether the job was cached anywhere. */
export function patchVideoGeneration(queryClient: QueryClient, update: VideoJobLiveUpdate): boolean {
  let found = false;
  const patch = (cached: VideoGeneration): VideoGeneration => {
    if (cached.id !== update.id) return cached;
    found = true;
    // Frames can arrive out of order; a finished job stays finished.
    if (isTerminalVideoState(cached.state)) return cached;
    return { ...cached, state: update.state, progress: update.progress ?? cached.progress };
  };
  queryClient.setQueryData<VideoGeneration>(videoGenerationKeys.detail(update.id), cached => cached && patch(cached));
  mapListedJobs(queryClient, patch);
  return found;
}
```

`videoGenerationErrors.ts`:

```ts
import { isAxiosError } from 'axios';
import { VIDEO_GENERATION_API_ERROR_CODES } from '@bike4mind/common';

type VideoGenerationApiErrorCode = (typeof VIDEO_GENERATION_API_ERROR_CODES)[number];

export const VIDEO_RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

// Keyed by the API's errorCode (b4m-core/common/src/schemas/videoGenerations.ts). The response's `error` text is
// never shown: user-facing messages come from the code (spec section 8).
const MESSAGES: Record<VideoGenerationApiErrorCode, string> = {
  unsupported_duration: 'This model does not support that duration.',
  unsupported_aspect_ratio: 'This model does not support that aspect ratio.',
  unsupported_resolution: 'This model does not support that resolution.',
  unsupported_mode: 'This model does not support that mode.',
  missing_input_image: 'Choose an image to animate.',
  unexpected_input_image: 'Remove the image, or switch to image to video.',
  unsupported_audio_option: 'This model does not let you turn audio on or off.',
  invalid_request: 'The request was not valid. Check the form and try again.',
  model_disabled: 'This model has been turned off. Pick another model.',
  model_unavailable: 'This model is not available right now. Pick another model.',
  insufficient_credits: 'You do not have enough credits for this video.',
  input_image_not_found: 'The selected image was not found. Pick another image.',
  idempotency_key_reused: 'This request was already sent with different settings. Try again.',
  invalid_idempotency_key: 'The request could not be sent. Try again.',
};

const isVideoApiErrorCode = (value: unknown): value is VideoGenerationApiErrorCode =>
  typeof value === 'string' && (VIDEO_GENERATION_API_ERROR_CODES as readonly string[]).includes(value);

const readErrorCode = (data: unknown): unknown =>
  typeof data === 'object' && data !== null && 'errorCode' in data ? data.errorCode : undefined;

export function describeVideoGenerationError(error: unknown, fallback: string): string {
  if (!isAxiosError(error)) return fallback;
  if (error.response?.status === 429) return VIDEO_RATE_LIMITED_MESSAGE;
  const code = readErrorCode(error.response?.data);
  return isVideoApiErrorCode(code) ? MESSAGES[code] : fallback;
}
```

`credits.ts`: add above `useGetCreditsBalance`:

```ts
export const CREDITS_BALANCE_KEY = ['credits-balance'] as const;
```

and change its `queryKey: ['credits-balance'],` to `queryKey: CREDITS_BALANCE_KEY,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/data/videoGenerationKeys.test.ts app/hooks/data/videoGenerationCache.test.ts app/hooks/data/videoGenerationErrors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/client/app/hooks/data/videoGenerationKeys.ts apps/client/app/hooks/data/videoGenerationKeys.test.ts \
  apps/client/app/hooks/data/videoGenerationCache.ts apps/client/app/hooks/data/videoGenerationCache.test.ts \
  apps/client/app/hooks/data/videoGenerationErrors.ts apps/client/app/hooks/data/videoGenerationErrors.test.ts \
  apps/client/app/hooks/data/__test__/videoGenerationFixtures.ts apps/client/app/hooks/data/credits.ts
git commit -m "feat(video): add the video query keys, cache writes and error messages"
```

---

### Task 4: Video generation hooks (models, gallery list, job detail, create, cancel)

**Files:**
- Create: `apps/client/app/hooks/data/videoGenerations.ts`
- Test: `apps/client/app/hooks/data/videoGenerations.test.tsx`

**Interfaces:**
- Consumes (Task 3): `videoGenerationKeys`; `isTerminalVideoState`, `seedVideoGeneration`, `prependVideoGeneration`, `upsertVideoGeneration`, `VideoGenerationPage`, `VideoGenerationList`; `describeVideoGenerationError`; `CREDITS_BALANCE_KEY`. `api` from `@client/app/contexts/ApiContext`; `useWebsocket`, `ReadyState` from `@client/app/contexts/WebsocketContext`.
- Produces:
  - `VIDEO_GALLERY_PAGE_SIZE = 12`, `SOCKET_DOWN_POLL_MS = 5_000`, `PENDING_SCAN_POLL_MS = 30_000`, `DETAIL_URL_REFRESH_LEAD_MS = 60_000`, `LIST_URL_REFRESH_LEAD_MS = 120_000`
  - `videoGenerationPollInterval(job: VideoGeneration | undefined, socketOpen: boolean, now: number): number | false`
  - `videoListRefreshInterval(list: VideoGenerationList | undefined, now: number): number | false`
  - `useVideoModels(): UseQueryResult<VideoModel[]>`
  - `useVideoGenerations(): UseInfiniteQueryResult<VideoGenerationList>`
  - `useVideoGeneration(jobId: string): UseQueryResult<VideoGeneration>`
  - `useCreateVideoGeneration(): UseMutationResult<VideoGeneration, Error, CreateVideoGenerationBody>`
  - `useCancelVideoGeneration(): UseMutationResult<VideoGeneration, Error, string>` (variable = job id)

- [ ] **Step 1: Write the failing tests** (`videoGenerations.test.tsx`)

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoGeneration } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  readyState: 1,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: h.readyState, subscribeToAction: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { listOf, readyOutput, videoJob } from './__test__/videoGenerationFixtures';
import type { VideoGenerationList } from './videoGenerationCache';
import { videoGenerationKeys } from './videoGenerationKeys';
import {
  DETAIL_URL_REFRESH_LEAD_MS,
  LIST_URL_REFRESH_LEAD_MS,
  PENDING_SCAN_POLL_MS,
  SOCKET_DOWN_POLL_MS,
  useCreateVideoGeneration,
  useVideoGenerations,
  videoGenerationPollInterval,
  videoListRefreshInterval,
} from './videoGenerations';

const NOW = Date.parse('2026-10-07T00:00:00.000Z');
const EXPIRES = '2026-10-07T00:15:00.000Z';

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.readyState = 1;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe('videoGenerationPollInterval', () => {
  it('polls every 5s while the socket is down and stops when it is open', () => {
    for (const state of ['pending', 'running', 'storing'] as const) {
      expect(videoGenerationPollInterval(videoJob({ state }), false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
      expect(videoGenerationPollInterval(videoJob({ state }), true, NOW)).toBe(false);
    }
  });

  it('re-reads a succeeded job every 30s while its file is being scanned', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ availability: 'pending_scan', url: null, expires_at: null }) });
    expect(videoGenerationPollInterval(job, true, NOW)).toBe(PENDING_SCAN_POLL_MS);
  });

  it('re-signs a ready URL shortly before it expires', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    expect(videoGenerationPollInterval(job, true, NOW)).toBe(Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS - NOW);
  });

  it('never returns a non-positive interval for an already expired URL', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    expect(videoGenerationPollInterval(job, true, Date.parse(EXPIRES) + 60_000)).toBeGreaterThan(0);
  });

  it('stops for a finished job with nothing left to refresh', () => {
    expect(videoGenerationPollInterval(videoJob({ state: 'failed' }), false, NOW)).toBe(false);
    const gone = videoJob({ state: 'succeeded', output: readyOutput({ availability: 'unavailable', url: null, expires_at: null }) });
    expect(videoGenerationPollInterval(gone, false, NOW)).toBe(false);
    expect(videoGenerationPollInterval(undefined, false, NOW)).toBe(false);
  });
});

describe('videoListRefreshInterval', () => {
  it('the list refresh fires before any card\'s own refresh', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    const list = listOf([job, videoJob({ id: 'job-2' })]);
    const listDelay = videoListRefreshInterval(list, NOW);
    const cardDelay = videoGenerationPollInterval(job, true, NOW);
    expect(listDelay).toBe(Date.parse(EXPIRES) - LIST_URL_REFRESH_LEAD_MS - NOW);
    expect(typeof listDelay === 'number' && typeof cardDelay === 'number' && listDelay < cardDelay).toBe(true);
  });

  it('does not refresh a list with no ready URL', () => {
    expect(videoListRefreshInterval(listOf([videoJob()]), NOW)).toBe(false);
    expect(videoListRefreshInterval(undefined, NOW)).toBe(false);
  });
});

describe('useVideoGenerations', () => {
  it('fetches the first page newest first and seeds every job into its detail entry', async () => {
    h.get.mockResolvedValue({ data: { data: [videoJob({ id: 'a' }), videoJob({ id: 'b' })], next_cursor: 'c1' } });
    const { result } = renderHook(() => useVideoGenerations(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledWith('/api/v1/video-generations', { params: { limit: 12 } });
    expect(result.current.hasNextPage).toBe(true);
    expect(queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail('b'))?.id).toBe('b');
  });

  it('passes the cursor for the next page', async () => {
    h.get
      .mockResolvedValueOnce({ data: { data: [videoJob({ id: 'a' })], next_cursor: 'c1' } })
      .mockResolvedValueOnce({ data: { data: [videoJob({ id: 'b' })], next_cursor: null } });
    const { result } = renderHook(() => useVideoGenerations(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(h.get).toHaveBeenLastCalledWith('/api/v1/video-generations', { params: { limit: 12, cursor: 'c1' } });
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('useCreateVideoGeneration', () => {
  const body = { model: 'grok-imagine-video-1.5', prompt: 'a lighthouse', mode: 'text_to_video' as const };

  it('puts the new job at the top of the gallery and refreshes the credit balance', async () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'old' })]));
    h.post.mockResolvedValue({ data: videoJob({ id: 'new', state: 'pending' }) });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/video-generations', body);
    const list = queryClient.getQueryData<VideoGenerationList>(videoGenerationKeys.list);
    expect(list?.pages[0].data.map(job => job.id)).toEqual(['new', 'old']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'] });
    expect(h.toastSuccess).toHaveBeenCalled();
  });

  it('toasts the message for the refusal code, not the server text', async () => {
    h.post.mockRejectedValue(
      Object.assign(new AxiosError('Request failed'), {
        response: { status: 422, data: { error: 'raw text', request_id: 'r', errorCode: 'model_disabled' } },
      })
    );
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(body).catch(() => undefined);
    });
    expect(h.toastError).toHaveBeenCalledWith('This model has been turned off. Pick another model.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/data/videoGenerations.test.tsx`
Expected: FAIL (module `./videoGenerations` not found).

- [ ] **Step 3: Implement** (`videoGenerations.ts`)

```ts
import { isAxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateVideoGenerationBody, VideoGeneration, VideoModel } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { CREDITS_BALANCE_KEY } from './credits';
import {
  isTerminalVideoState,
  prependVideoGeneration,
  seedVideoGeneration,
  upsertVideoGeneration,
  type VideoGenerationList,
  type VideoGenerationPage,
} from './videoGenerationCache';
import { describeVideoGenerationError } from './videoGenerationErrors';
import { videoGenerationKeys } from './videoGenerationKeys';

export const VIDEO_GALLERY_PAGE_SIZE = 12;
export const SOCKET_DOWN_POLL_MS = 5_000;
export const PENDING_SCAN_POLL_MS = 30_000;
// Signed URLs live 15 minutes (OUTPUT_URL_TTL_SECONDS on the server). The gallery list re-signs a whole page
// first (longer lead) so a page of cards sharing one expiry does not fire one request each: every video route is
// per-user rate-limited, as low as 10/min.
export const DETAIL_URL_REFRESH_LEAD_MS = 60_000;
export const LIST_URL_REFRESH_LEAD_MS = 120_000;
const MIN_REFETCH_MS = 1_000;

const msUntil = (expiresAt: string, leadMs: number, now: number): number =>
  Math.max(Date.parse(expiresAt) - leadMs - now, MIN_REFETCH_MS);

/** The fallback poll for one job; live updates normally arrive over the websocket (VideoGenerationUpdatesListener). */
export function videoGenerationPollInterval(
  job: VideoGeneration | undefined,
  socketOpen: boolean,
  now: number
): number | false {
  if (!job) return false;
  if (!isTerminalVideoState(job.state)) return socketOpen ? false : SOCKET_DOWN_POLL_MS;
  if (job.state !== 'succeeded' || !job.output) return false;
  if (job.output.availability === 'pending_scan') return PENDING_SCAN_POLL_MS;
  if (job.output.availability === 'ready' && job.output.expires_at) {
    return msUntil(job.output.expires_at, DETAIL_URL_REFRESH_LEAD_MS, now);
  }
  return false;
}

export function videoListRefreshInterval(list: VideoGenerationList | undefined, now: number): number | false {
  const expiries = (list?.pages ?? [])
    .flatMap(page => page.data)
    .flatMap(job => (job.output?.availability === 'ready' && job.output.expires_at ? [job.output.expires_at] : []));
  if (expiries.length === 0) return false;
  const earliest = expiries.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  return msUntil(earliest, LIST_URL_REFRESH_LEAD_MS, now);
}

export function useVideoModels() {
  return useQuery({
    queryKey: videoGenerationKeys.models,
    queryFn: async () => (await api.get<{ models: VideoModel[] }>('/api/v1/video-models')).data.models,
    staleTime: 5 * 60_000,
  });
}

export function useVideoGenerations() {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: videoGenerationKeys.list,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<VideoGenerationPage>('/api/v1/video-generations', {
        params: { limit: VIDEO_GALLERY_PAGE_SIZE, ...(pageParam && { cursor: pageParam }) },
      });
      response.data.data.forEach(job => seedVideoGeneration(queryClient, job));
      return response.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    refetchInterval: query => videoListRefreshInterval(query.state.data, Date.now()),
  });
}

export function useVideoGeneration(jobId: string) {
  const { readyState } = useWebsocket();
  const socketOpen = readyState === ReadyState.OPEN;
  return useQuery({
    queryKey: videoGenerationKeys.detail(jobId),
    queryFn: async () =>
      (await api.get<VideoGeneration>(`/api/v1/video-generations/${encodeURIComponent(jobId)}`)).data,
    enabled: jobId.length > 0,
    // List seeds and websocket patches keep this fresh; a mount right after a seed must not refetch.
    staleTime: 30_000,
    refetchInterval: query => videoGenerationPollInterval(query.state.data, socketOpen, Date.now()),
    retry: (failureCount, error) => !(isAxiosError(error) && error.response?.status === 404) && failureCount < 3,
  });
}

export function useCreateVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateVideoGenerationBody) =>
      (await api.post<VideoGeneration>('/api/v1/video-generations', body)).data,
    onSuccess: job => {
      prependVideoGeneration(queryClient, job);
      void queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY });
      toast.success('Video generation started');
    },
    onError: error => toast.error(describeVideoGenerationError(error, 'Could not start the video. Try again.')),
  });
}

export function useCancelVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) =>
      (await api.post<VideoGeneration>(`/api/v1/video-generations/${encodeURIComponent(jobId)}/cancel`)).data,
    // The job usually comes back still running with the cancel queued; the websocket delivers `cancelled`.
    onSuccess: job => upsertVideoGeneration(queryClient, job),
    onError: error => toast.error(describeVideoGenerationError(error, 'Could not cancel the video. Try again.')),
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/data/videoGenerations.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/hooks/data/videoGenerations.ts apps/client/app/hooks/data/videoGenerations.test.tsx
git commit -m "feat(video): add the video generation query and mutation hooks"
```

---

### Task 5: Global live-update listener for `generation_job_updated`

**Files:**
- Create: `apps/client/app/components/VideoGenerationUpdatesListener.ts`
- Test: `apps/client/app/components/VideoGenerationUpdatesListener.test.tsx`
- Modify: `apps/client/app/providers.tsx` (line ~197, next to `<WebsocketReactQueryInvalidateListener />`)

**Interfaces:**
- Consumes: `useWebsocket().subscribeToAction` / `.readyState`, `ReadyState`; `patchVideoGeneration`, `isTerminalVideoState` (Task 3); `videoGenerationKeys`; `CREDITS_BALANCE_KEY`.
- Produces: default-exported component `VideoGenerationUpdatesListener` (renders `null`), mounted once app-wide so phase 5's chat card is live with no extra wiring.

Frames: `{ action: 'generation_job_updated', job: { id, kind, state, progress?, error?, output? } }` (`b4m-core/common/src/schemas/actions.ts:349`). Only `state` and `progress` are trusted (Plan-time correction 2).

- [ ] **Step 1: Write the failing test** (`VideoGenerationUpdatesListener.test.tsx`)

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGenerationJobUpdatedAction, VideoGeneration } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  readyState: 1,
  handlers: [] as ((message: unknown) => Promise<void>)[],
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({
    readyState: h.readyState,
    subscribeToAction: (_action: string, callback: (message: unknown) => Promise<void>) => {
      h.handlers.push(callback);
      return () => {
        h.handlers = h.handlers.filter(entry => entry !== callback);
      };
    },
  }),
}));

import { listOf, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';
import VideoGenerationUpdatesListener from './VideoGenerationUpdatesListener';

let queryClient: QueryClient;

const renderListener = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <VideoGenerationUpdatesListener />
    </QueryClientProvider>
  );

const frame = (job: IGenerationJobUpdatedAction['job']): IGenerationJobUpdatedAction => ({
  action: 'generation_job_updated',
  job,
});

const send = async (message: IGenerationJobUpdatedAction) => {
  await act(async () => {
    await Promise.all(h.handlers.map(handler => handler(message)));
  });
};

const detail = (id: string) => queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(id));

beforeEach(() => {
  h.readyState = 1;
  h.handlers = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('VideoGenerationUpdatesListener', () => {
  it('patches a running frame into the job', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'pending' }));
    renderListener();
    await send(frame({ id: 'job-1', kind: 'video', state: 'running', progress: 0.25 }));
    expect(detail('job-1')).toMatchObject({ state: 'running', progress: 0.25 });
  });

  it('refetches a finished job and the credit balance instead of trusting the frame', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'running' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(
      frame({ id: 'job-1', kind: 'video', state: 'failed', error: { code: 'orphaned_submit', message: 'raw provider text' } })
    );
    expect(detail('job-1')).toMatchObject({ state: 'failed', error: null });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.detail('job-1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'] });
  });

  it('refreshes the gallery for a job started elsewhere', async () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'from-the-api', kind: 'video', state: 'pending' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
  });

  it('ignores other actions', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'pending' }));
    renderListener();
    await act(async () => {
      await Promise.all(h.handlers.map(handler => handler({ action: 'invalidate_query', queryKey: ['x'] })));
    });
    expect(detail('job-1')?.state).toBe('pending');
  });

  it('on reconnect refreshes the list and only the unfinished jobs, once', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('live'), videoJob({ id: 'live', state: 'running' }));
    queryClient.setQueryData(videoGenerationKeys.detail('done'), videoJob({ id: 'done', state: 'succeeded' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderListener();
    const tree = (
      <QueryClientProvider client={queryClient}>
        <VideoGenerationUpdatesListener />
      </QueryClientProvider>
    );

    // The first connect has nothing to catch up on.
    expect(invalidate).not.toHaveBeenCalled();

    h.readyState = 3;
    rerender(tree);
    h.readyState = 1;
    rerender(tree);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.detail('live'), exact: true });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: videoGenerationKeys.detail('done'), exact: true });
    expect(invalidate).toHaveBeenCalledTimes(2);

    rerender(tree);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoGenerationUpdatesListener.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the listener** (`VideoGenerationUpdatesListener.ts`)

```ts
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { VideoGeneration } from '@bike4mind/common';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { CREDITS_BALANCE_KEY } from '@client/app/hooks/data/credits';
import { isTerminalVideoState, patchVideoGeneration } from '@client/app/hooks/data/videoGenerationCache';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';

/**
 * Writes `generation_job_updated` frames for video jobs into the React Query cache, so every VideoJobCard (the
 * studio gallery, and the chat card in the agent-tool phase) is live without a subscription of its own.
 * A frame carries the stored error (internal code, possibly provider wording) and no signed URL, so only state
 * and progress are applied; a terminal frame refetches the job for its public error and output.
 * Mounted once, next to WebsocketReactQueryInvalidateListener (app/providers.tsx).
 */
const VideoGenerationUpdatesListener = () => {
  const { subscribeToAction, readyState } = useWebsocket();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToAction('generation_job_updated', async message => {
        if (message.action !== 'generation_job_updated' || message.job.kind !== 'video') return;
        const { id, state, progress } = message.job;
        const cached = patchVideoGeneration(queryClient, { id, state, progress });
        const pending: Promise<void>[] = [];
        // A job started on another surface (the API, the agent tool) while the gallery is open.
        if (!cached && queryClient.getQueryData(videoGenerationKeys.list)) {
          pending.push(queryClient.invalidateQueries({ queryKey: videoGenerationKeys.list }));
        }
        if (isTerminalVideoState(state)) {
          pending.push(queryClient.invalidateQueries({ queryKey: videoGenerationKeys.detail(id) }));
          pending.push(queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY }));
        }
        await Promise.all(pending);
      }),
    [queryClient, subscribeToAction]
  );

  // Frames sent while the socket was down are lost: catch up once per reconnect, never on the first connect.
  const hasOpenedRef = useRef(false);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = readyState === ReadyState.OPEN;
    if (isOpen && !wasOpenRef.current && hasOpenedRef.current) {
      void queryClient.invalidateQueries({ queryKey: videoGenerationKeys.list });
      for (const [key, job] of queryClient.getQueriesData<VideoGeneration>({ queryKey: videoGenerationKeys.details })) {
        if (job && !isTerminalVideoState(job.state)) {
          void queryClient.invalidateQueries({ queryKey: key, exact: true });
        }
      }
    }
    if (isOpen) hasOpenedRef.current = true;
    wasOpenRef.current = isOpen;
  }, [readyState, queryClient]);

  return null;
};

export default VideoGenerationUpdatesListener;
```

- [ ] **Step 4: Mount it** (`providers.tsx`)

Add the import next to the existing listener import:

```ts
import VideoGenerationUpdatesListener from '@client/app/components/VideoGenerationUpdatesListener';
```

and render it directly after `<WebsocketReactQueryInvalidateListener />`:

```tsx
            <WebsocketReactQueryInvalidateListener />
            <VideoGenerationUpdatesListener />
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoGenerationUpdatesListener.test.tsx app/contexts/ProviderBundle.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/client/app/components/VideoGenerationUpdatesListener.ts apps/client/app/components/VideoGenerationUpdatesListener.test.tsx apps/client/app/providers.tsx
git commit -m "feat(video): write generation_job_updated frames into the video cache"
```

---

### Task 6: Form rules as a pure module (`videoForm.ts`)

**Files:**
- Create: `apps/client/app/components/VideoStudio/videoForm.ts`
- Test: `apps/client/app/components/VideoStudio/videoForm.test.ts`

**Interfaces:**
- Consumes: `VideoModel`, `CreateVideoGenerationBody`, `VideoMode`, `AspectRatio`, `ResolutionTier`, `VIDEO_MODEL_CATALOG`, `VideoModelIdSchema`, `estimateVideoCostCredits` from `@bike4mind/common`.
- Produces:
  - `VIDEO_PROMPT_MAX_LENGTH = 4000`
  - `type VideoInputImage = { fileId: string; fileName: string }`
  - `type VideoFormState = { modelId: string; mode: VideoMode; prompt: string; durationSeconds: number; aspectRatio: AspectRatio; resolution: ResolutionTier; audio: boolean | null; inputImage: VideoInputImage | null }` (`audio` is `null` unless the model's audio is `'optional'`)
  - `MODE_LABELS: Record<VideoMode, string>`
  - `initialFormFor(model: VideoModel): VideoFormState`
  - `snapDuration(seconds: number, duration: VideoModel['duration']): number`
  - `clampToModel(state: VideoFormState, model: VideoModel): { state: VideoFormState; changes: string[] }`
  - `toCreateBody(state: VideoFormState): CreateVideoGenerationBody`
  - `canSubmit(state: VideoFormState): boolean`
  - `estimateCredits(state: VideoFormState): number | null`

- [ ] **Step 1: Write the failing test** (`videoForm.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { estimateVideoCostCredits, VIDEO_MODEL_CATALOG } from '@bike4mind/common';
import {
  discreteModel,
  optionalAudioModel,
  rangeModel,
} from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  snapDuration,
  toCreateBody,
  VIDEO_PROMPT_MAX_LENGTH,
  type VideoFormState,
} from './videoForm';

const IMAGE = { fileId: 'img-1', fileName: 'harbor.png' };
const form = (overrides: Partial<VideoFormState> = {}): VideoFormState => ({
  ...initialFormFor(rangeModel),
  prompt: 'a lighthouse at dusk',
  ...overrides,
});

describe('initialFormFor', () => {
  it('starts from the model defaults in text to video', () => {
    expect(initialFormFor(rangeModel)).toEqual({
      modelId: 'grok-imagine-video-1.5',
      mode: 'text_to_video',
      prompt: '',
      durationSeconds: 6,
      aspectRatio: '16:9',
      resolution: '480p',
      audio: null,
      inputImage: null,
    });
  });

  it('turns audio on only for a model where it is optional', () => {
    expect(initialFormFor(optionalAudioModel).audio).toBe(true);
    expect(initialFormFor(discreteModel).audio).toBeNull();
  });
});

describe('snapDuration', () => {
  it('picks the nearest discrete value, the shorter on a tie', () => {
    expect(snapDuration(5, discreteModel.duration)).toBe(4);
    expect(snapDuration(7, discreteModel.duration)).toBe(6);
    expect(snapDuration(12, discreteModel.duration)).toBe(8);
    expect(snapDuration(1, discreteModel.duration)).toBe(4);
  });

  it('clamps a range and lands on a step', () => {
    expect(snapDuration(0, rangeModel.duration)).toBe(1);
    expect(snapDuration(20, rangeModel.duration)).toBe(15);
    expect(snapDuration(5, optionalAudioModel.duration)).toBe(6);
    expect(snapDuration(3, optionalAudioModel.duration)).toBe(4);
    expect(snapDuration(8, optionalAudioModel.duration)).toBe(6);
  });

  it('keeps an allowed value', () => {
    expect(snapDuration(6, discreteModel.duration)).toBe(6);
    expect(snapDuration(9, rangeModel.duration)).toBe(9);
  });
});

describe('clampToModel', () => {
  it('reports nothing when every value fits', () => {
    const result = clampToModel(form({ durationSeconds: 6, aspectRatio: '9:16' }), discreteModel);
    expect(result.changes).toEqual([]);
    expect(result.state).toMatchObject({ modelId: discreteModel.id, durationSeconds: 6, aspectRatio: '9:16' });
  });

  it('snaps a range duration onto a discrete model and says so', () => {
    const result = clampToModel(form({ durationSeconds: 7 }), discreteModel);
    expect(result.state.durationSeconds).toBe(6);
    expect(result.changes).toContain('Duration changed from 7s to 6s.');
  });

  it('falls back to the model default aspect ratio and resolution', () => {
    const result = clampToModel(form({ aspectRatio: '1:1', resolution: '480p' }), discreteModel);
    expect(result.state).toMatchObject({ aspectRatio: '16:9', resolution: '720p' });
    expect(result.changes).toEqual(
      expect.arrayContaining(['Aspect ratio changed from 1:1 to 16:9.', 'Resolution changed from 480p to 720p.'])
    );
  });

  it('switches mode and drops the image when the model cannot animate an image', () => {
    const result = clampToModel(form({ mode: 'image_to_video', inputImage: IMAGE, durationSeconds: 4 }), optionalAudioModel);
    expect(result.state).toMatchObject({ mode: 'text_to_video', inputImage: null });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        'Synthetic Optional Audio does not support image to video; switched to text to video.',
        'Removed the input image (harbor.png).',
      ])
    );
  });

  it('keeps the image when the new model also animates images', () => {
    const result = clampToModel(form({ mode: 'image_to_video', inputImage: IMAGE }), discreteModel);
    expect(result.state.inputImage).toEqual(IMAGE);
  });

  it('turns audio back on, with a note, for a model that always generates it', () => {
    const start = { ...clampToModel(form(), optionalAudioModel).state, audio: false };
    const result = clampToModel(start, discreteModel);
    expect(result.state.audio).toBeNull();
    expect(result.changes).toContain('Veo 3.1 Fast always generates audio.');
  });

  it('defaults audio on when moving to a model where it is optional', () => {
    const result = clampToModel(form({ durationSeconds: 4 }), optionalAudioModel);
    expect(result.state.audio).toBe(true);
    expect(result.changes.some(change => change.toLowerCase().includes('audio'))).toBe(false);
  });
});

describe('toCreateBody', () => {
  it('sends the trimmed prompt and the chosen values, without audio for a fixed-audio model', () => {
    expect(toCreateBody(form({ prompt: '  a lighthouse  ' }))).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'a lighthouse',
      mode: 'text_to_video',
      duration_seconds: 6,
      aspect_ratio: '16:9',
      resolution: '480p',
    });
  });

  it('sends audio only when the model lets the user choose', () => {
    const state = { ...clampToModel(form({ durationSeconds: 4 }), optionalAudioModel).state, audio: false };
    expect(toCreateBody(state)).toMatchObject({ audio: false });
  });

  it('sends the image only in image to video', () => {
    expect(toCreateBody(form({ mode: 'image_to_video', inputImage: IMAGE }))).toMatchObject({
      mode: 'image_to_video',
      input_image_file_id: 'img-1',
    });
    expect(toCreateBody(form({ mode: 'text_to_video', inputImage: IMAGE }))).not.toHaveProperty('input_image_file_id');
  });
});

describe('canSubmit', () => {
  it('needs a non-blank prompt within the limit', () => {
    expect(canSubmit(form({ prompt: '   ' }))).toBe(false);
    expect(canSubmit(form({ prompt: 'x'.repeat(VIDEO_PROMPT_MAX_LENGTH + 1) }))).toBe(false);
    expect(canSubmit(form({ prompt: 'x'.repeat(VIDEO_PROMPT_MAX_LENGTH) }))).toBe(true);
  });

  it('needs an image in image to video', () => {
    expect(canSubmit(form({ mode: 'image_to_video', inputImage: null }))).toBe(false);
    expect(canSubmit(form({ mode: 'image_to_video', inputImage: IMAGE }))).toBe(true);
  });
});

describe('estimateCredits', () => {
  it('matches the server-side estimate for a catalog model', () => {
    const state = form({ durationSeconds: 9, resolution: '720p' });
    expect(estimateCredits(state)).toBe(
      estimateVideoCostCredits(VIDEO_MODEL_CATALOG['grok-imagine-video-1.5'], {
        model: 'grok-imagine-video-1.5',
        mode: 'text_to_video',
        prompt: state.prompt,
        durationSeconds: 9,
        aspectRatio: '16:9',
        resolution: '720p',
      })
    );
  });

  it('is null for a model the catalog does not know', () => {
    expect(estimateCredits(initialFormFor(optionalAudioModel))).toBeNull();
  });

  it('is null for a resolution the catalog has no price for', () => {
    expect(estimateCredits(form({ modelId: discreteModel.id, durationSeconds: 4, resolution: '4k' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/videoForm.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`videoForm.ts`)

```ts
/**
 * The studio form's rules, kept free of React: defaults per model, what changes when the user switches model,
 * the request body, and the credit estimate. The server never rounds a request (validateAgainstCapabilities),
 * so the form is where values are moved onto what the model supports, and every move is reported to the user.
 */
import {
  estimateVideoCostCredits,
  VIDEO_MODEL_CATALOG,
  VideoModelIdSchema,
  type AspectRatio,
  type CreateVideoGenerationBody,
  type ResolutionTier,
  type VideoMode,
  type VideoModel,
} from '@bike4mind/common';

// Must match the prompt max in CreateVideoGenerationBodySchema (b4m-core/common/src/schemas/videoGenerations.ts).
export const VIDEO_PROMPT_MAX_LENGTH = 4000;

export type VideoInputImage = { fileId: string; fileName: string };

export type VideoFormState = {
  modelId: string;
  mode: VideoMode;
  prompt: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  resolution: ResolutionTier;
  // null unless the model's audio is 'optional'; the request then omits `audio` (the server rejects it otherwise).
  audio: boolean | null;
  inputImage: VideoInputImage | null;
};

export const MODE_LABELS: Record<VideoMode, string> = {
  text_to_video: 'Text to video',
  image_to_video: 'Image to video',
};

const lower = (mode: VideoMode): string => MODE_LABELS[mode].toLowerCase();

export function initialFormFor(model: VideoModel): VideoFormState {
  return {
    modelId: model.id,
    mode: model.modes.includes('text_to_video') ? 'text_to_video' : model.modes[0],
    prompt: '',
    durationSeconds: model.defaults.duration_seconds,
    aspectRatio: model.defaults.aspect_ratio,
    resolution: model.defaults.resolution,
    audio: model.audio === 'optional' ? true : null,
    inputImage: null,
  };
}

export function snapDuration(seconds: number, duration: VideoModel['duration']): number {
  if (duration.kind === 'discrete') {
    // Nearest allowed value; a tie goes to the shorter, cheaper clip.
    return duration.values.reduce((best, value) => {
      const distance = Math.abs(value - seconds);
      const bestDistance = Math.abs(best - seconds);
      return distance < bestDistance || (distance === bestDistance && value < best) ? value : best;
    });
  }
  const clamped = Math.min(Math.max(seconds, duration.min), duration.max);
  const snapped = duration.min + Math.round((clamped - duration.min) / duration.step) * duration.step;
  // Rounding up can step past max when (max - min) is not a whole number of steps.
  const inRange = snapped > duration.max ? snapped - duration.step : snapped;
  return Number(inRange.toFixed(6));
}

export function clampToModel(state: VideoFormState, model: VideoModel): { state: VideoFormState; changes: string[] } {
  const changes: string[] = [];
  const name = model.display_name;

  const mode = model.modes.includes(state.mode) ? state.mode : model.modes[0];
  if (mode !== state.mode) {
    changes.push(`${name} does not support ${lower(state.mode)}; switched to ${lower(mode)}.`);
  }

  const inputImage = mode === 'image_to_video' ? state.inputImage : null;
  if (state.inputImage && !inputImage) changes.push(`Removed the input image (${state.inputImage.fileName}).`);

  const durationSeconds = snapDuration(state.durationSeconds, model.duration);
  if (durationSeconds !== state.durationSeconds) {
    changes.push(`Duration changed from ${state.durationSeconds}s to ${durationSeconds}s.`);
  }

  const aspectRatio = model.aspect_ratios.includes(state.aspectRatio) ? state.aspectRatio : model.defaults.aspect_ratio;
  if (aspectRatio !== state.aspectRatio) {
    changes.push(`Aspect ratio changed from ${state.aspectRatio} to ${aspectRatio}.`);
  }

  const resolution = model.resolutions.includes(state.resolution) ? state.resolution : model.defaults.resolution;
  if (resolution !== state.resolution) {
    changes.push(`Resolution changed from ${state.resolution} to ${resolution}.`);
  }

  // A non-null audio means the previous model let the user choose; only then is a change worth reporting.
  const audio = model.audio === 'optional' ? (state.audio ?? true) : null;
  if (state.audio === false && model.audio === 'always') changes.push(`${name} always generates audio.`);
  if (state.audio === true && model.audio === 'none') changes.push(`${name} generates video without audio.`);

  return {
    state: { ...state, modelId: model.id, mode, inputImage, durationSeconds, aspectRatio, resolution, audio },
    changes,
  };
}

export function toCreateBody(state: VideoFormState): CreateVideoGenerationBody {
  return {
    model: state.modelId,
    prompt: state.prompt.trim(),
    mode: state.mode,
    duration_seconds: state.durationSeconds,
    aspect_ratio: state.aspectRatio,
    resolution: state.resolution,
    ...(state.mode === 'image_to_video' && state.inputImage && { input_image_file_id: state.inputImage.fileId }),
    ...(state.audio !== null && { audio: state.audio }),
  };
}

export function canSubmit(state: VideoFormState): boolean {
  const prompt = state.prompt.trim();
  if (prompt.length === 0 || prompt.length > VIDEO_PROMPT_MAX_LENGTH) return false;
  return state.mode !== 'image_to_video' || state.inputImage !== null;
}

/** The same estimate the server holds credits with (spec 11.5), or null when it cannot be computed. */
export function estimateCredits(state: VideoFormState): number | null {
  const model = VideoModelIdSchema.safeParse(state.modelId);
  if (!model.success) return null;
  try {
    return estimateVideoCostCredits(VIDEO_MODEL_CATALOG[model.data], {
      model: model.data,
      mode: state.mode,
      prompt: state.prompt,
      durationSeconds: state.durationSeconds,
      aspectRatio: state.aspectRatio,
      resolution: state.resolution,
    });
  } catch {
    // The catalog declares no price for this combination; the form shows "unavailable" rather than a wrong number.
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/videoForm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/VideoStudio/videoForm.ts apps/client/app/components/VideoStudio/videoForm.test.ts
git commit -m "feat(video): add the studio form rules for defaults, clamping and estimates"
```

---

### Task 7: `ImageBrowserModal` title and empty-state hint

**Files:**
- Modify: `apps/client/app/components/Agent/ImageBrowserModal.tsx` (props, line 18-41; title line ~56; empty hint line ~78)
- Create: `apps/client/app/components/Agent/ImageBrowserModal.test.tsx`

**Interfaces:**
- Produces: two optional props, `title?: string` (default `'Select Portrait Image'`) and `emptyHint?: string` (default `'Upload images through the File Browser to use them as agent portraits'`). Existing callers (`AgentForm`, `ContentPreviewModal`) are unchanged.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import ImageBrowserModal from './ImageBrowserModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = (extra: { title?: string; emptyHint?: string } = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ImageBrowserModal
        isOpen
        onClose={vi.fn()}
        imageSearch=""
        onImageSearchChange={vi.fn()}
        isLoadingImages={false}
        imageFiles={[]}
        selectedImage={null}
        onSelectImage={vi.fn()}
        onApplyImage={vi.fn()}
        onSearch={vi.fn()}
        {...extra}
      />
    </CssVarsProvider>
  );

describe('ImageBrowserModal', () => {
  it('keeps the portrait wording by default', () => {
    renderModal();
    expect(screen.getByText('Select Portrait Image')).toBeInTheDocument();
    expect(screen.getByText(/agent portraits/)).toBeInTheDocument();
  });

  it('takes a caller title and empty hint', () => {
    renderModal({ title: 'Choose an image to animate', emptyHint: 'Upload images in Files to animate them here.' });
    expect(screen.getByText('Choose an image to animate')).toBeInTheDocument();
    expect(screen.getByText('Upload images in Files to animate them here.')).toBeInTheDocument();
    expect(screen.queryByText('Select Portrait Image')).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/Agent/ImageBrowserModal.test.tsx`
Expected: FAIL in "takes a caller title and empty hint" (the title is hard-coded).

- [ ] **Step 2: Implement**

Add to `ImageBrowserModalProps`:

```ts
  title?: string;
  emptyHint?: string;
```

Destructure with defaults:

```ts
  onSearch,
  title = 'Select Portrait Image',
  emptyHint = 'Upload images through the File Browser to use them as agent portraits',
}) => {
```

Replace the hard-coded heading text with `{title}` and the empty-state `body-sm` text with `{emptyHint}`.

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/Agent/ImageBrowserModal.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/client/app/components/Agent/ImageBrowserModal.tsx apps/client/app/components/Agent/ImageBrowserModal.test.tsx
git commit -m "feat(video): let the image browser modal take a title and empty hint"
```

---

### Task 8: `VideoJobCard` (standalone, keyed by `jobId`)

**Files:**
- Create: `apps/client/app/components/VideoStudio/VideoJobCard.tsx`
- Test: `apps/client/app/components/VideoStudio/VideoJobCard.test.tsx`

**Interfaces:**
- Consumes: `useVideoGeneration(jobId)`, `useCancelVideoGeneration()` (Task 4); `isTerminalVideoState` (Task 3); `useFileBrowser` from `@client/app/components/Files/fileBrowserStore`; `downloadData(data: BlobPart, filename: string, type?: string)`, `downloadUrl(url: string, filename: string)` from `@client/app/utils/download`.
- Produces: default export `VideoJobCard({ jobId }: { jobId: string })`; exported `useStablePlayerSrc(latestUrl: string | null, refresh: () => void): { src: string | null; onError: () => void; onLoaded: () => void }` and `MAX_PLAYER_URL_REFRESHES = 2`. Phase 5 renders `<VideoJobCard jobId={...} />` in chat.

States: `pending` Queued, `running` Generating (determinate progress when known), `storing` Saving, `succeeded` + `ready` plays inline, `succeeded` + `pending_scan` note, `succeeded` + `unavailable` (or no output) note, `failed`/`blocked`/`cancelled` show the server's code-derived message. Cancel in `pending`/`running` only (Plan-time correction 3). Download when ready. Open in Files when `output.file_id` and the output is not unavailable (Plan-time correction 4).

- [ ] **Step 1: Write the failing test** (`VideoJobCard.test.tsx`)

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoGeneration } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  query: {} as { data?: VideoGeneration; isPending: boolean; isError: boolean; refetch: ReturnType<typeof vi.fn> },
  cancel: { mutate: vi.fn(), isPending: false, isSuccess: false },
  setOpen: vi.fn(),
  downloadData: vi.fn(),
  downloadUrl: vi.fn(),
}));

vi.mock('@client/app/hooks/data/videoGenerations', () => ({
  useVideoGeneration: () => h.query,
  useCancelVideoGeneration: () => h.cancel,
}));
vi.mock('@client/app/components/Files/fileBrowserStore', () => ({
  useFileBrowser: (selector: (state: { setOpen: (open: boolean) => void }) => unknown) =>
    selector({ setOpen: h.setOpen }),
}));
vi.mock('@client/app/utils/download', () => ({ downloadData: h.downloadData, downloadUrl: h.downloadUrl }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { readyOutput, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoJobCard, { MAX_PLAYER_URL_REFRESHES } from './VideoJobCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const card = () => (
  <CssVarsProvider theme={appTheme}>
    <VideoJobCard jobId="job-1" />
  </CssVarsProvider>
);

const showJob = (job: VideoGeneration) => {
  h.query = { data: job, isPending: false, isError: false, refetch: vi.fn().mockResolvedValue({ data: job }) };
};
const succeeded = (output: VideoGeneration['output']) => videoJob({ state: 'succeeded', progress: 1, output });

beforeEach(() => {
  vi.clearAllMocks();
  h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: false };
});
afterEach(() => vi.unstubAllGlobals());

describe('VideoJobCard states', () => {
  it('shows a queued job with Cancel', () => {
    showJob(videoJob({ state: 'pending' }));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Queued');
    expect(screen.getByTestId('video-job-card-progress')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-job-card-cancel-btn'));
    expect(h.cancel.mutate).toHaveBeenCalledWith('job-1');
  });

  it('shows the progress of a running job', () => {
    showJob(videoJob({ state: 'running', progress: 0.4 }));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Generating');
    expect(screen.getByTestId('video-job-card-progress-label')).toHaveTextContent('40%');
  });

  it('says Cancelling once a cancel is accepted and the job is still running', () => {
    showJob(videoJob({ state: 'running' }));
    h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: true };
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Cancelling');
    expect(screen.getByTestId('video-job-card-cancel-btn')).toBeDisabled();
  });

  it('offers no Cancel while storing (the clip is already paid for)', () => {
    showJob(videoJob({ state: 'storing' }));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Saving');
    expect(screen.queryByTestId('video-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('plays a ready video inline and offers Download and Open in Files', () => {
    showJob(succeeded(readyOutput()));
    render(card());
    expect(screen.getByTestId('video-job-card-player')).toHaveAttribute('src', readyOutput().url);
    expect(screen.getByTestId('video-job-card-download-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-job-card-open-files-btn'));
    expect(h.setOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId('video-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('has no Open in Files for a clip stored outside Files', () => {
    showJob(succeeded(readyOutput({ file_id: null })));
    render(card());
    expect(screen.queryByTestId('video-job-card-open-files-btn')).not.toBeInTheDocument();
  });

  it('explains a clip that is still being scanned', () => {
    showJob(succeeded(readyOutput({ availability: 'pending_scan', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('video-job-card-scan-note')).toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-player')).not.toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-download-btn')).not.toBeInTheDocument();
  });

  it('explains a clip that is no longer available', () => {
    showJob(succeeded(readyOutput({ availability: 'unavailable', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('video-job-card-unavailable-note')).toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-open-files-btn')).not.toBeInTheDocument();
  });

  it.each([
    ['failed', 'provider_error', 'The provider failed to generate the video.'],
    ['blocked', 'content_blocked', 'The provider declined to generate this video under its content policy.'],
    ['cancelled', 'cancelled', 'The generation was cancelled.'],
  ] as const)('shows the server message for a %s job', (state, code, message) => {
    showJob(videoJob({ state, error: { code, message } }));
    render(card());
    expect(screen.getByTestId('video-job-card-error')).toHaveTextContent(message);
    expect(screen.queryByTestId('video-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('says so when the job cannot be loaded', () => {
    h.query = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    render(card());
    expect(screen.getByTestId('video-job-card-missing')).toBeInTheDocument();
  });
});

describe('VideoJobCard playback URL', () => {
  it('keeps the player src across a re-sign and swaps on error', () => {
    showJob(succeeded(readyOutput({ url: 'https://files.example/a' })));
    const { rerender } = render(card());
    showJob(succeeded(readyOutput({ url: 'https://files.example/b' })));
    rerender(card());
    const player = screen.getByTestId('video-job-card-player');
    expect(player).toHaveAttribute('src', 'https://files.example/a');
    fireEvent.error(player);
    expect(screen.getByTestId('video-job-card-player')).toHaveAttribute('src', 'https://files.example/b');
  });

  it('stops refreshing after MAX_PLAYER_URL_REFRESHES failed loads', () => {
    showJob(succeeded(readyOutput()));
    render(card());
    for (let attempt = 0; attempt < MAX_PLAYER_URL_REFRESHES + 3; attempt += 1) {
      fireEvent.error(screen.getByTestId('video-job-card-player'));
    }
    expect(h.query.refetch).toHaveBeenCalledTimes(MAX_PLAYER_URL_REFRESHES);
  });
});

describe('VideoJobCard download', () => {
  it('re-reads the job and saves the fresh URL as a file', async () => {
    showJob(succeeded(readyOutput()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['clip']) }));
    render(card());
    fireEvent.click(screen.getByTestId('video-job-card-download-btn'));
    await waitFor(() =>
      expect(h.downloadData).toHaveBeenCalledWith(expect.any(Blob), 'video-job-1.mp4', 'video/mp4')
    );
    expect(h.query.refetch).toHaveBeenCalled();
  });

  it('falls back to a plain link when the browser cannot read the file', async () => {
    showJob(succeeded(readyOutput()));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(card());
    fireEvent.click(screen.getByTestId('video-job-card-download-btn'));
    await waitFor(() => expect(h.downloadUrl).toHaveBeenCalledWith(readyOutput().url, 'video-job-1.mp4'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/VideoJobCard.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`VideoJobCard.tsx`)

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Card, Chip, LinearProgress, Stack, Typography, type ColorPaletteProp } from '@mui/joy';
import { toast } from 'sonner';
import type { GenerationJobState, VideoGeneration } from '@bike4mind/common';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import { isTerminalVideoState } from '@client/app/hooks/data/videoGenerationCache';
import { useCancelVideoGeneration, useVideoGeneration } from '@client/app/hooks/data/videoGenerations';
import { downloadData, downloadUrl } from '@client/app/utils/download';

const STATE_LABELS: Record<GenerationJobState, string> = {
  pending: 'Queued',
  running: 'Generating',
  storing: 'Saving',
  succeeded: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const STATE_COLORS: Record<GenerationJobState, ColorPaletteProp> = {
  pending: 'neutral',
  running: 'primary',
  storing: 'primary',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'warning',
  cancelled: 'neutral',
};

// Used only if a terminal job somehow has no public error; the server normally sends a code-derived message.
const FAILURE_FALLBACK: Partial<Record<GenerationJobState, string>> = {
  failed: 'This video could not be generated.',
  blocked: 'The provider declined to generate this video.',
  cancelled: 'The generation was cancelled.',
};

// The server refuses to cancel a storing job: the provider has already produced, and charged for, the clip.
const CANCELLABLE_STATES: readonly GenerationJobState[] = ['pending', 'running'];

// A refreshed URL that fails again (the file was removed or blocked) must not loop.
export const MAX_PLAYER_URL_REFRESHES = 2;

/**
 * Re-signing (every ~14 minutes) must not restart a clip mid-play: keep the URL the player started with until the
 * element reports an error, then take the newest URL, asking for a fresh one at most MAX_PLAYER_URL_REFRESHES times.
 */
export function useStablePlayerSrc(latestUrl: string | null, refresh: () => void) {
  const [src, setSrc] = useState<string | null>(latestUrl);
  const [awaitingFresh, setAwaitingFresh] = useState(false);
  const refreshes = useRef(0);

  useEffect(() => {
    if (src === null && latestUrl) {
      setSrc(latestUrl);
      return;
    }
    if (awaitingFresh && latestUrl && latestUrl !== src) {
      setSrc(latestUrl);
      setAwaitingFresh(false);
    }
  }, [latestUrl, src, awaitingFresh]);

  const onError = useCallback(() => {
    if (latestUrl && latestUrl !== src) {
      setSrc(latestUrl);
      return;
    }
    if (refreshes.current >= MAX_PLAYER_URL_REFRESHES) return;
    refreshes.current += 1;
    setAwaitingFresh(true);
    refresh();
  }, [latestUrl, src, refresh]);

  const onLoaded = useCallback(() => {
    refreshes.current = 0;
  }, []);

  return { src, onError, onLoaded };
}

const videoFileName = (jobId: string, contentType: string | undefined): string =>
  `video-${jobId}.${contentType === 'video/webm' ? 'webm' : 'mp4'}`;

const VideoJobCard = ({ jobId }: { jobId: string }) => {
  const { data: job, isPending, isError, refetch } = useVideoGeneration(jobId);
  const cancel = useCancelVideoGeneration();
  const openFiles = useFileBrowser(state => state.setOpen);
  const refresh = useCallback(() => void refetch(), [refetch]);
  const readyUrl = job?.state === 'succeeded' && job.output?.availability === 'ready' ? job.output.url : null;
  const player = useStablePlayerSrc(readyUrl, refresh);

  const handleDownload = async (): Promise<void> => {
    // Re-read first: the cached URL may be close to expiry.
    const { data: fresh } = await refetch();
    const url = fresh?.output?.availability === 'ready' ? fresh.output.url : null;
    if (!fresh || !url) {
      toast.error('This video is not available to download.');
      return;
    }
    const fileName = videoFileName(fresh.id, fresh.output?.content_type);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed with ${response.status}`);
      downloadData(await response.blob(), fileName, fresh.output?.content_type);
    } catch (error) {
      // A cross-origin read can be refused; the browser can still fetch the signed URL itself.
      console.error('Video download through a blob failed; opening the signed URL instead', error);
      downloadUrl(url, fileName);
    }
  };

  if (isPending) {
    return (
      <Card variant="outlined" data-testid="video-job-card-loading">
        <LinearProgress />
      </Card>
    );
  }
  if (isError || !job) {
    return (
      <Card variant="outlined" data-testid="video-job-card-missing">
        <Typography level="body-sm">This video could not be loaded.</Typography>
      </Card>
    );
  }

  const terminal = isTerminalVideoState(job.state);
  const output: VideoGeneration['output'] = job.state === 'succeeded' ? job.output : null;
  const failureMessage = job.error?.message ?? FAILURE_FALLBACK[job.state];
  const statusLabel = cancel.isSuccess && !terminal ? 'Cancelling' : STATE_LABELS[job.state];

  return (
    <Card variant="outlined" data-testid="video-job-card" data-job-id={job.id} sx={{ gap: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Chip size="sm" variant="soft" color={STATE_COLORS[job.state]} data-testid="video-job-card-status">
          {statusLabel}
        </Chip>
        <Typography level="body-xs">
          {job.duration_seconds}s, {job.aspect_ratio}, {job.resolution}
        </Typography>
      </Stack>

      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }} data-testid="video-job-card-prompt">
        {job.prompt}
      </Typography>

      {!terminal && (
        <Stack gap={0.5}>
          <LinearProgress
            data-testid="video-job-card-progress"
            determinate={job.state === 'running' && job.progress !== null}
            value={job.progress !== null ? Math.round(job.progress * 100) : undefined}
          />
          {job.state === 'running' && job.progress !== null && (
            <Typography level="body-xs" data-testid="video-job-card-progress-label">
              {Math.round(job.progress * 100)}%
            </Typography>
          )}
        </Stack>
      )}

      {job.state === 'succeeded' && output?.availability === 'ready' && player.src && (
        <Box
          component="video"
          controls
          preload="metadata"
          src={player.src}
          onError={player.onError}
          onLoadedData={player.onLoaded}
          data-testid="video-job-card-player"
          sx={{ width: '100%', borderRadius: 'sm', backgroundColor: 'common.black' }}
        />
      )}
      {job.state === 'succeeded' && output?.availability === 'pending_scan' && (
        <Typography level="body-sm" data-testid="video-job-card-scan-note">
          Your video is being checked and will play here shortly.
        </Typography>
      )}
      {job.state === 'succeeded' && (!output || output.availability === 'unavailable') && (
        <Typography level="body-sm" data-testid="video-job-card-unavailable-note">
          This video is no longer available.
        </Typography>
      )}
      {failureMessage && (
        <Typography level="body-sm" color="danger" data-testid="video-job-card-error">
          {failureMessage}
        </Typography>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap">
        {CANCELLABLE_STATES.includes(job.state) && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            loading={cancel.isPending}
            disabled={cancel.isSuccess}
            onClick={() => cancel.mutate(job.id)}
            data-testid="video-job-card-cancel-btn"
          >
            Cancel
          </Button>
        )}
        {output?.availability === 'ready' && (
          <Button
            size="sm"
            variant="outlined"
            onClick={() => void handleDownload()}
            data-testid="video-job-card-download-btn"
          >
            Download
          </Button>
        )}
        {output?.file_id && output.availability !== 'unavailable' && (
          <Button size="sm" variant="plain" onClick={() => openFiles(true)} data-testid="video-job-card-open-files-btn">
            Open in Files
          </Button>
        )}
      </Stack>
    </Card>
  );
};

export default VideoJobCard;
```

`FAILURE_FALLBACK[job.state]` is `undefined` for non-failure states, so `failureMessage` is set only for `failed`/`blocked`/`cancelled` (the server sets `error` only on those).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/VideoJobCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/VideoStudio/VideoJobCard.tsx apps/client/app/components/VideoStudio/VideoJobCard.test.tsx
git commit -m "feat(video): add the standalone VideoJobCard"
```

---

### Task 9: `VideoStudioForm`

**Files:**
- Create: `apps/client/app/components/VideoStudio/VideoStudioForm.tsx`
- Test: `apps/client/app/components/VideoStudio/VideoStudioForm.test.tsx`

**Interfaces:**
- Consumes (Task 6): `VideoFormState`, `initialFormFor`, `clampToModel`, `toCreateBody`, `canSubmit`, `estimateCredits`, `MODE_LABELS`, `VIDEO_PROMPT_MAX_LENGTH`. (Task 7): `ImageBrowserModal` with `title`/`emptyHint`. `useImageBrowser` from `@client/app/hooks/agent/useImageBrowser`. `formatCredits` from `@client/app/utils/formatUsd`.
- Produces: default export `VideoStudioForm(props: { models: VideoModel[]; isSubmitting: boolean; onSubmit: (body: CreateVideoGenerationBody) => void })`. `models` is non-empty (the page renders an empty state otherwise).

- [ ] **Step 1: Write the failing test** (`VideoStudioForm.test.tsx`)

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFabFileDocument, VideoModel } from '@bike4mind/common';
import { estimateVideoCostCredits, VIDEO_MODEL_CATALOG } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { formatCredits } from '@client/app/utils/formatUsd';

const h = vi.hoisted(() => ({ openImageBrowser: vi.fn(), closeImageBrowser: vi.fn() }));

vi.mock('@client/app/hooks/agent/useImageBrowser', () => ({
  useImageBrowser: () => ({
    isImageBrowserOpen: true,
    imageFiles: [],
    isLoadingImages: false,
    selectedImage: null,
    imageSearch: '',
    setImageSearch: vi.fn(),
    openImageBrowser: h.openImageBrowser,
    closeImageBrowser: h.closeImageBrowser,
    selectImage: vi.fn(),
    applySelectedImage: vi.fn(),
    fetchImageFiles: vi.fn(),
  }),
}));
// The real modal is covered by its own test; here it only needs to hand an image back.
vi.mock('@client/app/components/Agent/ImageBrowserModal', () => ({
  default: ({ onApplyImage }: { onApplyImage: (file: IFabFileDocument) => void }) => (
    <button
      data-testid="mock-apply-image"
      onClick={() => onApplyImage({ id: 'img-1', fileName: 'harbor.png' } as IFabFileDocument)}
    />
  ),
}));

import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoStudioForm from './VideoStudioForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const onSubmit = vi.fn();

const tree = (models: VideoModel[]) => (
  <CssVarsProvider theme={appTheme}>
    <VideoStudioForm models={models} isSubmitting={false} onSubmit={onSubmit} />
  </CssVarsProvider>
);

const pickModel = (name: string) => {
  fireEvent.click(screen.getByTestId('video-form-model-select'));
  fireEvent.click(screen.getByRole('option', { name }));
};
const typePrompt = (text: string) =>
  fireEvent.change(screen.getByTestId('video-form-prompt-input'), { target: { value: text } });
const grokEstimate = (durationSeconds: number) =>
  formatCredits(
    estimateVideoCostCredits(VIDEO_MODEL_CATALOG['grok-imagine-video-1.5'], {
      model: 'grok-imagine-video-1.5',
      mode: 'text_to_video',
      prompt: '',
      durationSeconds,
      aspectRatio: '16:9',
      resolution: '480p',
    })
  );

beforeEach(() => vi.clearAllMocks());

describe('VideoStudioForm duration control', () => {
  it('renders a slider bounded by a range model', () => {
    render(tree([rangeModel]));
    const slider = screen.getByTestId('video-form-duration-slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '15');
    expect(screen.queryByTestId('video-form-duration-option-4')).not.toBeInTheDocument();
  });

  it('renders one choice per value for a discrete model', () => {
    render(tree([discreteModel]));
    expect(screen.queryByTestId('video-form-duration-slider')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-form-duration-option-8'));
    expect(screen.getByTestId('video-form-duration-option-8')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('video-form-duration-option-4')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('VideoStudioForm model switch', () => {
  it('clamps the duration and says what changed', () => {
    render(tree([discreteModel, optionalAudioModel]));
    fireEvent.click(screen.getByTestId('video-form-duration-option-8'));
    pickModel('Synthetic Optional Audio');
    expect(screen.getByTestId('video-form-changes')).toHaveTextContent('Duration changed from 8s to 6s.');
    expect(screen.getByTestId('video-form-duration-slider')).toHaveValue('6');
  });

  it('shows the audio switch only where audio is optional', () => {
    render(tree([discreteModel, optionalAudioModel]));
    expect(screen.queryByTestId('video-form-audio-switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('video-form-audio-note')).toHaveTextContent('Audio is included.');
    pickModel('Synthetic Optional Audio');
    expect(screen.getByTestId('video-form-audio-switch')).toBeChecked();
  });

  it('switches to an offered model when the selected one disappears', () => {
    const { rerender } = render(tree([rangeModel, discreteModel]));
    pickModel('Veo 3.1 Fast');
    rerender(tree([rangeModel]));
    expect(screen.getByTestId('video-form-changes')).toHaveTextContent(
      'The selected model is no longer available; switched to Grok Imagine Video 1.5.'
    );
    typePrompt('a lighthouse');
    fireEvent.click(screen.getByTestId('video-form-submit-btn'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ model: 'grok-imagine-video-1.5' }));
  });
});

describe('VideoStudioForm estimate', () => {
  it('shows the catalog estimate and follows the duration', () => {
    render(tree([rangeModel]));
    expect(screen.getByTestId('video-form-estimate')).toHaveTextContent(`Estimated cost: ${grokEstimate(6)} credits`);
    fireEvent.change(screen.getByTestId('video-form-duration-slider'), { target: { value: '10' } });
    expect(screen.getByTestId('video-form-estimate')).toHaveTextContent(`Estimated cost: ${grokEstimate(10)} credits`);
  });

  it('says when no estimate is available', () => {
    render(tree([optionalAudioModel]));
    expect(screen.getByTestId('video-form-estimate')).toHaveTextContent('Cost estimate unavailable');
  });
});

describe('VideoStudioForm submit', () => {
  it('is disabled until there is a prompt, then sends the body', () => {
    render(tree([rangeModel]));
    expect(screen.getByTestId('video-form-submit-btn')).toBeDisabled();
    typePrompt('  a lighthouse at dusk ');
    fireEvent.click(screen.getByTestId('video-form-submit-btn'));
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'grok-imagine-video-1.5',
      prompt: 'a lighthouse at dusk',
      mode: 'text_to_video',
      duration_seconds: 6,
      aspect_ratio: '16:9',
      resolution: '480p',
    });
  });

  it('needs an image in image to video and sends it', () => {
    render(tree([rangeModel]));
    typePrompt('make the waves move');
    fireEvent.click(within(screen.getByTestId('video-form-mode-toggle')).getByText('Image to video'));
    expect(screen.getByTestId('video-form-submit-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('video-form-image-pick-btn'));
    expect(h.openImageBrowser).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mock-apply-image'));
    expect(screen.getByTestId('video-form-image-name')).toHaveTextContent('harbor.png');
    fireEvent.click(screen.getByTestId('video-form-submit-btn'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'image_to_video', input_image_file_id: 'img-1' })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/VideoStudioForm.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`VideoStudioForm.tsx`)

```tsx
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  FormControl,
  FormLabel,
  Option,
  Select,
  Slider,
  Stack,
  Switch,
  Textarea,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import type { CreateVideoGenerationBody, VideoModel } from '@bike4mind/common';
import ImageBrowserModal from '@client/app/components/Agent/ImageBrowserModal';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import { formatCredits } from '@client/app/utils/formatUsd';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  MODE_LABELS,
  toCreateBody,
  VIDEO_PROMPT_MAX_LENGTH,
  type VideoFormState,
} from './videoForm';

type VideoStudioFormProps = {
  models: VideoModel[];
  isSubmitting: boolean;
  onSubmit: (body: CreateVideoGenerationBody) => void;
};

const VideoStudioForm = ({ models, isSubmitting, onSubmit }: VideoStudioFormProps) => {
  const [form, setForm] = useState<VideoFormState>(() => initialFormFor(models[0]));
  const [changes, setChanges] = useState<string[]>([]);
  const imageBrowser = useImageBrowser();
  const model = models.find(candidate => candidate.id === form.modelId);

  // The model list can change under the form (an admin disables a model, a key goes away). Move to a model that is
  // still offered and say so, rather than submit one the server will refuse with model_disabled.
  useEffect(() => {
    if (model || models.length === 0) return;
    const fallback = models[0];
    const clamped = clampToModel(form, fallback);
    setForm(clamped.state);
    setChanges([
      `The selected model is no longer available; switched to ${fallback.display_name}.`,
      ...clamped.changes,
    ]);
  }, [form, model, models]);

  if (!model) return null;

  const update = (patch: Partial<VideoFormState>) => setForm(previous => ({ ...previous, ...patch }));

  const selectModel = (modelId: string | null) => {
    const next = models.find(candidate => candidate.id === modelId);
    if (!next || next.id === form.modelId) return;
    const clamped = clampToModel(form, next);
    setForm(clamped.state);
    setChanges(clamped.changes);
  };

  const estimate = estimateCredits(form);
  const promptLength = form.prompt.trim().length;

  return (
    <Stack gap={2} data-testid="video-form">
      <FormControl>
        <FormLabel>Model</FormLabel>
        <Select
          value={form.modelId}
          onChange={(_event, value) => selectModel(value)}
          slotProps={{ button: { 'data-testid': 'video-form-model-select' } }}
        >
          {models.map(candidate => (
            <Option key={candidate.id} value={candidate.id}>
              {candidate.display_name}
            </Option>
          ))}
        </Select>
      </FormControl>

      {changes.length > 0 && (
        <Alert color="warning" variant="soft" data-testid="video-form-changes">
          <Stack>
            {changes.map(change => (
              <Typography key={change} level="body-sm">
                {change}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      <FormControl>
        <FormLabel>Mode</FormLabel>
        <ToggleButtonGroup
          size="sm"
          value={form.mode}
          onChange={(_event, value) => {
            const mode = model.modes.find(candidate => candidate === value);
            if (mode) update({ mode, inputImage: mode === 'image_to_video' ? form.inputImage : null });
          }}
          data-testid="video-form-mode-toggle"
        >
          {model.modes.map(mode => (
            <Button key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </Button>
          ))}
        </ToggleButtonGroup>
      </FormControl>

      <FormControl>
        <FormLabel>Prompt</FormLabel>
        <Textarea
          minRows={3}
          value={form.prompt}
          placeholder="Describe the video you want"
          onChange={event => update({ prompt: event.target.value })}
          slotProps={{ textarea: { 'data-testid': 'video-form-prompt-input', maxLength: VIDEO_PROMPT_MAX_LENGTH } }}
        />
        <Typography level="body-xs" sx={{ alignSelf: 'flex-end' }}>
          {promptLength}/{VIDEO_PROMPT_MAX_LENGTH}
        </Typography>
      </FormControl>

      {form.mode === 'image_to_video' && (
        <FormControl>
          <FormLabel>Image</FormLabel>
          <Stack direction="row" gap={1} alignItems="center">
            <Button
              size="sm"
              variant="outlined"
              onClick={() => imageBrowser.openImageBrowser()}
              data-testid="video-form-image-pick-btn"
            >
              {form.inputImage ? 'Change image' : 'Choose image'}
            </Button>
            {form.inputImage && (
              <Typography level="body-sm" data-testid="video-form-image-name">
                {form.inputImage.fileName}
              </Typography>
            )}
          </Stack>
        </FormControl>
      )}

      <FormControl>
        <FormLabel>Duration: {form.durationSeconds}s</FormLabel>
        {model.duration.kind === 'range' ? (
          <Slider
            min={model.duration.min}
            max={model.duration.max}
            step={model.duration.step}
            value={form.durationSeconds}
            valueLabelDisplay="auto"
            onChange={(_event, value) => {
              if (typeof value === 'number') update({ durationSeconds: value });
            }}
            slotProps={{ input: { 'data-testid': 'video-form-duration-slider' } }}
          />
        ) : (
          <ToggleButtonGroup
            size="sm"
            value={String(form.durationSeconds)}
            onChange={(_event, value) => {
              const seconds = Number(value);
              if (model.duration.kind === 'discrete' && model.duration.values.includes(seconds)) {
                update({ durationSeconds: seconds });
              }
            }}
          >
            {model.duration.values.map(seconds => (
              <Button key={seconds} value={String(seconds)} data-testid={`video-form-duration-option-${seconds}`}>
                {seconds}s
              </Button>
            ))}
          </ToggleButtonGroup>
        )}
      </FormControl>

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Aspect ratio</FormLabel>
          <Select
            value={form.aspectRatio}
            onChange={(_event, value) => {
              const aspectRatio = model.aspect_ratios.find(candidate => candidate === value);
              if (aspectRatio) update({ aspectRatio });
            }}
            slotProps={{ button: { 'data-testid': 'video-form-aspect-select' } }}
          >
            {model.aspect_ratios.map(ratio => (
              <Option key={ratio} value={ratio}>
                {ratio}
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Resolution</FormLabel>
          <Select
            value={form.resolution}
            onChange={(_event, value) => {
              const resolution = model.resolutions.find(candidate => candidate === value);
              if (resolution) update({ resolution });
            }}
            slotProps={{ button: { 'data-testid': 'video-form-resolution-select' } }}
          >
            {model.resolutions.map(resolution => (
              <Option key={resolution} value={resolution}>
                {resolution}
              </Option>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {model.audio === 'optional' && form.audio !== null ? (
        <Switch
          checked={form.audio}
          onChange={event => update({ audio: event.target.checked })}
          endDecorator="Audio"
          slotProps={{ input: { 'data-testid': 'video-form-audio-switch' } }}
        />
      ) : (
        <Typography level="body-sm" data-testid="video-form-audio-note">
          {model.audio === 'always' ? 'Audio is included.' : 'This model generates video without audio.'}
        </Typography>
      )}

      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Typography level="body-sm" data-testid="video-form-estimate">
          {estimate === null ? 'Cost estimate unavailable' : `Estimated cost: ${formatCredits(estimate)} credits`}
        </Typography>
        <Button
          loading={isSubmitting}
          disabled={!canSubmit(form)}
          onClick={() => onSubmit(toCreateBody(form))}
          data-testid="video-form-submit-btn"
        >
          Generate video
        </Button>
      </Stack>

      <ImageBrowserModal
        isOpen={imageBrowser.isImageBrowserOpen}
        onClose={imageBrowser.closeImageBrowser}
        imageSearch={imageBrowser.imageSearch}
        onImageSearchChange={imageBrowser.setImageSearch}
        isLoadingImages={imageBrowser.isLoadingImages}
        imageFiles={imageBrowser.imageFiles}
        selectedImage={imageBrowser.selectedImage}
        onSelectImage={imageBrowser.selectImage}
        onApplyImage={file => {
          update({ inputImage: { fileId: file.id, fileName: file.fileName } });
          imageBrowser.closeImageBrowser();
        }}
        onSearch={() => void imageBrowser.fetchImageFiles(imageBrowser.imageSearch)}
        title="Choose an image to animate"
        emptyHint="Upload images in Files to animate them here."
      />
    </Stack>
  );
};

export default VideoStudioForm;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/VideoStudioForm.test.tsx`
Expected: PASS. If the slider `fireEvent.change` does not move a Joy `Slider` under jsdom, drive it with the keyboard instead (`fireEvent.keyDown(slider, { key: 'ArrowRight' })` four times from 6 to reach 10); do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/VideoStudio/VideoStudioForm.tsx apps/client/app/components/VideoStudio/VideoStudioForm.test.tsx
git commit -m "feat(video): add the capability-driven studio form"
```

---

### Task 10: `VideoGallery`

**Files:**
- Create: `apps/client/app/components/VideoStudio/VideoGallery.tsx`
- Test: `apps/client/app/components/VideoStudio/VideoGallery.test.tsx`

**Interfaces:**
- Consumes: `useVideoGenerations()` (Task 4); `VideoJobCard` (Task 8).
- Produces: default export `VideoGallery()`: every video job the user owns (any `source`), newest first, as `VideoJobCard`s; Load more while `hasNextPage`.

- [ ] **Step 1: Write the failing test** (`VideoGallery.test.tsx`)

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ query: {} as Record<string, unknown>, fetchNextPage: vi.fn() }));

vi.mock('@client/app/hooks/data/videoGenerations', () => ({ useVideoGenerations: () => h.query }));
vi.mock('./VideoJobCard', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="gallery-card">{jobId}</div>,
}));

import { listOf, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoGallery from './VideoGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGallery = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VideoGallery />
    </CssVarsProvider>
  );
const loaded = (data: ReturnType<typeof listOf>, hasNextPage = false) => {
  h.query = {
    data,
    isPending: false,
    isError: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: h.fetchNextPage,
  };
};

beforeEach(() => vi.clearAllMocks());

describe('VideoGallery', () => {
  it('renders one card per job in server order (newest first), across pages', () => {
    loaded(listOf([videoJob({ id: 'c' }), videoJob({ id: 'b' })], [videoJob({ id: 'a' })]));
    renderGallery();
    expect(screen.getAllByTestId('gallery-card').map(node => node.textContent)).toEqual(['c', 'b', 'a']);
  });

  it('renders a job once when a prepend pushed it onto the next page too', () => {
    loaded(listOf([videoJob({ id: 'new' }), videoJob({ id: 'b' })], [videoJob({ id: 'b' }), videoJob({ id: 'a' })]));
    renderGallery();
    expect(screen.getAllByTestId('gallery-card').map(node => node.textContent)).toEqual(['new', 'b', 'a']);
  });

  it('loads more while there is a next page', () => {
    loaded(listOf([videoJob()]), true);
    renderGallery();
    fireEvent.click(screen.getByTestId('video-gallery-load-more-btn'));
    expect(h.fetchNextPage).toHaveBeenCalled();
  });

  it('hides Load more on the last page', () => {
    loaded(listOf([videoJob()]));
    renderGallery();
    expect(screen.queryByTestId('video-gallery-load-more-btn')).not.toBeInTheDocument();
  });

  it('shows an empty state', () => {
    loaded(listOf([]));
    renderGallery();
    expect(screen.getByTestId('video-gallery-empty')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    h.query = { data: undefined, isPending: false, isError: true };
    renderGallery();
    expect(screen.getByTestId('video-gallery-error')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/VideoGallery.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`VideoGallery.tsx`)

```tsx
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/joy';
import { useVideoGenerations } from '@client/app/hooks/data/videoGenerations';
import VideoJobCard from './VideoJobCard';

const VideoGallery = () => {
  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useVideoGenerations();

  if (isPending) return <CircularProgress size="sm" data-testid="video-gallery-loading" />;
  if (isError || !data) {
    return (
      <Typography level="body-sm" color="danger" data-testid="video-gallery-error">
        Could not load your videos. Refresh to try again.
      </Typography>
    );
  }

  // A job created after page 1 was fetched shifts the cursor pages, so a later page can repeat a row.
  const jobIds = [...new Set(data.pages.flatMap(page => page.data.map(job => job.id)))];
  if (jobIds.length === 0) {
    return (
      <Typography level="body-sm" data-testid="video-gallery-empty">
        Videos you generate will appear here.
      </Typography>
    );
  }

  return (
    <Stack gap={2} data-testid="video-gallery">
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {jobIds.map(jobId => (
          <VideoJobCard key={jobId} jobId={jobId} />
        ))}
      </Box>
      {hasNextPage && (
        <Button
          variant="outlined"
          color="neutral"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          sx={{ alignSelf: 'center' }}
          data-testid="video-gallery-load-more-btn"
        >
          Load more
        </Button>
      )}
    </Stack>
  );
};

export default VideoGallery;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/VideoStudio/VideoGallery.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/VideoStudio/VideoGallery.tsx apps/client/app/components/VideoStudio/VideoGallery.test.tsx
git commit -m "feat(video): add the video gallery"
```

---

### Task 11: The `/studio/video` page, its route and crawl policy

**Files:**
- Create: `apps/client/app/routes/studio/video.tsx`, `apps/client/app/routes/studio/video.test.tsx`
- Modify: `apps/client/app/router.tsx` (lazy import near line 87; route next to `hearthRoute`; `layoutRoute.addChildren([...])` at line ~1144)
- Test: `apps/client/app/router.test.ts`
- Modify: `apps/client/app/seo/crawlPolicy.ts` (`CORE_DISALLOWED_PATHS`), Test: `apps/client/app/seo/crawlPolicy.test.ts` (`EXPECTED_CORE_DISALLOWED`)

**Interfaces:**
- Consumes: `useVideoModels`, `useCreateVideoGeneration` (Task 4); `VideoStudioForm` (Task 9); `VideoGallery` (Task 10); `PageFrame` from `@client/app/components/common/PageFrame`.
- Produces: default export `VideoStudioPage`; route path `/studio/video` under `layoutRoute`; `'/studio'` in `CORE_DISALLOWED_PATHS`.

- [ ] **Step 1: Write the failing tests**

`routes/studio/video.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateVideoGenerationBody } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  models: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));

vi.mock('@client/app/hooks/data/videoGenerations', () => ({
  useVideoModels: () => h.models,
  useCreateVideoGeneration: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock('@client/app/components/VideoStudio/VideoGallery', () => ({
  default: () => <div data-testid="video-gallery-stub" />,
}));
vi.mock('@client/app/components/VideoStudio/VideoStudioForm', () => ({
  default: ({ onSubmit }: { onSubmit: (body: CreateVideoGenerationBody) => void }) => (
    <button data-testid="video-form-stub" onClick={() => onSubmit({ model: 'm', prompt: 'p' })} />
  ),
}));

import { rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoStudioPage from './video';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VideoStudioPage />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('VideoStudioPage', () => {
  it('renders the form and the gallery when a model is usable', () => {
    h.models = { data: [rangeModel], isPending: false, isError: false };
    renderPage();
    screen.getByTestId('video-form-stub').click();
    expect(h.mutate).toHaveBeenCalledWith({ model: 'm', prompt: 'p' });
    expect(screen.getByTestId('video-gallery-stub')).toBeInTheDocument();
  });

  it('explains that video is not enabled, and still shows past videos', () => {
    h.models = { data: [], isPending: false, isError: false };
    renderPage();
    expect(screen.getByTestId('video-studio-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('video-form-stub')).not.toBeInTheDocument();
    expect(screen.getByTestId('video-gallery-stub')).toBeInTheDocument();
  });

  it('shows loading and error states for the models', () => {
    h.models = { data: undefined, isPending: true, isError: false };
    const { unmount } = renderPage();
    expect(screen.getByTestId('video-studio-loading')).toBeInTheDocument();
    unmount();
    h.models = { data: undefined, isPending: false, isError: true };
    renderPage();
    expect(screen.getByTestId('video-studio-error')).toBeInTheDocument();
  });
});
```

`router.test.ts`, append:

```ts
describe('Video studio route', () => {
  it('renders /studio/video inside the notebook layout', () => {
    const ids = router.matchRoutes('/studio/video', {}).map(match => match.routeId);
    expect(ids).toContain('/layout');
    expect(ids.some(id => id.endsWith('/studio/video'))).toBe(true);
  });
});
```

`crawlPolicy.test.ts`: in `EXPECTED_CORE_DISALLOWED`, insert `'/studio',` between `'/status',` and `'/subscribe',`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bike4mind/client exec vitest run app/routes/studio/video.test.tsx app/router.test.ts app/seo/crawlPolicy.test.ts`
Expected: FAIL (page module missing; no `/studio/video` match; `/studio` missing from the policy).

- [ ] **Step 3: Implement the page** (`routes/studio/video.tsx`)

```tsx
import { CircularProgress, Stack, Typography } from '@mui/joy';
import PageFrame from '@client/app/components/common/PageFrame';
import VideoGallery from '@client/app/components/VideoStudio/VideoGallery';
import VideoStudioForm from '@client/app/components/VideoStudio/VideoStudioForm';
import { useCreateVideoGeneration, useVideoModels } from '@client/app/hooks/data/videoGenerations';

const VideoStudioPage = () => {
  const models = useVideoModels();
  const create = useCreateVideoGeneration();

  const renderForm = () => {
    if (models.isPending) return <CircularProgress size="sm" data-testid="video-studio-loading" />;
    if (models.isError) {
      return (
        <Typography level="body-sm" color="danger" data-testid="video-studio-error">
          Could not load the video models. Refresh to try again.
        </Typography>
      );
    }
    if (models.data.length === 0) {
      return (
        <Typography level="body-sm" data-testid="video-studio-empty">
          Video generation is not available for your account yet.
        </Typography>
      );
    }
    return (
      <VideoStudioForm models={models.data} isSubmitting={create.isPending} onSubmit={body => create.mutate(body)} />
    );
  };

  return (
    <PageFrame testId="video-studio-page">
      <Stack gap={3}>
        <Typography level="h2">Video Studio</Typography>
        {renderForm()}
        <Typography level="title-lg">Your videos</Typography>
        <VideoGallery />
      </Stack>
    </PageFrame>
  );
};

export default VideoStudioPage;
```

- [ ] **Step 4: Register the route and the crawl rule**

`router.tsx`, with the other lazy pages:

```ts
const VideoStudioPage = lazy(() => import('./routes/studio/video'));
```

next to `hearthRoute`:

```tsx
// Video Studio: generate clips from text or a library image, and the gallery of the user's video jobs.
const studioVideoRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/studio/video',
  component: () => (
    <Suspense fallback={<RouteLoadingFallback />}>
      <VideoStudioPage />
    </Suspense>
  ),
});
```

and add `studioVideoRoute,` after `hearthRoute,` in `layoutRoute.addChildren([...])`.

`crawlPolicy.ts`: insert `'/studio',` between `'/status',` and `'/subscribe',` in `CORE_DISALLOWED_PATHS`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @bike4mind/client exec vitest run app/routes/studio/video.test.tsx app/router.test.ts app/seo/crawlPolicy.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/client/app/routes/studio/video.tsx apps/client/app/routes/studio/video.test.tsx \
  apps/client/app/router.tsx apps/client/app/router.test.ts \
  apps/client/app/seo/crawlPolicy.ts apps/client/app/seo/crawlPolicy.test.ts
git commit -m "feat(video): add the /studio/video page"
```

---

### Task 12: Sidenav entry, shown only when a model is usable

**Files:**
- Modify: `apps/client/app/components/layouts/Notebook/Sidenav/SidenavNav.tsx` (imports; the `items` array after the `projects` entry, line ~245)
- Test: `apps/client/app/components/layouts/Notebook/Sidenav/SidenavNav.test.tsx`

**Interfaces:**
- Consumes: `useVideoModels()` (Task 4).
- Produces: a `video-studio` row (`data-testid="sidenav-nav-video-studio"`) navigating to `/studio/video`. It sits after Projects, so the positional pinned split (`items.slice(0, 2)`) is unchanged.

- [ ] **Step 1: Write the failing test**

In `SidenavNav.test.tsx`, add `useVideoModelsMock: vi.fn(),` to the existing `vi.hoisted(...)` object, add the mock next to the other hook mocks:

```tsx
// The row is gated on GET /api/v1/video-models (react-query); stubbed like the other data hooks here.
vi.mock('@client/app/hooks/data/videoGenerations', () => ({ useVideoModels: useVideoModelsMock }));
```

add `useVideoModelsMock.mockReturnValue({ data: [] });` to the top-level `beforeEach`, and append:

```tsx
describe('SidenavNav Video Studio row', () => {
  const videoRow = () => screen.queryByTestId('sidenav-nav-video-studio');

  it('shows when at least one video model is usable', () => {
    useVideoModelsMock.mockReturnValue({ data: [{ id: 'grok-imagine-video-1.5' }] });
    renderNav();
    expect(videoRow()).toHaveTextContent('Video Studio');
  });

  it('hides when no model is usable or the models have not loaded', () => {
    renderNav();
    expect(videoRow()).not.toBeInTheDocument();
    useVideoModelsMock.mockReturnValue({ data: undefined });
    renderNav();
    expect(videoRow()).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/layouts/Notebook/Sidenav/SidenavNav.test.tsx`
Expected: FAIL in "shows when at least one video model is usable".

- [ ] **Step 2: Implement**

Imports:

```ts
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import { useVideoModels } from '@client/app/hooks/data/videoGenerations';
```

After `const gearsSignal = useGearsNavSignal();`:

```ts
  // Shown only when GET /api/v1/video-models lists a model this user can run, so it never dead-ends.
  const { data: videoModels } = useVideoModels();
  const isVideoStudioEnabled = (videoModels?.length ?? 0) > 0;
```

In `items`, directly after the `projects` entry:

```tsx
    ...(isVideoStudioEnabled
      ? [
          {
            key: 'video-studio',
            label: t('sidenav.videoStudio', 'Video Studio'),
            icon: iconSlot(<MovieOutlinedIcon sx={{ fontSize: '18px' }} />),
            isActive: location.pathname.startsWith('/studio/video'),
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/studio/video' });
            },
          },
        ]
      : []),
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/layouts/Notebook/Sidenav`
Expected: PASS (the new tests and every existing Sidenav suite).

- [ ] **Step 4: Commit**

```bash
git add apps/client/app/components/layouts/Notebook/Sidenav/SidenavNav.tsx apps/client/app/components/layouts/Notebook/Sidenav/SidenavNav.test.tsx
git commit -m "feat(video): link the video studio from the sidenav when a model is usable"
```

---

### Task 13: Verification gate and preview E2E checklist

- [ ] **Step 1: Run the gates** (dispatch to `verify`)

Run: `pnpm turbo:core:build && pnpm turbo:typecheck && pnpm lint:check`
Expected: all PASS.

Run (targeted suites, `VITEST_MAX_WORKERS=25%`):

```bash
pnpm --filter @bike4mind/common exec vitest run src/types/entities/FabFileTypes.test.ts src/video
pnpm --filter @bike4mind/database exec vitest run src/__tests__/fabFileSearchQuery.test.ts
pnpm --filter @bike4mind/services exec vitest run src/fabFileService/search.test.ts
pnpm --filter @bike4mind/client exec vitest run pages/api/v1/__tests__ app/hooks/data app/components/VideoStudio \
  app/components/VideoGenerationUpdatesListener.test.tsx app/components/Agent/ImageBrowserModal.test.tsx \
  app/components/Files/Browser app/components/layouts/Notebook/Sidenav app/routes/studio app/router.test.ts app/seo
```

Expected: PASS. Then `pnpm turbo:test` for the full suite; expected PASS.

- [ ] **Step 2: Hygiene**

Run: `BASE=$(git merge-base HEAD origin/feat/video-generation-omni-flash-api) && git diff "$BASE" -U0 --diff-filter=AM -- '*.ts' '*.tsx' | command grep -nP '^\+(?!\+\+).*[^\x00-\x7F]'; bash scripts/check-no-smart-punctuation.sh --changed "$BASE" && bash scripts/check-no-control-bytes.sh --changed "$BASE"`
Expected: the grep prints nothing and both scripts exit 0 (they must get `--changed <base>`; their default reads the staged diff, which is empty after commits).

Run: `git diff "$BASE" -- apps/client b4m-core packages | command grep -nE '^\+.*\bas any\b|: any\b'`
Expected: no output.

No commit unless a gate forced a fix; such a fix gets its own conventional commit naming what broke.

- [ ] **Step 3: Preview E2E checklist** (record results, no URLs or keys, in the PR body's test notes)

Deploy the branch to a preview (PR label flow). Non-production stages run the deterministic `test` provider (`ENABLE_TEST_VIDEO_PROVIDER=true`), so this costs nothing.

1. Log in with an email one-time code.
2. As an admin, open admin settings and confirm `test-video` is enabled under the video generation block (enable it if not). Confirm the sidenav now shows **Video Studio**; with every model disabled it must disappear after a reload.
3. Open **Video Studio**. Pick `test-video`: the duration is a slider (1-10s), the estimate reads `Estimated cost: N credits`, audio reads "This model generates video without audio." If a discrete model (Veo) is enabled on the preview, switch to it and confirm the duration becomes 4/6/8 choices and the change note names any clamped value.
4. **Text to video:** prompt "a paper boat on a pond", Generate. A card appears at the top as Queued, moves to Generating and Saving without a reload (websocket), then plays inline. The credit balance in the header updates.
5. **Image to video:** switch mode, Choose image (the modal is titled "Choose an image to animate"), pick a library image, Generate. Same lifecycle; the card plays.
6. **Cancel:** start a third job and press Cancel at once. The status reads Cancelling, then Cancelled with "The generation was cancelled."; the balance returns to its pre-job value.
7. **Socket fallback:** in devtools, take the network offline for ~10s while a job runs, then restore it. The card still reaches Ready (polling, then the reconnect refresh).
8. **Download** saves `video-<id>.mp4` and it plays locally. **Open in Files** opens the Files drawer with the clip at the top; the type filter **Video** lists only video files.
9. **Gallery:** with more than 12 jobs, Load more appends older jobs with no duplicates. A job created through the public API with an API key (`source: api`) also appears.

Expected: every step passes. Any failure is fixed in its owning task's files with a `fix(video): ...` commit and the step re-run.

---

## Out of scope (later plans)

- The `video_generation` agent tool and the chat `VideoJobCard` placement (plan 4; this plan's card and listener are built for it).
- A per-model price display from `credits_per_second` (the estimate uses the catalog, which the server also uses).
- Webhook/callback delivery for API jobs.
- Removing the unused duplicate `app/hooks/useImageBrowser.ts`.

## Spec coverage

| Spec requirement (section 9 and epic phase 4) | Task |
|---|---|
| Tanstack route `/studio/video`, MUI Joy | 11 |
| Form from `GET /video-models`: model, mode, prompt | 9 |
| Image picker from the library for image-to-video | 7, 9 |
| Duration slider (range) or segmented control (discrete) | 6, 9 |
| Aspect ratio, resolution, audio toggle when `optional` | 6, 9 |
| Live credit estimate from `estimateVideoCost` | 6, 9 |
| Switching models clamps and says what changed | 6, 9 |
| Gallery of the user's jobs, newest first | 4, 10 |
| `generation_job_updated` written into the React Query cache | 3, 5 |
| Polling as fallback when the socket is down | 4, 5 |
| Succeeded cards play inline; Open in Files, Download; Cancel while running | 8 |
| `VideoJobCard` standalone, keyed by `jobId`, reusable by chat | 8 |
| Server data in React Query; form state local | 4, 9 |
| Files browser type filters include video | 2 |
| Studio jobs carry `source: 'studio'` (spec 5.4) | 1 |
| User-facing errors derived from codes (spec 8) | 3, 8 |
| UI tests: range vs discrete, clamping, estimate, card states | 6, 8, 9 |
| Verification and preview E2E | 13 |

## Self-review notes

- Every task names its files, gives real code for new logic, and states the command and expected result.
- Names are consistent across tasks: `videoGenerationKeys.{all,models,list,details,detail}`, `VideoGenerationList`/`VideoGenerationPage`, `seedVideoGeneration`/`prependVideoGeneration`/`upsertVideoGeneration`/`patchVideoGeneration`, `videoGenerationPollInterval`/`videoListRefreshInterval`, `VideoFormState` with `audio: boolean | null`, `CREDITS_BALANCE_KEY`, `MAX_PLAYER_URL_REFRESHES`, and the `video-form-*` / `video-job-card-*` / `video-gallery-*` / `video-studio-*` test ids.
- Review Focus items map to named tests: Task 4 and Task 5 (socket down and reconnect), Task 8 (stable player src, bounded refresh), Task 3 (no terminal regression, no older overwrite), Task 4 (list re-signs before cards), Task 9 (model disappears).
- Two jsdom behaviours are assumed rather than proven at plan time: a Joy `Slider` responding to `fireEvent.change` on its hidden range input (Task 9 names the keyboard fallback) and the TanStack route id ending in `/studio/video` (Task 11 asserts by suffix for that reason).
