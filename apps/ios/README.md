# Bike4Mind iOS

Native iPhone app (SwiftUI, Swift 6). `make build`, `make test`, `make format`, `make lint` (see the Makefile).
Simulator-only until an Apple Developer team id is configured (`IOS_TEAM_ID`); see [DEVICE_TESTING.md](DEVICE_TESTING.md) for everything that
needs a device or signing.

## Feature map

| Area | Where it lives |
|------|----------------|
| Sign-in (PKCE, Keychain refresh token, App Lock) | `B4MKit/Auth`, `Bike4Mind/Features/SignIn` |
| First-launch welcome | `B4MKit/Onboarding`, `Bike4Mind/Features/Onboarding` |
| Chat home, Notebooks list and streaming chat over the realtime socket | `B4MKit/Sessions`, `Chat`, `Realtime`; `Features/Sessions` |
| Push registration, deep links and universal links | `B4MKit/Push`, `Links` |
| Live Activities and agent runs | `B4MKit/LiveActivity`, `Agents`; `Widgets/QuestLiveActivity.swift` |
| Share extension, camera and voice capture | `B4MKit/Capture`, `CaptureUI`, `ShareExtension` |
| Widgets, App Intents, media gallery | `Widgets`, `Features/Intents`, `Features/Media` |
| Account deletion and restore | `B4MKit/Account`, `Features/Account` |

## Targets and packages

- **Bike4Mind**: the app. **Widgets**: widget and Live Activity extension. **ShareExtension**: the share sheet target.
- **Packages/B4MKit**: everything that is not a view (API, auth, view models, wire formats); unit-tested on the simulator and the host.
- **Packages/B4MClient**: the generated OpenAPI client (see below).
- Screens never use generated types; `B4MKit` maps them to domain models behind `B4MAPI`.

## Account deletion

App Store Guideline 5.1.1(v). Settings (the avatar on the Chat home) > Delete Account requires typing `DELETE` and states the 30-day grace period. The wire is
hand-written (`B4MKit/Account/AccountDeletionWire.swift`) because the routes are not in the OpenAPI snapshot yet:
`DELETE /api/users/me`, `POST /api/users/me/restore-deletion`, a 409 `account_deletion_org_transfer_required` envelope listing
organizations, and the 403 `{accountDeletionPending, deletionScheduledFor}` gate. `URLSessionTransport` recognizes that 403 on any
call and `RootView` swaps the shell for the restore screen. Move the routes into the generated client when the snapshot catches up.

## Client version handshake

Every request declares the build with `X-Client-Name: b4m-ios` and `X-Client-Version` (`CFBundleShortVersionString` padded
to strict SemVer, so `1.0` goes out as `1.0.0`). `URLSessionTransport` (`B4MKit/Networking/HTTPTransport.swift`) stamps
them for the generated client, every hand-written wire and the share extension, and `URLSessionWebSocketConnector` for the
socket upgrade; presigned object-storage uploads and downloads are left alone. The identity, the 426 detector, the signal and
`ClientUpgradeStatus` live in `B4MKit/Networking/ClientIdentity.swift`.
When an admin raises `minimumClientVersions` for `b4m-ios` above the build, the server answers 426 `upgrade_required`: the
transport reports it on `ClientUpgradeSignal`, calls throw `APIError.upgradeRequired`, and `RootView` covers the app with the
update-required screen (`ClientUpgradeStatus`) without signing out. "Try again" and every foreground re-check through
`ClientVersionProbe`. The App Store link (`AppLinks.appStore`) is a placeholder until the app has an App Store id.

## Generated API client

`Packages/B4MClient` is generated from the backend's OpenAPI spec with
[swift-openapi-generator](https://github.com/apple/swift-openapi-generator) 1.14.3 (pinned exactly in
`Tools/Generator/Package.swift`; runtime pinned in `Packages/B4MClient/Package.swift`).

- **Committed output, no build plugin.** `Sources/B4MClient/Generated` is checked in, so a regeneration is a
  reviewable diff and building the app never fetches or compiles the generator.
- **Snapshot.** `Packages/B4MClient/openapi.json` is a copy of `apps/client/public/openapi.json`.
- **Filter.** `openapi-generator-config.yaml` lists the operations the app uses. The full spec generates
  ~140k lines; add an operation to the `filter.operations` list when a screen needs it.
  `sendChatMessage` is excluded: its request schema has both `max_tokens` and `maxTokens`, which collide and do not compile,
  so chat uses the hand-written `ChatSendWire`.

Regenerate:

```sh
make generate-client                          # re-run on the committed snapshot; git diff must be empty
make generate-client SPEC_REF=origin/main     # take a new snapshot from a git ref
make generate-client SPEC_FILE=/path/openapi.json
```

Screens never use generated types: `B4MKit` maps them to domain models behind the `B4MAPI` protocol
(`APIClient` is the implementation), so a regeneration cannot ripple into the UI.

## UI fixtures

A DEBUG build launched with `B4M_UI_FIXTURES=1` skips sign-in and serves canned sessions, transcript,
credits, media, widgets and capture (`Bike4Mind/Features/Debug/FixtureServices.swift`). `B4M_UI_FIXTURE_ACCOUNT=org-transfer`
shows the delete-account 409 list and `pending` launches on the restore screen:

```sh
SIMCTL_CHILD_B4M_UI_FIXTURES=1 xcrun simctl launch booted com.bike4mind.app
```

Fixture details worth knowing: each of the first sessions opens its own small transcript, and the pre-seeded "Working" turn in
Trip planning settles a few seconds after the session is first opened. Media items open generated local files (an image per tile, one
audio and one video clip; `FixtureMediaFiles.swift`). A fixture capture send steps through queued, uploading, registering and done so the
Sessions upload chip can be watched; the first send to the Receipts lake fails once ("No connection.") so Retry can be tried.

## Sign-in callback

The web sign-in sheet (`ASWebAuthenticationSession`, PKCE) returns to the app on a redirect URI. `OAuthConfiguration` holds
the two clients; `Bike4MindApp` picks one per build and, in DEBUG, per server:

| Build and server | client_id | redirect_uri | Needs |
|---|---|---|---|
| Release, any server | `b4m-ios-app` | `https://app.bike4mind.com/ios/auth-callback` (claimed universal link) | signed build, `webcredentials:` associated domain, AASA on app.bike4mind.com |
| DEBUG, production | `b4m-ios-app` | same https link | same as Release |
| DEBUG, any other server | `b4m-ios-app-dev` | `com.bike4mind.app://auth-callback` (private-use scheme, RFC 8252) | nothing; works on unsigned simulator builds |

The production client only ever redirects to the claimed https link, which only the app holding the associated domain can
receive. Any app can claim a custom scheme, and a first-party client skips the consent screen, so PKCE alone would not stop
another app from running its own flow against that client and receiving the code. The custom scheme therefore belongs to a
separate first-party client, `b4m-ios-app-dev`, which the server seeds on non-production stages only (never on production).
It has to be first-party all the same: the app routes refuse relying-party tokens.

The scheme is deliberately not in `CFBundleURLTypes`: the session intercepts the redirect itself, and registering it would
let any app or page open Bike4Mind with that URL. Server URIs are exact-match.

## Push notifications and universal links

- `Bike4Mind.entitlements` declares `aps-environment` (`development`; Xcode rewrites it to `production` when
  archiving with distribution signing) and `applinks:app.bike4mind.com` and `webcredentials:app.bike4mind.com` (the AASA file needs both an `applinks` entry
  and a `webcredentials.apps` entry for the app id).
- Unsigned simulator builds ignore entitlements (the simulator `.xcent` is empty), so `make build` stays green with
  no team. Nothing is gated. Once an Apple Developer team id is configured: set `DEVELOPMENT_TEAM`, enable the Push
  Notifications and Associated Domains capabilities on the App ID, and publish the AASA file on app.bike4mind.com.
  Until then, universal links open in Safari and APNs registration fails (logged, harmless) in the simulator.
- Authorization: provisional (silent) on first signed-in moment; the system prompt appears once, when the user first
  opens a conversation (`PushRegistrationCoordinator.userDidReachValueMoment`).

## Widgets, App Intents and the media gallery

- **Widgets** (`Widgets/`): the app writes a `WidgetSnapshot` JSON into the `group.com.bike4mind.app` container and the extension only reads it, with no network or auth in the widget process. The app calls `WidgetCenter.reloadTimelines` when a chat turn settles, credits load, or the latest image changes. A missing container degrades to placeholders. `Widgets/Bike4MindWidgets.swift` is the bundle entry point and registers the widgets plus `QuestLiveActivity`, which reuses `Widgets/Shared/`.
- **App Intents** (`Bike4Mind/Features/Intents/`): Ask, Start quest and Capture note only open the composer with a draft (`AssistantRequest.route`); they never send. Ask and Capture note land on the home screen, the root of the stack.
- **Settings** (`Bike4Mind/Features/Settings/`): the avatar on the home screen and the drawer's account row push Settings onto the stack, and `Route.settings` (deep links, the Credits widget) lands there too. The profile header reads the access token's claims (`AccountProfile`); there is no profile endpoint.
- **Studio** (code name `media`, `Bike4Mind/Features/Media/`): a grid over the Files API via the hand-written `MediaClient`. Presigned URLs are re-fetched near expiry and at most twice after a playback failure. Under `B4M_UI_FIXTURES=1` the Studio gallery and the widgets show canned data.
## Navigation

- One navigation stack rooted at the start-of-chat home (`NewConversationView`); there is no tab bar, so chat owns the full screen. The stack's path and the drawer's open state live in `AppNavigator`, which every route goes through.
- A leading sidebar drawer (`Features/Shell/HomeDrawer.swift`) opens from the home menu button or a drag from the left edge. Rows: New chat, Studio, the most recent notebooks plus All notebooks, and an account footer that opens Settings. The home avatar is a second path to Settings.
- The drawer grows additively: a new top-level surface is a new drawer row (optionally gated by client config), and existing rows never move.
- Studio hosts creation surfaces as they land, with the media gallery as its root today.
- As with Notebooks (`session` in code), user-facing names differ from code names: `Route.media`, `SessionsDestination.studio` and the `media-*` accessibility identifiers keep their names.

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

## App icon and launch screen

The icon is a generated **placeholder** (three connected nodes on a brand-blue gradient, no text) so builds look finished.
Replace it with real artwork whenever it exists: drop a 1024x1024 PNG over
`Bike4Mind/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` and the launch mark in `LaunchMark.imageset`.
To regenerate the placeholder: `swift Tools/GenerateAppIcon.swift`. The launch screen is `AppSupport/Info.plist` (`UILaunchScreen`:
`LaunchBackground` colour plus the centered `LaunchMark` image).

## Privacy manifests and App Privacy answers

`PrivacyInfo.xcprivacy` ships in the app, `Widgets` and `ShareExtension`. No tracking, no tracking domains, no diagnostics or
analytics SDKs. Required-reason API declared: UserDefaults (`CA92.1` app's own data, `1C8F.1` same App Group). Re-check this list when
adding code that reads file timestamps, disk space or system uptime.

App Store Connect questionnaire (all data is **linked to the user**, **not used for tracking**, purpose **App Functionality**):

| Data type | Collected | Why |
|-----------|-----------|-----|
| Contact Info: Email Address, Name | Yes | Account sign-in (completed in the web sign-in sheet) |
| Identifiers: User ID, Device ID | Yes | Session identity; APNs token for push |
| User Content: Photos or Videos, Audio Data, Other User Content | Yes | Chat messages, files, images and voice notes the user sends |
| Diagnostics (crash, performance), Usage Data, Location, Health, Financial, Browsing, Search | No | Not collected |

Does the app track users across other companies' apps or sites: **No**. Account deletion is available in the app. Keep this table
in sync with the manifests and with what the build actually sends.

## fastlane and CI

- `bundle install`, then `bundle exec fastlane test` (same as `make test`), `build` (simulator build) and `beta` (TestFlight).
  **`beta` is a stub:** it refuses to run until `IOS_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_CONTENT_BASE64` are set,
  and signing is not configured in the repo.
- `.github/workflows/ios.yml` runs on changes to `apps/ios/**`: the entitlements parity check (`Tools/check-entitlements-parity.sh`), `make lint`, `make test`,
  the generated-client reproducibility check (`make generate-client` then `git status --porcelain` must be empty) and `make build`, with SwiftPM cached.
  The workflow selects the newest installed Xcode 26.x and the first available iPhone simulator. The runner needs an Xcode that matches the project's SDK; adjust the runner image if it lags.

## Device testing

[DEVICE_TESTING.md](DEVICE_TESTING.md) is the checklist for everything the simulator cannot prove.
