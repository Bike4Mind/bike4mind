# Mobile E2E (Maestro)

One Maestro suite, run unchanged against the iOS app (`apps/ios`) and the Android app (`apps/android`). It is the
drift detector for the parity model: a journey that passes on one platform and fails on the other fails that
platform's lane in `.github/workflows/mobile-e2e.yml` (the lanes are separate jobs).

Both apps use the bundle/application id `com.bike4mind.app`, so flows address elements the same way on both:

- iOS: `accessibilityIdentifier("...")`
- Android: `Modifier.testTag("...")`, exposed as resource ids (`testTagsAsResourceId` is set once in `MainActivity`)
- Flows use `id: <name>`; give both platforms the same name. Where the layouts genuinely differ (for example
  sign-out sits behind Settings on iOS and in the top bar on Android), the flow branches with `when: platform:`.

## Layout

```
flows/              top-level flows: the blocking pass (non-recursive on purpose)
flows/quarantine/   flows that run non-blocking (see below)
subflows/           shared steps (sign-in, start a chat, ...), never run on their own
scripts/            run-flows.sh (the one entry point CI and humans use), fetch-otc.js
```

| Flow | Tags | Needs |
|---|---|---|
| `00-launch` | `smoke` | nothing; both platforms |
| `01-sign-in`, `02-start-chat`, `04-sign-out` | `live` | staging test user (below); both platforms |
| `03-agent-approval` | `fixture`, `ios-only` | nothing (iOS canned data, `B4M_UI_FIXTURES`); Android does not render approvals yet |

Tags are how a platform opts out: `run-flows.sh android` excludes `ios-only` and `fixture`. Retire `ios-only` when
the Android client gains the feature, and add the matching test tags.

## Running it

Staging test user, from your shell or CI secrets (never committed):

| Env var | CI secret | Meaning |
|---|---|---|
| `B4M_E2E_SERVER_URL` | `MOBILE_E2E_SERVER_URL` | origin of the staging server the Debug build signs in to |
| `B4M_E2E_EMAIL` | `MOBILE_E2E_EMAIL` | staging test user; the address must end in `-e2e@test.com` |
| `B4M_E2E_CLEANUP_SECRET` | `MOBILE_E2E_CLEANUP_SECRET` | the staging stage's `E2E_CLEANUP_SECRET`; lets `fetch-otc.js` read the login one-time code so no mailbox is needed |

Sign-in is the real flow: the app's web sign-in sheet, email, one-time code. No tokens are injected.
Without all three, `run-flows.sh` skips the `live` flows and prints a loud warning (a GitHub annotation in CI).

```bash
# iOS: build the Debug app (apps/ios: make build), install it on a booted simulator, then
apps/mobile-e2e/scripts/run-flows.sh ios
# Android: install the Debug APK (apps/android: ./gradlew :app:assembleDebug) on a running emulator, then
apps/mobile-e2e/scripts/run-flows.sh android
```

Install Maestro (needs a JDK 17+) from the pinned release in `.github/workflows/mobile-e2e.yml`, or see
https://docs.maestro.dev. Reports and screenshots land in `$REPORT_DIR` (default `./report`, gitignored).

## Flake policy: quarantine, never delete

A flaky flow must not block merges and must not be deleted (deleting hides the drift it was written to catch).

- **Quarantine:** `git mv flows/<name>.yaml flows/quarantine/<name>.yaml` and fix its `runFlow` paths
  (`../subflows/` becomes `../../subflows/`). Add a `quarantine` tag and a one-line comment saying why and
  linking the tracking issue. The flow keeps running in the non-blocking step of both lanes, so its results
  stay visible.
- **Un-quarantine:** once it has passed on both lanes for a week of runs, `git mv` it back, restore the paths,
  and drop the comment.
- A quarantined flow that fails never fails the lane. A flow on the blocking pass that fails does.
