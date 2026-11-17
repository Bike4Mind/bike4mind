# Mobile release train

How the native apps (`apps/ios`, `apps/android`) get from `main` to testers and the stores: a monthly train, one shared version per train, a parity matrix that decides what is allowed on it, and two CI lanes that produce installable builds (TestFlight and the Play internal testing track). The web app keeps deploying continuously and is not on the train; it appears in the matrix only as the reference each mobile platform is measured against.

## Parts

| Part | Where |
| --- | --- |
| Parity matrix (source of truth) | [`packages/scripts/src/mobileRelease/parityMatrix.json`](../packages/scripts/src/mobileRelease/parityMatrix.json) |
| Matrix rules and gate | `packages/scripts/src/mobileRelease/parityMatrix.ts` |
| Version scheme, build numbers, handshake checks | `packages/scripts/src/mobileRelease/versioning.ts` |
| CLI | `pnpm --filter @bike4mind/scripts mobile-release <command>` (`src/mobileRelease/cli.ts`) |
| iOS lane | [`.github/workflows/ios-testflight.yml`](../.github/workflows/ios-testflight.yml), which runs the `beta` lane in `apps/ios/fastlane/Fastfile` |
| Android lane | [`.github/workflows/android-play-internal.yml`](../.github/workflows/android-play-internal.yml), signing wired in `apps/android/app/build.gradle.kts` |

## Parity matrix

One row per user-facing feature, one cell per platform (`web`, `ios`, `android`), and an optional `train` (`YY.M`) the feature is due in.

| Status | Meaning |
| --- | --- |
| `green` | Merged, tested on a device per the platform's `DEVICE_TESTING.md`, and ready for users on that platform. |
| `yellow` | In progress. |
| `red` | Not started. |
| `na` | Never ships on this platform (a widget has no web cell). Counts as green for every rule below. |

**The gating rule.** A feature has shipped when its whole web / iOS / Android row is green. A train build for a platform is refused while any feature due in that train, or an earlier one, is not green on that platform. The lane's `plan` job runs that check (`mobile-release plan`), so a red cell stops the build before anything is signed, and the job log names the features. A row without a `train` never blocks; it is tracked, not scheduled.

A slipped feature unblocks the train in exactly one way: someone moves its `train` to a later month in a PR. That makes the slip a reviewed decision instead of a silent one. Hide an unfinished feature behind its client-config flag until its cell is green; the matrix records readiness, the flag controls exposure.

**Who updates it.**

- The engineer who lands a feature's work on a platform flips that platform's cell in the same PR. A PR that turns a cell `green` is where the reviewer checks the device-testing evidence.
- The train captain (the engineer running that month's train, rotating) assigns `train` to features at planning and retargets any that slipped at the cut.
- New features get a row when their first platform PR lands, with the other cells `red` or `na`.

The `@bike4mind/scripts` unit suite validates the committed matrix (schema, unique kebab-case ids, train format) on every PR, so a malformed edit fails CI. Locally: `pnpm --filter @bike4mind/scripts mobile-release validate`.

## Versioning

A train version is `YY.M.PATCH`: the two-digit year and the month of the train cut, then the hotfix number (`26.12.0` for the December 2026 train, `26.12.1` for its first hotfix). No leading zeros. It is plain SemVer, so it is the same string in all three places:

- iOS `CFBundleShortVersionString` (`MARKETING_VERSION`) and Android `versionName`.
- The `X-Client-Version` header the apps send with `X-Client-Name: b4m-ios` / `b4m-android` (the client-version handshake, `b4m-core/common/src/api-contract/clientVersion.ts`, CONVENTIONS.md section 9).
- The values in the `minimumClientVersions` admin setting.

Each upload also needs a build number that only ever rises. Both platforms use the same one, `YYMMPPSS`: year, month, patch, then the slot `SS`, which is the rc number (1-98) for a release candidate and 99 for the final build. `26.12.0-rc.1` builds as `26120001`, `26.12.0-rc.2` as `26120002`, the final `26.12.0` as `26120099` and `26.12.1-rc.1` as `26120101`. It becomes iOS `CFBundleVersion` (`CURRENT_PROJECT_VERSION`) and Android `versionCode`, and stays well under Play's versionCode ceiling.

A release candidate is marked only by its tag and build number. The binary carries the bare version, so `26.12.0-rc.2` identifies itself to the server as `26.12.0`.

**Minimum supported version per platform.** Because the store version and the handshake version are the same string, `minimumClientVersions` means "the oldest train still served" per platform, and each platform moves on its own, e.g. `{"b4m-ios": "26.11.0", "b4m-android": "26.12.0"}`. A mobile minimum must be a train version: a pre-release minimum never matches what a store build sends. Check a value before saving it:

```sh
pnpm --filter @bike4mind/scripts mobile-release check-minimums --minimums '{"b4m-ios":"26.11.0"}'
```

Raise a platform's minimum only after the release it names is live in that store and has had time to reach users, and announce it first (CONVENTIONS.md section 9). Builds from before the first train report `0.1.0`; they are below any train version, so the first raised minimum turns them all away.

## Monthly cadence

| When | What |
| --- | --- |
| Week before the cut | Planning: the train captain sets `train` on the features meant for this month and chases red and yellow cells. |
| First business day of the month: cut | Get the version with `mobile-release train-version` (or `--date YYYY-MM-DD`). Retarget anything not green. Branch `release/mobile-YY.M` from `main` and push the tag `mobile-vYY.M.0-rc.1` on it. Both lanes run. |
| Week 1-2: soak | Internal testers on TestFlight and the Play internal track run each platform's `DEVICE_TESTING.md` (the iOS TestFlight smoke list included). Fixes land on `main` first and are cherry-picked to the release branch; each round is a new `-rc.N` tag. |
| End of week 2: release | Tag `mobile-vYY.M.0` on the commit of the approved rc. The lanes build the final build (slot 99); submit it for App Store review and promote it to production in the Play Console by hand. Store promotion is deliberately not automated. |
| Any time: hotfix | Cherry-pick to `release/mobile-YY.M` and tag `mobile-vYY.M.(P+1)-rc.1`, then the final tag, the same way. |

A train that cannot go green on one platform can still ship on the other: the gate is per platform.

## Distribution lanes

Both workflows trigger on a `mobile-v*` tag push, or by hand (`workflow_dispatch` with `version` and an optional `rc`) from `main` or a `release/mobile-*` branch. Each has two jobs:

1. **plan** (Ubuntu, the shared [`_mobile-release-plan.yml`](../.github/workflows/_mobile-release-plan.yml)): installs the workspace, builds `@bike4mind/common`, and runs `mobile-release plan --platform <ios|android>`, which parses the tag or inputs, applies the parity gate, and outputs the version and build number.
2. **The lane**, in the `mobile-release` GitHub environment, so its secrets are scoped there and required reviewers on that environment gate every upload.
   - **iOS** (`macos-26`): selects Xcode 26.x as `ios.yml` does, then `bundle exec fastlane beta`, which archives with automatic signing through the App Store Connect API key and uploads to TestFlight. The build lands in TestFlight for internal testers once Apple finishes processing.
   - **Android** (Ubuntu): decodes the upload keystore into the runner's temp dir, runs `./gradlew :app:bundleRelease` with the planned `versionName` and `versionCode` and the `FCM_*` values as `b4m.fcm.*` Gradle properties (a build without them would ship with push off), and uploads the signed bundle to the Play internal testing track.

### Required secrets and variables

Set these on the `mobile-release` environment (Settings, Environments). Nothing here is committed.

Also on that environment, limit **Deployment branches and tags** to `main`, `release/mobile-*` and the tag pattern `mobile-v*`, and add a tag ruleset that restricts who can create `mobile-v*` tags. The workflows' own branch check runs from the dispatched ref's copy of the workflow, so a branch could edit it out; the environment policy is what actually keeps secrets away from other refs.

| Name | Kind | Lane | Value |
| --- | --- | --- | --- |
| `IOS_TEAM_ID` | secret | iOS | Apple Developer team id. |
| `ASC_KEY_ID` | secret | iOS | App Store Connect API key id (App Manager role). |
| `ASC_ISSUER_ID` | secret | iOS | App Store Connect API issuer id. |
| `ASC_KEY_CONTENT_BASE64` | secret | iOS | The `.p8` API key, base64-encoded. |
| `ANDROID_KEYSTORE_BASE64` | secret | Android | The Play upload keystore (`.jks`), base64-encoded. With Play App Signing this is the upload key, not the app signing key. |
| `ANDROID_KEYSTORE_PASSWORD` | secret | Android | Keystore password. |
| `ANDROID_KEY_ALIAS` | secret | Android | Upload key alias. |
| `ANDROID_KEY_PASSWORD` | secret | Android | Upload key password. |
| `PLAY_SERVICE_ACCOUNT_JSON` | secret | Android | JSON key of a Google Cloud service account invited in the Play Console with release permission for the app. |
| `ANDROID_PACKAGE_NAME` | variable | Android | The app's Play package name (the `applicationId`). |
| `FCM_APPLICATION_ID` | variable | Android | Firebase app id (`mobilesdk_app_id` in the console's `google-services.json`). Client config, not a secret. Baked into the build; push is off without it. |
| `FCM_API_KEY` | variable | Android | Firebase web API key (`current_key` in `google-services.json`). Client config, not a secret. |
| `FCM_PROJECT_ID` | variable | Android | Firebase project id. |
| `FCM_SENDER_ID` | variable | Android | Firebase sender id (`project_number`). |
| `ANDROID_PLAY_RELEASE_STATUS` | variable, optional | Android | `completed` by default. Set to `draft` until the app's first Play review is done, since Play accepts only drafts before then. |

Each lane checks its credentials up front and fails with the list of missing names rather than half-running.

### One-time setup before the first build

- **iOS:** an App Store Connect app record for the bundle id, the Push Notifications and Associated Domains capabilities on the App ID, and the AASA file on the web domain (see `apps/ios/README.md`).
- **Android:** a Play Console app with Play App Signing enabled; the first bundle may need a manual upload in the Console before the API accepts uploads. Register the `b4m-android-app` OAuth client and publish `assetlinks.json` on the server before testers sign in on a release build (see `apps/android/README.md`).
