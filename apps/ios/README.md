# Bike4Mind iOS

`make build`, `make test`, `make format`, `make lint` (see the Makefile).

## Generated API client

`Packages/B4MClient` is generated from the backend's OpenAPI spec with
[swift-openapi-generator](https://github.com/apple/swift-openapi-generator) 1.14.3 (pinned exactly in
`Tools/Generator/Package.swift`; runtime pinned in `Packages/B4MClient/Package.swift`).

- **Committed output, no build plugin.** `Sources/B4MClient/Generated` is checked in, so a regeneration is a
  reviewable diff and building the app never fetches or compiles the generator.
- **Snapshot.** `Packages/B4MClient/openapi.json` is a copy of `apps/client/public/openapi.json`.
- **Filter.** `openapi-generator-config.yaml` lists the operations the app uses. The full spec generates
  ~140k lines; add an operation to the `filter.operations` list when a screen needs it.
  `sendChatMessage` is excluded for now: its request schema has both `max_tokens` and `maxTokens`, which
  collide and do not compile. Chat (M3) has to fix that first.

Regenerate:

```sh
make generate-client                          # re-run on the committed snapshot; git diff must be empty
make generate-client SPEC_REF=origin/main     # take a new snapshot from a git ref
make generate-client SPEC_FILE=/path/openapi.json
```

Screens never use generated types: `B4MKit` maps them to domain models behind the `B4MAPI` protocol
(`APIClient` is the implementation), so a regeneration cannot ripple into the UI.

## UI fixtures

A DEBUG build launched with `B4M_UI_FIXTURES=1` skips sign-in and serves canned sessions, transcript
and credits (`Bike4Mind/Features/Debug/FixtureServices.swift`):

```sh
SIMCTL_CHILD_B4M_UI_FIXTURES=1 xcrun simctl launch booted com.bike4mind.app
```

## Push notifications and universal links

- `Bike4Mind.entitlements` declares `aps-environment` (`development`; Xcode rewrites it to `production` when
  archiving with distribution signing) and `applinks:app.bike4mind.com`.
- Unsigned simulator builds ignore entitlements (the simulator `.xcent` is empty), so `make build` stays green with
  no team. Nothing is gated. Once an Apple Developer team exists: set `DEVELOPMENT_TEAM`, enable the Push
  Notifications and Associated Domains capabilities on the App ID, and publish the AASA file on app.bike4mind.com.
  Until then, universal links open in Safari and APNs registration fails (logged, harmless) in the simulator.
- Authorization: provisional (silent) on first signed-in moment; the system prompt appears once, when the user first
  opens a conversation (`PushRegistrationCoordinator.userDidReachValueMoment`).

## Share and capture

- **Share extension** (`ShareExtension/`): a `com.apple.share-services` target that takes links, text, images, PDFs and
  files from any app, lets the user pick a lake or session and an optional note, and uploads in the background. The target is a
  thin shell; mapping, the destination memory, the upload state machine and the wire clients live in
  `Packages/B4MKit/Sources/B4MKit/Capture`. `CaptureUI/` (the composer view) is compiled into both the app and the extension.
- **In-app capture**: the Sessions toolbar's capture menu (camera, photo library, voice note) and the microphone button in the
  chat composer reuse the same composer and engine.
- **Uploads** go `POST /api/v1/files` -> presigned `PUT` (background `URLSession`) -> poll `GET /api/v1/files/{id}` until
  scanned -> attach (`POST /api/v1/data-lakes/{id}/files/{file}` or a chat turn with `fileIds`). Jobs are JSON files in the App
  Group container, so either process can resume the other's work. The app re-creates the extension's session when the system
  relaunches it (`handleEventsForBackgroundURLSession`).
- **Voice** records with `AVAudioRecorder` and transcribes through `POST /api/v1/transcriptions/uploads` + `POST /api/v1/transcriptions`.
- **Shared access**: both targets carry the `group.com.bike4mind.app` App Group and the `$(AppIdentifierPrefix)com.bike4mind.shared`
  keychain group so the extension can read the app's refresh token. The team prefix is resolved at runtime; with no entitlement in
  effect (an unsigned build) the keychain item stays private to the app, the App Group falls back to Application Support, and the
  extension simply reports it is signed out. The share flow works end to end only on a signed build with both capabilities enabled.
- `B4M_UI_FIXTURES=1` swaps in fixture destinations, submission and transcription, in the app and in the extension.
