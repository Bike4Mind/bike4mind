# Device-only verification

Everything below needs a physical iPhone, a signed build, or a deployed backend, so none of it runs in the simulator or in
CI. Work through it before the first TestFlight build and again before each release. Mark each item with the build and date.

## Prerequisites (Apple Developer portal and backend)

- [ ] Paid team, `DEVELOPMENT_TEAM` set, automatic signing on for the app and both extensions.
- [ ] App IDs for `com.bike4mind.app`, the Share extension and the Widgets extension with these capabilities: Push
      Notifications, Associated Domains, App Groups (`group.com.bike4mind.app`), Keychain Sharing
      (`$(AppIdentifierPrefix)com.bike4mind.shared`). The App Group and the keychain group must be enabled on **all three**
      bundle ids, or the extension cannot reach the session.
- [ ] `apple-app-site-association` published at `https://app.bike4mind.com/.well-known/apple-app-site-association` listing
      `/sessions/*` and `/notebooks/*`.
- [ ] APNs auth key uploaded to the backend; Live Activity push (`liveactivity` push type) enabled for it.
- [ ] Backend deployed with the iOS OAuth client, push-token routes, Live Activity token kind, agent-run route and the
      account-deletion routes (see Account deletion below).

## Push notifications (real APNs)

- [ ] Sign in; the device token registers (`POST /api/v1/push-tokens`, `kind: device`, `environment: sandbox` on a debug build,
      `production` on TestFlight).
- [ ] First launch: provisional authorization, no system alert. Opening the first conversation shows the one system prompt.
- [ ] A push for a finished quest arrives with the app backgrounded, killed and in the foreground (foreground policy: no banner
      for the screen you are already looking at).
- [ ] Tapping the notification opens `/sessions/{id}` directly, including from a cold start (route queued until the shell is up).
- [ ] Notification category toggles and the Settings master toggle (denied state opens iOS Settings).
- [ ] Sign-out unregisters the token (server no longer pushes to the device).

## Live Activities and agent runs

- [ ] Start a chat turn: a Live Activity appears with real `pushType: .token`; the token is POSTed
      (`kind: liveActivity`, with activity id and quest id) before the first server frame.
- [ ] Server frames update the activity and end it; Lock Screen and Dynamic Island (compact, expanded, minimal) render correctly.
- [ ] Stale dimming after the activity goes stale; the approval-needed state shows the urgent treatment.
- [ ] Settings > Live Activities set to off: the app starts none and does not crash.
- [ ] Five-activity cap: a sixth quest does not start a sixth activity and the oldest is handled as designed.
- [ ] Sign-out ends every activity and unregisters their tokens, including with the device offline (activities still end locally).
- [ ] Relaunch adopts activities that were running when the app was killed.
- [ ] Agent run against staging: the composer toggle sends `202`, the app polls, a second run while one is in flight gets `409`
      (in-flight cap) with a readable message, and a user without the admin `EnableAgentMode` setting does not see the toggle.

## Universal links

- [ ] With associated domains and real signing, `https://app.bike4mind.com/sessions/{id}` and `/notebooks/{id}` open the app from
      Notes, Messages and Safari. (Unsigned simulator builds open Safari instead; that is expected there.)
- [ ] A link while signed out waits for sign-in and then opens the right screen.

## Share extension and capture

- [ ] Share a link, text, an image, a PDF and a file from Safari, Photos and Files: the composer lists them, destination memory
      persists, and the upload completes.
- [ ] The extension reads the app's session through the shared keychain group; signed out in the app shows "signed out" in the extension.
- [ ] Background upload survives killing the host app and the extension; the app relaunches for background URLSession events and
      finishes attach.
- [ ] **Simultaneous refresh-token rotation:** refresh tokens are single-use and rotate. With an expired access token, trigger a
      refresh in the app and the extension at the same moment (start a share while the app is foregrounded, repeat many times).
      Watch for a sign-out storm: either process must not end the session when the other rotated first. The app retries once with
      the freshly stored token; confirm the extension does too.
- [ ] Camera, microphone and photo-library permission prompts show the usage strings and denial is handled with a clear message.
- [ ] Voice note records, transcribes and drops text into the composer.

## Media, AirPlay and Siri

- [ ] Video and audio play from the gallery; AirPlay routes; Picture in Picture works; presigned URL expiry recovers on its own.
- [ ] Siri phrases for Ask, Start quest and Capture note are recognized; the actions appear in Shortcuts and Spotlight and only
      open the composer with a draft (never send).
- [ ] Widgets: Credits, Latest generation and Running agents in the gallery (small and medium), placeholder and signed-out
      appearance, dark mode, and a tap landing on the right screen.

## Account deletion (App Store 5.1.1(v))

Against a backend that has the deletion routes deployed:

- [ ] Settings > Delete Account: the button stays disabled until `DELETE` is typed; success signs the app out immediately, clears the
      keychain, ends activities and shows the "scheduled for deletion" note on sign-in.
- [ ] An account that owns an organization gets the 409 list of organization names; the session stays signed in.
- [ ] An impersonating admin session gets the "not available for this session" message.
- [ ] **Pending account sign-in:** sign in again with the account inside the 30 days. Confirm how an iOS (JWT, PKCE) session
      experiences the pending gate: the token exchange and refresh must succeed, most routes answer 403 `{accountDeletionPending}`,
      and the app routes to the restore screen. If sign-in itself is refused, the restore screen is unreachable and the server
      contract needs a decision.
- [ ] Restore returns the app to the normal shell; canceled subscriptions are not reinstated (the screen says so).
- [ ] Sign out from the restore screen works.
- [ ] After the deletion request the server revoked the session: confirm the best-effort push unregister and Live Activity token calls
      fail quietly and the user is never shown a "session ended" error instead of the deletion note.

## TestFlight smoke list

Run on the first TestFlight build and every release candidate:

- [ ] Install, launch, welcome screens, sign in (PKCE; Sign in with Apple once the server side is deployed).
- [ ] Chat: send, stream, reply settles, credits update.
- [ ] Push: register, receive, tap through.
- [ ] Share: share a link and an image from another app.
- [ ] Live Activity: start, update, end.
- [ ] App Lock (Face ID), sign out, sign in again.
- [ ] Dynamic Type at the largest accessibility size on Sessions, chat and Settings; VoiceOver through sign-in, a chat turn and Settings.
- [ ] Icon and launch screen show (the shipped icon is a placeholder, see the README).

## Things worth watching that are not in a feature list

- The Lakes tab is a placeholder that points at the web; decide whether to ship it or hide it before App Review.
- Terms and Privacy links in Settings point at `bike4mind.com/terms-of-service` and `/privacy`; confirm they resolve.
- The privacy manifests and the App Store Connect answers in the README must match what the build actually does.
