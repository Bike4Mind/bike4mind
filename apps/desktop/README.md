# @bike4mind/desktop

Electron desktop client for Bike4Mind. It signs in against a Bike4Mind backend and stops
there: no chat, no session list, no model picker, no packaging/installer yet.

The web SPA (`apps/client`) cannot be wrapped: it is a Next.js server-rendered shell that
hydrates Tanstack Router, not a static bundle. So this app has its own lean renderer
(Vite + React 19 + MUI Joy + Tanstack Router) that will talk to the remote Bike4Mind API
over HTTP. Shared Zod schemas and types come from `@bike4mind/common`; components get
ported over from `apps/client` only as later tasks need them.

## Running it

```bash
pnpm --filter @bike4mind/desktop dev
```

Starts the Vite dev server for the renderer, builds main and preload, and launches
Electron against it with HMR.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server + Electron, with HMR |
| `pnpm build` | Bundles main, preload and renderer into `out/` |
| `pnpm start` | Launches Electron against an existing `out/` build |
| `pnpm typecheck` | `tsc` over both tsconfig projects |
| `pnpm typecheck:fast` | `tsgo`, falling back to `tsc` |
| `pnpm test` | vitest |

## Layout

```
src/main/       main process (Node). Owns windows, the OAuth device flow and every token.
src/main/auth/  device flow, keychain-backed token vault, refresh timer, auth IPC handlers.
src/preload/    contextBridge boundary. Exposes window.b4m.
src/renderer/   the UI (React + MUI Joy + Tanstack Router).
src/shared/     IPC channel names and payload types, imported by main and preload.
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload exposes
one hand-written method per IPC channel rather than a generic `invoke(channel, ...args)`
passthrough, because a passthrough would let renderer code reach every handler main ever
registers. The OAuth device flow runs in **main** so tokens never enter the renderer, and
the IPC contract in `src/shared/ipc.ts` states the invariant that channels may return auth
*state* but never a token.

## Authentication

The whole RFC 8628 device flow lives in `src/main/auth`, on top of the shared
`@bike4mind/client-auth` package (the same one the CLI uses). The renderer only ever receives
derived state - signed out, awaiting approval (with the user code to display), signed in, or
one of the two blocked states below - and there is deliberately no IPC channel that returns a
token.

- **Client id.** This app registers as `b4m-desktop`. One `DeviceFlowClient` is constructed
  with it and serves both `/api/oauth/device/initiate` and `/api/oauth/device/token`, because
  the token endpoint rejects a device code whose stored `clientId` differs from the redeeming
  `client_id` (RFC 8628 s3.4).
- **Storage.** Tokens go to the OS keychain via Electron `safeStorage`, keyed per normalized
  API URL, in `<userData>/auth-vault.json`. Deliberately not the CLI's plaintext
  `~/.bike4mind/config.json`. `safeStorage` is only usable after the app `ready` event, so
  `registerAuth()` must be called from inside `whenReady()`. Where
  `safeStorage.isEncryptionAvailable()` is false (Linux with no keyring) the vault degrades to
  memory-only and the UI says so - it never falls back to writing plaintext.
- **Per-environment tokens.** Switching between Production, Local Dev and a self-hosted URL
  restores the session already cached for that endpoint instead of forcing another device
  flow, matching the CLI.
- **Proactive refresh.** Access tokens live 30 minutes. A timer refreshes 5 minutes before
  expiry rather than waiting for a 401, because a later task mints WebSocket connect tickets
  from the live token and an open socket never produces the 401 a lazy refresh waits for.
- **Two states that are not login failures.** A 403 carrying `policyAcceptanceRequired` and a
  401 carrying `mfaPending` are authenticated states; the session is kept and the UI offers the
  browser link that resolves each, plus a retry. Rendering either as "sign-in failed" would
  leave the user with no way forward.
- **Never logged.** No access token, refresh token or device code is logged at any level.
  Debug logging is opt-in via `B4M_DESKTOP_VERBOSE=1` rather than on in dev, because the shared
  HTTP client debug-logs request bodies.

`B4M_DEFAULT_API_URL` is baked into the main bundle at build time (see the `define` block in
`electron.vite.config.ts`), exactly as the CLI bakes it via tsdown. Empty for an unbranded
fork, which then has no Production option and must pick Local Dev or a custom URL.

Routing uses hash history. A packaged build loads the renderer over `file://`, which has no
origin for the History API to push against, so hash history is the one mode that behaves
identically in dev and when packaged.

## Version constraints

**Electron 44 is required, and it is not a Node-version compromise.** The repo sets
`engines: node >=24`, and Electron ships its own Node for the main process:

| Electron | Bundled Node | Chromium |
| --- | --- | --- |
| 44.4.5 (used here) | **24.21.0** | 152 |
| 43.7.5 | 24.21.0 | 150 |
| 40.10.6 | 24.15.0 | 144 |
| 39.8.10 | 22.22.1 | 142 |
| 38 and earlier | 22.x | <= 140 |

Electron 40 was the first release to bundle Node 24, so **do not drop below Electron 40** or
the main process stops satisfying the repo's stated Node floor. At Electron 44 there is
nothing to avoid: main-process code can use any Node 24 API. (Verified by running
`ELECTRON_RUN_AS_NODE=1 electron -e "process.versions.node"`, not just read from release
notes.)

**Vite is pinned to 7 here while `apps/client` is on 8.** `electron-vite@5` (latest stable)
peer-caps Vite at `^7`; the version that accepts Vite 8 is `electron-vite@6.0.0-beta.1`,
which has been in beta since April 2026. A stable Vite 7 was preferred over a stale beta.
`@vitejs/plugin-react` is on `^5.2.0` because that is the release whose peer range spans
both 7 and 8, so the eventual bump to Vite 8 is a one-line change here. Revisit when
electron-vite 6 goes stable.

`@mui/joy` resolves to exactly `5.0.0-beta.52`, which is what the root
`pnpm.patchedDependencies` entry is keyed to, so the repo's Joy patch applies here too.
Emotion arrives transitively via `@mui/system` -> `@mui/styled-engine`; per `CLAUDE.md` it is
not installed directly.

## Importing `@bike4mind/common` into the renderer

The renderer no longer imports it (auth needs only main-process code), but the two
workarounds below stay in `electron.vite.config.ts` for the tasks that will. It works, and it
does **not** drag in server-only dependencies. The package's runtime
dependencies are `@bike4mind/hearth`, `axios`, `dayjs` and `zod`. No mongoose, no AWS SDK.

Two things did need handling, both because the renderer is a sandboxed browser with no Node
globals. Both are absorbed in `electron.vite.config.ts`, so renderer code can just import
from `@bike4mind/common`:

1. **`node:crypto`.** The root barrel statically imports `createHash`/`createHmac`
   (`src/utils/artifactHelpers.ts`, `src/utils/anonymousSessionId.ts`,
   `src/constants/lakeConfigAudit.ts`). Without a stand-in the renderer bundle does not
   link at all. It is aliased to `src/renderer/src/shims/nodeCrypto.ts`, which **throws**
   rather than returning an empty digest. All three call sites are call-time only (never
   module scope), so nothing throws on import today. This mirrors what `apps/client` does in
   its turbopack `resolveAlias` for `fs`/`path`/`net`/`tls`, except loud instead of silent.

2. **`process.env` read at module scope.** `b4m-core/common/src/utils.ts` evaluates
   `process.env.APP_NAME` and `process.env.WEBSITE_URL` at import time. `process` does not
   exist in the renderer, so this threw `ReferenceError: process is not defined` and the app
   rendered a blank window. Worth knowing: **the production build hid this**, because rollup
   tree-shook the two unused constants; only `pnpm dev` (unbundled modules, no tree-shaking)
   surfaced it. Import something that actually uses `getBrandName`/`getWebsiteUrl` and the
   production build would break too. It is fixed with a compile-time `define` of
   `process.env` rather than a `globalThis.process` shim, so `typeof process` stays
   `undefined` and libraries that feature-detect Node still take their browser branch.

**Cost: the barrel is expensive.** Importing one contract object from `@bike4mind/common`
grows the renderer bundle from 985 kB to 1,942 kB, because `export *` from the root index
pulls in the whole package. Today `@bike4mind/common` only exposes four narrow subpaths
(`./atlassian/config`, `./jira/api`, `./types/entities/RapidReplyTypes`,
`./types/entities/UserTypes`), none of which cover the API contracts or schemas the desktop
client will want. Type-only imports are free (erased at build time); value imports are not.

Follow-up worth filing: give `@bike4mind/common` a subpath export for `./api-contract` (and
ideally `./schemas`), and make the two `process.env` reads lazy. That would let the desktop
renderer drop both workarounds above and cut roughly a megabyte.
