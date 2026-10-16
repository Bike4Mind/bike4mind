# Upstream Sparkle integration gate

Status: blocked before runtime or publication integration. This document does not
enable Sparkle, change Linux updates, or authorize a release.

## Consent contract

Checking must not download an archive. Downloading must not authorize replacement.
Only Restart and install, after the existing busy check and `prepareQuit`, may
authorize installation. Ordinary quit, forced quit, and a crash before that action
must leave the installed version unchanged.

Keep Electron and Linux `electron-updater`. The intended macOS implementation is
an owned N-API Objective-C++ bridge over unmodified upstream Sparkle, not a new
verification or replacement engine.

## Source-verified blocker in Sparkle 2.10.0

Holding `showReadyToInstallAndRelaunch` is not an installation authorization gate:

1. [`SPUUserDriver.h`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SPUUserDriver.h#L208-L224)
   explicitly says Sparkle attempts installation if the application terminates.
   Dismiss preserves this behavior; Skip cancels the current installation.
2. [`SPUCoreBasedUpdateDriver.m`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SPUCoreBasedUpdateDriver.m#L166-L183)
   calls `extractUpdate:` directly from `downloadDriverDidDownloadUpdate:` after
   the synchronous `didDownloadUpdate:` notification. The inspected interactive
   path has no asynchronous download-complete authorization reply.
3. [`SPUInstallerDriver.m`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SPUInstallerDriver.m#L207-L219)
   launches the installer in `extractDownloadedUpdate:silently:completion:`. The
   ready callback follows installer preparation
   ([`SPUInstallationFinishedStage1` handling](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SPUInstallerDriver.m#L321-L340)),
   not just download completion.
4. [`AppInstaller.m`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Autoupdate/AppInstaller.m#L392-L415)
   registers a termination listener in `retrieveProcessIdentifierAndStartInstallation`.
   Termination at or after host registration marks the target terminated: if stage 1
   has already run, [`finishInstallationAfterHostTermination`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Autoupdate/AppInstaller.m#L765)
   is called immediately; otherwise [`startInstallation`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Autoupdate/AppInstaller.m#L690-L744)
   calls it on stage-1 completion. Either path proceeds to final installation without
   requiring the ready reply. The helper also sets `_willCompleteInstallation` during
   `startInstallation`, allowing the updater connection to disappear without
   necessarily canceling installation.
5. [`SPUUpdaterDelegate.h`](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SPUUpdaterDelegate.h#L342-L356)
   offers relaunch postponement, not a documented veto on this helper-side
   termination path; its quit-install callback
   ([source](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SPUUpdaterDelegate.h#L422-L440))
   states that Sparkle "will always attempt to install the update when the app
   terminates".

A `before-quit` handler cannot protect against SIGKILL or a main-process crash.
Immediately replying Skip at ready still leaves the interval between installer
preparation and delivery/processing of that cancellation. Callback completion in
the host must not be treated as proof that the helper has completed cancellation.

This establishes that the proposed held-ready bridge does not enforce the
contract. It does not establish that every upstream-compatible design is
impossible. Investigate keeping the archive unstaged until explicit Restart,
using supported upstream APIs only. Do not use private selectors, patched
installer behavior, custom archive verification, or manual bundle replacement to
work around the gate. A download-complete notification is not a pause API.

## Evidence boundaries

A prior disposable packaged Electron proof of concept on macOS arm64 27.0.1 with
Electron 44.4.5 and Sparkle 2.10.0 reported:

- A correctly signed archive replaced version 1.0.0 and relaunched version 1.0.1.
- Tampered archives and a wrong Ed25519 key were rejected, leaving 1.0.0 installed.
- No archive request occurred during a two-second check-only hold.
- Explicit Skip cancellation followed by ordinary quit left 1.0.0 installed.

Those are prior reported observations, not tests rerun for this document. Forced
termination, crash, and OS shutdown were not tested in that proof of concept. No
native build, packaged install, or signature test has been run against this gate.

`showDownloadDidStartExtractingUpdate` is not proof that extraction succeeded:
the notification precedes archive validation failure too.

## Acceptance gate before enabling macOS Sparkle

Use disposable application bundles, unique bundle identifiers, temporary
installations and isolated profiles. Never target an existing installation,
profile, or production keychain identity.

- Demonstrate a supported pre-staging pause that survives normal quit, SIGKILL,
  a main-process crash, and interrupted download. Assert the installed version
  remains unchanged without Restart consent, including when termination races
  download completion and installer preparation.
- Demonstrate explicit Restart replacement and relaunch on a minimal packaged
  app, then an actual Bike4Mind bundle. Confirm busy refusal and forced consent
  still pass through `UpdateService` and `prepareQuit`.
- Deny tampered archives, wrong/missing signatures, missing/malformed public keys,
  malformed metadata, invalid feeds and absent native modules/frameworks before
  ready/install. Test a valid signed archive as the corresponding allow path.
- Record no archive request before Download. Exercise offline operation,
  repeated commands, cancellation, permissions failures and interrupted install.
- Build and inspect arm64 and x64 packaging, Electron-header compatibility,
  framework symlinks/helpers, addon asar unpacking and rpaths. Test nested signing
  inside-out; do not substitute an untested `codesign --deep` signing pass.
- Keep HTTPS for production feeds, with loopback HTTP confined to tests. Keep
  archive validation required and fail closed if configuration or native loading
  fails. Never fall back to unverified replacement.

Fresh-download Gatekeeper acceptance remains untested. Ad-hoc executable signing
is not Developer ID signing or notarization. Optional Apple signing may remain
supported, but must not become a requirement for the proposed Sparkle path.

## Deferred distribution and key setup

Do not change release automation or publish installers while the consent gate is
unresolved. Preserve source tag protections and the separate destination App
token. No production signing identity or secret is generated by this work.

After the acceptance gate passes:

1. Fetch upstream 2.10.0 from
   <https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz>.
   Verify SHA256 `c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`
   before invoking its tools. Include upstream license notices; do not commit binaries.
2. Reconcile current publication fixes before editing the publisher. Preserve
   Linux metadata. Remove `latest-mac.yml` only after enumerating actual consumers
   and deciding how previously installed clients are handled.
3. Obtain separate approval for production Sparkle key creation and custody.
   Put the public key in a source Actions variable baked into the bundle; supply
   the private key through a secret and stdin only, never arguments or logs.
   Test disposable keys separately and delete them after tests.
4. Confirm external destination App credentials are configured with only the
   release permissions required by the existing isolated publisher.
5. Generate an appcast with versioned destination archive URLs, exact sizes,
   versions and Ed25519 signatures. Upload feed and ZIP/DMG assets to one draft,
   verify downloaded bytes, signatures and real metadata, then publish the
   complete release before any Latest promotion. Do not alter production tag
   protections or automate a real publication as a test.
6. Document key backup, authorized operators and a tested rotation procedure.
   With mandatory pre-extraction verification, do not assume replacing only the
   public key is sufficient for old clients to accept the transition archive.
7. Test recovery as a new higher-version release signed by a key current clients
   trust. Do not assume repointing Latest to an older release performs rollback.
   Before rollout, rollback of this integration is removal of the unenabled
   changes; there is currently no Sparkle client migration to reverse.

Native lifecycle hardening, publication integration, key rotation and rollback
verification remain implementation work, not capabilities delivered here.
