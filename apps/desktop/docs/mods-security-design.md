# View mods: security design

Status: design, for review. No runtime code exists yet. Decisions this document leaves open are
marked **Undecided**.

Tier 3 of Desktop Mods lets a user run their own HTML, JS and CSS as an Orchestrate view. The mod
draws from a read-only snapshot of one orchestration and can change anything only by asking the host
for a named action, which the host checks before doing. This document says how that is isolated,
what a mod can see and do, how it gets onto the machine, and what happens when it misbehaves.

Everything here builds on mechanisms the app already has. Each section cites the file it reuses.

## 1. Goals and non-goals

Goals:

- A mod can never reach the preload bridge (`window.b4m`), Node, the filesystem, the shell, the
  network, or another mod.
- A mod sees only the snapshot fields its granted permissions unlock, and nothing that is not in the
  view contract at all: no paths, prompts, transcripts, model names or credentials.
- Every action a mod asks for is checked against the snapshot it was shown and against the app's own
  state before anything happens.
- The user can always get back to a built-in view, even from a mod that has hung.
- Nothing is installed without the user seeing the files and permissions first.

Non-goals for Tier 3:

- Publisher identity, signing, or a gallery. The author field in a manifest is self-declared.
- Persistent per-mod storage. A mod is stateless across loads (see section 4.4).
- Any surface beyond Orchestrate and the mini window (see section 13, **Undecided**).
- Any trust level above the sandbox (see section 12, **Undecided**).

## 2. What exists today

| Mechanism | Where | What it gives us |
|---|---|---|
| App-owned scheme serving a sandbox document with a header CSP | `src/main/chat/artifacts/sandboxProtocol.ts` | Pattern for `b4m-mod:`; registered `standard` + `secure`, deliberately not `bypassCSP`, no `supportFetchAPI` |
| Opaque-origin iframe, `sandbox="allow-scripts"`, content over postMessage, provenance by `event.source` | `src/renderer/src/chat/HtmlArtifactFrame.tsx` | The frame model and the reasoning for every omitted sandbox flag |
| Top-level opaque origin via `sandbox allow-scripts` in the CSP header | `src/main/chat/artifacts/artifactViews.ts` (`VIEW_CSP`) | How to get an opaque origin for a document that is not an iframe |
| Two-way frame channel with a build timeout that kills a runaway worker | `src/renderer/src/chat/model3d/modelEngineFrame.ts`, `src/main/chat/model3d/engineProtocol.ts` (`BUILD_TIMEOUT_MS`) | Precedent for reading messages back from a frame, and for killing code that spins |
| Renderer CSP: `default-src 'self'; script-src 'self'; frame-src b4m-artifact: b4m-model:` | `src/renderer/index.html` | Mods must be a closed addition to this policy, as artifacts were |
| Window isolation: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; `will-navigate` and `setWindowOpenHandler` deny | `src/main/index.ts`, `src/main/watch/miniWindow.ts` | Every window that could host a mod is already hardened |
| Sandboxed `WebContentsView` in its own session partition, permission requests denied, downloads cancelled, keys heard in main via `before-input-event` | `src/main/chat/browser/BrowserManager.ts` | Precedent for hosting untrusted content in its own process, overlaid on app chrome |
| Narrow preload whose every call main checks against the sender | `src/preload/mini.ts`, `src/main/watch/ipc.ts` (`fromMini`, `isWatchedSession`) | The model for a mod bridge: tiny surface, sender-gated, every id rechecked in main |
| "Quick" approvals, and `once`/`deny` as the only decisions that cross a narrow bridge | `src/shared/watch.ts` (`isQuickApproval`, `isWatchDecision`) | The exact set a mod may approve |
| Snapshot contract and action gate | `src/shared/viewSnapshot.ts` (`viewSnapshotSchema`, `acceptViewAction`) | The data a mod gets and the first check on what it asks for |
| Snapshot built from the roster; actions gated before they select anything | `src/renderer/src/chat/orchestrator/viewSnapshot.ts`, `snapshotView.tsx`, `OrchestratorStage.tsx` (`runViewAction`) | Built-in views already go "through the same gate a view that does not ship with the app will go through" |
| Agent commands may never write the app's userData folder | `src/main/chat/tools/sandbox.ts` (`sandboxCommand`, `alwaysDenied`) | Installed mods are out of reach of the app's own agents |
| Reserved Mod+Shift+Esc back to Board | issue #7854 (in progress) | The escape shortcut this design depends on |
| `answer`, `approve`, `stop` actions in the view contract | issue #7855 (in progress) | The consequential actions a mod may ask for |

The app does not register any `b4m://` protocol client with the OS today (no
`app.setAsDefaultProtocolClient`), so install links are new surface (section 8).

## 3. Threat model

The mod author is untrusted. A mod may be written carelessly or with intent to: read more of the
user's work than it was granted, send it off the machine, act on the user's behalf without the user
(approve a tool call, answer a question, stop work), deny service to the app, or persist itself.

Snapshot text is also untrusted. Agent titles, "now" lines and pending questions are written by
models that read web pages and repositories. A mod that renders that text unsafely can be made to
run attacker-written script with the mod's own permissions. The design therefore treats "the mod is
honest but renders hostile text" as a first-class case, not only "the mod is hostile".

The app's own agents are a writer of files on this machine. Anything that grants trust based on
where a file lives must account for an agent having written it (section 12).

Out of scope: a compromised renderer or main process, and an attacker with local user access.

## 4. Hosting, origin, sandbox and CSP

### 4.1 Where the mod runs: two options

The draft plan puts the mod in an iframe beside the artifact sandbox. Reading the code surfaced a
second option that the rest of this document is written to accommodate. **Decision needed** (it is
an engineering call, but it changes cost and what controls are possible, so it is listed in section
15).

**H1. Iframe in the renderer** (the draft). `<iframe src="b4m-mod://<id>/" sandbox="allow-scripts">`
mounted by a `ModFrame` component in the Orchestrate stage, exactly as `HtmlArtifactFrame` mounts the
artifact sandbox.

- Cheap: same layout, z-order, theming and focus behaviour as any other view.
- Isolation from the bridge is proven: the artifact frame already relies on it.
- Weaknesses: whether a sandboxed cross-origin frame on a custom scheme gets its own process
  (out-of-process iframe) must be verified, not assumed. If it shares the renderer's process, a mod
  that spins the CPU freezes the whole window, including the escape shortcut's handler. The host
  cannot observe real user input inside the frame, which the consequential-action gate in section
  6.3 needs. Every check happens in the renderer, on the app's general bridge, so main cannot tell a
  mod's request from a native button's.

**H2. A `WebContentsView` per mod** overlaid on the stage, as `BrowserManager` overlays agent pages.
The view loads `b4m-mod://<id>/index.html` top-level in a dedicated non-persistent session partition
(`mods`), with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and a tiny preload
in the style of `src/preload/mini.ts`.

- Its own renderer process by construction: main can kill it (`webContents.forcefullyCrashRenderer`
  or destroying the view) without touching the app window, and read its memory and CPU from
  `app.getAppMetrics()`.
- Main sees every key and pointer event in it (`before-input-event`, `input-event`), which is what
  makes the escape shortcut and the user-activation gate reliable.
- Every bridge call arrives in main with a sender that is that mod's `webContents`, so main gates it
  the way `src/main/watch/ipc.ts` gates the mini window (`fromMini`), and the renderer is out of the
  path entirely.
- The `b4m-mod:` handler is registered only on the `mods` partition, so the app's own windows cannot
  load mod code at all.
- Costs: a native view sits above the renderer's DOM, so stage overlays (popovers, the peek drawer,
  menus, toasts) cannot draw over it; the stage must hide or shrink the view while one is open.
  Bounds must follow layout changes. More memory per mod. The mini window needs the same treatment.

The recommendation is H2, because three controls below (resource limits, the escape shortcut and the
activation gate) are only reliable with it. H1 is acceptable for a first release only if a spike
shows the frame is out-of-process and the release ships without the consequential actions.

The rest of this section applies to both.

### 4.2 Origin

- Scheme `b4m-mod`, registered with `protocol.registerSchemesAsPrivileged` before ready, with
  `standard: true, secure: true` and nothing else: not `bypassCSP`, not `supportFetchAPI`, not
  `corsEnabled`, not `stream`. Same reasoning as `registerArtifactScheme`.
- One host per mod: `b4m-mod://<id>/`. The id is the directory name and the URL host, so it is
  restricted to `^[a-z0-9][a-z0-9-]{1,62}$` (hosts on a standard scheme are lowercased; anything else
  would make two ids collide).
- The document runs on an opaque origin regardless: under H1 from the iframe's `sandbox` attribute,
  under H2 from `sandbox allow-scripts` in the CSP header, as `VIEW_CSP` does in `artifactViews.ts`.
  An opaque origin has no storage, no cookies and is cross-origin to every other mod and to the app.

### 4.3 The protocol handler

Serves files only from the mod's active version directory (section 9), and only:

- paths that normalise inside that directory (no `..`, no absolute paths, no encoded separators,
  symlinks refused at install so none exist to follow);
- files whose extension is on the allow-list fixed at install (`html`, `js`, `css`, `json`, `svg`,
  `png`, `jpg`, `webp`, `gif`, `woff2`, `mp3`, `ogg`), with the `Content-Type` set from the
  extension and `X-Content-Type-Options: nosniff`;
- with `Cache-Control: no-store`, so an update or rollback is never served stale.

Unknown host, unknown path or disallowed type answers 404 with the CSP still attached. As
`artifactViews.ts` does for the agent browser partition, any other session that sees a `b4m-mod:`
request answers with an inert not-found page.

Under H1 the handler also refuses the entry document unless `Sec-Fetch-Dest` is `iframe`, so the
scheme cannot be opened top-level by a navigation that slipped past `will-navigate`. This header's
presence on custom-scheme requests needs verifying in the spike; it is defence in depth, not the
primary control.

Module scripts from an opaque origin are CORS requests (`Origin: null`). The handler answers the
mod's own static files with `Access-Control-Allow-Origin: *`; that exposes nothing, because those
files are the mod's own code and no other origin can fetch at all (`connect-src 'none'` everywhere).

### 4.4 CSP

Sent as a response header on every file, never a meta tag, so the mod's markup cannot choose its own
policy (the same rule as `SANDBOX_CSP`). `<origin>` is the literal `b4m-mod://<id>`, named exactly
rather than as `'self'`, because the meaning of `'self'` for a document whose origin is opaque is not
something to rely on.

```
default-src 'none';
script-src <origin>;
style-src <origin> 'unsafe-inline';
img-src <origin> data: blob:;
font-src <origin> data:;
media-src <origin> blob:;
connect-src 'none';
worker-src 'none';
frame-src 'none';
child-src 'none';
object-src 'none';
form-action 'none';
base-uri 'none';
sandbox allow-scripts            (H2 only; H1 gets it from the iframe attribute)
```

Differences from the artifact sandbox, and why:

- **No `'unsafe-inline'` or `'unsafe-eval'` for script.** Artifacts allow inline script because the
  whole artifact is one document written by the model. A mod is shipped as files, so it does not need
  inline script, and refusing it also refuses inline event handlers. That is the main defence against
  hostile snapshot text: a mod that writes an agent title into `innerHTML` cannot be made to run an
  `onerror` attribute from it. The SDK documentation will still tell authors to use `textContent`.
- **Inline style is allowed**, as for artifacts: it cannot run code, and views animate by setting
  styles.
- **`connect-src 'none'`** is the exfiltration control for requests: no fetch, XHR, WebSocket,
  EventSource or beacon. Navigation is closed separately (section 4.6). With `img-src` limited to the mod's own origin plus `data:`/`blob:`, an image URL cannot be
  used as a side channel either.
- **`worker-src 'none'`.** Workers are a way to burn CPU outside the heartbeat's reach (section 11)
  for no rendering benefit. Revisit if a real mod needs one.

The response also carries a `Permissions-Policy` header that disables every powerful feature:
`camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(),
clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), payment=(), fullscreen=(),
idle-detection=(), screen-wake-lock=()`. Independently, the `mods` partition (H2) or a filter on the
default session for requests whose frame URL is `b4m-mod:` (H1) denies every permission request and
check and cancels every download, as `BrowserManager.session()` does for the agent browser.

### 4.5 Sandbox flags

`allow-scripts` and nothing else, for the reasons spelled out in `HtmlArtifactFrame.tsx`:

| Omitted flag | Why |
|---|---|
| `allow-same-origin` | Would give the mod a real `b4m-mod://<id>` origin with storage that persists across loads and is shared by every load of that mod, which is the persistent state section 1 rules out. Never added. |
| `allow-popups`, `allow-popups-to-escape-sandbox` | A mod must not open windows. `setWindowOpenHandler` denies them as well. |
| `allow-top-navigation*` | A mod must not navigate the app away. `will-navigate` denies it as well. |
| `allow-modals` | `alert()` would block the app behind the mod. |
| `allow-forms` | Nowhere to submit to. |
| `allow-downloads` | No file leaves a mod. |
| `allow-pointer-lock`, `allow-orientation-lock`, `allow-presentation`, `allow-storage-access-by-user-activation` | No use in a view, and each is a way to take something from the user. |

### 4.6 Navigation lock (H2)

CSP and `sandbox allow-scripts` do not stop a top-level document navigating itself, and a navigation
carries data out in its URL. Under H2, every mod `webContents`:

- denies `will-navigate`, `will-redirect` and `will-frame-navigate` except to its own
  `b4m-mod://<id>/`, and denies every `setWindowOpenHandler` request;
- sits on the `mods` partition, whose `webRequest.onBeforeRequest` cancels any URL whose scheme is
  not `b4m-mod:`, so a missed navigation path still reaches no network.

## 5. The data channel

### 5.1 Handshake and transport

1. The host loads the entry document. The mod's runtime (a small SDK script, `b4m-mod-sdk.js`, that
   authors include; it is convenience, never a control) posts `{ type: 'mod-ready', contract: 1 }`.
2. Under H1 the host accepts that only if `event.source === frame.contentWindow`, as
   `HtmlArtifactFrame` and `modelEngineFrame` do (an opaque origin reports `'null'`, which is not
   something to check), then transfers one end of a fresh `MessageChannel` to the frame with
   targetOrigin `'*'`. All further traffic uses that port, which no other window can hold.
   Under H2 the preload exposes `b4mMod.onSnapshot(listener)` and `b4mMod.act(action)` and nothing
   else, and main checks the sender on every call.
3. A mod that does not post `mod-ready` within 5 s of load counts as a failed load (section 9.2).

### 5.2 Messages

Host to mod:

- `{ type: 'snapshot', snapshot }`: the projected snapshot (5.3). Sent once on ready, then on change,
  coalesced to at most 4 per second so a busy orchestration does not flood the mod.
- `{ type: 'paused', paused }`: the host's `useScenePause` state (`scene/useScenePause`), so a mod can
  stop animating while hidden, as built-in views do.
- `{ type: 'action-result', requestId, ok, reason? }`.
- `{ type: 'ping', n }`: the heartbeat (section 11).

Mod to host:

- `{ type: 'action', requestId, action }`.
- `{ type: 'pong', n }`.

Every inbound message is parsed with a Zod schema (strict objects, string length caps) and dropped if
it does not match; a dropped message counts towards the flood limit (section 11). Nothing a mod sends
is ever rendered by the host or written anywhere.

### 5.3 Permissions and the snapshot fields they unlock

The host never hands a mod the full `ViewSnapshot`. A pure function in `src/shared/` (proposed
`projectSnapshot(snapshot, permissions)`) removes every field the mod was not granted, and the result
is validated against `viewSnapshotSchema` before sending (every gated field is already optional in
the schema, so a projected snapshot is still a valid one).

| Permission | Unlocks | Notes |
|---|---|---|
| (none, always) | `contract`; `root.id`, `root.state`; per agent `id`, `title`, `state`, `parentId`, `depth`, `updatedAt` | The minimum to draw anything. `title` is model-written text; see section 3. |
| `read:snippets` | per agent `now`; `decision.question` and, once #7855 lands, the question's options | Free text from the agents' work. The broadest read permission. |
| `read:repo` | per agent `pr` (`number`, `state`) | Any future repo or branch display field joins this permission, not the base set. |
| `read:cost` | per agent `usdCost`, `credits` | Spend is sensitive in some organisations. |
| `act:open` | actions `open-agent`, `open-root` | Navigation only. |
| `act:answer` | action `answer` (#7855); also the `decision.id` it names | Requires `read:snippets` (the manifest is rejected otherwise): a mod must not answer a question it cannot show. |
| `act:approve` | action `approve` with `once` or `deny`, for quick approvals only (#7855); the quick approval's id | Requires `read:snippets` (the manifest is rejected otherwise): #7855 adds the quick approval to the snapshot's `decision` (its `approvalId`, with `approvalSummary` as `question`), gated by `read:snippets`, and a mod must not approve what it cannot show. Never `always`, matching `isWatchDecision`. Quick is `isQuickApproval` in `src/shared/watch.ts`. |
| `act:stop` | action `stop` (#7855) | |

The draft plan listed `act:open` and `act:stop` but not answer or approve. This design splits them
into their own permissions, because each one lets a mod act on the user's behalf in a different way
and the review sheet should be able to say so separately.

Adding a field to `ViewSnapshot` means deciding which permission unlocks it, in the same change. A
test asserts that `projectSnapshot` with no permissions returns exactly the base field set, so a new
field cannot reach mods by default.

## 6. The action bridge

### 6.1 The checks

An action is carried out only if all of these hold:

1. It parses as a `ViewAction` (`viewActionSchema`).
2. The mod holds the permission for that kind (5.3).
3. `acceptViewAction` accepts it against **the projected snapshot most recently sent to that mod**,
   not the host's newest one. An id the mod was never shown is rejected even if it exists.
4. The app's own state still agrees: the agent is still in this orchestration (as
   `isWatchedSession` checks for the mini window), the decision is still pending, the approval is
   still pending and still quick, the agent is still running for `stop`.
5. For `answer`, `approve` and `stop`: the user-activation gate (6.3).
6. The mod is within its rate limits (section 11).

Rejected actions return `action-result` with `ok: false` and a short reason code; nothing else
happens. Accepted actions run through the same paths the native controls use (#7855 scope item 3);
mods get no new way to do anything.

### 6.2 Where the checks run

Both the host and main, for different reasons.

- **Host side** (the `ModFrame` component under H1, the mod's view controller in main under H2)
  runs 1 to 3 and 6. Only the host knows which projected snapshot this particular mod was sent, so
  only the host can do check 3 correctly.
- **Main** runs 2 and 4 again, and 5. Main owns the installed-mod store, so it is the source of truth
  for granted permissions; a renderer bug cannot widen them. Main also owns the approval and session
  state that check 4 reads, which closes the race between the host's check and the action landing.

Under H1 the host-side checks run in the app renderer and reach main through a dedicated
`mods:act` IPC channel carrying the mod id, not through the general bridge methods the native
buttons use, so main can apply the mod's permissions. Under H2 everything is in main and the sender
check replaces the mod id argument, exactly as `fromMini` does.

### 6.3 User-activation gate

`answer`, `approve` and `stop` change the user's work. A mod, or hostile text running inside an
honest mod, must not be able to perform them without the user. These three actions are accepted only
within 1 s of a real pointer or key event that main observed in that mod's own `webContents`
(`input-event` / `before-input-event`), and each input event authorises at most one such action.
Script-generated events are not observed by main, so a mod cannot forge one.

This is reliable only under H2. Under H1 the host cannot see input inside a cross-origin frame, so
there is no sound gate; the H1 fallback is to ship `act:open` only and keep the consequential
permissions unavailable until hosting moves to H2.

## 7. Manifest

`mod.json` at the root of the mod, validated with a Zod strict schema in `src/shared/` (proposed
`modManifestSchema`). Unknown keys reject the mod.

```json
{
  "manifest": 1,
  "id": "night-shift",
  "name": "Night Shift",
  "version": "1.2.0",
  "kind": "view",
  "contract": 1,
  "entry": "index.html",
  "author": "free text, not verified",
  "description": "One or two lines shown on the review sheet.",
  "permissions": ["read:snippets", "act:open"]
}
```

| Field | Rule |
|---|---|
| `manifest` | Literal `1`. The manifest format's own version. |
| `id` | `^[a-z0-9][a-z0-9-]{1,62}$`. Directory name and URL host. |
| `name` | 1 to 60 characters, shown in the view menu. |
| `version` | Semver, used only to show "update from X to Y". |
| `kind` | `skin`, `layout` or `view`. Only `view` carries code and loads under `b4m-mod:`. Skins and layouts (Tiers 1 and 2) are data-only and never served as documents. A `skin` or `layout` that contains a `.js` or `.html` file is rejected. |
| `contract` | The `VIEW_SNAPSHOT_CONTRACT` the mod was written for. A mod whose contract the app does not support is installed but disabled, with the reason shown. |
| `entry` | A relative path to an `.html` file inside the mod. |
| `author`, `description` | Free text, length-capped, shown as plain text and labelled as unverified. |
| `permissions` | A set of the strings in 5.3. `act:answer` or `act:approve` without `read:snippets` is rejected. |

## 8. Install, update and the review sheet

### 8.1 Sources

- **Install link**: `b4m://mod/install?src=<url>`. New OS protocol client registration
  (`app.setAsDefaultProtocolClient('b4m')`, `open-url` on macOS, the second-instance argv elsewhere).
  `src` must be `https:`. Whether any `https` host is accepted or only an allow-list is **a decision
  for the user** (section 15); the mechanism is the same.
- **From a folder**: "Install mod from folder..." in the view menu, through the OS file picker.

A link, a folder pick or anything else only ever opens the review sheet. Nothing is copied into the
mods directory until the user presses Install on it.

### 8.2 Fetch and stage (main process)

1. Download with `net` on a dedicated session with no cookies and no credentials, following at most
   3 redirects, all `https`. Size cap 5 MB compressed.
2. Unpack into a fresh temp directory. Refuse: more than 200 files, more than 20 MB unpacked, any
   symlink, any path that normalises outside the root, any extension off the allow-list (4.3), a
   missing or invalid `mod.json`, an `entry` that does not exist.
3. Hash every file (SHA-256). The hashes go on the sheet and into the store.

One review sheet at a time. A second link while one is open is dropped with a toast.

### 8.3 The review sheet

Rendered by the app's own renderer (never by mod code), showing:

- name, id, version, kind, and the source (the link's host, or the folder path);
- the author and description, labelled "provided by the mod, not verified";
- every permission as a plain sentence ("Can read what each agent is doing now",
  "Can approve quick tool calls when you click inside it");
- the file list with sizes;
- for an update: the old and new version, and permissions added or removed, with additions
  highlighted;
- Install and Cancel. Install is not the default button, so Enter does not install.

### 8.4 Update

The same path as install. Every update shows the sheet, even with identical permissions, because the
code changed. There is no automatic update in Tier 3.

## 9. Storage and last-good-version

### 9.1 Layout

Under the app's userData folder (`app.getPath('userData')`, as every other store in
`src/main/*/index.ts` uses):

```
mods/
  <id>/
    state.json         { active, lastGood, enabled, strikes, granted: [...], hashes: {...} }
    versions/
      <n>/             one directory per install, never modified after it is written
        mod.json
        index.html
        ...
```

- An install writes `versions/<n+1>/` completely, then switches `active` by writing `state.json` to a
  temp file and renaming it over the old one, so a crash never leaves a half-written active version.
- `granted` is what the user approved on the sheet, kept separately from the manifest's request, so
  a later file edit cannot add a permission.
- The protocol handler serves only `versions/<active>/`, and checks each file's hash against
  `hashes` before serving it. A file that changed on disk after install is not served, and the mod
  shows as modified, with Reinstall offered.
- Agent shell commands already cannot write the userData folder (`alwaysDenied` in
  `src/main/chat/tools/sandbox.ts`, macOS `sandbox-exec`). On other platforms that wrapper does not
  run, so an agent shell has the local user's file access and can rewrite the version files and
  `state.json` together; the hash check does not defend against that, and it is out of scope
  (section 3). The hash check catches corruption and partial edits.
- Only the active version, the last good one and at most one failed version pending retry are kept;
  older directories are deleted after a successful switch.

### 9.2 Last-good-version

A version becomes good once it has, in one load, posted `mod-ready` within 5 s, received a snapshot
and answered heartbeats for 10 s. A newly installed version that fails that (bad entry, a throw
before ready, a hang) is rolled back: `active` returns to `lastGood`, the failed version is kept for
one retry, and the stage shows "Night Shift 1.3.0 failed to start; back on 1.2.0". A mod with no good
version falls back to Board.

### 9.3 Safe start

If the app's renderer becomes unresponsive or crashes while a mod is active twice within 10 minutes,
the next start opens with all mods disabled and says so. A `--disable-mods` launch flag does the
same on demand.

## 10. Escape, and where mod code may render

### 10.1 The escape shortcut

Mod+Shift+Esc (#7854) always switches to Board and leaves Focus mode. For mods it also unloads the
mod (destroying its frame or view, which ends its process under H2) and marks it suspended for the
session; the user re-selects it from the view menu.

The shortcut must work when focus is inside the mod and when the mod is spinning. It is therefore
handled in main through `before-input-event` on the hosting `webContents`, as
`attachDevLogShortcut` (`src/main/devlog/window.ts`) and the agent browser's tab shortcuts
(`src/shared/browserTabs.ts`) already are, and main tells the renderer to switch. Under H2 main also
listens on the mod's own `webContents`, since keys there never reach the window's. A mod cannot bind
or swallow the chord: main sees it before the page does and calls `preventDefault`.

The chord is listed in the view menu, and a mod view always shows a small host-drawn "Back to Board"
affordance outside the mod's rectangle that the mod cannot cover.

### 10.2 Where mod code may render

Only:

- the Orchestrate stage in an app window, when the user picked that mod in the view menu;
- the mini window, under the same rules, with the actions the mini bridge already supports
  (`open`, quick `approve`); not `answer` or `stop` until the mini bridge has them.

Never:

- top-level in any window, including the main window, the mini window, the developer log window and
  the payment window;
- in the agent browser's partition (`BrowserManager`), which already serves only allow-listed
  schemes;
- in the chat transcript, the artifact panel, Settings, the review sheet, notifications, the menu-bar
  item or any other surface;
- in Presenter mode or any screen-share surface, unless that mode's own redaction design admits it.

Enforcement:

- H2: the `b4m-mod:` handler exists only on the `mods` partition, and only main creates views on it,
  only from the stage and mini hosts.
- H1: the scheme is added to the renderer CSP's `frame-src` (the only CSP change in the app), and a
  test fails if the mod frame component is imported anywhere but the stage and the mini route, as
  `viewRegistry.tsx` keeps view components out of the stage today. `Sec-Fetch-Dest` refuses
  top-level loads (4.3).
- H1: `will-navigate` and `setWindowOpenHandler` already deny the app window leaving its page.
- H2: those handlers are per window (`src/main/index.ts`, `src/main/watch/miniWindow.ts`) and a new
  view gets none of them, so main installs the same denials on every mod `webContents` itself
  (section 4.6).

## 11. Resource limits

| Abuse | Limit | On breach |
|---|---|---|
| CPU spin | Heartbeat every 2 s; a pong must come back within 1 s. Three missed in a row. Under H2, also CPU over 80% of a core for 30 s from `app.getAppMetrics()`. | Unload, strike |
| Memory | Under H2, working set over 512 MB for the mod's process. | Unload, strike |
| Message flood | Mod to host: 16 KB per message, 20 messages per second (token bucket, burst 40). Malformed messages count double. | Drop excess; a sustained 5 s over the limit unloads, strike |
| Action spam | 5 actions per second; consequential actions limited to one per input event (6.3). | Reject with `rate-limited` |
| Hidden work | Host sends `paused`; under H2 the view gets `backgroundThrottling: true` and is detached when the stage is hidden, as the agent browser parks inactive tabs. | n/a |
| Audio | Starts muted under H2 (`setAudioMuted`, as `BrowserManager` does); a per-mod "allow sound" toggle in the view menu. | n/a |

A strike is recorded in `state.json`. Three strikes disable the mod until the user re-enables it,
with the reason shown. Under H1, a mod that hangs the renderer cannot be stopped by any of this,
which is the main reason H2 is recommended; safe start (9.3) is the only backstop.

## 12. Open scope A: fuller trust for locally authored mods

**Undecided.** This section lays out the options; it does not choose.

The question: may a mod the user wrote on this machine opt into more than the sandbox gives, such as
network access, the shell, or reach across the app?

The central fact for every option: **"locally authored" is not something the app can observe.** It
can observe where files are and who installed them, and this app runs agents that write files on the
user's behalf, including agents that read untrusted web pages. Any trust keyed to "the files are in
my dev folder" is trust granted to whatever wrote that folder. Every option above A0 therefore needs
trust bound to the exact bytes the user approved (a hash set, as in 9.1), revoked by any change, and
re-approved through a main-process sheet that no agent and no mod can drive.

### A0. No fuller trust

Every mod is sandboxed. A user who needs more writes an agent tool, an MCP server or a script
instead, where the existing permission prompts apply.

- Trade-off: the simplest model to explain and to review; "a mod cannot hurt you" stays true.
- Risk: power users route around it with less reviewed tools.
- Cost: none beyond this design.

### A1. Declared network hosts

A mod may list `https` hosts in its manifest; they are added to its `connect-src` and `img-src`, shown
on the review sheet, and nothing else changes.

- Trade-off: covers the commonest wish (live data, a status page, a CI badge) without new code paths
  in the app.
- Risk: it is an exfiltration channel for whatever the mod can read, so `read:snippets` plus any host
  should be presented on the sheet as "can send what agents are doing to example.com". A DNS name can
  change owners.
- Cost: small. Per-mod CSP generation, sheet copy, a test that no wildcard host is accepted.
- Could apply to all mods, not only local ones; the local distinction adds little here.

### A2. Wider app reach through more actions

New permissions for actions beyond the view contract: start a session, send a message to an agent,
read a transcript, open a file in the editor.

- Trade-off: lets mods become real tools (a custom dispatcher, a review queue).
- Risk: each action is a new path from untrusted code into the user's work, and transcript reads
  break the view contract's promise of "display data only". The activation gate would have to cover
  all of them.
- Cost: medium to large. Each action needs its own contract entry, main-side validation, sheet copy
  and tests; the snapshot contract grows a second, broader tier.

### A3. Full trust (Node or shell)

A locally authored mod runs with a preload that exposes Node, or spawns processes.

- Trade-off: maximum power; effectively a plugin system.
- Risk: the sandbox stops being a boundary at all for that mod, and the agent-writes-files problem
  above becomes a persistence path: an agent tricked into writing a trusted mod gains code execution
  every time Orchestrate opens. Hash-bound approval reduces but does not remove this, since the user
  is asked to approve code they may not read.
- Cost: large. A separate trust UI, code-signing or hash pinning, a kill switch, and a support burden
  for every mod that breaks the app. Hard to walk back once shipped.

## 13. Open scope B: extension points beyond Orchestrate

**Undecided.** This section lays out the options; it does not choose.

The question: should mods reach surfaces other than the Orchestrate stage and the mini window, such
as side panels, the status line, commands, or hooks on app events?

Each new surface multiplies the places mod code may render (section 10.2), each needs its own
read-only contract (the view snapshot covers one orchestration only), and each needs its own escape.

### B0. Orchestrate and the mini window only

- Trade-off: one contract, one escape, one place to audit.
- Risk: none new.
- Cost: none beyond this design.

### B1. Data-only reach

Mods may contribute to other surfaces only declaratively, as Tiers 1 and 2 do: a status-line template
filled from snapshot fields, a palette, a layout. No mod code runs outside Orchestrate.

- Trade-off: covers much of the cosmetic demand with no new code isolation.
- Risk: templates can still leak granted fields into surfaces that are screen-shared more often; the
  same permissions apply.
- Cost: small to medium per surface: a schema per contribution point and a renderer for it.

### B2. Sandboxed code panels elsewhere

The same sandbox, hosted in a side panel or a pane next to chat.

- Trade-off: the most flexible UI reach.
- Risk: next to chat the natural data is the conversation, which is far more sensitive than the
  orchestration snapshot. A new contract would be needed, and the pressure to put transcript text in
  it would be constant. Overlay z-order (H2) gets harder outside the stage.
- Cost: medium. A per-surface contract and permission set, host placement and escape per surface.

### B3. Commands and hooks

Mods register commands (palette entries, shortcuts) or run on events (an agent finished, a question
arrived) without a visible surface.

- Trade-off: automation, the thing users most often ask plugins for.
- Risk: headless code has no user-activation signal, so the activation gate cannot apply and every
  hook action would be unattended. Shortcut registration can squat on app chords (the reserved escape
  chord must stay unbindable). Background execution needs its own CPU budget and a host process that
  lives outside any window.
- Cost: large. A background host, an event contract, quotas, and UI to see what hooks ran and why.

## 14. Implementation issues

The Tier 3 runtime splits into these issues. Order matters where noted.

1. **Spike: mod hosting.** Verify whether a sandboxed `b4m-mod:` iframe runs out-of-process, whether
   `before-input-event` and `input-event` fire for input inside it, and whether `Sec-Fetch-Dest`
   reaches a custom-scheme handler. Build a throwaway H2 overlay on the stage to measure z-order and
   bounds-sync cost. Output: the H1/H2 decision. Blocks 4, 5, 7 and 9.
2. **Manifest schema and snapshot projection** (`src/shared/`): `modManifestSchema`,
   `projectSnapshot`, the permission table, and the test that a new snapshot field is ungranted by
   default. Pure code, can start now.
3. **`b4m-mod:` scheme and handler:** registration, per-mod host, path and type guards, hash check,
   CSP and `Permissions-Policy` headers, permission and download denial, and (H2) the navigation
   lock of section 4.6 with a test that a mod cannot navigate or open a window to any other URL.
4. **Mod host and data channel:** the stage host (frame or view), handshake, port or preload, the
   message schemas, snapshot coalescing, pause.
5. **Action bridge:** host-side and main-side checks, the `mods:act` channel (H1) or sender-gated
   preload (H2), routing to the existing answer, approve and stop paths. Depends on #7855.
6. **User-activation gate** for `answer`, `approve` and `stop`. H2 only.
7. **Resource limits:** heartbeat, process metrics, message and action budgets, strikes, disable.
8. **Mod store:** userData layout, atomic active pointer, last-good rollback, safe start, the
   `--disable-mods` flag.
9. **Escape for mods:** wire #7854's chord through main for mod hosts, unload on escape, the
   host-drawn "Back to Board" affordance.
10. **Install and review sheet:** `b4m://` protocol client, download and staging, the review sheet,
    install from folder, update diff.
11. **Mini window mod host** with the mini bridge's action set.
12. **Mods in Settings:** list, enable or disable, granted permissions, strikes, uninstall.
13. **SDK and author guide:** `b4m-mod-sdk.js`, typings generated from the shared schemas, an example
    mod, and authoring rules (no inline script, render text with `textContent`).

Issues for scope options A and B are not listed; they depend on the decisions in sections 12 and 13.

## 15. Decisions needed before the runtime is built

1. **Hosting (H1 iframe or H2 `WebContentsView`).** The recommendation is H2; it decides whether
   resource limits, the escape shortcut and the activation gate are reliable. Issue 1 informs it.
2. **Whether mods may act on the user's behalf at all in the first release** (`act:answer`,
   `act:approve`, `act:stop`), or ship read and `act:open` only until the activation gate is proven.
3. **Install sources:** any `https` link, or an allow-listed host only, until there is a gallery and
   publisher identity.
4. **Open scope A** (section 12) and **open scope B** (section 13). Neither blocks the Tier 3 runtime
   as designed here, which assumes A0 and B0; both shape what the SDK promises authors.
