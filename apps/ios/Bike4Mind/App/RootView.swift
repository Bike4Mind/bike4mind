import B4MKit
import SwiftUI

/// Routes between sign-in, the locked screen and the signed-in shell purely from `AuthController.state`.
struct RootView: View {
  @Environment(AuthController.self) private var auth
  @Environment(AppServices.self) private var services
  @Environment(\.scenePhase) private var scenePhase
  @AppStorage(Onboarding.completedKey) private var isOnboardingCompleted = false
  @State private var lifecycle = AuthLifecycle()
  /// Whether the signed-in shell has been built this session; App Lock then covers it instead of replacing it.
  @State private var hasShownShell = false

  var body: some View {
    Group {
      switch auth.state {
      case .restoring:
        ProgressView()
          .task { auth.restore() }
      case .signedOut(let reason):
        if Onboarding.shouldShow(isCompleted: isOnboardingCompleted, signOutReason: reason) {
          OnboardingView { isOnboardingCompleted = true }
        } else {
          SignInView(signOutReason: reason)
        }
      case .signedIn, .locked:
        signedInContent
      }
    }
    .animation(.default, value: auth.state)
    .onChange(of: auth.state) { _, state in
      handleAuthState(state)
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      // Lock on the way out so the app-switcher snapshot never shows content.
      if phase == .background { auth.lockIfNeeded() }
      guard phase == .active else { return }
      appDidBecomeActive()
    }
  }

  /// The shell stays mounted under the lock so drafts, optimistic turns and open sheets survive backgrounding.
  /// A cold launch straight into `.locked` shows only the lock until the first unlock builds the shell.
  @ViewBuilder
  private var signedInContent: some View {
    let isLocked = auth.state == .locked
    ZStack {
      if hasShownShell || !isLocked {
        signedInShell
          .redacted(reason: isLocked ? .placeholder : [])
          .blur(radius: isLocked ? 24 : 0)
          .allowsHitTesting(!isLocked)
          .accessibilityHidden(isLocked)
          .onAppear { hasShownShell = true }
      }
      if isLocked {
        LockedView()
          .transition(.opacity)
      }
    }
  }

  @ViewBuilder
  private var signedInShell: some View {
    switch services.accountStatus.state {
    case .active:
      MainTabView()
        .task { await services.realtime.start() }
    case .deletionPending(let scheduledFor):
      AccountRestoreView(scheduledFor: scheduledFor)
    }
  }

  /// Idempotent foreground refresh; also run once from the launch edge, because a cold launch reaches
  /// `.active` while auth is still restoring.
  private func appDidBecomeActive() {
    Task { await services.push.appDidBecomeActive() }
    services.resumeCapture()
    // A socket that gave up reconnecting while backgrounded gets a fresh start.
    if auth.state == .signedIn {
      let realtime = services.realtime
      Task { await realtime.resume() }
      services.refreshWidgetCredits()
    }
  }

  private func handleAuthState(_ state: AuthController.State) {
    let plan = lifecycle.transition(to: state)
    if state == .signedIn || state == .locked {
      // Someone who got this far never needs the welcome, e.g. a session restored after a reinstall.
      isOnboardingCompleted = true
    }
    if plan.startsSession {
      // First sign-in (or a restored launch) is the moment to ask for quiet push authorization.
      Task { await services.push.sessionDidStart() }
      services.questActivities.sessionDidStart()
    }
    if plan.releasesPendingRoute {
      services.navigator.releasePendingRoute()
    }
    if plan.runsLaunchWork {
      services.prepareWidgets()
      appDidBecomeActive()
    }
    if plan.endsSession {
      endSession()
    }
  }

  private func endSession() {
    hasShownShell = false
    services.accountStatus.reset()
    // Cached rows belong to the account that fetched them.
    let realtime = services.realtime
    Task { await realtime.stop() }
    Task { await services.sessionListCache.clear() }
    services.push.sessionDidEnd()
    // A session that ended on its own cannot unregister tokens; the activities still must not linger.
    services.questActivities.sessionDidEnd()
    let monitor = services.agentRunMonitor
    Task { await monitor.stopAll() }
    // The widgets sit on the Home Screen: they must not keep showing the last account's data.
    let widgets = services.widgets
    Task { await widgets.signOut() }
    services.navigator.discardPendingRoute()
  }
}
