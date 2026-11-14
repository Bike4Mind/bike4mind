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

## Client identity

Every request carries `X-Client-Name: b4m-android` and `X-Client-Version` (the app's `versionName`, padded to
`MAJOR.MINOR.PATCH`), so `minimumClientVersions["b4m-android"]` can refuse an old build with a 426. Keep `versionName`
to one to three integers; anything else sends neither header.

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
