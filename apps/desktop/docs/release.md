# Desktop release pipeline

How a Bike4Mind desktop build gets from a merged pull request to a user's machine, and how the
installed app updates itself. Users never need access to this repository: they download a dmg once
from a stable URL, and every later version arrives as an in-app "Restart to update".

This is a design note plus the ops checklist. The moving parts are:

| Piece | Where |
| --- | --- |
| Versioning and changelog | changesets, the same flow as the npm packages (see [Versioning](#versioning)) |
| Build, sign, notarize, publish | [`.github/workflows/desktop-release.yml`](../../../.github/workflows/desktop-release.yml) |
| Manifest rewrite, release notes, version checks | [`scripts/release.mjs`](../scripts/release.mjs), tested by `scripts/release.test.ts` |
| Update client | `src/main/update` (electron-updater) and `src/shared/update.ts` (the state machine) |
| Update UI | `UpdateBanner` in the sidebar, `UpdateSettings` in Settings |

Nothing in this repo names the bucket, the CloudFront distribution, the download host, the AWS
account or the Apple team. This repo is public; every one of those arrives at run time from GitHub
variables and secrets, listed in [the checklist](#infra-and-secrets-checklist).

## The update protocol

electron-updater's `generic` provider, pointed at a plain https URL baked into the build from
`B4M_UPDATE_FEED_URL` (see `src/main/update/feed.ts` for why it is `generic` and not `s3`/`github`).

- The app fetches `<feed>/latest-mac.yml`. It lists, per architecture, the zip to install with its
  `sha512` and size, and optionally `releaseNotes`.
- electron-updater offers the update only when the manifest's `version` is **greater** (semver) than
  the running app's. Versions must therefore only ever go up, which changesets guarantees.
- On macOS the **zip** is what the updater installs (handed to Squirrel.Mac). The **dmg** is only the
  first-install download and is never referenced by an update.
- Squirrel.Mac refuses to install a payload that is not signed by the same Developer ID as the
  running app. That is the integrity check; there is no second signature to manage, unlike manifold's
  minisign key. It also means **an unsigned build can never update itself**.

## Host layout

One bucket behind CloudFront, served over https. The feed URL is the host root.

```
<host>/latest-mac.yml                      the release switch; the only object a release overwrites
<host>/Bike4Mind-latest-arm64.dmg          stable first-install links, rewritten each release
<host>/Bike4Mind-latest-x64.dmg
<host>/releases/v1.4.0/Bike4Mind-1.4.0-arm64-mac.zip
<host>/releases/v1.4.0/Bike4Mind-1.4.0-arm64-mac.zip.blockmap
<host>/releases/v1.4.0/Bike4Mind-1.4.0-mac.zip                 (x64)
<host>/releases/v1.4.0/Bike4Mind-1.4.0-mac.zip.blockmap
<host>/releases/v1.4.0/Bike4Mind-1.4.0-arm64.dmg
<host>/releases/v1.4.0/Bike4Mind-1.4.0-x64.dmg
<host>/releases/v1.4.0/*.dmg.blockmap
```

- **Version prefixes are write-once.** Objects under `releases/` are uploaded with
  `Cache-Control: public, max-age=31536000, immutable`. Re-uploading a key that has been served would
  leave the old bytes at the edge for a year, so the workflow refuses to publish into a prefix that
  holds anything. A broken release is fixed by publishing the next version, never by overwriting.
- **`latest-mac.yml` is uploaded last**, with `max-age=60`. Until it is rewritten no client can see
  the new prefix, so a half-finished upload is invisible rather than a 404 for everyone checking.
- electron-builder writes bare file names into `latest-mac.yml`; `release.mjs manifest` rewrites them
  to `releases/v<version>/<file>`. Keeping the version in the path also keeps **differential
  downloads** working: electron-updater finds the old blockmap by replacing the new version with the
  running one everywhere in the zip's URL.
- **Rollback** is rewriting `latest-mac.yml` to point at an older prefix. Note that installed apps
  already on the newer version will not downgrade (`allowDowngrade` is off); rollback only stops
  further installs of the bad version, so the real fix is still the next version.
- **Stable first-install URL:** `<host>/Bike4Mind-latest-arm64.dmg` and `-x64.dmg`. These are
  server-side copies (not redirects - CloudFront with a private S3 origin does not honour S3 website
  redirects) with `max-age=300`, rewritten just before the manifest. A download page or the web app
  links here.

## Release trigger and versioning

### Versioning

The repo already versions packages with **changesets driven by PR titles**, and it fits the desktop
with one change, so there is no separate version-bump script:

1. A PR titled `feat(desktop): ...` / `fix(desktop): ...` that touches `apps/desktop/` gets
   `.changeset/pr-<N>.md` written by the auto-changeset bot, bumping `@bike4mind/desktop` (minor for
   `feat`, patch for `fix`/`perf`/`refactor`, major for `!`). The resolver used to skip private
   packages; `apps/desktop/package.json` now opts in with `"changesetsVersioned": true` (see
   `.github/scripts/resolve-changeset-packages.sh`). Changeset files are fragments, the same idea as
   manifold's `changelog.d/`: one file per PR, so concurrent PRs never conflict on the changelog.
2. changesets also patch-bumps the desktop whenever a bundled workspace dependency
   (`@bike4mind/common`, `@bike4mind/mcp`, `@bike4mind/client-auth`) is released, because that code
   ships inside the app. That is correct, and those releases read "Maintenance release" in the app.
3. The existing **"Version Packages" PR** (opened by `release.yaml`) is the release PR. It writes the
   new version into `apps/desktop/package.json` and the section into `apps/desktop/CHANGELOG.md`, and
   it is the preview: the bump and the notes are reviewable before anything ships, which is the job
   manifold's `version-preview.yml` does.

Every desktop build therefore carries a real, strictly increasing semver from `package.json`, which
is the only version source: electron-builder bakes it into `Info.plist` and `latest-mac.yml`, and the
workflow checks the built bundle against it.

### Trigger: merging the Version Packages PR is the release

`desktop-release.yml` runs on a push to `main` that changes `apps/desktop/package.json`. In practice
that is the Version Packages merge, the same merge that publishes the npm packages. Merging it IS the
publish, exactly as merging manifold's release PR into `prod` is.

Why not manifold's `main` -> `prod` release branch: bike4mind already has a release PR (Version
Packages) and a release workflow keyed on `main` (`release.yaml`), and the web app's production
deploy is a separate deployer-driven flow (`prod-release.yml`). A second long-lived branch would be a
second release ritual that only the desktop uses. The protections manifold gets from `prod` come from
elsewhere here:

| Manifold relies on | Here |
| --- | --- |
| `prod` admits no direct push (ruleset) | `main` already requires a PR; the workflow additionally only acts on a version that has never been published |
| `version-bump.mjs` is the only writer of the version | changesets is the only writer; the workflow is `contents: read` and pushes nothing back |
| The gate skips a push that carries no new version | Same: a push whose version prefix already exists is a no-op, not a failure |
| Release notes must exist | Same: a real run fails in the gate if `CHANGELOG.md` has no section for the version |

**One coupling to know about:** the desktop talks to the production API, which is deployed
separately. A desktop feature that needs a new server endpoint must degrade gracefully against the
previous server, or its PR must not merge before the server change is live. If that becomes
uncomfortable, add **required reviewers** to the `desktop-release` environment: every release then
waits for a click in Actions, and a rejected run is safe (nothing was written; the next version, or a
dispatch, publishes later). Note that both jobs declare the environment, so a run would ask twice.

### Dry run

`workflow_dispatch` with `dry_run: true` (the default) builds, signs, notarizes and verifies, prints
the manifest it would publish, and uploads nothing. It works before the version is bumped (a
collision with an existing prefix and missing notes become warnings). A real dispatch is only for
re-publishing a version whose prefix is still **empty**; it is not a recovery path for a partial
upload - mint the next version instead.

## Signing and notarization

electron-builder handles both from the environment, so `electron-builder.yml` names no identity:

- **Code signing:** `CSC_LINK` (base64 of the Developer ID Application `.p12`) and
  `CSC_KEY_PASSWORD`. The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false` so a runner keychain can
  never substitute a different identity.
- **Notarization:** the App Store Connect API key route, preferred over an Apple ID because it is
  owned by the organization and not a person: `APPLE_API_KEY` (path to the `.p8`, written from a
  secret at run time), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Enabled with `-c.mac.notarize=true`.
  electron-builder notarizes and staples each `.app` before it builds the dmg and zip, so both carry
  the ticket. The Apple ID route (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) also
  works and needs no workflow change beyond swapping the env.
- `hardenedRuntime` and `build/entitlements.mac.plist` are already on.

Before anything is uploaded the workflow checks, on every built `.app` **and** on the `.app` inside
every zip (the bytes the updater will install):

- `codesign --verify --deep --strict`, and the `TeamIdentifier` equals `APPLE_TEAM_ID` (a build
  signed by the wrong team installs fine and then can never update)
- `spctl --assess --type execute` (Gatekeeper accepts it as notarized Developer ID)
- `xcrun stapler validate`
- `CFBundleShortVersionString` equals the version being published

## Architectures

**Recommendation: arm64 and x64, as separate builds** (not universal). Manifold ships arm64 only
because its internal user base had no Intel Macs; the Bike4Mind desktop is a product for customers,
and Intel Macs are still in use. The cost is small: one arm64 runner builds both (no native modules
to cross-compile; the app uses Node's built-in `node:sqlite` and wasm tree-sitter), notarization runs
twice, and one `latest-mac.yml` lists both zips - electron-updater picks the one matching the
machine (`arm64` in the file name). Separate builds keep each download half the size of a universal
one. Dropping x64 later is a one-line change to `mac.target` in `electron-builder.yml`; an x64
install then simply stops seeing updates.

**Windows is deferred.** It needs an Authenticode certificate, `latest.yml` beside the NSIS
installer, and its own job. The update client already works there; only the pipeline does not exist.

## The in-app experience

- Checks 15s after launch and every 6 hours, only in a **packaged** build **with** a feed. Dev runs
  and forks stay `unsupported` and show nothing but the version.
- When a check finds a newer version it **downloads in the background** immediately. Nothing
  installs itself on quit.
- Once downloaded, a banner in the sidebar says "Version X is ready" with **Restart to update**, the
  release notes behind "What's new", and a dismiss button (dismissal lasts until the next version).
  Settings has the same actions plus "Check again".
- Restart asks main what is in flight first (streaming replies, sessions at the approval gate,
  background processes). If anything is, the banner names it and offers "Restart anyway" or "Keep
  working"; otherwise it quits and installs (`quitAndInstall`).
- A failed check or download is never shown as an error.

## Infra and secrets checklist

Nothing below exists yet, and none of it is created by this change. Ops provides it; the workflow
skips itself (the gate job does not run) until `DESKTOP_RELEASE_BUCKET` is set, so merging the
workflow first is safe.

### 1. Apple

- [ ] **Developer ID Application certificate** exported as `.p12` with a password. If manifold's
  Apple Developer **organization** account is the same team (the intent there was to enroll as the
  Bike4Mind organization), reuse it: a Developer ID certificate signs any number of apps, and the
  same team on both products is the right identity. Confirm the team ID matches before reusing.
  Manifold's notes record that its signing was not yet in place, so this may be a first enrollment
  for both - the D-U-N-S lead time (days to weeks) applies.
- [ ] **App Store Connect API key** (Developer role is enough for notarization): the `.p8`, its key
  ID and the issuer ID.
- [ ] The **Team ID**, so the workflow can assert the signature's `TeamIdentifier`.
- [ ] Keep an offline copy of the `.p12` and its password. Changing the signing team later strands
  every installed app (Squirrel.Mac refuses an update signed by a different team), so the first
  signed release should use the identity you intend to keep.

### 2. Download host

- [ ] A **private S3 bucket** dedicated to desktop releases (versioning optional).
- [ ] A **CloudFront distribution** with OAC to the bucket, https-only viewer policy, and a domain
  such as a `downloads.*` host with an ACM certificate in **us-east-1** (a `*.example.com` wildcard
  does not cover a two-label subdomain).
- [ ] Missing keys should return **404**, not 403 (grant the OAC `s3:ListBucket`, or add a custom
  error response). The workflow treats a 404 manifest as "first release" and any other failure as an
  error.
- [ ] The feed URL (`https://<host>`, no trailing path) becomes `B4M_UPDATE_FEED_URL`. It is baked
  into every install; changing it later strands installed apps on the old host, so pick the final
  name up front.

### 3. GitHub OIDC role and environment

- [ ] A GitHub **environment** named `desktop-release` with a **deployment branch policy** that
  admits only `main` (custom policy, one entry). All secrets below go here, not at repo level, so only
  a job running on `main` that declares the environment can read them.
- [ ] An **IAM role** trusting `token.actions.githubusercontent.com`, with the trust policy's `sub`
  bound to the environment claim, `repo:<org>/<repo>:environment:desktop-release`. Check whether the
  org uses immutable (ID-based) subject claims: manifold's role needed the `@<id>` form, and a
  mismatch fails as an unexplained `AssumeRoleWithWebIdentity` denial.
- [ ] Role permissions, nothing more: `s3:ListBucket` on the bucket, `s3:PutObject` on
  `releases/*`, `latest-mac.yml` and `Bike4Mind-latest-*.dmg`, `s3:GetObject` on `releases/*` (the
  server-side copy that makes the latest dmg reads its source), and `cloudfront:CreateInvalidation`
  on the distribution.

### 4. Variables and secrets

Repository **variables** (not secret, but not committed either):

| Name | Value |
| --- | --- |
| `DESKTOP_RELEASE_BUCKET` | bucket name; its presence is what arms the workflow |
| `DESKTOP_RELEASE_AWS_REGION` | the bucket's region |
| `DESKTOP_RELEASE_AWS_ROLE_ARN` | the OIDC role |
| `DESKTOP_RELEASE_DISTRIBUTION_ID` | CloudFront distribution (invalidation is skipped if unset) |
| `B4M_UPDATE_FEED_URL` | `https://<host>` |
| `B4M_DEFAULT_API_URL` | already exists (the CLI uses it) |
| `APPLE_TEAM_ID` | asserted against the signature |
| `DESKTOP_MAC_RUNNER` | optional; defaults to `macos-15` (arm64) |

`desktop-release` environment **secrets**:

| Name | Value |
| --- | --- |
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | its password |
| `APPLE_API_KEY_P8` | contents of the App Store Connect `.p8` |
| `APPLE_API_KEY_ID` | its key ID |
| `APPLE_API_ISSUER` | the issuer ID |

### 5. Rulesets the trigger relies on

- [ ] `main` must keep requiring a pull request (it does today). The push trigger assumes every
  change to `apps/desktop/package.json` arrived through a reviewed PR - in practice the Version
  Packages PR. A direct push that bumped the version would publish it.
- [ ] Nothing automated may need to push to `main` for a release: the workflow is `contents: read`.
- [ ] Do not add `apps/desktop/package.json` edits to any bot's bypass list.

### 6. First release

1. Set the variables and secrets, then dispatch a **dry run** from `main` and read its summary: it
   proves the role, the signing identity, notarization and the manifest shape.
2. The next Version Packages merge that bumps the desktop publishes it.
3. Download `<host>/Bike4Mind-latest-arm64.dmg` on a clean Mac (quarantine applies) and confirm it
   opens without a Gatekeeper prompt beyond the standard "downloaded from the internet".
4. Builds made before the feed URL existed have no feed and cannot update; their users reinstall once
   from the latest dmg.

## Testing the updater locally

No credentials needed for the check and download half:

```bash
# Build A (the installed app), pointed at a loopback feed. Loopback http is the one non-https
# feed resolveFeedUrl accepts.
B4M_UPDATE_FEED_URL=http://127.0.0.1:8765 pnpm --filter @bike4mind/desktop exec electron-vite build
pnpm --filter @bike4mind/desktop exec electron-builder --mac --arm64 --publish never \
  -c.publish.provider=generic -c.publish.url=http://127.0.0.1:8765
# Build B: bump the version, build again, then lay out a host directory the way the workflow does
# (release.mjs manifest + releases/v<version>/) and serve it on 127.0.0.1:8765.
```

`-c.extraMetadata.version=0.1.1` on the second `electron-builder` run produces B without touching
`package.json`. Run build A with `B4M_DESKTOP_VERBOSE=1` and `--user-data-dir=<scratch dir>` (so it
does not share a profile with your other builds). About 15s after the window is up it fetches
`latest-mac.yml`, resolves the `releases/v0.1.1/` URLs, downloads and sha512-checks the zip, hands it
to the Squirrel.Mac proxy and reaches `ready` with the release notes. **Restart then fails on an
unsigned build, by design**: Squirrel.Mac downloads the zip and rejects it with
`Code signature ... did not pass validation`, and the app keeps running the old version. The install
half can only be proven with a signed pair of builds, which is the first dry run's job.
