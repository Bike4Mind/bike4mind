# @bike4mind/desktop

Electron desktop client for Bike4Mind. It signs in against a Bike4Mind backend, holds local
conversations in two modes, and runs local tools behind an approval gate.

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
| `pnpm package` | Installers for the host platform, into `release/` |

## Packaging

`electron-builder` assembles what `electron-vite build` put in `out/`; its config is
[`electron-builder.yml`](./electron-builder.yml). Artifacts land in `release/`, which is
gitignored.

| Command | Produces |
| --- | --- |
| `pnpm package` | everything the host platform can build |
| `pnpm package:mac` | `dmg` and `zip`, both for arm64 and x64 |
| `pnpm package:win` | `nsis` installer, x64 |
| `pnpm package:dir` | an unpacked `.app`/directory, no installer - the fast loop |

The macOS `zip` is not redundant with the `dmg`. The dmg is the human-facing installer;
the zip is the format a Squirrel.Mac auto-updater consumes, so it has to exist before
auto-update (T44) can.

### Baking the backend URL

`B4M_DEFAULT_API_URL` is substituted into the main bundle at build time and is what makes
**Production** selectable in the environment picker - `hostedAvailable()` in
`src/main/auth/environment.ts` is false whenever it is empty, and the picker then reads
"Production (not set in this build)". A packaged app inherits no shell environment, so
there is nothing to read at runtime.

**There is deliberately no fallback URL in source.** This repo is public and open-core;
committing a hostname here would put it in every fork's bundle. The CLI has the same rule
and the same shape (`packages/cli/tsdown.config.ts`, injected in `release.yaml` from a repo
variable), so the two clients are branded the same way.

Supply it per build, highest precedence first:

```bash
B4M_DEFAULT_API_URL=https://your-backend.example pnpm package:mac
```

or, to stop retyping it, put it in `apps/desktop/.env.local` - which `.gitignore` already
covers, at the root, for `.env` and `.env*.local` alike:

```
B4M_DEFAULT_API_URL=https://your-backend.example
```

Build with neither and the app ships with no hosted option at all, which is the correct
state for an unbranded fork: Local Dev and a self-hosted URL still work.

### Signing

Nothing in `electron-builder.yml` names a certificate, and an unsigned build is the
supported default - it produces a working dmg on a machine with no credentials at all.
electron-builder logs `skipped macOS application code signing` and ad-hoc signs instead,
which is the minimum macOS needs to run an arm64 build locally. An unsigned app is still
quarantined on another machine: Gatekeeper needs a right-click -> Open, or
`xattr -d com.apple.quarantine`.

Signing turns itself on once credentials are in the environment:

| Variable | Effect |
| --- | --- |
| `CSC_LINK` + `CSC_KEY_PASSWORD` | base64 `.p12` (or a file path) used on both platforms |
| `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` | Windows-only certificate, for a combined build |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization credentials |

A "Developer ID Application" identity already in the login keychain is picked up with no
variables at all. `hardenedRuntime` and `build/entitlements.mac.plist` are always on: they
are inert while unsigned and are what notarization will require, and the entitlements are
the ones this app actually needs (JIT, and spawning unsigned child processes for shell
commands and MCP servers).

Notarization is the one thing not enabled by default, because `notarize: true` without
credentials is a hard build failure rather than a warning. Turn it on per invocation:

```bash
pnpm package:mac -c.mac.notarize=true
```

**Still blocked on certificates:** a Developer ID Application certificate (macOS) and an
EV or OV code-signing certificate (Windows). Until then a macOS user has to clear
quarantine by hand and a Windows user gets a SmartScreen warning. The config does not
change when they arrive - only the environment does.

### What ships, and what does not

`dependencies` in this package's `package.json` is the *unbundled runtime* closure, not
everything the app imports. Vite bundles the renderer, so React, MUI Joy, Tanstack Router
and the markdown stack are build-time only and live in `devDependencies`; electron-builder
computes the packaged `node_modules` from `dependencies` alone, so leaving them there
shipped every one of them twice.

The same rule is why `@bike4mind/utils` is bundled into main rather than externalized (see
the `exclude` on `externalizeDepsPlugin` in `electron.vite.config.ts`). Main uses one
subpath of it; the package *declares* six AWS SDK clients, openai, jimp, tiktoken, xlsx
and mammoth, and electron-builder ships what is declared. Bundling that one subpath took
`app.asar` from 257 MB to 42 MB.

`@bike4mind/mcp` is the remaining example of the same shape - it declares
`@anthropic-ai/sdk` and `@octokit/rest` alongside the MCP SDK that main actually uses, and
those still ship. Fixing that is a change to `b4m-core/mcp`'s entry points, not to this
config.

`B4M_DESKTOP_DEFAULT_MODEL` overrides the model a *new* conversation starts on for one launch,
for a launch nobody is driving and so cannot reach the in-app picker. It is a preference, not a
guarantee: the list is the server's (see `ModelCatalog`), and a deployment that does not offer
that id starts on the first one it does. Existing conversations keep the model saved on them.
Unset or blank leaves the shipped default. Either way the preference is logged once at startup,
so a launch can be checked without opening the picker.

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

## Chat and Code modes

Every conversation has a mode, chosen with the segmented control at the top of the sidebar.

- **Chat** is the default, and is what every conversation before modes existed reads back as.
  It is grounded in nothing in particular: its tools use the folders granted under **More**.
- **Code** adds project grounding. Starting one asks for a project directory and nothing else;
  it opens on that repository's current branch, in the checkout itself, and its conversations
  group under the project in the sidebar.

**Tools are not the difference.** Both modes carry the same file, shell and background-process
tools. Code mode's distinction is *where* they run.

### The chip row

A Code session's grounding sits above the composer as a row of pills - the backend, the project
directory, the branch paired with a worktree checkbox, and the folders granted for context -
and every one of them is editable mid-session. It is a persistent surface rather than a setup
step, because what it shows is where the *next* turn's commands will run.

The first chip names the b4m backend (the environment from `src/main/auth/environment.ts`), not
where the agent runs: the agent is this app's main process and has nowhere else to be, so a
local/remote switch would offer a choice that does not exist. That setting is app-wide, which
the chip's tooltip says.

**Changing the branch, worktree or directory is refused while the session is busy** - a reply
streaming, or a background process still alive in the current working directory. The working
directory roots this session's shell commands and everything they started, so repointing it
under a running turn would have the rest of that turn run somewhere the first half did not, and
repointing it past a live dev server would leave that server in a checkout the conversation no
longer claims. Both conditions clear on their own, so it is a wait rather than a dead end;
`ChatService.project.test.ts` pins both the refusal and that it leaves the binding untouched.

Moving to a *different* repository drops the branch and the context folders with it: a branch
name means nothing in a repository it does not belong to, and folders chosen as context for one
codebase are not consent to read them alongside another.

### The workspace toggle is a git worktree

Off, the session runs in the project directory. On, it runs in a git worktree for the chosen
branch, following the layout in `~/.config/b4m/worktree.zsh`: worktrees live inside the
project's own container directory (the parent of the shared git dir), one folder per branch,
with `/` in the branch name written as `+`.

```
<container>/.bare              the bare repo
<container>/main               the main worktree
<container>/fix+some-branch    one folder per branch
```

That layout is reimplemented in `src/main/chat/project/workspace.ts` rather than shelled out
to, because a packaged app cannot assume a personal shell function exists. Nothing ever writes
to a `../` path, which would scatter folders that read as separate projects.

Three cases it handles rather than failing:

- **The worktree already exists** - adopted, not recreated. A worktree registered for that
  branch at some *other* path is adopted too, because git allows a branch in exactly one
  worktree and `worktree add` would otherwise fail against it.
- **The branch does not exist** - created from `origin/main` (then `origin/master`, then
  `HEAD`), `--no-track`, matching the shell helper's default.
- **The branch is the one the main checkout is on** - resolves *to* the main checkout, since
  git permits nothing else. The resolved path is shown under the session title whenever it
  differs from the project directory, so the app never claims an isolation it did not get.

**Deleting a session never deletes its worktree.** A worktree can hold uncommitted work, and
deleting a conversation must not be a way to lose code. Removing one stays a git operation the
user performs themselves (`rmworktree <branch>`).

### Tools run in the session's working directory

`ChatService.resolveToolScope` puts the session's working directory and its context
directories at the *front* of the granted roots and passes the working directory on
`ToolContext`. Everything downstream reads it: `bash_execute` and `bash_background` default
their cwd to it, `resolveWithinRoots` resolves relative paths against it, and `glob_files` /
`grep_search` anchor there.

This is load-bearing. Before it, an ungrounded default fell back to `roots[0]` - the first
folder the user ever granted. For a session bound to a worktree that is the main checkout, so
commands would have run on the wrong branch while the UI said otherwise. `src/main/chat/tools/
workingDirectory.test.ts` pins it by making the working directory the *second* root, so any
regression to `roots[0]` fails.

### Session storage and migration

Sessions gained `mode`, an optional `project` and an optional `pinned`. `SessionStore.parse`
stays tolerant, as it already was: a file with no `mode` reads back as Chat, which is what
every pre-existing conversation is. A file claiming `code` with an unusable project is
downgraded to Chat rather than trusted, because a Code session with no working directory would
send its tools to whatever the first global grant happens to be.

`SessionStore.modes.test.ts` runs against a session file captured from the pre-change code,
not a hand-written approximation.

### Sidebar

Adapted from Claude Code desktop's layout: primary nav, a **Pinned** section, then project
groups with per-group actions (new session, search, settings) and a leading status dot per row
- filled while a reply streams, hollow when idle. The dot is driven by a global subscription to
main's stream events, not the open conversation, so a session replying in the background shows
as running.

Two of its entries have no counterpart here. **Artifacts** is dropped: desktop conversations are
local and produce none. **Customize** maps onto the folder grants this app already had, which
moved out of the account panel into the collapsible **More**.

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

## Updates

`electron-updater` against a `generic` feed, wired in `src/main/update`. The feed URL is baked
in at build time from `B4M_UPDATE_FEED_URL`, exactly like `B4M_DEFAULT_API_URL` above, and for
one extra reason: this repo is public, and a release feed is a host or a bucket behind one. The
`generic` provider is what makes that possible - `s3` and `github` want a bucket name or an
owner/repo in committed configuration, whereas `generic` takes a plain URL any static host can
serve. Set nothing and the build simply does not check, which is right for a fork that
publishes no releases.

Only https is accepted, plus http on the loopback so the check path can be exercised against a
local static server. See `resolveFeedUrl` in `src/main/update/feed.ts`.

| When | What |
| --- | --- |
| 15s after launch | The first check, deliberately behind the window, auth and model catalog |
| Every 6 hours | Because this app is left running for days, so "on launch" alone is not enough |
| The Customize row | On demand |

Nothing downloads or installs itself. `autoDownload` and `autoInstallOnAppQuit` are both off:
the user presses Download, and then Restart. An install asks main what is in flight first - a
streaming reply, a session at the approval gate, a background process still up - and refuses
with that report rather than quitting, so the restart is never a surprise. Background children
are killed before the app is handed to the installer, not left to the quit handlers.

A failed check is never surfaced. No network, a dead feed and a malformed manifest all land as
one quiet state that keeps showing the current version, and none of them can retract an update
that is already downloaded and waiting. The state machine is in `src/shared/update.ts` and is
unit-tested there, which matters more than usual: **macOS will not auto-update an unsigned
app**, so until code-signing certificates exist the full download-and-install cycle cannot be
exercised on macOS at all. Do not "fix" that by relaxing the signature check - an updater that
accepts unsigned payloads is a remote code execution path.

Packaging (the macOS `zip` target the updater consumes) is a separate concern; see the
packaging config once it lands.

## App icon

`build/icon.svg` is the source of truth: a copy of the square bike4mind mark that the web app
uses as its splash logo and favicon (`apps/client/public/images/logos/Colored_Favicon.svg` -
byte-identical to `icons/Colored_Logo_Clean.svg`, despite the name, so there is no separate
wordmark to weigh against it). It is copied in rather than read across from `apps/client`,
because a packaged app ships only its own directory.

Regenerate every format after a brand change:

```bash
./apps/desktop/build/generate-icons.sh
```

macOS only. It rasterises with Quick Look (`qlmanage`) and packs the `.icns` with `iconutil`;
ImageMagick handles only the resulting PNG. **ImageMagick cannot rasterise this SVG** - its
internal renderer silently drops every gradient-filled path, which here is the entire wheel,
leaving four cyan dots on a blank canvas. Quick Look flattens onto white, so the script
restores the transparent corners with a circular mask.

| File | Consumed by |
| --- | --- |
| `build/icon.icns` | electron-builder, macOS app bundle |
| `build/icon.ico` | electron-builder, Windows |
| `build/icon.png` | electron-builder, Linux (512x512) |
| `src/renderer/favicon.png` | the renderer's `<link rel="icon">` |

The mark is inset rather than bled to the edge: 824/1024 on macOS, which is Apple's icon
grid, and a looser 0.92 elsewhere, where there is no grid to match. It stops reading as a
wheel below about 32px - the white filigree inside the disc washes out into a pale blob at
16px - but the disc silhouette and the brand blue still carry it.

Where the icon actually shows:

- **Windows and Linux** take it from the `icon` option on the `BrowserWindow`, which resolves
  through electron-vite's `?asset` import so the PNG is copied into `out/main/chunks/` and the
  path is correct both in dev and when packaged.
- **macOS** ignores that option - its windows have no icon - and reads the dock icon from the
  app bundle, which only exists once T9 packages the app. `app.dock.setIcon()` covers the gap
  for `pnpm dev`.
- The renderer's favicon is cosmetic inside Electron, which does not apply a page favicon to
  the window. It is there for where the renderer is opened as a page: devtools and
  `electron-vite preview`.

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
