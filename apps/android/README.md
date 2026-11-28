# Bike4Mind Android

Native Android client (Kotlin, Jetpack Compose). `make test`, `make build`, `make lint`, `make generate-client` (see the
Makefile). Needs a JDK 17+ on `PATH` and an Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`); Gradle
comes from the pinned wrapper. CI: [`.github/workflows/android.yml`](../../.github/workflows/android.yml),
path-filtered to this directory and kept out of the web pipelines, as `apps/ios` is.

## Modules

- **client**: the generated OpenAPI client (see below), a plain Kotlin/JVM library.
- **kit**: the engine, a plain Kotlin/JVM library with JVM tests (twin of `apps/ios/Packages/B4MKit`): client identity
  headers and the 426 upgrade signal, the HTTP transport (bearer token, one refresh-and-retry on 401), PKCE sign-in and
  the token session, sessions, the chat send/stream/poll loop and the realtime socket. Android types stay out of it.
- **app**: the Compose app (twin of `apps/ios/Bike4Mind`): screens, the Keystore-encrypted token store, the Custom Tab
  sign-in and the debug server picker. Behavior belongs in `kit`; the app wires it (`AppGraph`).

## Running the app

`./gradlew :app:installDebug` on a running emulator or a connected phone. Debug builds talk to staging unless built with
`-Pb4m.serverUrl=https://...` (or `http://10.0.2.2:3000` for a local server from the emulator), and the sign-in screen can
switch servers at runtime. Release builds always use production. Walkthroughs that need a device are in
[DEVICE_TESTING.md](./DEVICE_TESTING.md).

## Sign-in callback

Sign-in is the server's own OAuth 2.0 + PKCE web flow in a Custom Tab, so email and Google sign-in need no native SDK.

| Build | OAuth client | Redirect |
| --- | --- | --- |
| debug (non-production servers) | `b4m-ios-app-dev` (shared with iOS debug builds) | `com.bike4mind.app://auth-callback` |
| release (production) | `b4m-android-app` (not registered on the server yet) | `https://app.bike4mind.com/android/auth-callback` (App Link) |

A production build needs the server to register `b4m-android-app` and publish `/.well-known/assetlinks.json` first.

## Push notifications (FCM)

The app registers its FCM token through `POST /api/v1/push-tokens` (`platform: android`) while signed in and notifications
are allowed, and withdraws it on sign-out or when the user turns notifications off (`kit/push`, twin of the iOS
`PushRegistrationCoordinator`). The server sends through FCM HTTP v1 when its `FCM_SERVICE_ACCOUNT` secret is set (see the
deployment secrets reference).

Firebase is configured from Gradle properties, not a `google-services.json` and not the google-services plugin, so nothing
project-specific is committed. Take the four values from the Firebase console (Project settings -> Your apps -> the
`com.bike4mind.app` Android app; they are the fields of its `google-services.json`) and put them in
`~/.gradle/gradle.properties` or pass them with `-P`:

| Property | `google-services.json` field |
| --- | --- |
| `b4m.fcm.applicationId` | `client[0].client_info.mobilesdk_app_id` |
| `b4m.fcm.apiKey` | `client[0].api_key[0].current_key` |
| `b4m.fcm.projectId` | `project_info.project_id` |
| `b4m.fcm.senderId` | `project_info.project_number` |

With any of them unset the app builds and runs normally and simply never gets a push token (CI builds this way).

Tapping a push routes by its `data` (`kit/push/PushRoute`): a `brief_ready` push opens that brief; any other push opens
its `deepLink` (see below), else its `sessionId`. Which categories a user receives is a server-side preference
(`preferences.pushNotifications`); the app has no settings screen for it yet.

## Links

`kit/links/DeepLinkRouter` (twin of the iOS router) maps Bike4Mind URLs to screens: `/notebooks/<id>` and
`/sessions/<id>` open that chat, `/briefs/<id>` that brief, `/notebooks`, `/sessions` and the root the chats list.
Any other page opens in the browser. It accepts `https://app.bike4mind.com` links and links to the server the build talks
to, since a push `deepLink` is built from that server's URL.

The manifest claims `app.bike4mind.com` for the paths with a native screen, with `autoVerify`. Android only opens them
in the app once the server publishes `/.well-known/assetlinks.json` for the app's signing certificate; until then they
open in the browser. To try one without that, target the app directly:

```bash
adb shell am start -a android.intent.action.VIEW -d https://app.bike4mind.com/notebooks/<id> com.bike4mind.app
```

## Artifacts

`kit/artifacts` and the Artifacts screens (reachable from the chats list while `features.artifacts` is on) read the user's
own artifacts through the public API (`listArtifacts`, `getArtifact`). `ArtifactType.presentation` decides how each type is
shown: html, svg and mermaid in a hardened WebView, code and prose as selectable text, and react, recharts, lattice and chess
as an "Open full version" link to the web app in a Custom Tab. `ArtifactDocuments` builds the WebView pages: every page gets a
Content-Security-Policy, the markup is stripped of frames, base and meta tags, and svg is stripped of scripts. The WebView
has no JS bridge, file access, storage or cookies, and loads with a null origin.

`app/src/main/assets/mermaid.min.js` is the diagram renderer (mermaid 11.17.2, MIT, licence beside it), served to the
WebView from the app's assets. To update it, copy `dist/mermaid.min.js` from the `mermaid` package and bump the version here.

## Client identity

Every request carries `X-Client-Name: b4m-android` and `X-Client-Version` (the app's `versionName`, padded to
`MAJOR.MINOR.PATCH`), so `minimumClientVersions["b4m-android"]` can refuse an old build with a 426. Keep `versionName`
to one to three integers; anything else sends neither header.

## Releases

Release builds ship on the monthly mobile train: `.github/workflows/android-play-internal.yml` builds a signed bundle and uploads it to the Play internal testing track on a `mobile-v*` tag. `versionName` and `versionCode` come from `-Pb4m.versionName` / `-Pb4m.versionCode`, and signing from `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; without them a release build is unsigned at `0.1.0` (1). Process, version scheme and secrets: [docs/mobile-release-train.md](../../docs/mobile-release-train.md).

## Generated API client

`client/` is generated from the backend's OpenAPI spec with [openapi-generator](https://openapi-generator.tech)'s
`kotlin` generator, library `jvm-ktor`, serialization `kotlinx_serialization`, at the version pinned in
`gradle/libs.versions.toml`. The pipeline follows `apps/ios/Packages/B4MClient`:

- **Committed output.** `client/generated` is checked in, so a regeneration is a reviewable diff and building never runs
  the generator. CI regenerates from the snapshot and fails on any diff.
- **Snapshot.** `client/openapi.json` is a copy of `apps/client/public/openapi.json` with overlay-only enum values
  stripped (`scripts/strip_overlay_literals.py`). Refresh it with `make generate-client SPEC_REF=origin/main`.
- **Drift signal.** The snapshot is not refreshed by server changes. `native-openapi-drift.yml` compares it (after the
  overlay-literal stripping above) with `apps/client/public/openapi.json` on every PR that touches the spec or a
  snapshot, and keeps one PR comment up to date with the per-client difference. It **warns and never blocks**: the
  check stays green so an API change does not have to regenerate Swift and Kotlin in the same PR. Additive changes
  still decode; regenerate before shipping a removed, renamed or retyped field.
- **Open enums.** `scripts/open_enums.py` drops every string `enum` before generation, so a value the server adds later
  decodes as a plain string instead of failing the whole response on every installed build. A test guards it.
- **Filter.** `client/operations.txt` lists the operations the app uses; `scripts/filter_operations.py` prunes the rest
  of the spec and every schema they do not reach. Add an operationId there when a screen needs it.
- **JSON.** Pass `installB4MJson()` as each API's `httpClientConfig`: the generator installs no converter, and
  `B4MClientJson` ignores unknown keys and decodes omitted optionals as null. OpenAPI `number` maps to `Decimal`
  (an exact `BigDecimal`), free-form values to `JsonElement`.
- `sendChatMessage` is excluded, as on iOS: its response is an anyOf the generator flattens into one class that
  cannot decode the queued shape.

The two Python scripts `open_enums.py` and `strip_overlay_literals.py` are copies of the iOS ones; change both together.
