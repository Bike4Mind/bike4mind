# Device and emulator verification

CI builds the app, runs the JVM tests (`client`, `kit`) and Android lint. Nothing below runs in CI: it needs an emulator or
a phone and a deployed backend. Work through it before the first internal build and again before each release. Mark each
item with the build and date.

## Prerequisites (backend)

- [ ] The non-production server you test against (staging, a preview, a local server) has the `b4m-ios-app-dev` OAuth client
      with `com.bike4mind.app://auth-callback` among its redirect URIs. Debug builds reuse it (`OAuthConfiguration.nonProduction`).
- [ ] Before a production build: the server registers the `b4m-android-app` OAuth client with the
      `https://app.bike4mind.com/android/auth-callback` redirect, `/.well-known/assetlinks.json` lists the release signing
      certificate, and the manifest gains the matching `autoVerify` App Link intent filter. Until then a release build
      cannot sign in.
- [ ] To exercise the upgrade screen: an admin can set `minimumClientVersions["b4m-android"]` above the build's
      `versionName`.

## Push notifications (FCM)

Needs a physical device or a Google-APIs emulator image, a build with the `b4m.fcm.*` properties set (see README), and a
server whose `FCM_SERVICE_ACCOUNT` secret belongs to the same Firebase project.

- [ ] On Android 13+, the first sign-in shows the notification permission prompt once; allowing it registers the token
      (a `POST /api/v1/push-tokens` with `platform: android` in the server log, a `pushtokens` row for the user).
- [ ] A chat reply that finishes while the app is backgrounded (and no websocket is open) shows a "Reply ready"-style
      notification; tapping it opens the app. While the app is in the foreground the same push is shown by the app.
- [ ] An agent approval request (when the server publishes one) arrives the same way.
- [ ] Denying the permission (or switching notifications off in system settings) removes the token row; switching them
      back on registers again.
- [ ] Sign out removes the token row; a different account signing in on the device registers it under that account.
- [ ] Uninstalling the app and sending a push prunes the row (FCM answers `UNREGISTERED`).
- [ ] A build without the `b4m.fcm.*` properties runs normally and registers no token.

## First-launch welcome

- [ ] A fresh install opens on the two-page welcome; swipe and "Next" both advance, back returns a page, "Continue"
      lands on sign-in.
- [ ] Relaunching after "Continue" goes straight to sign-in; so does signing out later.
- [ ] Uninstall and reinstall: the welcome shows again.
- [ ] Installing a newer build over one that predates the welcome (`adb install -r`, signed in or not) skips it.
- [ ] The notification permission is still asked at the first signed-in moment, not on the welcome.
- [ ] Rotating or font scale 200% keeps the page readable (the page scrolls) and keeps the current page.

## Server picker (debug builds)

- [ ] A fresh debug install points at the build's `-Pb4m.serverUrl` (default staging); the sign-in screen shows it.
- [ ] "Use this server" with a local server (`http://10.0.2.2:3000` from the emulator) switches without a restart; a URL
      that is not http(s) shows an error and keeps the old server.
- [ ] Switching servers while signed in signs out (tokens are per server).
- [ ] A release build shows no picker and always talks to production.

## Sign-in (Custom Tab, PKCE)

- [ ] "Sign in" opens a Custom Tab on `/oauth/authorize`; email sign-in and Google sign-in both return to the app signed in.
- [ ] Cancelling in the Custom Tab (back) leaves the sign-in screen usable; signing in again works.
- [ ] Denying consent (if the server shows it) returns with an error message, not a crash.
- [ ] Kill the app while the Custom Tab is in front ("Don't keep activities" in developer options), finish sign-in: the
      redirect still completes (the verifier and state survive on disk).
- [ ] Opening a stale `com.bike4mind.app://auth-callback?...` link (from an earlier attempt) is ignored.
- [ ] Cold start after sign-in restores the session without showing the sign-in screen.
- [ ] Sign out returns to the sign-in screen; offline sign-out still signs out locally.

## Tokens

- [ ] With the access token expired (wait it out, or shorten it on a local server), the next request refreshes once and
      succeeds; several screens refreshing at once spend the refresh token once.
- [ ] A refresh token the server rejects signs the user out.
- [ ] Uninstall and reinstall: the app starts signed out (backup is off, and the Keystore key goes with the app).

## Chats

- [ ] The list shows recent sessions, newest first, with "Untitled" for unnamed ones, and loads more on scroll.
- [ ] The default model from `/api/v1/client-config` shows above the list.
- [ ] Opening a session shows its transcript in order.
- [ ] "New chat" sends a first message: the reply streams in, the conversation appears in the list after Back + Refresh.
- [ ] A message in an existing session streams its reply; the status line (when the server sends one) clears when done.
- [ ] Airplane mode mid-reply, then back online: the reply still completes (socket reconnect, or the polling fallback).
- [ ] A refused message (for example out of credits) shows the server's reason and keeps the draft box usable.
- [ ] Rotation and process death keep the open chat and the draft.

## Agent runs

Needs a server with `/api/v1/agent-executions` and notifications allowed for the app.

- [ ] In an existing chat, "Agent" shows next to the composer (not in "New chat"). With it on, a send starts an agent
      run: the turn appears, and the toggle turns itself off so the next message is a plain chat turn.
- [ ] Starting a run shows an ongoing "Running agents" notification titled with the opening of the prompt, reading
      "Starting agent", then "Using <tool>" / "Finished <tool>" and "Step N" as the run advances.
- [ ] On Android 16+, the notification shows as a Live Update (status bar chip, lock screen) with the progress style.
      On Android 15 and below it is a plain ongoing notification with an indeterminate bar.
- [ ] Leaving the chat (Back) and leaving the app (Home, or another app) keep the notification updating until the run
      ends, and it still clears at the end with the app out of sight. "Running" lists Bike4Mind meanwhile.
- [ ] When the run completes, fails or is stopped, the notification clears.
- [ ] A run that needs approval or input turns it into an alerting "Waiting for your approval" (or "Waiting for your
      input") notification, with the app in front or out of sight.
- [ ] Tapping either notification opens that run's chat, from the foreground, the background and after sign-in.
- [ ] Force-stopping the app while a run is going removes the notification, and nothing restarts it.
- [ ] A start the server refuses shows the error and leaves "Agent" on, so sending again retries the run.

## Brief

Needs a server with the briefs API (`/api/v1/briefs`) and a user with some recent agent activity.

- [ ] "Brief" on the chats list opens the latest brief, or "No brief yet" with "Compose a brief".
- [ ] "Compose a brief" shows "Putting your brief together", then the brief (usually under a minute); "Refresh" after
      "Still working on it" picks it up once it is ready.
- [ ] A slow or hung polling request stops at the 90-second polling deadline, including time spent waiting for HTTP;
      leaving the screen cancels the request without showing a timeout on another screen.
- [ ] After composing a new brief while an older ready one exists, fail a polling GET: the error offers "Try again".
      Restoring connectivity and retrying fetches the new brief by ID, without another compose POST or showing the older one.
- [ ] Tap a brief push while signed out, then rotate/recreate the Activity before completing sign-in: the pending brief
      opens afterward. Rotate again after consuming it: returning to chats must not replay the old launch intent.
- [ ] A ready brief lists "What needs you" first, then "Handled" and "What happened"; empty sections are hidden.
- [ ] A decision with "Open approval" opens that chat, where the existing approval card answers it.
- [ ] Tapping a `brief_ready` push opens that brief: from the system tray with the app backgrounded, from a cold start,
      and from the notification the app shows while in the foreground. Signed out, the tap opens the brief after sign-in.
- [ ] With the `brief_ready` category switched off for the user (`preferences.pushNotifications.brief_ready: false`,
      set from web or iOS), no brief push arrives; the brief is still reachable from the chats list.

## Studio gallery

Needs a user with some generated images, video and audio (made on web or iOS; Android only views them).

- [ ] "Studio" on the chats list opens the gallery: generated media newest first, each filter (All, Images, Video,
      Audio) showing only its kind, and more tiles loading as the grid scrolls.
- [ ] Leave and reopen the gallery, then kill and relaunch the app and open it again: the last grid (tiles included)
      appears at once, before the network answers. In airplane mode the grid still shows, with an inline error.
- [ ] An image opens full screen; pinch and double tap zoom it. A video and an audio file play with system controls.
- [ ] Open a file, wait past its link expiry (about an hour), then play it: it reloads instead of failing.
- [ ] Sign out and sign in as another user: the first user's grid never appears, not even for a moment.

## Links

Until the server publishes `assetlinks.json`, open links with `adb shell am start -a android.intent.action.VIEW -d <url>
com.bike4mind.app` (see README).

- [ ] `https://app.bike4mind.com/notebooks/<id>` opens that chat, from a cold start and with the app already running.
      Signed out, it opens after sign-in.
- [ ] `/briefs/<id>` opens that brief; `/notebooks` and the bare host open the chats list.
- [ ] A page with no Android screen (for example `/pricing`) opens in the browser, not back in the app.
- [ ] A push with a `deepLink` to a chat (for example a finished reply) opens that chat when tapped, from the system
      tray and from the notification the app shows in the foreground.
- [ ] Once `assetlinks.json` lists the signing certificate: tapping an `app.bike4mind.com/notebooks/<id>` link in another
      app (mail, chat) opens the app without a chooser.

## Upgrade required

- [ ] With the minimum version above the build's, any request shows the update screen with the required version.
- [ ] "Try again" after the minimum is lowered returns to where the user was, still signed in.
- [ ] "Try again" offline keeps the update screen.

## Headers

- [ ] Every request (proxy, or server logs) carries `X-Client-Name: b4m-android` and `X-Client-Version` as `MAJOR.MINOR.PATCH`.
