import B4MKit
import SwiftUI

/// Signed-in navigation skeleton: one stack rooted at the start-of-chat home, with a leading drawer for
/// everything else. The stack's path and the drawer's open state live in `AppNavigator`, which deep links and
/// notification taps drive.
struct AppShellView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    @Bindable var navigator = services.navigator
    ZStack(alignment: .leading) {
      NavigationStack(path: $navigator.sessionPath) {
        NewConversationView(api: services.api, activities: services.questActivities)
          .navigationDestination(for: SessionsDestination.self) { destination in
            switch destination {
            case .sessionList:
              SessionsView()
            case .session(let session):
              SessionDetailView(session: session)
                // Opening a conversation is the first moment the app has shown the user value, so this is
                // when the one-time system notification prompt appears.
                .task { await services.push.userDidReachValueMoment() }
            case .settings:
              SettingsView()
            case .studio:
              MediaGalleryView()
            }
          }
      }
      HomeDrawer()
    }
    .fullScreenCover(
      item: Binding(
        get: { navigator.voiceRequest },
        set: { if $0 == nil { navigator.endVoiceConversation(startedSessionID: nil) } })
    ) { request in
      VoiceConversationView(request: request)
    }
    .inAppSafari(
      url: Binding(
        get: { navigator.externalURL },
        set: { if $0 == nil { navigator.consumeExternalURL() } }))
  }
}
