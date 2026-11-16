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

## Upgrade required

- [ ] With the minimum version above the build's, any request shows the update screen with the required version.
- [ ] "Try again" after the minimum is lowered returns to where the user was, still signed in.
- [ ] "Try again" offline keeps the update screen.

## Headers

- [ ] Every request (proxy, or server logs) carries `X-Client-Name: b4m-android` and `X-Client-Version` as `MAJOR.MINOR.PATCH`.
