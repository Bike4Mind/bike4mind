# @bike4mind/desktop

Electron desktop client for Bike4Mind. It signs in against a Bike4Mind backend, holds local
conversations in two modes, and runs local tools behind an approval gate.

The web SPA (`apps/client`) cannot be wrapped: it is a Next.js server-rendered shell that
hydrates Tanstack Router, not a static bundle. So this app has its own lean renderer
(Vite + React 19 + MUI Joy + Tanstack Router) that will talk to the remote Bike4Mind API
over HTTP. Shared Zod schemas and types come from `@bike4mind/common`; components get
ported over from `apps/client` only as later tasks need them.

## Download and install

Download installers from [Desktop releases](https://github.com/Bike4Mind/desktop-releases/releases).
No Node.js, pnpm, or source checkout is required.

1. On macOS, choose `arm64.dmg` for Apple Silicon (Intel builds are paused), open it,
   and drag Bike4Mind into Applications.
2. On Linux x64, download the `.AppImage`, mark it executable (`chmod +x <file>.AppImage`),
   and launch it. Some distributions require FUSE support to run AppImages.

New distribution releases require Developer ID signing and notarization. Legacy unsigned
builds in the source repository do not gain an updater retroactively: install the first signed
feed-enabled build manually. `SHA256SUMS.txt` accompanies each release for checksum verification.
Windows packaging exists locally but is not yet part of the release pipeline.

## Running it

```bash
pnpm --filter @bike4mind/desktop dev
```

Starts the Vite dev server for the renderer, builds main and preload, and launches
Electron against it with HMR.

| Command               | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `pnpm dev`            | Dev server + Electron, with HMR                    |
| `pnpm build`          | Bundles main, preload and renderer into `out/`     |
| `pnpm start`          | Launches Electron against an existing `out/` build |
| `pnpm typecheck`      | `tsc` over both tsconfig projects                  |
| `pnpm typecheck:fast` | `tsgo`, falling back to `tsc`                      |
| `pnpm test`           | vitest                                             |
| `pnpm package`        | Installers for the host platform, into `release/`  |

## Images in conversations

Right-click an image in a sent message or tool result to open its menu. From the keyboard,
focus the image and press Shift+F10 or the context-menu key. Local images offer **Copy image**,
**Save image...**, **Attach as context** for the next message, a **Copy** submenu for the image,
file path or Markdown, and **Show in Finder** (File Explorer on Windows, folder on Linux).
Draft attachment tiles have no context menu. Cancelling the save dialog leaves the image alone.

A remote image linked in a Markdown reply offers only **Copy > Markdown**: it has no local file,
and the desktop renderer does not load remote images.

If an action fails, read the error notice. "That image is no longer available" means the stored
file could not be found; paste or attach the original image again. If the clipboard cannot decode
the image format, use **Save image...** instead. A failed attachment appears as a rejection above
the composer, where it can be dismissed.

## Chat costs

The footer ring shows your personal credit balance as a percentage of your monthly personal
plan allowance. Organization credit pools are separate. A balance above the allowance, for
example after rollover or a top-up, fills the ring while the tooltip keeps the actual percentage.
Accounts without a monthly personal allowance show the balance without a percentage.
If the balance or allowance is unavailable, check that you are signed in and can reach the
backend; older backends may not report an allowance. The separate Context panel shows context usage.

Chat shows the credits reported by the server while a reply streams, after it finishes, and
in the composer's usage details. Missing credit usage is left blank rather than shown as zero.

In development (`pnpm dev`), Settings offers **Show dollar costs**, off by default. It switches
the streaming cost and the composer's last-turn cost to the server's dollar figure, and adds
dollars to the completed reply's tooltip. Completed replies keep their credit headline.
The choice is saved locally. Production builds hide this setting and always display credits,
even if a development run previously saved the dollar preference.

If a cost is absent, the server may not have reported it yet; older replies may have no saved
usage. The app does not estimate credits by converting dollars. A developer dollar display
falls back to credits when the server reports no dollar figure.

## Suggested next prompt

Settings has a **Suggested next prompt** switch and model picker. **Automatic** uses a small
hosted model when the server offers one. You can also pin an offered hosted model or an Ollama
model. Ollama requests use the server's configured endpoint, which may run on a different
machine from the desktop app.

A saved model that disappears stays marked **unavailable**, and suggestions stop until it
returns or you choose another model. It never silently falls back to a hosted model. Use
**Refresh models** after changing the server's model configuration. If the catalog cannot be
loaded, the picker shows an error; refresh to retry without losing the saved choice. Turning
the switch off or changing models clears the current hint and discards late answers from the
previous choice. Ollama completion requests time out after 30 seconds; hosted requests after
five. Loading the model list can add time before generation starts.

## Local history and offline models

Turn on **Local history** for a conversation to index its messages and visited browser pages
on this device. The switch is in the browser pane's **...** menu (open the pane with the globe
button in the conversation header); an icon in the header shows while it is on. Use **Search conversations** in the sidebar to search opted-in history while
offline. Turning the switch off removes that conversation from the index. Settings -> General ->
Local history -> **Clear local history** clears the current account's index; it does not delete
the original conversations or disable future capture in opted-in sessions.

Run Ollama locally on `127.0.0.1:11434` with a downloaded chat model, then choose that model
in the model picker. From the signed-out screen, choose **Use local models**. These models
send inference requests to the local daemon; cloud-backed Ollama models are excluded.
Local requests use a 4,096-token context by default, capped at the model's supported window.
To use a larger window, set `PARAMETER num_ctx 8192` (or another supported size) in the
model's Ollama Modelfile; discovery and inference use the same explicit context size.
Local Code sessions can still use network tools when permitted, so offline inference does not
make tool execution offline.

If a model is missing, check that Ollama is running at that address and the installed model
supports chat, then refresh the model list. If history is missing, check the conversation's
switch and the selected account. A clear or search error is shown in the interface; retry after
resolving the reported problem. The search index is separate from the saved conversations.

## Import from Claude

Open Settings -> Import to enable Claude Code sync or select a claude.ai data export.
Code sync reads `~/.claude/projects` by default and imports only sessions run inside a
repository's `.claude/worktrees/<name>` directory. Use the folder picker to choose another
transcript source and the project filter to narrow the imported repositories.

For claude.ai, export your data from Claude's settings, then choose the downloaded ZIP or
its `conversations.json`. You can also select a folder to watch for new exports. Reimporting
an export updates changed conversations. Sending a message here makes the imported session
your own copy, which later imports and removal of untouched imports leave alone.

If nothing appears, check that you are signed in, sync is enabled, the selected source is
readable, and the session ran in a Claude Code worktree. Review the Import page's error and
failed counts, repair file permissions or select a complete export, then retry. The source
files remain read-only throughout import.

## Packaging

`electron-builder` assembles what `electron-vite build` put in `out/`; its config is
[`electron-builder.yml`](./electron-builder.yml). Artifacts land in `release/`, which is
gitignored.

| Command              | Produces                                                   |
| -------------------- | ---------------------------------------------------------- |
| `pnpm package`       | everything the host platform can build                     |
| `pnpm package:mac`   | `dmg` and `zip`, both for arm64 and x64                    |
| `pnpm package:win`   | `nsis` installer, x64                                      |
| `pnpm package:linux` | `AppImage`, x64                                            |
| `pnpm package:dir`   | an unpacked `.app`/directory, no installer - the fast loop |

The macOS `zip` is not redundant with the `dmg`. The dmg is the human-facing installer;
the zip is the format a Squirrel.Mac auto-updater consumes, so it has to exist before
auto-update can.

### Automated releases

[`Desktop Release`](../../.github/workflows/desktop-release.yml) runs on pushes to
`main` and pull requests touching `apps/desktop/**` or the desktop release workflow,
version script, dependency gate, and their tests. It can also be run manually from
Actions on `main`.

Automatic triggers are temporarily desktop-only. Shared/core/backend sources, root
dependencies, lockfiles, patches, and shared configuration alone do not start this
workflow, even when desktop depends on them. Until dependency-aware triggers are
restored, those changes need a manual run or a later desktop change to package.

When a run starts, before packaging,
`scripts/desktop_affected.py` compares the desktop workspace dependency closure on both
sides, including dev/typecheck dependencies and transitively resolved lockfile entries.
The same check governs semantic bumps and release notes, excluding unrelated workspace
and web-only changes. Shared workspace/build configuration remains a conservative
input within an existing run; malformed or missing historical inputs require a build.
Pull requests compare their base with the head. Pushes and manual runs check every
commit since the last desktop release, including pending shared dependency changes.

Pull requests targeting `main` run the same builds and artifact validation without
publishing a release. In the workflow run's Artifacts section, download
`desktop-mac-arm64` and `desktop-linux-x64` for installers,
plus `installer-checksums` for `SHA256SUMS.txt`. PR jobs have only
read access to repository contents; the publication job runs only for pushes or manual
dispatches on `main`. PR runs are isolated from the main release concurrency group.

The workflow installs from the frozen lockfile, builds shared packages, runs desktop
typechecks and tests on macOS and Linux, then packages Apple Silicon and Linux x64.
The two platform jobs run in parallel; Turbo also builds independent shared packages
in parallel while respecting dependency order. Intel macOS release builds are temporarily
paused; local x64 packaging remains available. Publication waits for both build jobs and
validates the arm64 DMG, arm64 ZIP, and Linux AppImage.
Failed uploads leave a draft release, not a partially published download page.

macOS jobs read the repository or organization Actions variable `OSX_RUNNER_LABEL`,
defaulting to `macos-26-runner` when unset or empty. The selected runner must be
Apple Silicon and available to this repository. Linux stays on `ubuntu-24.04`.
Paid runner usage is billed by GitHub.

Publication uses the existing release App only to reserve protected source version tags.
A separate distribution App token has contents write access only to the installer repository.
The workflow token and PR build jobs remain read-only. Missing credentials fail publication.
The distribution repository needs no Actions workflows; disable Actions there. The source
workflow is the only publisher. Anyone can read public installers and metadata, not drafts.

Storage is deliberately short-lived: platform installers, checksums, and release notes
expire after one day; startup evidence expires after three days. Installers are stored
only once per platform; there is no duplicate combined installer upload.
Superseded PR runs are canceled; main release runs are not interrupted.
Dependency caching is disabled for this workflow, including setup-node's automatic
package-manager cache. Runner-local build files disappear with the hosted runner.
Published GitHub Release assets remain available for downloads and rollback separately
from Actions artifact retention. Retention bounds lifetime, not total storage: many
concurrent runs can still exhaust the shared artifact allowance. These settings do not
delete existing artifacts or caches created by earlier runs or other workflows.

The Linux job also launches the actual AppImage under Xvfb with an isolated temporary
profile. It checks the rendered sign-in/environment screen, auth initialization, and
the packaged version through main/preload IPC. `linux-x64-smoke-results` contains a screenshot
and startup logs. This smoke test uses AppImage extraction and `--no-sandbox` only in
CI; it does not verify FUSE mounting, desktop integration, sandbox compatibility on a
real workstation, or authenticated chat. Those still need real-machine acceptance tests.

The macOS job mounts the native-architecture DMG read-only, copies the app to a temporary
installation directory, and runs the same startup checks with an isolated profile.
`mac-arm64-smoke-results` contains screenshots and logs.
Apple Silicon runs on a native standard runner. The tests use a mock keychain
to avoid system prompts or accessing a real login keychain. It does not verify secure
credential persistence. This does
not verify Gatekeeper approval on a fresh machine.

Installer versions follow SemVer, selected automatically by
`scripts/desktop_release_version.py`. The first release uses the package version
(`0.1.0`). After that, desktop release tags are the version source of truth; there is
no version-bump commit or separate package release PR.

Local `pnpm package:*` commands use the highest stable desktop tag reachable from
the checkout, with `-local.<commit>` appended so an unreleased build does not
impersonate a published installer. Fetch tags with `git fetch origin --tags` first.
Missing tags fail with instructions instead of silently producing version 0.1.0.
Set `DESKTOP_VERSION=0.6.0-test.1` for an explicit local test version. Local builds
never publish. CI continues to select its own version and call the builder directly.
Local macOS packaging explicitly uses ad-hoc signing, not Developer ID or
notarization. Set `DESKTOP_MAC_IDENTITY` to an explicit Developer ID identity when
needed. A valid ad-hoc signature does not guarantee fresh-download Gatekeeper acceptance.

- `feat: ...` bumps minor; `fix: ...`, dependency updates, builds, refactors, and
  other relevant changes bump patch.
- During beta, `type!: ...` or a `BREAKING CHANGE:` footer bumps minor, not major.
  Moving to 1.x requires a deliberate policy change reviewed before release.
- The accidental `desktop-v1.0.0` release is excluded from baseline selection in
  CI and local packaging, but its source tag is retained. The beta line resumes
  from 0.5.0 with 0.6.0. Other stable major baselines fail closed, not silently ignored.
  Existing 1.0.0 installations need a manual 0.x installation, not an updater downgrade.
- `docs`, `test`, `ci`, and `style` alone do not publish a new stable release.
- The highest bump across unreleased, desktop-relevant first-parent commits wins.
  Unrelated web-only commits do not affect the desktop version. Squash merges use the
  PR title as their commit header, so set it to the intended release type.
- PR installers use prereleases such as `0.2.0-pr.123.42`, with the PR title supplying
  its intended bump. They never become stable releases or change the next stable version.

Reruns at an already released commit reuse its version and leave published assets
unchanged. Draft releases reserve their version so a failed upload can be retried.
An older checkout cannot publish after a newer desktop release. Version selection reads
both repositories and source tag reservations, preserving the pre-migration SemVer baseline.
Desktop updates use only the dedicated repository's Latest release. Production release
automation is unchanged. Keep source desktop release tags intact;
changing the package version does not override existing release history.

The hosted backend defaults to `https://app.bike4mind.com`; the repository variable
`B4M_DEFAULT_API_URL` overrides it. `DESKTOP_RELEASE_REPOSITORY` supplies the
dedicated public `owner/repo`; CI derives and bakes `B4M_UPDATE_FEED_URL` as its
`https://github.com/<owner>/<repo>/releases/latest/download/` URL. Unset or source-repo
destinations fail closed. PR builds have no signing credentials and are not published.

The validation job generates `latest-mac.yml` and `latest-linux.yml` from the actual
installer bytes, with SHA-512 and size. ZIP blockmaps are mandatory; AppImage blockmaps
are embedded by electron-builder, and any external blockmaps are retained. Payload URLs
are pinned to the version tag, so a later Latest switch cannot break an already offered
update. All assets are uploaded to a draft and downloaded for byte comparison before
publication promotes the complete release to Latest. A failed upload never exposes a
partial manifest. Published assets are not overwritten on retry.

#### Distribution setup checklist

1. Create a public, distribution-only repository with an initial `main` commit. Do not
   publish source, credentials, debug dumps, or builder configuration as release assets.
2. Set source Actions variable `DESKTOP_RELEASE_REPOSITORY` to the dedicated `owner/repo`
   in the same organization as the source. Keep its name stable for installed clients.
3. Install a dedicated GitHub App on only that repository with Contents read/write.
   Set source variable `DESKTOP_RELEASE_APP_ID` and secret `DESKTOP_RELEASE_APP_PRIVATE_KEY`.
   The existing source release App and protected-tag bypass remain unchanged.
4. Choose a macOS signing path. Set `DESKTOP_MAC_SIGNING=true` with the five Apple
   secrets below for Developer ID signing and notarization. Alternatively, explicitly
   set `DESKTOP_MAC_ADHOC_BETA=true` for account-free 0.x beta distribution. Unset,
   false or malformed opt-ins deny publication; Apple signing takes precedence.
   The ad-hoc path ships DMG/ZIP manual installers, disables macOS in-app updates
   and omits `latest-mac.yml`. Linux metadata and updates remain enabled. Ad-hoc
   signing provides bundle integrity, not publisher identity or notarization.
   Fresh-download Gatekeeper acceptance remains untested; Open Anyway may be needed.
5. Merge through review, then inspect the first trusted run's signatures, notarization,
   packaged startup evidence, and destination release asset set. Confirm anonymous
   `latest-linux.yml` downloads redirect successfully (also `latest-mac.yml` for
   the Developer ID path only). CI logs record
   publication and tag operations; organization audit-log retention is managed separately.
6. Test two signed versions using a temporary installation and profile. Check, download,
   and explicitly restart into the newer version. Never use a user's existing profile.
   Contract tests and local feed checks do not prove Squirrel.Mac signature acceptance.

To disable account-free publication, unset `DESKTOP_MAC_ADHOC_BETA` before another
run. To switch to Developer ID, configure its credentials and set
`DESKTOP_MAC_SIGNING=true`; missing credentials fail rather than falling back to
ad-hoc. Do not overwrite published assets or reuse a reserved version. Recover with
a new higher 0.x version. Users of ad-hoc builds must install that recovery manually.
Distribution App setup is still required independently of Apple. These opt-ins do
not enable Sparkle or prove macOS auto-update compatibility.

#### GitHub App setup (independent of Apple)

1. In the organization settings, open Developer settings > GitHub Apps > New GitHub App.
   Use a dedicated distribution publisher, disable webhooks, and limit installation to
   this account. It needs no OAuth callback, user permissions, or event subscriptions.
2. Under Repository permissions, grant Contents read/write. Metadata read is implicit;
   leave every other permission unset. No organization permissions are needed.
3. Install the App with Only select repositories and select only the distribution repo.
   Do not add the source repo or grant this App a source tag-ruleset bypass.
4. Set source Actions variable `DESKTOP_RELEASE_APP_ID` to the App's client ID, as required
   by `actions/create-github-app-token@v3`. Generate a private key and upload its PEM
   contents directly into source Actions secret `DESKTOP_RELEASE_APP_PRIVATE_KEY`.
   Never paste the PEM into chat, commit it, or put it in the distribution repository.
5. After credentials are available, verify the minted token can create and remove a
   temporary destination draft, but cannot write to the source or another repository.
   A successful test using a personal gh login does not prove the App's token scope.

This can be configured while Apple access is pending. Leave `DESKTOP_MAC_SIGNING` unset
until the Apple credentials are ready. PR packaging remains available; main distribution
stays blocked, and no unsigned installer becomes an automatic update.

Release notes list desktop-relevant first-parent changes and explain the semantic bump.
The publication script is `apps/desktop/scripts/publish-release.sh`, shared with
`apps/desktop/scripts/verify-publication.sh`. Run the latter from the repository root
with an explicitly selected sandbox `owner/repo` argument and a gh login with write
access there. It creates a temporary release, downloads and compares its probe asset,
checks that reruns do not overwrite published assets, then deletes the release and tag.
It refuses the current repository. This tests the API flow, not the workflow token's
production permissions or the full installer set. No sandbox is configured by default.

Set `DESKTOP_MAC_SIGNING=true` only after configuring all five repository secrets:
`DESKTOP_CSC_LINK`, `DESKTOP_CSC_KEY_PASSWORD`, `DESKTOP_APPLE_ID`,
`DESKTOP_APPLE_APP_SPECIFIC_PASSWORD`, and `DESKTOP_APPLE_TEAM_ID`.
Only trusted main runs receive these credentials. Opting in with incomplete credentials
fails rather than silently publishing unsigned builds. Signed runs require Developer ID
code-signature and app/DMG stapling validation. Without opt-in, main distribution is blocked. Signing credentials
and end-to-end notarization verification are external setup requirements.

To stop offering a broken release, mark it as a prerelease and explicitly mark the last
good complete distribution release as Latest. Verify both manifest URLs anonymously.
Do not overwrite existing assets or enable updater downgrades. Ship a higher fixed version.
To roll back manually, download and reinstall an earlier desktop release. Back up the app's
user-data directory before downgrading because older builds may not understand newer
local data. If a release is broken, mark it as a prerelease or return it to draft in
GitHub Releases, then rerun the workflow on corrected `main` to publish a new version.

### Baking the backend URL

`B4M_DEFAULT_API_URL` is substituted into the main bundle at build time and is the
**Production** entry in the environment picker. A packaged app inherits no shell
environment, so there is nothing to read at runtime.

When nothing supplies it, the build uses `https://app.bike4mind.com` (`PRODUCTION_API_URL` in
`electron.vite.config.ts`), so every build signs in to production with nothing to type. A
fork that runs its own backend overrides it, highest precedence first:

```bash
B4M_DEFAULT_API_URL=https://your-backend.example pnpm package:mac
```

or, to stop retyping it, put it in `apps/desktop/.env.local` - which `.gitignore` already
covers, at the root, for `.env` and `.env*.local` alike:

```
B4M_DEFAULT_API_URL=https://your-backend.example
```

Local Dev and a self-hosted URL stay available from "Change server" on the sign-in card.

### Signing

Nothing in `electron-builder.yml` names a certificate. Local package scripts explicitly
request ad-hoc signing; skipping signing can leave an invalid linker signature after
Electron is repackaged. Verify bundle integrity with `codesign --verify --deep --strict`.
Ad-hoc signing is not notarization and does not establish the publisher's identity.
Fresh-download Gatekeeper approval must be tested separately. Do not bypass an invalid
signature by removing quarantine attributes.

Direct electron-builder invocations (including the trusted CI signing job) can use
credentials from the environment. Local package scripts additionally require
`DESKTOP_MAC_IDENTITY` to opt into a Developer ID identity:

| Variable                                                   | Effect                                                |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `CSC_LINK` + `CSC_KEY_PASSWORD`                            | base64 `.p12` (or a file path) used on both platforms |
| `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`                    | Windows-only certificate, for a combined build        |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization credentials                              |

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

`dependencies` in this package's `package.json` is the _unbundled runtime_ closure, not
everything the app imports. Vite bundles the renderer, so React, MUI Joy, Tanstack Router
and the markdown stack are build-time only and live in `devDependencies`; electron-builder
computes the packaged `node_modules` from `dependencies` alone, so leaving them there
shipped every one of them twice.

The same rule is why `@bike4mind/utils` is bundled into main rather than externalized (see
the `exclude` on `externalizeDepsPlugin` in `electron.vite.config.ts`). Main uses one
subpath of it; the package _declares_ six AWS SDK clients, openai, jimp, tiktoken, xlsx
and mammoth, and electron-builder ships what is declared. Bundling that one subpath took
`app.asar` from 257 MB to 42 MB.

`@bike4mind/mcp` is the remaining example of the same shape - it declares
`@anthropic-ai/sdk` and `@octokit/rest` alongside the MCP SDK that main actually uses, and
those still ship. Fixing that is a change to `b4m-core/mcp`'s entry points, not to this
config.

`node-pty` (the terminal panel's pty) is the one native dependency, so it is a `dependency`
and stays external, while `@xterm/*` is bundled into the renderer and lives in
`devDependencies`. It is pinned to a 1.2 beta because 1.1.0 publishes its macOS
`spawn-helper` without the execute bit, and every spawn then fails with `posix_spawnp failed`.
`electron-builder.yml` unpacks it from the asar (a `.node` file and the helper both have to be
real files) and turns `npmRebuild` off: the module is N-API with prebuilt binaries for every
target, so a rebuild would only compile a different binary from the one dev runs.

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
_state_ but never a token.

## Chat and Code modes

Every conversation has a mode, chosen with the segmented control at the top of the sidebar.

- **Chat** is the default, and is what every conversation before modes existed reads back as.
  It is grounded in nothing in particular: its tools use the folders granted under **More**.
- **Code** adds project grounding. Starting one asks for a project directory and nothing else;
  it opens on that repository's current branch, in the checkout itself, and its conversations
  group under the project in the sidebar.

**Tools are not the difference.** Both modes carry the same file, shell and background-process
tools. Code mode's distinction is _where_ they run.

### The chip row

A Code session's grounding sits above the composer as a row of pills - the backend, the project
directory, the branch paired with a worktree checkbox, and the folders granted for context -
and every one of them is editable mid-session. It is a persistent surface rather than a setup
step, because what it shows is where the _next_ turn's commands will run.

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

Moving to a _different_ repository drops the branch and the context folders with it: a branch
name means nothing in a repository it does not belong to, and folders chosen as context for one
codebase are not consent to read them alongside another.

### The workspace toggle is a git worktree

Off, the session runs in the project directory. On, it runs in a git worktree of its own. The
worktree lives in the app's own `.b4m` folder inside the project's container directory (the
parent of the shared git dir), with `/` in the branch name written as `+`:

```
<container>/.b4m/.gitignore         ignores everything in .b4m, so worktrees stay out of git status
<container>/.b4m/worktrees/<branch> one folder per session branch, e.g. b4m+fix-login-3fa9c1
<container>/.b4m/spare              a ready checkout that makes the next one fast (see below)
```

The layout is reimplemented in `src/main/chat/project/workspace.ts` rather than shelled out
to the user's `worktree` shell function (`~/.config/b4m/worktree.zsh`, still the source of the
`+` folder convention and the default base), because a packaged app cannot assume a personal
shell function exists. Nothing ever writes to a `../` path, which would scatter folders that
read as separate projects, and the repository's own `.gitignore` is never touched. Keeping
everything under `.b4m` also means a worktree can never collide with a folder the user made
themselves, such as `<container>/main`.

**The chosen branch is a base, not a target.** The session gets a branch of its own, named
`b4m/<slug>-<hex>` (the slug comes from the session title, the random suffix keeps two sessions
from the same base apart), cut from the branch the user picked. A name that is not an existing
branch names the session's own branch instead, cut from the default base. Either way the
session is alone on its branch, so picking `main` never hands back the user's own checkout and
the app never claims an isolation it did not get. The resolved path is shown under the session
title whenever it differs from the project directory.

Cases it handles rather than failing:

- **The session already has its worktree** - reused, not recreated. Reuse is keyed only on the
  session's _own_ branch, which is saved on the session and handed back on every later
  resolution. A worktree some other tool registered for the base branch is never adopted.
- **The branch does not exist yet** - for a `main` base (`main`, `origin/main`, or no base
  picked while the checkout is on `main`) it is created from `origin/main` right after a
  successful fetch, so local-only or diverged `main` commits never seed it; if that fetch fails
  the session fails to prepare instead of starting from stale history. Local `main` is never
  touched. Any other base is created from its remote-tracking ref once that is proven to
  contain the local base, otherwise from the base itself. With no base picked it is the branch
  `origin/HEAD` points at, then `origin/main`, then `origin/master`, then `HEAD`. Always
  `--no-track`, so a later `git push` does not aim at the base. A repository without an
  `origin` remote uses its local `main`.

**An occupied path is refused, never adopted or cleared.** If the target folder is already a
git worktree holding something else, or exists but is not a worktree, the session fails to
prepare with a message naming the path. Move it with `git worktree move` (a plain `mv` leaves
git pointing at a path that no longer exists), or pick a different branch.

**A spare checkout makes starting fast.** After a worktree is cut in a repository, the app
prepares one detached checkout in `.b4m/spare` shortly afterwards, so it does not compete with
the new session's first moments. The next session moves it into place and switches it to the
new branch, which rewrites only the files that differ - about 0.2s instead of the 1.3s a full
checkout takes on this monorepo. It is bounded on every side: a repository gets one only after
a worktree was cut in it during the current run, at most two repositories keep one (the least
recently used goes first), an unused spare is removed after 30 minutes, and all of them are
removed on quit. A spare left behind by a crash is recognized by its git metadata and original
`HEAD`; one that has been changed, or that the app does not own, is left alone and no spare is
made.

**Deleting a session can also remove its worktree and branch.** The delete confirmation offers
this only for an app-created checkout under `.b4m/worktrees` on a `b4m/` branch. It defaults on
only when no other conversation (including archived ones) uses the directory or branch, the
checkout has no uncommitted or untracked files, and its commits are preserved in its upstream
or base branch. Ordinary ignored files do not prevent removal; nested worktrees and folders
used by other conversations are kept. Running conversations must stop first; unsafe checkouts
show the reason and are kept. Cleanup stops background processes, waits for terminal shells
to exit and closes the browser, then rechecks safety and uses `git worktree remove` and
`git branch -d`, without force. A shell that cannot be stopped keeps its checkout. New workspace
bindings wait until cleanup finishes. Git refusals are shown in the dialog; the conversation is
kept so you can retry or delete it without cleanup. Archiving, imported-session deletion and
the agent's `session_delete` tool keep their worktrees.

### Starting a session in a worktree

A suggested task or approved `session_spawn` appears in the sidebar before git finishes,
with "Preparing worktree..." in its row and chips. Its first turn waits for the checkout;
messages sent while it prepares queue behind the initial task. New Code sessions with the
worktree toggle on also wait for their checkout before running tools.

If a spawned session cannot prepare its worktree, the app shows a failure toast and reports
the failure to the parent conversation. An empty failed session is removed, and a suggested
task returns to pending: start the card again after correcting the git or filesystem error.
For a tool spawn, ask the parent to try `session_spawn` again.

A failed session that accepted follow-up messages is kept. Its unsent task, follow-ups and
attachments are saved in its transcript, and typed input returns to its open composer for
retry. Relayed messages remain in the transcript. After correcting the startup error, retry
in that conversation; its suggestion card stays started to avoid creating a duplicate.
Deleting a session while it prepares cancels its launch without reporting a startup failure.

### Tools run in the session's working directory

`ChatService.resolveToolScope` puts the session's working directory and its context
directories at the _front_ of the granted roots and passes the working directory on
`ToolContext`. Everything downstream reads it: `bash_execute` and `bash_background` default
their cwd to it, `resolveWithinRoots` resolves relative paths against it, and `glob_files` /
`grep_search` anchor there.

This is load-bearing. Before it, an ungrounded default fell back to `roots[0]` - the first
folder the user ever granted. For a session bound to a worktree that is the main checkout, so
commands would have run on the wrong branch while the UI said otherwise. `src/main/chat/tools/
workingDirectory.test.ts` pins it by making the working directory the _second_ root, so any
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

- filled while a reply streams or its worktree prepares, hollow when idle. The dot is driven by a
  global subscription to main's stream events, not the open conversation, so a session replying in
  the background shows as running.

**Artifacts** opens a searchable grid of the artifacts created by this app across your machines.
Thumbnails load as cards approach the viewport; select a card to view it or share its live link.
Use Back or Escape to return to the grid. **Refresh** reloads the list and thumbnail bodies after
an edit in the web app. Search, filters and counts cover the newest 100 artifacts at most.

The library requires a signed-in account and network access. If the list or an opened artifact
cannot load, its error offers **Try again**; sign in again if your session has expired.
**Customize** maps onto the folder grants this app already had, which moved out of the account
panel into the collapsible **More**.

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
- **Dev identity.** Unpackaged runs (`pnpm dev`, `pnpm start`, `electron-vite preview`) take
  the name `Bike4Mind Dev`, so they get their own userData folder and keychain item instead of
  sharing the installed app's (`src/main/appIdentity.ts`). The first such run after upgrading
  starts signed out.
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
`electron.vite.config.ts`), exactly as the CLI bakes it via tsdown, and falls back to
`https://app.bike4mind.com` when no build supplies it.

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

| When              | What                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| 15s after launch  | The first check, deliberately behind the window, auth and model catalog       |
| Every 6 hours     | Because this app is left running for days, so "on launch" alone is not enough |
| The Customize row | On demand                                                                     |

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

| File                       | Consumed by                             |
| -------------------------- | --------------------------------------- |
| `build/icon.icns`          | electron-builder, macOS app bundle      |
| `build/icon-mac.png`       | macOS development Dock icon (1024x1024) |
| `build/icon.ico`           | electron-builder, Windows               |
| `build/icon.png`           | electron-builder, Linux (512x512)       |
| `src/renderer/favicon.png` | the renderer's `<link rel="icon">`      |

macOS uses the full-size mark with its own blue gradient extended behind it, making the
circular edge seamless with the rounded-square tile. The corner radius is 22% of the tile
width. The tile retains the 824/1024 outer inset for the macOS icon grid; the
transparent margin is outside the tile, not between a circular silhouette and the grid.
Windows, Linux, and the favicon keep the circular mark with a 0.92 inset. At small sizes,
the fine detail softens, but the silhouette and brand blue still carry it.

Where the icon actually shows:

- **Windows and Linux** take it from the `icon` option on the `BrowserWindow`, which resolves
  through electron-vite's `?asset` import so the PNG is copied into `out/main/chunks/` and the
  path is correct both in dev and when packaged.
- **macOS** ignores that option - its windows have no icon - and reads the dock icon from the
  app bundle, which only exists once the app is packaged. `app.dock.setIcon()` covers the gap
  for `pnpm dev`, using `build/icon-mac.png` with the same tile as the bundle icon. Restart
  dev after regenerating icons. An installed app needs to be rebuilt and replaced before
  its bundle icon changes.
- The renderer's favicon is cosmetic inside Electron, which does not apply a page favicon to
  the window. It is there for where the renderer is opened as a page: devtools and
  `electron-vite preview`.

## Version constraints

**Electron 44 is required, and it is not a Node-version compromise.** The repo sets
`engines: node >=24`, and Electron ships its own Node for the main process:

| Electron           | Bundled Node | Chromium |
| ------------------ | ------------ | -------- |
| 44.4.5 (used here) | **24.21.0**  | 152      |
| 43.7.5             | 24.21.0      | 150      |
| 40.10.6            | 24.15.0      | 144      |
| 39.8.10            | 22.22.1      | 142      |
| 38 and earlier     | 22.x         | <= 140   |

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

## Standing permission rules

Settings -> Permissions also shows the local capability ledger: active grants for files,
tools, browser origins, imported identity, project trust and credit-spending actions,
followed by their 200 most recent audit events. Tool execution does not
append audit events. The ledger uses an append-only local log; existing ledger files are
migrated automatically. Conversation grants are visible only in the account that created
them. Revoke removes the corresponding stored permission or
conversation allowance immediately. A separate overlapping allow can still authorize a
call; inspect the remaining grants and permission rules if a prompt does not reappear.
Standing tool approvals end when the desktop restarts. Durable grants are migrated into
the ledger, including folders shared with saved conversations when Settings loads.
Imported browser identity remains separate from anonymous access.

If the ledger cannot be loaded or a revoke fails, Settings displays the error. Check that
the desktop's user-data directory is writable, then retry. A failed revoke must not be
treated as confirmation that access ended. Invalid logs are quarantined for inspection;
audit synchronization failures are logged and do not undo completed permission changes.

Open Settings -> Permissions to add allow, ask, or deny rules for every project or one
project. Rules use Claude Code syntax, for example `Bash(git status:*)`,
`Read(~/notes/**)`, and `WebFetch(domain:docs.example.com)`. Deny takes precedence over
ask, and ask over allow. A shell command needs an allow for every subcommand.
Native tool rules such as `request_directory` also apply to interactive tools:
a deny refuses the call, while an allow still requires the tool's interactive response.

The approval card's "Allow in this chat" remembers consent for this conversation.
"Always allow" saves the displayed allow rules in Settings -> Permissions, and also
answers waiting cards those rules cover. For web fetches, both buttons cover every site,
including after a reply has read web content; the saved rule is `WebFetch`.
Use a `WebFetch(domain:...)` rule in Settings for a narrower persistent allow.
Irreversible calls cannot save a standing allow. Browser cards cannot save a rule.
Settings also shows imported Claude Code sources read-only. Turn off "Use them here"
to stop importing them. An untrusted
project contributes ask and deny rules, but cannot grant itself an allow.

If a permission source cannot be read or parsed, tool execution is refused rather than
dropping its restrictions. Check the path named in the error, repair the JSON or file
permissions, then retry. Claude Code sources reload when their settings change; after
repairing the desktop rule file, retry the call. A failed Settings save displays an
error and keeps the previously saved rules active.

If "Always allow" reports that its rule could not be saved, consent still applies in
this conversation. Retry the save in Settings -> Permissions before relying on it in
another chat. To restore fetch approval cards, remove the saved `WebFetch` allow and
start a new chat; existing conversation consent lasts for that conversation.
