# Device-only verification

Everything below needs a physical iPhone, a signed build, or a deployed backend, so none of it runs in the simulator or in
CI. Work through it before the first TestFlight build and again before each release. Mark each item with the build and date.

## Prerequisites (Apple Developer portal and backend)

- [ ] Apple Developer team id configured (`IOS_TEAM_ID` / `DEVELOPMENT_TEAM`) on a paid team, automatic signing on for the app and both extensions.
- [ ] App IDs for `com.bike4mind.app`, the Share extension and the Widgets extension with these capabilities: Push
      Notifications, Associated Domains, App Groups (`group.com.bike4mind.app`), Keychain Sharing
      (`$(AppIdentifierPrefix)com.bike4mind.shared`). The App Group and the keychain group must be enabled on **all three**
      bundle ids, or the extension cannot reach the session.
- [ ] `apple-app-site-association` published at `https://app.bike4mind.com/.well-known/apple-app-site-association` listing
      `/sessions/*` and `/notebooks/*` under `applinks`, and the app id under `webcredentials.apps` (the entitlement declares
      both `applinks:` and `webcredentials:app.bike4mind.com`).
- [ ] APNs auth key uploaded to the backend; Live Activity push (`liveactivity` push type) enabled for it.
- [ ] The `b4m-ios-app` OAuth client lists both redirect URIs: `https://app.bike4mind.com/ios/auth-callback` (Release) and
      `com.bike4mind.app://auth-callback` (DEBUG; see the README "Sign-in callback" table).
- [ ] Backend deployed with the iOS OAuth client, push-token routes, Live Activity token kind, agent-run route and the
      account-deletion routes (see Account deletion below).

## Push notifications (real APNs)

- [ ] Sign in; the device token registers (`POST /api/v1/push-tokens`, `kind: device`, `environment: sandbox` on a debug build,
      `production` on TestFlight).
- [ ] First launch: provisional authorization, no system alert. Opening the first conversation shows the one system prompt.
- [ ] A push for a finished quest arrives with the app backgrounded, killed and in the foreground (foreground policy: no banner
      for the screen you are already looking at).
- [ ] Tapping the notification opens `/sessions/{id}` directly, including from a cold start (route queued until the shell is up),
      and Back from that notebook lands on the Chat home.
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

## Sign-in against staging (simulator)

A DEBUG build signs in through the `com.bike4mind.app://` scheme, so this runs on an unsigned simulator build. Needs the
staging `b4m-ios-app` client to list `com.bike4mind.app://auth-callback`.

- [ ] On the welcome screen tap **Server** and pick staging, then **Sign in with Bike4Mind**: the system "wants to use ... to
      Sign In" prompt appears and the staging login page opens in the sheet (no instant "cancelled").
- [ ] Sign in with a staging test account: the sheet closes on its own and the app lands on the start-of-chat home.
- [ ] Real data loads: the drawer lists the account's notebooks, Settings shows its name, email and credit balance.
- [ ] Close the sheet with its X instead: the app stays on the welcome screen with no error banner.

## Universal links

- [ ] With associated domains and real signing, `https://app.bike4mind.com/sessions/{id}` and `/notebooks/{id}` open the app from
      Notes, Messages and Safari. (Unsigned simulator builds open Safari instead; that is expected there.)
- [ ] A link while signed out waits for sign-in and then opens the right screen.
- [ ] Open an unhandled `https://app.bike4mind.com/<unknown path>` link on the device: it must open in Safari and not bounce back
      into the app in a loop (universal-link re-entry check).
- [ ] On device, tap a `.web` route and the Lakes "Open on the Web" button for an `app.bike4mind.com` page: both must open in the
      in-app Safari sheet and must not reopen the app.

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
- [ ] Share a 48MP or other very large HEIC from Photos: the extension stays under its memory limit and completes (OOM regression check).
- [ ] Camera, microphone and photo-library permission prompts show the usage strings and denial is handled with a clear message.
- [ ] Voice note records, transcribes and drops text into the composer.

## Studio gallery, AirPlay and Siri

- [ ] Video and audio play from the Studio gallery; AirPlay routes; Picture in Picture works; presigned URL expiry recovers on its own.
- [ ] Siri phrases for Ask, Start quest and Capture note are recognized; the actions appear in Shortcuts and Spotlight and only
      open the composer with a draft (never send): Ask and Capture note on the Chat home, Start quest in the chosen notebook.
- [ ] Widgets: Credits (small), Latest generation (small, medium) and Running agents (small, medium) in the gallery,
      placeholder and signed-out appearance, dark mode, and a tap landing on the right screen (Credits opens Settings,
      with Back to the home screen).
- [ ] Lock-screen accessory widgets render and refresh: Credits (circular, rectangular, inline) and Running agents (rectangular, inline).

## Account deletion (App Store 5.1.1(v))

Against a backend that has the deletion routes deployed:

- [ ] Settings > Delete Account: the button stays disabled until `DELETE` is typed; success signs the app out immediately, clears the
      keychain, ends activities and shows the "scheduled for deletion" note on sign-in.
- [ ] Tapping "Delete my account" prompts "Confirm it's you" (password; an emailed code via "Send code"; authenticator code for
      MFA accounts; a segmented picker when several apply). A correct proof dismisses the sheet and the deletion completes on its own.
      A wrong password or code shows the error and attempts remaining. The proof is good for 5 minutes. Five wrong passwords revoke the
      session and the app drops to the signed-out screen. A passkey-only account sees the "use the web" note.
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

## Client version gate

- [ ] Against staging, set the admin `minimumClientVersions` for client `b4m-ios` above the installed build: confirm the app shows
      the update-required screen without signing out, then lower the minimum and confirm "Try again" (or a foreground) clears it.

## TestFlight smoke list

Run on the first TestFlight build and every release candidate:

- [ ] Install, launch, welcome screens, sign in (PKCE over the https universal link; Sign in with Apple once the server side is deployed).
- [ ] Chat: send, stream, reply settles, credits update.
- [ ] Navigation: the app opens on the start-of-chat home with no tab bar. The top-left menu button opens the drawer, and so
      does a drag from the left edge (it follows the finger); a scrim tap or a leftward swipe closes it, and the keyboard
      drops when it opens. New chat closes the drawer and focuses the composer. Studio pushes the gallery, and opening a
      Studio item shows no bar; Back returns step by step to home. Recent notebooks (up to five) push that notebook, All
      notebooks pushes the full list, and the account footer (name and email) pushes Settings, as does the top-right
      avatar. Sending from home pushes the new notebook; Back lands on home with the draft cleared and the greeting back,
      also with the keyboard up. Check light and dark, and a large text size.
- [ ] Push: register, receive, tap through.
- [ ] Share: share a link and an image from another app.
- [ ] Live Activity: start, update, end.
- [ ] App Lock (Face ID), sign out, sign in again.
- [ ] Dynamic Type at the largest accessibility size on the Chat home, Notebooks, chat and Settings; VoiceOver through sign-in, a chat turn and Settings.
- [ ] Icon and launch screen show (the shipped icon is a placeholder, see the README).

## Things worth watching that are not in a feature list

- The Lakes tab is a placeholder that points at the web; decide whether to ship it or hide it before App Review.
- Terms and Privacy links in Settings point at `bike4mind.com/terms-of-service` and `/privacy`; confirm they resolve.
- The privacy manifests and the App Store Connect answers in the README must match what the build actually does.
