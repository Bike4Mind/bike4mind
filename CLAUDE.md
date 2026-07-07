# Bike4Mind Engineering Standards

In-repo engineering-standards document referenced by [CONTRIBUTING.md](./CONTRIBUTING.md). It's written for AI coding agents (Claude Code, Cursor, etc.), but the rules apply to everyone. This file covers **how to write code that fits this codebase**. For the open/closed boundary, license, CLA, secret policy, and the full PR flow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## This is a public repository

Everything committed here is public and permanent. Before you commit, ask: *"Would I be fine seeing this on the front page of Hacker News?"*

- **Never commit secrets** (API keys, tokens, connection strings, `.env`). The gitleaks pre-commit hook + CI scans are a backstop, not the guard. If you leak one: **rotate first, delete second** — history is permanent.
- No customer/partner names, cloud identifiers (AWS account IDs, ARNs, bucket names — resolve at runtime), internal-tracker issue numbers, or teammate names in code, comments, commits, or branch names.
- **ASCII only** in code and comments — no curly quotes, em-dashes, or other smart punctuation.

## Commit identity

Commit under a **single, consistent email that is verified on your GitHub account**, and use the same one you sign the CLA with. Set it per-clone (no `--global`, so your other repos keep their own identity):

```bash
git config user.email "you@example.com"   # a verified email on your GitHub account
```

GitHub only links a commit to your account when the email is verified there, and using one verified email consistently is what keeps the CLA check matching you. Don't let your identity drift across commits.

## Key commands

| Task | Command (cached) | Uncached fallback |
|------|------------------|-------------------|
| Type check all | `pnpm turbo:typecheck` | `pnpm -r typecheck` |
| Test all | `pnpm turbo:test` | `pnpm -r test` |
| Lint (CI parity) | `pnpm lint:check` | — |
| Build core packages | `pnpm turbo:core:build` | `pnpm core:build` |
| Test one package | `pnpm --filter <pkg> test` | e.g. `pnpm --filter @bike4mind/agents test` |

Verify before pushing: `pnpm turbo:typecheck && pnpm turbo:test && pnpm lint:check`.

## Project structure

- **`apps/client`** — Next.js app: a Tanstack-Router SPA plus the Pages-API backend (`pages/api/*`). Next.js is used only for the API routes; all client routing is Tanstack Router.
- **`packages/cli`** — interactive CLI + ReAct agent.
- **`b4m-core/*`** — the engine, published as `@bike4mind/*` packages (`common`, `utils`, `agents`, `services`, `llm-adapters`, `db-core`, etc.). Core packages live at `b4m-core/<name>` and are symlinked into `node_modules/@bike4mind/<name>`.
- **`packages/database`** — the `@bike4mind/database` package: Mongoose models, queries, and shared DB utils.
- Realtime WebSocket fanout ships as a separate container image, referenced per deploy via the `SUBSCRIBER_FANOUT_IMAGE` env var (it lives in its own repo; see `infra/subscriberFanout.ts`).

## Turborepo build orchestration

Turbo gives cached, topologically-ordered builds; the `pnpm` commands still work as fallback.

- Repeat runs are near-instant on a cache hit. `turbo:core:build` builds packages in dependency order (common → utils → agents → services → …).
- **Do not run `turbo build` unfiltered** — it would try to `next build` the SPA outside its deploy context. Use `pnpm turbo:core:build` / `pnpm turbo:build`.
- If builds seem stale after a big change, add `--force`.
- **Worker-pool budget:** each package's vitest defaults to all host cores, so running many packages at once oversubscribes CPU. Set `VITEST_MAX_WORKERS` (e.g. `2` or `25%`) to cap each pool; the shared `vitest.shared.ts` wires it in. CI runs tests as a sharded matrix so an orchestrator running N packages should keep `N × VITEST_MAX_WORKERS ≤ cores`.
- **Database tests must use `createMongoServer()`** (`packages/database/src/__test__/createMongoServer.ts`) instead of `MongoMemoryServer.create()` — it retries on the port-collision race that occurs under parallel execution.

## TypeScript guidelines

- **Avoid `any`.** Use it only as a last resort and **document why** in a comment.
- Prefer `unknown` (forces narrowing), generics (`<T extends …>`), union types, or `Record<string, unknown>` over `any`.
- ✅ `const data: unknown = await fetch(); if (typeof data === 'object') { … }`
- ⚠️ `const legacy: any = …; // any: third-party lib ships no types`

## Testing guidelines

**File placement:**
- **Co-locate** tests next to the source (`Foo.tsx` + `Foo.test.tsx`).
- **Exception:** files under `pages/` use a `__tests__/` subdirectory (Next.js treats every file in `pages/` as a route).
- Pure utilities with no single owner may use a `__tests__/` subdirectory.

**Element selection:** always use `data-testid` (naming `component-action-element`, e.g. `modal-confirm-btn`) — never CSS class names (MUI/Emotion generates random class names).

**MUI Joy component tests need the theme wrapper** (custom palette tokens like `background.surface2` break without it):

```tsx
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
```

**Mocking deep import chains:** if a component's transitive imports reach a context provider via a `@/`/`@client` alias, mock it explicitly, e.g. `vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: () => ({ /* … */ }) }))`.

## MongoDB index guidelines

- **Never use `index: true`** on a field definition — it's a query-optimization hint, not a data constraint, and scattering it across fields is the root cause of duplicate-index warnings.
- **`unique: true` on a field IS fine** — it describes the nature of the field (a data constraint).
- Declare all **performance indexes together** at the bottom of the schema via `schema.index()` (the only way to define compound indexes) so they're auditable at a glance.

```ts
const userSchema = new Schema({
  email: { type: String, required: true, unique: true }, // unique: data constraint ✅
  organizationId: { type: Schema.Types.ObjectId },        // no index: true ✅
});

userSchema.index({ organizationId: 1, createdAt: -1 });   // performance indexes together ✅
```

## Styling guidelines

- **MUI Joy** (`@mui/joy`) is the primary UI library; use `@mui/system` utilities (`styled`, `keyframes`) for advanced styling.
- **Do not install or use `@emotion`.**
- Styled components: `styled('div')(...)` with proper TypeScript types.

## Theme mode guidelines

- Compare theme mode via `const theme = useTheme(); const mode = theme.palette.mode;` — **not** `useColorScheme()`, which can return `'system'` and won't match `mode === 'dark'`. `theme.palette.mode` resolves `'system'` to the actual OS preference.
- Only use `useColorScheme()` when you need `setMode` to toggle.

## Routing guidelines

- **Always use Tanstack Router** (`@tanstack/react-router`) for client-side routing and its hooks (`useNavigate`, `useRouter`, `useLocation`, `useParams`).
- **Do not** use Next.js router hooks (`next/router`, `next/navigation`). Next.js serves only the Pages-API backend; the app is a SPA.

## Dependency management

- **Avoid adding dependencies to the root `package.json`.** Install them in the specific workspace package that uses them — clearer ownership, better tree-shaking. Only truly cross-cutting deps belong at the root.

## Commit & PR conventions

- **Conventional Commits**: `type(scope): description` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, …). PR titles are validated in CI and drive the automatic changeset + version bump — no manual `pnpm changeset` needed. Breaking changes use `!` (e.g. `feat(agents)!: …`).
- Branch naming: `type/short-description` (e.g. `fix/questmaster-spinner`) — no tracker issue numbers.
- Fill the PR template, get CI green, address the automated review, and let a **human click merge**. First PR: sign the CLA as described in [CONTRIBUTING.md](./CONTRIBUTING.md#contributor-license-agreement-cla).
