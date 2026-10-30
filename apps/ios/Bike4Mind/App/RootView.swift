import B4MKit
import SwiftUI

/// Routes between sign-in, the locked screen and the signed-in shell purely from `AuthController.state`.
struct RootView: View {
  @Environment(AuthController.self) private var auth
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      switch auth.state {
      case .restoring:
        ProgressView()
          .task { auth.restore() }
      case .signedOut(let reason):
        SignInView(signOutReason: reason)
      case .signedIn:
        MainTabView()
      case .locked:
        LockedView()
      }
    }
    .animation(.default, value: auth.state)
    .onChange(of: scenePhase) { _, phase in
      // Lock on the way out so the app-switcher snapshot never shows content.
      if phase == .background { auth.lockIfNeeded() }
    }
  }
}
